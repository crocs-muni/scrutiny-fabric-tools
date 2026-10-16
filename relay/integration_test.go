// Package relaytest contains the end-to-end test of the assembled relay: it
// mounts the exact wiring used by the binary on an httptest server and drives
// it over a websocket, covering the pilot's acceptance criteria.
package relaytest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip42"
	"github.com/coder/websocket"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/relay"
)

const (
	testTimeout = 15 * time.Second

	// a canonical value with a demo twin, as the pilot publishers use it
	testAcceptedTag = "scrutiny-fabric-test"
	// a word that only exists in the test note content
	testSearchWord = "schnitzelverse"
)

func TestPilotRelayFlow(t *testing.T) {
	sk := nostr.Generate()
	pk := sk.Public()

	dataDir := t.TempDir()
	cfg := config.Config{
		Paths: config.Paths{
			DataDir:         dataDir,
			BaseDBPath:      filepath.Join(dataDir, "base.bolt"),
			SearchIndexPath: filepath.Join(dataDir, "search"),
		},
		ListenAddr: "127.0.0.1:0",
		// empty: khatru derives the base URL from the request, so the NIP-42
		// relay tag must be ws://host:port in this test
		ServiceURL:       "",
		AllowedPubkeys:   []nostr.PubKey{pk},
		AcceptedTags:     config.DefaultAcceptedTags(),
		RelayName:        "scrutiny-fabric relay (test)",
		RelayDescription: "integration test instance",
		RelayContact:     config.DefaultRelayContact,
		MaxQueryLimit:    500,
		MaxEventPastAge:  config.DefaultMaxEventPastAge,
	}

	bundle, err := relay.Build(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("building the relay: %v", err)
	}
	defer bundle.Close()

	srv := httptest.NewServer(bundle.Handler())
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dialing the relay: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	client := &wsClient{t: t, ctx: ctx, conn: conn}

	// 1) the NIP-42 challenge is sent eagerly on connect
	client.expectEagerChallenge()

	// 2) reads are open: an unauthenticated REQ gets EOSE on an empty store
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "open-reads",
		Filters:        []nostr.Filter{{Kinds: []nostr.Kind{nostr.KindTextNote}}},
	})
	if events := client.readUntilEOSE(); len(events) != 0 {
		t.Fatalf("expected an empty store, got %d events", len(events))
	}

	// 3) unauthenticated writes are rejected with the "auth-required:" prefix
	// and a fresh challenge next to the rejection
	note := makeNote(t, sk, testAcceptedTag, "pilot note containing "+testSearchWord)
	client.send(nostr.EventEnvelope{Event: note})
	unauthedOK := client.readOK(note.ID)
	if unauthedOK.OK {
		t.Fatal("expected the unauthenticated write to be rejected")
	}
	if !strings.HasPrefix(unauthedOK.Reason, "auth-required:") {
		t.Fatalf("unauthenticated rejection reason = %q, want the auth-required: prefix", unauthedOK.Reason)
	}
	if !client.sawAuthDuringLastWait {
		t.Fatal("expected a NIP-42 challenge alongside the auth-required rejection")
	}

	// 4) authenticate with NIP-42 and publish the note
	client.authenticate(sk, wsURL)
	client.send(nostr.EventEnvelope{Event: note})
	if ok := client.readOK(note.ID); !ok.OK {
		t.Fatalf("authenticated publish failed: %s", ok.Reason)
	}

	// 5) the note is queryable by its accepted t tag
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "by-tag",
		Filters: []nostr.Filter{{
			Kinds: []nostr.Kind{nostr.KindTextNote},
			Tags:  nostr.TagMap{"t": []string{testAcceptedTag}},
		}},
	})
	if events := client.readUntilEOSE(); !containsEvent(events, note.ID) {
		t.Fatalf("#t query returned %d events, want the published note", len(events))
	}

	// 6) a kind 5 deletion request targeting the note is accepted and stored
	deletion := makeDeletion(t, sk, note.ID)
	client.send(nostr.EventEnvelope{Event: deletion})
	if ok := client.readOK(deletion.ID); !ok.OK {
		t.Fatalf("kind 5 publish failed: %s", ok.Reason)
	}

	// 7) the deletion request is queryable by kind and e tag
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "deletion",
		Filters: []nostr.Filter{{
			Kinds: []nostr.Kind{nostr.KindDeletion},
			Tags:  nostr.TagMap{"e": []string{note.ID.Hex()}},
		}},
	})
	if events := client.readUntilEOSE(); !containsEvent(events, deletion.ID) {
		t.Fatalf("deletion query returned %d events, want the stored kind 5", len(events))
	}

	// 8) DEL-11: the target of the deletion request is still served
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "target",
		Filters:        []nostr.Filter{{IDs: []nostr.ID{note.ID}}},
	})
	if events := client.readUntilEOSE(); !containsEvent(events, note.ID) {
		t.Fatal("DEL-11 violation: the event referenced by an accepted kind 5 is no longer served")
	}

	// 9) NIP-50: the note is found by a search on its content
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "search",
		Filters: []nostr.Filter{{
			Search: testSearchWord,
			Kinds:  []nostr.Kind{nostr.KindTextNote},
		}},
	})
	if events := client.readUntilEOSE(); !containsEvent(events, note.ID) {
		t.Fatalf("search returned %d events, want the published note", len(events))
	}

	// 10) documented behavior: a search shorter than 2 characters returns no
	// events (bleve trims and refuses search strings with less than 2 chars)
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "short-search",
		Filters: []nostr.Filter{{
			Search: "a",
			Kinds:  []nostr.Kind{nostr.KindTextNote},
		}},
	})
	if events := client.readUntilEOSE(); len(events) != 0 {
		t.Fatalf("short search returned %d events, want 0", len(events))
	}

	// 11) kind 1 without an accepted t tag is rejected as blocked
	offVocabulary := makeNote(t, sk, "some-unrelated-tag", "must not be stored")
	client.send(nostr.EventEnvelope{Event: offVocabulary})
	if ok := client.readOK(offVocabulary.ID); ok.OK {
		t.Fatal("expected the off-vocabulary note to be rejected")
	} else if !strings.HasPrefix(ok.Reason, "blocked:") {
		t.Fatalf("off-vocabulary rejection reason = %q, want the blocked: prefix", ok.Reason)
	}

	// 12) a sybil key that authenticates but is not on the allowlist is
	// blocked: NIP-42 authentication alone does not grant publishing rights.
	// (khatru keeps all authenticated pubkeys and GetAuthed returns the last
	// one, so the second AUTH on this connection switches the effective
	// identity.)
	sybil := nostr.Generate()
	client.authenticate(sybil, wsURL)
	sybilNote := makeNote(t, sybil, testAcceptedTag, "must not be stored")
	client.send(nostr.EventEnvelope{Event: sybilNote})
	if ok := client.readOK(sybilNote.ID); ok.OK {
		t.Fatal("expected the non-allowlisted publisher to be blocked")
	} else if !strings.HasPrefix(ok.Reason, "blocked:") {
		t.Fatalf("non-allowlisted rejection reason = %q, want the blocked: prefix", ok.Reason)
	}

	// 13) NIP-11 advertises NIP-50 but neither NIP-9 (DEL-11) nor NIP-86
	// (the management API is never served)
	assertNIP11(t, srv.URL)
}

