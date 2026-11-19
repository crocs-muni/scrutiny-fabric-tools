// Package relaytest contains the end-to-end test of the assembled relay: it
// mounts the exact wiring used by the binary on an httptest server and drives
// it over a websocket, covering the pilot's acceptance criteria.
package relaytest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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

// TestKindZeroReplaceableProfile pins the NIP-01 posture for kind 0: the
// profile is stored, a newer profile of the same author supersedes the older
// one, and a re-send of the older profile is dropped as already-superseded.
func TestKindZeroReplaceableProfile(t *testing.T) {
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

	profile := func(name string, ts nostr.Timestamp) nostr.Event {
		evt := nostr.Event{
			Kind:      nostr.KindProfileMetadata,
			CreatedAt: ts,
			Tags:      nostr.Tags{{"l", "pilot-profile@example.org"}},
			Content:   name,
		}
		if err := evt.Sign(sk); err != nil {
			t.Fatalf("signing the profile: %v", err)
		}
		return evt
	}

	// 0) kind 0 is auth-gated like every other write: an unauthenticated
	// profile is rejected with the NIP-42 challenge
	first := profile("pilot profile v1", nostr.Now()-60)
	client.send(nostr.EventEnvelope{Event: first})
	unauthedOK := client.readOK(first.ID)
	if unauthedOK.OK {
		t.Fatal("expected the unauthenticated kind-0 write to be rejected")
	}
	if !strings.HasPrefix(unauthedOK.Reason, "auth-required:") {
		t.Fatalf("unauthenticated kind-0 rejection reason = %q, want the auth-required: prefix", unauthedOK.Reason)
	}

	client.authenticate(sk, wsURL)

	latest := func() string {
		client.send(nostr.ReqEnvelope{
			SubscriptionID: "profile-latest",
			Filters:        []nostr.Filter{{Kinds: []nostr.Kind{nostr.KindProfileMetadata}, Authors: []nostr.PubKey{pk}}},
		})
		events := client.readUntilEOSE()
		if len(events) != 1 {
			t.Fatalf("profile query returned %d events, want exactly the one live profile", len(events))
		}
		return events[0].Content
	}

	// 1) the same profile, now authenticated, is accepted and queryable by
	// kind + author
	client.send(nostr.EventEnvelope{Event: first})
	if ok := client.readOK(first.ID); !ok.OK {
		t.Fatalf("kind 0 publish failed: %s", ok.Reason)
	}
	if got := latest(); got != "pilot profile v1" {
		t.Fatalf("profile content = %q, want the first profile", got)
	}

	// 2) a newer profile of the same author supersedes it: the query returns
	// the newer one only
	second := profile("pilot profile v2", nostr.Now())
	client.send(nostr.EventEnvelope{Event: second})
	if ok := client.readOK(second.ID); !ok.OK {
		t.Fatalf("second kind 0 publish failed: %s", ok.Reason)
	}
	if got := latest(); got != "pilot profile v2" {
		t.Fatalf("profile content = %q, want the superseding profile", got)
	}

	// 3) a re-send of the older profile is an OK no-op: the superseded event
	// stays superseded
	client.send(nostr.EventEnvelope{Event: first})
	if ok := client.readOK(first.ID); !ok.OK {
		t.Fatalf("re-sent older profile must be an OK no-op, got: %s", ok.Reason)
	}
	if got := latest(); got != "pilot profile v2" {
		t.Fatalf("profile content = %q, want the newer profile after the older re-send", got)
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

	return startTestRelay(t, cfg).Server
}

// testServer is an assembled relay mounted on an httptest server. It also
// keeps the handler and the parsed config: the Blossom tests drive oversized
// bodies through the handler directly (an early 413 must not race a
// multi-megabyte socket write) and assert on the blob directory derived from
// the config.
type testServer struct {
	*httptest.Server

	handler http.Handler
	cfg     config.Config
}

// startTestRelay builds the relay exactly like the binary (relay.Build) and
// mounts bundle.Handler() on an httptest server. The bundle and the server are
// closed by t.Cleanup.
func startTestRelay(t *testing.T, cfg config.Config) *testServer {
	t.Helper()

	bundle, err := relay.Build(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("building the relay: %v", err)
	}
	t.Cleanup(bundle.Close)

	handler := bundle.Handler()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &testServer{Server: srv, handler: handler, cfg: cfg}
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
// survives only when the transport peer is loopback or inside
// SCRUTINY_TRUSTED_PROXY_CIDRS (the reverse proxy's network); from any other
// peer the header is deleted so a direct client cannot forge the per-IP
// identity khatru's limiters derive from it. Note what changed from the old
// blanket rule: a private-range peer is no longer trusted by default, so a
// client inside the same LAN as the relay cannot forge a limiter identity.
func TestHardenedForwardedForTrustRule(t *testing.T) {
	const forged = "198.51.100.23"

	cases := []struct {
		name       string
		remoteAddr string
		wantKept   bool
	}{
		{"loopback ipv4", "127.0.0.1:4040", true},
		{"loopback ipv6", "[::1]:4040", true},
		{"private 10/8 without allowlist", "10.1.2.3:4040", false},
		{"private 172.16/12 without allowlist", "172.17.0.1:4040", false},
		{"private 192.168/16 without allowlist", "192.168.1.9:4040", false},
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
			relay.Hardened(next, config.Config{}).ServeHTTP(httptest.NewRecorder(), req)

			if kept := seen == forged; kept != tc.wantKept {
				t.Fatalf("X-Forwarded-For kept = %v (value %q), want %v", kept, seen, tc.wantKept)
			}
		})
	}

	t.Run("allowlisted CIDR is trusted", func(t *testing.T) {
		var seen string
		next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			seen = r.Header.Get("X-Forwarded-For")
		})
		_, cidr, err := net.ParseCIDR("172.17.0.0/16")
		if err != nil {
			t.Fatal(err)
		}
		cfg := config.Config{TrustedProxyCIDRs: []*net.IPNet{cidr}}

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "172.17.0.1:4040"
		req.Header.Set("X-Forwarded-For", forged)
		relay.Hardened(next, cfg).ServeHTTP(httptest.NewRecorder(), req)

		if seen != forged {
			t.Fatalf("X-Forwarded-For not kept for allowlisted peer: %q", seen)
		}
	})

	t.Run("peer outside allowlisted CIDR is not", func(t *testing.T) {
		var seen string
		next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			seen = r.Header.Get("X-Forwarded-For")
		})
		_, cidr, _ := net.ParseCIDR("172.17.0.0/16")
		cfg := config.Config{TrustedProxyCIDRs: []*net.IPNet{cidr}}

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "172.18.0.1:4040"
		req.Header.Set("X-Forwarded-For", forged)
		relay.Hardened(next, cfg).ServeHTTP(httptest.NewRecorder(), req)

		if seen == forged {
			t.Fatalf("X-Forwarded-For kept for peer outside allowlist: %q", seen)
		}
	})
}

// TestHardenedOpsEndpointsLoopbackOnly pins the operator-only rule: /healthz
// and /metrics answer only to loopback peers. A remote peer gets 404 — the
// compose.dev stage publishes 3334 on all interfaces, so without this the
// whole VM network could read the health text and the metrics surface.
func TestHardenedOpsEndpointsLoopbackOnly(t *testing.T) {
	for _, path := range []string{"/healthz", "/metrics"} {
		for _, tc := range []struct {
			name       string
			remoteAddr string
			wantOK     bool
		}{
			{"loopback", "127.0.0.1:4040", true},
			{"private LAN peer", "10.1.2.3:4040", false},
		} {
			t.Run(path+" from "+tc.name, func(t *testing.T) {
				next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusOK)
				})
				req := httptest.NewRequest(http.MethodGet, path, nil)
				req.RemoteAddr = tc.remoteAddr
				rec := httptest.NewRecorder()
				relay.Hardened(next, config.Config{}).ServeHTTP(rec, req)
				gotOK := rec.Code == http.StatusOK
				if gotOK != tc.wantOK {
					t.Fatalf("status = %d, want ok = %v", rec.Code, tc.wantOK)
				}
			})
		}
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
	relay.Hardened(next, config.Config{}).ServeHTTP(httptest.NewRecorder(), req)

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
	if !strings.Contains(doc.PostingPolicy, "kind 0 profile metadata") {
		t.Errorf("NIP-11 posting_policy = %q, want the kind-0 profile sentence", doc.PostingPolicy)
	}
	if !strings.Contains(doc.Retention, "NIP-01 replaceable") {
		t.Errorf("NIP-11 retention = %q, want the kind-0 NIP-01 exception note", doc.Retention)
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

// The Blossom endpoint (issue #123, docs/specs/mcp-publishing.md §9.4) is
// driven black-box through the same handler the binary mounts. Uploads are
// authenticated with kind-24242 authorization events, as the MCP client sends
// them; nothing below reaches into the relay internals.

// blobTimeout is generous for the 49 MB case; everything is loopback.
const blobTimeout = 60 * time.Second

// blobRelay is a relay built from config.FromEnv (so the default blob cap is
// the configured one, not a test-local number) plus the allowlisted publisher
// that signs the upload authorizations.
type blobRelay struct {
	*testServer

	publisher nostr.SecretKey
}

func newBlobRelay(t *testing.T) *blobRelay {
	t.Helper()

	publisher := nostr.Generate()
	cfg, err := config.FromEnv(config.LookupFromMap(map[string]string{
		config.EnvDataDir:        t.TempDir(),
		config.EnvServiceURL:     "ws://127.0.0.1:3334",
		config.EnvAllowedPubkeys: publisher.Public().Hex(),
	}))
	if err != nil {
		t.Fatalf("config.FromEnv: %v", err)
	}
	if cfg.BlobMaxBytes != config.DefaultBlobMaxBytes {
		t.Fatalf("config.FromEnv default BlobMaxBytes = %d, want %d", cfg.BlobMaxBytes, config.DefaultBlobMaxBytes)
	}

	return &blobRelay{testServer: startTestRelay(t, cfg), publisher: publisher}
}

// blobDescriptor mirrors the JSON body of khatru's PUT /upload response.
type blobDescriptor struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
	Type   string `json:"type"`
}