// TestPastAgeWindow pins the configurable freshness window: with
// MaxEventPastAge = 48h an authed event created 4h ago is accepted and one
// created 49h ago is rejected "too old". The window exists for mirror
// backfills; the default (2h) is covered by TestPilotRelayFlow publishing
// fresh events only.
func TestPastAgeWindow(t *testing.T) {
	sk := nostr.Generate()
	pk := sk.Public()

	dataDir := t.TempDir()
	cfg := config.Config{
		Paths: config.Paths{
			DataDir:         dataDir,
			BaseDBPath:      filepath.Join(dataDir, "base.bolt"),
			SearchIndexPath: filepath.Join(dataDir, "search"),
		},
		ListenAddr:       "127.0.0.1:0",
		ServiceURL:       "",
		AllowedPubkeys:   []nostr.PubKey{pk},
		AcceptedTags:     config.DefaultAcceptedTags(),
		RelayName:        "scrutiny-fabric relay (test)",
		RelayDescription: "integration test instance",
		MaxQueryLimit:    500,
		MaxEventPastAge:  48 * time.Hour,
	}

	bundle, err := relay.Build(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("building the relay: %v", err)
	}
	defer bundle.Close()

	srv := httptest.NewServer(bundle.Handler())
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dialing the relay: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")

	client := &wsClient{t: t, ctx: ctx, conn: conn}
	client.expectEagerChallenge()
	client.authenticate(sk, wsURL)

	within := makeNote(t, sk, testAcceptedTag, "backfill-aged note")
	within.CreatedAt = nostr.Now() - nostr.Timestamp(4*60*60)
	within.Sign(sk)
	client.send(nostr.EventEnvelope{Event: within})
	if ok := client.readOK(within.ID); !ok.OK {
		t.Fatalf("created_at now-4h inside a 48h window was rejected: %s", ok.Reason)
	}

	beyond := makeNote(t, sk, testAcceptedTag, "too-old note")
	beyond.CreatedAt = nostr.Now() - nostr.Timestamp(49*60*60)
	beyond.Sign(sk)
	client.send(nostr.EventEnvelope{Event: beyond})
	if ok := client.readOK(beyond.ID); ok.OK {
		t.Fatal("created_at now-49h inside a 48h window must be rejected")
	} else if !strings.Contains(ok.Reason, "too old") {
		t.Fatalf("rejection reason = %q, want it to name the age (\"too old\")", ok.Reason)
	}
}