// blobPath is the on-disk body path documented in §9.4.
func (b *blobRelay) blobPath(hash string) string {
	return filepath.Join(b.cfg.DataDir, "blobs", hash)
}

// blossomAuth signs a kind-24242 authorization and returns the
// "Nostr <base64>" header value the Blossom spec (and the MCP client) sends.
func blossomAuth(t *testing.T, sk nostr.SecretKey, verb, hash string) string {
	t.Helper()

	evt := nostr.Event{
		Kind:      24242,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"t", verb},
			{"x", hash},
			{"expiration", strconv.FormatInt(int64(nostr.Now())+300, 10)},
		},
		Content: verb + " " + hash,
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("signing the blossom %q authorization: %v", verb, err)
	}
	raw, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshaling the blossom %q authorization: %v", verb, err)
	}
	return "Nostr " + base64.StdEncoding.EncodeToString(raw)
}

func hashHex(t *testing.T, body []byte) string {
	t.Helper()
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// doHTTP issues one request and returns status, headers and body. Every
// failure names the method and path so a red test says which route broke.
func doHTTP(t *testing.T, method, url string, body io.Reader, headers map[string]string) (int, http.Header, []byte) {
	t.Helper()

	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("building %s %s: %v", method, url, err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: blobTimeout}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("%s %s: reading the response: %v", method, req.URL.Path, err)
	}
	return resp.StatusCode, resp.Header, raw
}

// headBlob returns the status and declared Content-Length of a HEAD request.
// The MCP client treats any 2xx as "already present", so the length must come
// from the response rather than a body.
func headBlob(t *testing.T, url string) (int, int64) {
	t.Helper()

	req, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		t.Fatalf("building HEAD %s: %v", url, err)
	}
	resp, err := (&http.Client{Timeout: blobTimeout}).Do(req)
	if err != nil {
		t.Fatalf("HEAD %s: %v", req.URL.Path, err)
	}
	defer resp.Body.Close()
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		t.Fatalf("HEAD %s: draining the response: %v", req.URL.Path, err)
	}
	return resp.StatusCode, resp.ContentLength
}