// TestSearchBudgetLimitsSearchesOnly drains the per-IP NIP-50 budget: the
// search limiter holds 120 tokens (30/min refill) and has no loopback exemption,
// so more searches than that are answered with CLOSED carrying the search
// message, while a plain (non-search) filter on a fresh connection still gets
// EOSE. Loopback is the only IP the httptest client can present.
func TestSearchBudgetLimitsSearchesOnly(t *testing.T) {
	dataDir := t.TempDir()
	cfg := config.Config{
		Paths: config.Paths{
			DataDir:         dataDir,
			BaseDBPath:      filepath.Join(dataDir, "base.bolt"),
			SearchIndexPath: filepath.Join(dataDir, "search"),
		},
		ListenAddr:       "127.0.0.1:0",
		ServiceURL:       "",
		AllowedPubkeys:   []nostr.PubKey{nostr.Generate().Public()},
		AcceptedTags:     config.DefaultAcceptedTags(),
		RelayName:        "scrutiny-fabric relay (test)",
		RelayDescription: "integration test instance",
		RelayContact:     config.DefaultRelayContact,
		MaxQueryLimit:    500,
		MaxEventPastAge:  config.DefaultMaxEventPastAge,
	}

	bundle, err := relay.Build(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("building the relay: %v", err)
	}
	defer bundle.Close()

	srv := httptest.NewServer(bundle.Handler())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dialing the relay: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")
	client := &wsClient{t: t, ctx: ctx, conn: conn}
	client.expectEagerChallenge()

	// One more search than the burst of 120; each REQ uses a distinct sub id.
	const searches = 130
	for i := range searches {
		client.send(nostr.ReqEnvelope{
			SubscriptionID: fmt.Sprintf("search-%d", i),
			Filters: []nostr.Filter{{
				Search: testSearchWord,
				Kinds:  []nostr.Kind{nostr.KindTextNote},
			}},
		})
	}

	var closedReasons []string
	for range searches {
		switch env := client.read().(type) {
		case *nostr.EOSEEnvelope:
		case *nostr.AuthEnvelope:
		case *nostr.ClosedEnvelope:
			closedReasons = append(closedReasons, env.Reason)
		default:
			t.Fatalf("unexpected envelope while draining the search budget: %T", env)
		}
	}
	if len(closedReasons) == 0 {
		t.Fatal("expected at least one search to be CLOSED once the budget was spent")
	}
	for _, reason := range closedReasons {
		if !strings.HasPrefix(reason, "rate-limited:") || !strings.Contains(reason, "search budget") {
			t.Fatalf("search rejection reason = %q, want the search budget message", reason)
		}
	}

	// A fresh connection issuing a NON-search filter is unaffected: the budget
	// only covers NIP-50 searches.
	conn2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dialing the relay (second connection): %v", err)
	}
	defer conn2.Close(websocket.StatusNormalClosure, "test done")
	client2 := &wsClient{t: t, ctx: ctx, conn: conn2}
	client2.expectEagerChallenge()
	client2.send(nostr.ReqEnvelope{
		SubscriptionID: "plain",
		Filters:        []nostr.Filter{{Kinds: []nostr.Kind{nostr.KindTextNote}}},
	})
	if events := client2.readUntilEOSE(); len(events) != 0 {
		t.Fatalf("plain filter on a fresh connection returned %d events, want EOSE on an empty store", len(events))
	}
}

// newTestRelay builds the relay with the standard test configuration and
// mounts the same hardened handler as the binary (bundle.Handler()) on an
// httptest server; the bundle and server are closed by t.Cleanup.
func newTestRelay(t *testing.T) *httptest.Server {
	t.Helper()

	dataDir := t.TempDir()
	cfg := config.Config{
		Paths: config.Paths{
			DataDir:         dataDir,
			BaseDBPath:      filepath.Join(dataDir, "base.bolt"),
			SearchIndexPath: filepath.Join(dataDir, "search"),
		},
		ListenAddr:       "127.0.0.1:0",
		ServiceURL:       "",
		AllowedPubkeys:   []nostr.PubKey{nostr.Generate().Public()},
		AcceptedTags:     config.DefaultAcceptedTags(),
		RelayName:        "scrutiny-fabric relay (test)",
		RelayDescription: "integration test instance",
		RelayContact:     config.DefaultRelayContact,
		MaxQueryLimit:    500,
		MaxEventPastAge:  config.DefaultMaxEventPastAge,
	}

	bundle, err := relay.Build(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("building the relay: %v", err)
	}
	t.Cleanup(bundle.Close)

	srv := httptest.NewServer(bundle.Handler())
	t.Cleanup(srv.Close)
	return srv
}

// TestFilterComplexityCaps pins the request-complexity guard: a single filter
// over the id cap is CLOSED with the complexity message before it reaches the
// stores, while a filter inside the caps still completes (EOSE on the empty
// store).
func TestFilterComplexityCaps(t *testing.T) {
	srv := newTestRelay(t)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dialing the relay: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")
	client := &wsClient{t: t, ctx: ctx, conn: conn}
	client.expectEagerChallenge()

	// 400 ids is inside the 500-id cap: the query runs and EOSEs.
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "ids-within-cap",
		Filters:        []nostr.Filter{{IDs: makeIDs(400)}},
	})
	if events := client.readUntilEOSE(); len(events) != 0 {
		t.Fatalf("in-cap id query returned %d events, want EOSE on an empty store", len(events))
	}

	// 600 ids is over the cap: CLOSED with the complexity message, no EOSE.
	client.send(nostr.ReqEnvelope{
		SubscriptionID: "ids-over-cap",
		Filters:        []nostr.Filter{{IDs: makeIDs(600)}},
	})
	env := client.read()
	closed, ok := env.(*nostr.ClosedEnvelope)
	if !ok {
		t.Fatalf("over-cap id query got %T, want CLOSED", env)
	}
	if closed.SubscriptionID != "ids-over-cap" {
		t.Fatalf("CLOSED for subscription %q, want ids-over-cap", closed.SubscriptionID)
	}
	if closed.Reason != "rejected: filter too complex" {
		t.Fatalf("CLOSED reason = %q, want %q", closed.Reason, "rejected: filter too complex")
	}
}

// TestManagementAPINotServed pins the NIP-86 posture: the management endpoint
// is never served. A request carrying the NIP-86 content type is answered with
// 404 and a one-line explanation by Hardened, before khatru's routing could
// hand it to its management handler (which reads and hashes the whole request
// body before checking Authorization, and whose methods are all unwired here).
func TestManagementAPINotServed(t *testing.T) {
	srv := newTestRelay(t)

	req, err := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(`{"method":"stats","params":[]}`))
	if err != nil {
		t.Fatalf("building the NIP-86 request: %v", err)
	}
	req.Header.Set("Content-Type", "application/nostr+json+rpc")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("calling the NIP-86 endpoint: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("NIP-86 status = %d, want 404", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading the NIP-86 404 body: %v", err)
	}
	if !strings.Contains(string(body), "NIP-86") {
		t.Fatalf("NIP-86 404 body = %q, want the one-line explanation", body)
	}
}