// putBlob uploads body with a fresh upload authorization from sk.
func (b *blobRelay) putBlob(t *testing.T, sk nostr.SecretKey, body []byte, contentType string) (int, []byte) {
	t.Helper()

	req, err := http.NewRequest(http.MethodPut, b.URL+"/upload", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("building PUT /upload: %v", err)
	}
	req.Header.Set("Authorization", blossomAuth(t, sk, "upload", hashHex(t, body)))
	req.Header.Set("Content-Type", contentType)
	client := &http.Client{Timeout: blobTimeout}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("PUT /upload (%d bytes): %v", len(body), err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("PUT /upload: reading the response: %v", err)
	}
	return resp.StatusCode, raw
}

// uploadOK uploads and fails the test unless the relay answers 200 with a
// descriptor whose sha256 matches the body.
func (b *blobRelay) uploadOK(t *testing.T, sk nostr.SecretKey, body []byte, contentType string) blobDescriptor {
	t.Helper()

	status, raw := b.putBlob(t, sk, body, contentType)
	if status != http.StatusOK {
		t.Fatalf("PUT /upload (%d bytes): status %d, want 200 (body %q)", len(body), status, raw)
	}
	var desc blobDescriptor
	if err := json.Unmarshal(raw, &desc); err != nil {
		t.Fatalf("PUT /upload: decoding the descriptor from %q: %v", raw, err)
	}
	if want := hashHex(t, body); desc.SHA256 != want {
		t.Fatalf("PUT /upload: descriptor sha256 = %q, want %q", desc.SHA256, want)
	}
	if desc.Size != len(body) {
		t.Fatalf("PUT /upload: descriptor size = %d, want %d", desc.Size, len(body))
	}
	return desc
}

// TestBlossomUploadExemptFromRequestBodyCap is the §9.4 body-cap acceptance
// case: a blob one byte over Hardened's 64 KiB non-websocket cap is stored,
// and the blob directory holds the raw bytes plus the size/uploader sidecar.
func TestBlossomUploadExemptFromRequestBodyCap(t *testing.T) {
	b := newBlobRelay(t)

	body := make([]byte, 64*1024+1) // just over Hardened's cap, nothing more
	desc := b.uploadOK(t, b.publisher, body, "application/octet-stream")

	blobFile := b.blobPath(desc.SHA256)
	info, err := os.Stat(blobFile)
	if err != nil {
		t.Fatalf("PUT /upload: stored blob %s: %v", blobFile, err)
	}
	if info.Size() != int64(len(body)) {
		t.Fatalf("PUT /upload: stored blob size = %d, want %d", info.Size(), len(body))
	}

	raw, err := os.ReadFile(blobFile + ".json")
	if err != nil {
		t.Fatalf("PUT /upload: stored sidecar %s.json: %v", blobFile, err)
	}
	var sidecar struct {
		Size     int64  `json:"size"`
		Uploader string `json:"uploader"`
	}
	if err := json.Unmarshal(raw, &sidecar); err != nil {
		t.Fatalf("PUT /upload: decoding the sidecar %s: %v", raw, err)
	}
	if sidecar.Size != int64(len(body)) {
		t.Fatalf("PUT /upload: sidecar size = %d, want %d", sidecar.Size, len(body))
	}
	if want := b.publisher.Public().Hex(); sidecar.Uploader != want {
		t.Fatalf("PUT /upload: sidecar uploader = %q, want %q", sidecar.Uploader, want)
	}

	// HEAD is unauthenticated and answers from the blob index with a length,
	// which is what the MCP client uses to declare the blob present.
	status, length := headBlob(t, b.URL+"/"+desc.SHA256)
	if status != http.StatusOK {
		t.Fatalf("HEAD /%s: status %d, want 200", desc.SHA256, status)
	}
	if length != int64(len(body)) {
		t.Fatalf("HEAD /%s: Content-Length = %d, want %d", desc.SHA256, length, len(body))
	}
}