// TestHardenedForwardedForTrustRule pins the XFF trust rule: X-Forwarded-For
// survives only when the transport peer is loopback or in a private range
// (Caddy's docker network, the VM-internal tunnel, local development); from
// any other peer the header is deleted so a direct client cannot forge the
// per-IP identity khatru's limiters derive from it.
func TestHardenedForwardedForTrustRule(t *testing.T) {
	const forged = "198.51.100.23"

	cases := []struct {
		name       string
		remoteAddr string
		wantKept   bool
	}{
		{"loopback ipv4", "127.0.0.1:4040", true},
		{"loopback ipv6", "[::1]:4040", true},
		{"private 10/8", "10.1.2.3:4040", true},
		{"private 172.16/12 (docker)", "172.17.0.1:4040", true},
		{"private 192.168/16", "192.168.1.9:4040", true},
		{"public ipv4", "203.0.113.9:4040", false},
		{"public ipv6", "[2001:db8::1]:4040", false},
		{"unparsable peer", "not-an-ip", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen string
			next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				seen = r.Header.Get("X-Forwarded-For")
			})

			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = tc.remoteAddr
			req.Header.Set("X-Forwarded-For", forged)
			relay.Hardened(next).ServeHTTP(httptest.NewRecorder(), req)

			if kept := seen == forged; kept != tc.wantKept {
				t.Fatalf("X-Forwarded-For kept = %v (value %q), want %v", kept, seen, tc.wantKept)
			}
		})
	}
}

// TestHardenedRequestBodyCap pins the belt-and-braces body cap: every
// non-websocket request body stops at 64 KiB.
func TestHardenedRequestBodyCap(t *testing.T) {
	var readErr error
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
	})

	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(make([]byte, 128*1024)))
	relay.Hardened(next).ServeHTTP(httptest.NewRecorder(), req)

	var maxErr *http.MaxBytesError
	if !errors.As(readErr, &maxErr) {
		t.Fatalf("reading a 128 KiB body returned %v, want *http.MaxBytesError", readErr)
	}
	if maxErr.Limit != 64*1024 {
		t.Fatalf("body cap = %d, want 65536", maxErr.Limit)
	}
}

// The khatru connection and filter limiters could in principle be exercised by
// forging X-Forwarded-For (khatru.GetIPFromRequest prefers the first
// global-unicast XFF entry over RemoteAddr), but their bursts are the
// production ceilings (600 connections, 2000 filters) and the wiring uses the
// fixed consts, so there is no non-hacky way to inject a small burst here. Their
// loopback exemption also blocks direct testing without a spoofed header. The
// search limiter above is covered end to end; the khatru ones are exercised by
// construction (same policy funcs the library tests).

// wsClient is a tiny raw websocket client. The nostr pool client exists, but
// it hides the raw message ordering this test needs to assert (challenge
// before OK:false, EOSE after EVENTs), so the coder/websocket client that
// khatru itself builds on is driven directly.
type wsClient struct {
	t    *testing.T
	ctx  context.Context
	conn *websocket.Conn

	challenge             string
	sawAuthDuringLastWait bool
}

func (c *wsClient) send(env any) {
	c.t.Helper()
	b, err := json.Marshal(env)
	if err != nil {
		c.t.Fatalf("marshaling %T: %v", env, err)
	}
	if err := c.conn.Write(c.ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("writing %T: %v", env, err)
	}
}

func (c *wsClient) read() nostr.Envelope {
	c.t.Helper()
	typ, data, err := c.conn.Read(c.ctx)
	if err != nil {
		c.t.Fatalf("reading from the relay: %v", err)
	}
	if typ != websocket.MessageText {
		c.t.Fatalf("unexpected websocket message type %v", typ)
	}
	env, err := nostr.ParseMessage(string(data))
	if err != nil {
		c.t.Fatalf("parsing relay message %q: %v", data, err)
	}
	return env
}

// expectEagerChallenge reads the first message, which must be the NIP-42
// challenge khatru sends from OnConnect.
func (c *wsClient) expectEagerChallenge() {
	c.t.Helper()
	env := c.read()
	auth, ok := env.(*nostr.AuthEnvelope)
	if !ok || auth.Challenge == nil {
		c.t.Fatalf("expected the eager AUTH challenge as the first message, got %T", env)
	}
	c.challenge = *auth.Challenge
}

// readOK reads until the OK for eventID arrives, skipping envelopes that can
// legitimately interleave on the same connection:
//
//   - AUTH challenges (remembered for the next authenticate call);
//   - EVENT broadcasts from subscriptions that are still open, for example the
//     "open-reads" listener receiving every stored kind 1 while we wait for
//     the OK of the write that produced it;
//   - NOTICEs.
//
// CLOSED envelopes and OKs for other events still fail the test.
func (c *wsClient) readOK(eventID nostr.ID) nostr.OKEnvelope {
	c.t.Helper()
	c.sawAuthDuringLastWait = false
	for {
		env := c.read()
		switch e := env.(type) {
		case *nostr.OKEnvelope:
			if e.EventID != eventID {
				c.t.Fatalf("OK for event %s, want %s", e.EventID.Hex(), eventID.Hex())
			}
			return *e
		case *nostr.AuthEnvelope:
			if e.Challenge != nil {
				c.challenge = *e.Challenge
			}
			c.sawAuthDuringLastWait = true
		case *nostr.EventEnvelope:
			// a broadcast from a still-open subscription; irrelevant to the OK
		case *nostr.NoticeEnvelope:
			// informational only
		default:
			c.t.Fatalf("unexpected envelope while waiting for an OK: %T", env)
		}
	}
}

// readUntilEOSE reads until EOSE, returning the EVENTs received on the way.
func (c *wsClient) readUntilEOSE() []nostr.Event {
	c.t.Helper()
	c.sawAuthDuringLastWait = false
	var events []nostr.Event
	for {
		env := c.read()
		switch e := env.(type) {
		case *nostr.EventEnvelope:
			events = append(events, e.Event)
		case *nostr.EOSEEnvelope:
			return events
		case *nostr.AuthEnvelope:
			if e.Challenge != nil {
				c.challenge = *e.Challenge
			}
			c.sawAuthDuringLastWait = true
		default:
			c.t.Fatalf("unexpected envelope while waiting for EOSE: %T", env)
		}
	}
}

// authenticate answers the latest NIP-42 challenge with a signed kind 22242
// event and waits for the AUTH OK.
func (c *wsClient) authenticate(sk nostr.SecretKey, relayURL string) {
	c.t.Helper()
	if c.challenge == "" {
		c.t.Fatal("no NIP-42 challenge received")
	}
	authEvent := nip42.CreateUnsignedAuthEvent(c.challenge, sk.Public(), relayURL)
	if err := authEvent.Sign(sk); err != nil {
		c.t.Fatalf("signing the AUTH event: %v", err)
	}
	c.send(nostr.AuthEnvelope{Event: authEvent})
	if ok := c.readOK(authEvent.ID); !ok.OK {
		c.t.Fatalf("AUTH rejected: %s", ok.Reason)
	}
}

func makeNote(t *testing.T, sk nostr.SecretKey, vocabTag, content string) nostr.Event {
	t.Helper()
	evt := nostr.Event{
		Kind:      nostr.KindTextNote,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"t", vocabTag}},
		Content:   content,
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("signing the note: %v", err)
	}
	return evt
}

func makeDeletion(t *testing.T, sk nostr.SecretKey, target nostr.ID) nostr.Event {
	t.Helper()
	evt := nostr.Event{
		Kind:      nostr.KindDeletion,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"e", target.Hex()}},
		Content:   "pilot deletion request: stored and served, never acted upon (DEL-11)",
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("signing the deletion request: %v", err)
	}
	return evt
}

// makeIDs builds n distinct, never-all-zero event ids for filter tests.
func makeIDs(n int) []nostr.ID {
	ids := make([]nostr.ID, n)
	for i := range ids {
		ids[i][0] = 0xaa
		ids[i][1] = byte(i >> 8)
		ids[i][2] = byte(i)
	}
	return ids
}

func containsEvent(events []nostr.Event, id nostr.ID) bool {
	for _, evt := range events {
		if evt.ID == id {
			return true
		}
	}
	return false
}