// zeroReader streams zero bytes forever without allocating a large buffer; the
// handler reads only the first bytes before it rejects on the declared size.
type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// TestBlossomUploadSizeLimits pins the cap itself: 49 MB is stored, and one
// byte over the 50 MiB default is refused before the body is read. The
// oversized request goes through bundle.Handler() directly so the early 413
// cannot race a multi-megabyte socket write; the declared Content-Length is
// the real size and the body streams.
func TestBlossomUploadSizeLimits(t *testing.T) {
	if testing.Short() {
		t.Skip("the 49 MB / 50 MB uploads are skipped in -short")
	}
	b := newBlobRelay(t)

	const largeSize = 49 << 20 // one allocation; the oversized case streams
	large := make([]byte, largeSize)
	desc := b.uploadOK(t, b.publisher, large, "application/octet-stream")
	info, err := os.Stat(b.blobPath(desc.SHA256))
	if err != nil {
		t.Fatalf("PUT /upload (%d bytes): stored blob: %v", largeSize, err)
	}
	if info.Size() != largeSize {
		t.Fatalf("PUT /upload (%d bytes): stored blob size = %d", largeSize, info.Size())
	}
	status, length := headBlob(t, b.URL+"/"+desc.SHA256)
	if status != http.StatusOK {
		t.Fatalf("HEAD /%s: status %d, want 200", desc.SHA256, status)
	}
	if length != largeSize {
		t.Fatalf("HEAD /%s: Content-Length = %d, want %d", desc.SHA256, length, largeSize)
	}

	// Exactly one byte over the configured cap. Only the declared size reaches
	// RejectUpload before the body is consumed, so stream the bytes.
	tooBig := config.DefaultBlobMaxBytes + 1
	sum := sha256.New()
	if _, err := io.CopyN(sum, zeroReader{}, tooBig); err != nil {
		t.Fatalf("hashing the oversized body: %v", err)
	}
	hash := hex.EncodeToString(sum.Sum(nil))

	req := httptest.NewRequest(http.MethodPut, "/upload", io.LimitReader(zeroReader{}, tooBig))
	req.ContentLength = tooBig
	req.Header.Set("Authorization", blossomAuth(t, b.publisher, "upload", hash))
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	b.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PUT /upload (%d bytes): status %d, want 413 (body %q)",
			tooBig, rec.Code, rec.Body.String())
	}
	// The 413 with X-Reason naming the cap is Hardened's pre-allocation
	// guard (relay.go's /upload check) refusing the announced
	// Content-Length before khatru reads the body; if that guard goes away,
	// the body overflows MaxBytesReader mid-read and the failure looks
	// different, so pin the guard's exact response.
	wantReason := fmt.Sprintf("blocked: blob exceeds %d bytes", config.DefaultBlobMaxBytes)
	if reason := rec.Header().Get("X-Reason"); reason != wantReason {
		t.Fatalf("PUT /upload (%d bytes): X-Reason %q, want %q", tooBig, reason, wantReason)
	}
	if _, err := os.Stat(b.blobPath(hash)); !os.IsNotExist(err) {
		t.Fatalf("PUT /upload (%d bytes): blob %s exists after rejection (stat err %v)",
			tooBig, hash, err)
	}
	status, _, _ = doHTTP(t, http.MethodHead, b.URL+"/"+hash, nil, nil)
	if status != http.StatusNotFound {
		t.Fatalf("HEAD /%s after a rejected upload: status %d, want 404", hash, status)
	}
}

// TestBlossomUploadSizeCapSurvivesWebsocketHeader: an Upload request that
// carries Upgrade: websocket cannot bypass the upload cap. If the guard sits
// below the websocket early-return, the request is passed straight to khatru,
// which allocates from the announced Content-Length before any hook and never
// answers this 413.
func TestBlossomUploadSizeCapSurvivesWebsocketHeader(t *testing.T) {
	b := newBlobRelay(t)

	tooBig := config.DefaultBlobMaxBytes + 1
	sum := sha256.New()
	if _, err := io.CopyN(sum, zeroReader{}, tooBig); err != nil {
		t.Fatalf("hashing the oversized body: %v", err)
	}
	hash := hex.EncodeToString(sum.Sum(nil))

	// No body is written: with the guard in place it is never read, and even
	// if it were, khatru would reject the anonymous request after its
	// allocation, so the response cannot be this 413.
	req := httptest.NewRequest(http.MethodPut, "/upload", nil)
	req.ContentLength = tooBig
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	b.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PUT /upload with Upgrade: websocket (%d bytes): status %d, want 413 (body %q)",
			tooBig, rec.Code, rec.Body.String())
	}
	wantReason := fmt.Sprintf("blocked: blob exceeds %d bytes", config.DefaultBlobMaxBytes)
	if reason := rec.Header().Get("X-Reason"); reason != wantReason {
		t.Fatalf("PUT /upload with Upgrade: websocket (%d bytes): X-Reason %q, want %q",
			tooBig, reason, wantReason)
	}
	if _, err := os.Stat(b.blobPath(hash)); !os.IsNotExist(err) {
		t.Fatalf("PUT /upload with Upgrade: websocket (%d bytes): blob %s exists after rejection (stat err %v)",
			tooBig, hash, err)
	}
}

// TestBlossomRejectsNonAllowlistedUploader: NIP-42/Blossom authentication
// alone grants nothing; only SCRUTINY_ALLOWED_PUBKEYS may upload.
func TestBlossomRejectsNonAllowlistedUploader(t *testing.T) {
	b := newBlobRelay(t)

	body := []byte("sybil upload must never be stored")
	hash := hashHex(t, body)
	status, raw := b.putBlob(t, nostr.Generate(), body, "text/plain")
	if status != http.StatusForbidden {
		t.Fatalf("PUT /upload as a non-allowlisted key: status %d, want 403 (body %q)", status, raw)
	}
	if _, err := os.Stat(b.blobPath(hash)); !os.IsNotExist(err) {
		t.Fatalf("PUT /upload as a non-allowlisted key: blob %s exists (stat err %v)", hash, err)
	}
	status, _, _ = doHTTP(t, http.MethodHead, b.URL+"/"+hash, nil, nil)
	if status != http.StatusNotFound {
		t.Fatalf("HEAD /%s after a rejected upload: status %d, want 404", hash, status)
	}
}

// TestBlossomDeleteAlwaysRejected: blobs are as permanent as the events citing
// them, so DELETE is refused and the blob stays served.
func TestBlossomDeleteAlwaysRejected(t *testing.T) {
	b := newBlobRelay(t)

	body := []byte("permanent artifact\n")
	desc := b.uploadOK(t, b.publisher, body, "text/plain")

	status, _, raw := doHTTP(t, http.MethodDelete, b.URL+"/"+desc.SHA256, nil, map[string]string{
		"Authorization": blossomAuth(t, b.publisher, "delete", desc.SHA256),
	})
	if status != http.StatusForbidden {
		t.Fatalf("DELETE /%s: status %d, want 403 (body %q)", desc.SHA256, status, raw)
	}

	status, _, raw = doHTTP(t, http.MethodGet, b.URL+"/"+desc.SHA256, nil, nil)
	if status != http.StatusOK {
		t.Fatalf("GET /%s after DELETE: status %d, want 200 (body %q)", desc.SHA256, status, raw)
	}
	if !bytes.Equal(raw, body) {
		t.Fatalf("GET /%s after DELETE: body %q, want %q", desc.SHA256, raw, body)
	}
}

// TestBlossomUnsupportedRoutes: the blob directory is not a public listing
// endpoint (§9.4 keeps the index out of the event store, serves no /list) and
// the BUD routes the relay does not wire (/mirror, /media, /report) are 404
// before they can reach a handler that dereferences an absent store.
func TestBlossomUnsupportedRoutes(t *testing.T) {
	b := newBlobRelay(t)

	b.uploadOK(t, b.publisher, []byte("listed nowhere"), "text/plain")

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/list/" + b.publisher.Public().Hex()},
		{http.MethodPut, "/mirror"},
		{http.MethodGet, "/media"},
		{http.MethodPut, "/report"},
	}
	for _, tc := range cases {
		status, _, raw := doHTTP(t, tc.method, b.URL+tc.path, nil, nil)
		if status != http.StatusNotFound {
			t.Fatalf("%s %s: status %d, want 404 (body %q)", tc.method, tc.path, status, raw)
		}
	}
}