// assertNIP11 fetches the relay information document and checks the DEL-11
// advertising (NIP-50 yes; NIP-9, NIP-45 and NIP-86 no; no auth_required
// limitation) plus the public-exposure metadata: contact, operator pubkey, the
// enforced limitation values, the retention note, and the probe-retention
// sentence in the policy.
func assertNIP11(t *testing.T, baseURL string) {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, baseURL, nil)
	if err != nil {
		t.Fatalf("building the NIP-11 request: %v", err)
	}
	req.Header.Set("Accept", "application/nostr+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("fetching NIP-11: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("NIP-11 status = %d", resp.StatusCode)
	}

	var doc struct {
		Software      string `json:"software"`
		Contact       string `json:"contact"`
		PubKey        string `json:"pubkey"`
		SupportedNIPs []any  `json:"supported_nips"`
		PostingPolicy string `json:"posting_policy"`
		Retention     string `json:"retention"`
		Limitation    *struct {
			AuthRequired     bool `json:"auth_required"`
			RestrictedWrites bool `json:"restricted_writes"`
			MaxMessageLength int  `json:"max_message_length"`
			MaxContentLength int  `json:"max_content_length"`
			MaxEventTags     int  `json:"max_event_tags"`
			MaxLimit         int  `json:"max_limit"`
		} `json:"limitation"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatalf("decoding NIP-11: %v", err)
	}

	has := func(nip string) bool {
		for _, v := range doc.SupportedNIPs {
			switch x := v.(type) {
			case float64:
				if fmt.Sprintf("%d", int(x)) == nip {
					return true
				}
			case string:
				if x == nip {
					return true
				}
			}
		}
		return false
	}

	if !has("50") {
		t.Errorf("NIP-11 supported_nips = %v, want it to include 50 (search)", doc.SupportedNIPs)
	}
	if has("9") {
		t.Error("NIP-11 advertises NIP-9 although deletion is inert (DEL-11)")
	}
	if has("45") {
		t.Error("NIP-11 advertises NIP-45 although no count hook is wired")
	}
	if has("86") {
		t.Error("NIP-11 advertises NIP-86 although the management API is refused with 404 (Hardened)")
	}
	if doc.PostingPolicy == "" {
		t.Error("NIP-11 posting_policy must describe the write policy")
	}
	if !strings.Contains(doc.PostingPolicy, "never re-emitted") {
		t.Errorf("NIP-11 posting_policy = %q, want the probe-retention sentence", doc.PostingPolicy)
	}
	if doc.Software != "github.com/crocs-muni/scrutiny-fabric-tools/relay" {
		t.Errorf("NIP-11 software = %q", doc.Software)
	}
	if doc.Contact != config.DefaultRelayContact {
		t.Errorf("NIP-11 contact = %q, want %q", doc.Contact, config.DefaultRelayContact)
	}
	if doc.PubKey != "c0df886f934aad0c1e62f08b04bd54b44bdd1b5cb0b2ab250cbed25cf64c8a27" {
		t.Errorf("NIP-11 pubkey = %q", doc.PubKey)
	}
	if doc.Retention == "" || !strings.Contains(doc.Retention, "never deleted") {
		t.Errorf("NIP-11 retention = %q, want the DEL-11 note", doc.Retention)
	}
	if doc.Limitation == nil {
		t.Fatal("NIP-11 limitation object is missing")
	}
	if doc.Limitation.AuthRequired {
		t.Error("NIP-11 must not advertise auth_required: reads are open")
	}
	if !doc.Limitation.RestrictedWrites {
		t.Error("NIP-11 must advertise restricted_writes: writes are allowlist-gated")
	}
	if doc.Limitation.MaxMessageLength != 512000 {
		t.Errorf("NIP-11 limitation.max_message_length = %d, want 512000", doc.Limitation.MaxMessageLength)
	}
	if doc.Limitation.MaxContentLength != 262144 {
		t.Errorf("NIP-11 limitation.max_content_length = %d, want 262144", doc.Limitation.MaxContentLength)
	}
	if doc.Limitation.MaxEventTags != 64 {
		t.Errorf("NIP-11 limitation.max_event_tags = %d, want 64", doc.Limitation.MaxEventTags)
	}
	if doc.Limitation.MaxLimit != 500 {
		t.Errorf("NIP-11 limitation.max_limit = %d, want 500", doc.Limitation.MaxLimit)
	}
}