// TestBlossomServesByHash pins the read surface: GET/HEAD by hash with any
// extension, attachment disposition and nosniff for non-images, inline for
// PNG, 404 for absent hashes.
func TestBlossomServesByHash(t *testing.T) {
	b := newBlobRelay(t)

	body := []byte("# scrutiny artifact\n\nserved by hash, not by extension\n")
	desc := b.uploadOK(t, b.publisher, body, "text/markdown")

	// GET without an extension, and with a requested extension used only for
	// the filename (the hash is the lookup key). PDF and HTML are the
	// active/opaque document cases: both must be attachments.
	for _, path := range []string{
		"/" + desc.SHA256,
		"/" + desc.SHA256 + ".pdf",
		"/" + desc.SHA256 + ".html",
		"/" + desc.SHA256 + ".zip",
	} {
		status, hdr, raw := doHTTP(t, http.MethodGet, b.URL+path, nil, nil)
		if status != http.StatusOK {
			t.Fatalf("GET %s: status %d, want 200 (body %q)", path, status, raw)
		}
		if !bytes.Equal(raw, body) {
			t.Fatalf("GET %s: body %q, want the uploaded bytes", path, raw)
		}
		cd := hdr.Get("Content-Disposition")
		if !strings.HasPrefix(cd, "attachment") {
			t.Fatalf("GET %s: Content-Disposition = %q, want an attachment", path, cd)
		}
		if !strings.Contains(cd, desc.SHA256) {
			t.Fatalf("GET %s: Content-Disposition = %q, want the sha256 in the filename", path, cd)
		}
		if got := hdr.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("GET %s: X-Content-Type-Options = %q, want nosniff", path, got)
		}
	}

	// HEAD is unauthenticated, works for both shapes, and carries the size.
	for _, path := range []string{"/" + desc.SHA256, "/" + desc.SHA256 + ".pdf"} {
		status, length := headBlob(t, b.URL+path)
		if status != http.StatusOK {
			t.Fatalf("HEAD %s: status %d, want 200", path, status)
		}
		if length != int64(len(body)) {
			t.Fatalf("HEAD %s: Content-Length = %d, want %d", path, length, len(body))
		}
	}

	// Absent hashes are 404 on both methods.
	absent := strings.Repeat("a", 64)
	status, _, _ := doHTTP(t, http.MethodGet, b.URL+"/"+absent, nil, nil)
	if status != http.StatusNotFound {
		t.Fatalf("GET /%s: status %d, want 404", absent, status)
	}
	status, _ = headBlob(t, b.URL+"/"+absent)
	if status != http.StatusNotFound {
		t.Fatalf("HEAD /%s: status %d, want 404", absent, status)
	}

	// Images stay inline: the 8-byte PNG signature is enough for both the MIME
	// sniff and the inline decision.
	png := []byte("\x89PNG\r\n\x1a\n")
	pngDesc := b.uploadOK(t, b.publisher, png, "image/png")
	if !strings.HasPrefix(pngDesc.Type, "image/png") {
		t.Fatalf("PUT /upload (png): descriptor type = %q, want image/png", pngDesc.Type)
	}
	status, hdr, raw := doHTTP(t, http.MethodGet, b.URL+"/"+pngDesc.SHA256+".png", nil, nil)
	if status != http.StatusOK {
		t.Fatalf("GET /%s.png: status %d, want 200 (body %q)", pngDesc.SHA256, status, raw)
	}
	if !bytes.Equal(raw, png) {
		t.Fatalf("GET /%s.png: body %q, want the PNG bytes", pngDesc.SHA256, raw)
	}
	if ct := hdr.Get("Content-Type"); !strings.HasPrefix(ct, "image/png") {
		t.Fatalf("GET /%s.png: Content-Type = %q, want image/png", pngDesc.SHA256, ct)
	}
	if cd := hdr.Get("Content-Disposition"); !strings.HasPrefix(cd, "inline") {
		t.Fatalf("GET /%s.png: Content-Disposition = %q, want inline", pngDesc.SHA256, cd)
	}
}

// TestBlossomUploadLeavesNoEventInStore: the blob directory is the index, so
// no kind-24242 record may ever be served by REQ.
func TestBlossomUploadLeavesNoEventInStore(t *testing.T) {
	b := newBlobRelay(t)
	b.uploadOK(t, b.publisher, []byte("no event may cite this upload"), "text/plain")

	wsURL := "ws" + strings.TrimPrefix(b.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dialing the relay: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")
	client := &wsClient{t: t, ctx: ctx, conn: conn}
	client.expectEagerChallenge()

	client.send(nostr.ReqEnvelope{
		SubscriptionID: "blossom-auth-events",
		Filters:        []nostr.Filter{{Kinds: []nostr.Kind{24242}}},
	})
	if events := client.readUntilEOSE(); len(events) != 0 {
		t.Fatalf("REQ kinds:[24242] after a Blossom upload returned %d events, want 0", len(events))
	}
}

// TestBlossomCoexistsWithLandingAndOpsEndpoints: Blossom's catch-all "/" must
// not shadow the landing page, /healthz or /metrics, and the upload counters
// must move.
func TestBlossomCoexistsWithLandingAndOpsEndpoints(t *testing.T) {
	b := newBlobRelay(t)

	status, _, raw := doHTTP(t, http.MethodGet, b.URL+"/", nil, nil)
	if status != http.StatusOK {
		t.Fatalf("GET / (landing page): status %d, want 200 (body %q)", status, raw)
	}
	if !bytes.Contains(bytes.ToLower(raw), []byte("scrutiny")) {
		t.Fatalf("GET / (landing page): body %q does not mention scrutiny", raw)
	}

	status, _, raw = doHTTP(t, http.MethodGet, b.URL+"/healthz", nil, nil)
	if status != http.StatusOK {
		t.Fatalf("GET /healthz: status %d, want 200 (body %q)", status, raw)
	}

	type snapshot struct {
		BlobsTotal     int64 `json:"blobs_total"`
		BlobBytesTotal int64 `json:"blob_bytes_total"`
	}
	readSnapshot := func() snapshot {
		t.Helper()
		status, _, raw := doHTTP(t, http.MethodGet, b.URL+"/metrics", nil, nil)
		if status != http.StatusOK {
			t.Fatalf("GET /metrics: status %d, want 200 (body %q)", status, raw)
		}
		var s snapshot
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("GET /metrics: decoding %q: %v", raw, err)
		}
		return s
	}

	if before := readSnapshot(); before.BlobsTotal != 0 || before.BlobBytesTotal != 0 {
		t.Fatalf("GET /metrics before the upload: blobs_total=%d blob_bytes_total=%d, want 0/0",
			before.BlobsTotal, before.BlobBytesTotal)
	}

	const size = 64*1024 + 1
	b.uploadOK(t, b.publisher, make([]byte, size), "application/octet-stream")

	after := readSnapshot()
	if after.BlobsTotal != 1 {
		t.Fatalf("GET /metrics after one upload: blobs_total=%d, want 1", after.BlobsTotal)
	}
	if after.BlobBytesTotal != int64(size) {
		t.Fatalf("GET /metrics after one upload: blob_bytes_total=%d, want %d", after.BlobBytesTotal, size)
	}

	// Guard the exact counter names the ops surface documents.
	_, _, raw = doHTTP(t, http.MethodGet, b.URL+"/metrics", nil, nil)
	for _, key := range []string{"blobs_total", "blob_bytes_total"} {
		if !bytes.Contains(raw, []byte(key)) {
			t.Fatalf("GET /metrics: response %s does not carry %q", raw, key)
		}
	}
}
