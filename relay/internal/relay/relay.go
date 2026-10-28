// Package relay assembles the complete relay (configuration + stores + gates +
// metrics) into a single http.Handler (Bundle.Handler) that serves the khatru
// relay behind the transport-level hardening (see Hardened).
//
// The assembly lives here instead of in cmd/relay/main.go so that the binary
// and the integration test build the exact same wiring and mount the same
// handler.
package relay

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"log"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/eventstore"
	"fiatjaf.com/nostr/khatru"
	"fiatjaf.com/nostr/khatru/policies"
	"fiatjaf.com/nostr/nip11"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/gate"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/metrics"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/store"
)

// Version is reported in NIP-11.
const Version = "0.1.0-pilot"

// Write policy knobs. The NIP-11 PostingPolicy and the gate chain below are
// built from these (and cfg.MaxEventPastAge, the freshness window, which is
// env-configurable so backfills can widen it without a rebuild) so they
// cannot drift apart.
const (
	maxContentBytes  = 256 * 1024
	maxFutureAge     = 15 * time.Minute
	maxIndexableTags = 64
	maxAuthedPubkeys = 128

	// maxMessageBytes is the websocket frame cap enforced by khatru
	// (Relay.MaxMessageSize) and advertised as limitation.max_message_length.
	maxMessageBytes = 512000
)

// Rate limits. These are deliberately generous DDoS ceilings, not user
// throttles: a NAT'd lab of lens clients plus our own tunnel walks must never
// hit them. The khatru limiters exempt loopback; the search limiter does not.
const (
	// connectionRate* wire policies.ConnectionRateLimiter to RejectConnection:
	// the DDoS ceiling on new connections per IP (600 up front, then 30/10s).
	connectionRateTokens   = 30
	connectionRateInterval = 10 * time.Second
	connectionRateBurst    = 600

	// filterRate* wire policies.FilterIPRateLimiter to the request reject hook:
	// the DDoS ceiling on stored-event queries per IP (2000 up front, 600/min).
	filterRateTokens   = 600
	filterRateInterval = time.Minute
	filterRateBurst    = 2000

	// searchRate* are the much tighter per-IP budget for NIP-50 search filters
	// (see searchlimit.go): 120 up front, 30/min. Still a DDoS ceiling.
	searchRateTokens   = 30
	searchRateInterval = time.Minute
	searchRateBurst    = 120
)

// Filter complexity caps. A single REQ filter must not be able to make the
// stores do unbounded per-query work, so authors/ids/tag values are capped.
// The caps sit far above what the fabric pipelines page at (id batches of
// 300-400) and what lens sends (narrow #x tag filters), so only abusive
// single filters are clipped. NIP-11's limitation document has no field for
// them; they are enforced without being advertised.
const (
	maxFilterAuthors   = 400
	maxFilterIDs       = 500
	maxFilterTagValues = 500
)

// filterTooComplexMessage is the CLOSED reason for a filter over the caps
// above. "rejected: " is not one of the magic prefixes khatru's
// NormalizeOKMessage recognizes, so the message reaches the client verbatim.
const filterTooComplexMessage = "rejected: filter too complex"

// maxRequestBodyBytes caps every non-websocket request body handled by
// Hardened. The only non-websocket surfaces are NIP-11 and the ops endpoints;
// none of them takes a body, and khatru sets no cap of its own on HTTP bodies.
// 64 KiB is belt-and-braces, not a working limit.
const maxRequestBodyBytes = 64 * 1024

// nip86DisabledMessage is the one-line comment returned as the 404 body for
// every NIP-86 request. khatru's management handler reads and hashes the
// entire request body (khatru/nip86.go:71) before it looks at the
// Authorization header (khatru/nip86.go:79), so an unauthenticated caller
// could force an unbounded read; and no ManagementAPI method is wired here
// anyway.
const nip86DisabledMessage = "// NIP-86 management API disabled: khatru reads the whole unauthenticated request body before auth (nip86.go:71) and no methods are wired."

// relayInfoPubKey is the fixed operator pubkey advertised in NIP-11 ("pubkey").
const relayInfoPubKey = "c0df886f934aad0c1e62f08b04bd54b44bdd1b5cb0b2ab250cbed25cf64c8a27"

// retentionNote is advertised verbatim under NIP-11 "retention". The pinned
// nip11.RelayRetentionDocument only models purge schedules (time/count/kinds),
// so this prose value is emitted through the document's Malformed escape hatch
// (nip11/easyjson.go). See OverwriteRelayInformation below.
const retentionNote = "none — events are never deleted; kind-5 deletion requests are stored but not honored (DEL-11)"

// Bundle is a fully assembled relay and everything it owns.
type Bundle struct {
	Relay   *khatru.Relay
	Store   *store.Dual
	Metrics *metrics.Metrics

	// cfg is kept so Handler() can build the transport guards from the same
	// parsed configuration the relay was wired from.
	cfg config.Config
}

// Close releases the stores. Call it after the HTTP server has stopped.
func (b *Bundle) Close() {
	if b == nil || b.Store == nil {
		return
	}
	b.Store.Close()
}

// Handler returns the http.Handler to mount: the assembled khatru relay
// behind the transport hardening (Hardened). The binary and the integration
// test both mount this, so they exercise the same HTTP surface.
func (b *Bundle) Handler() http.Handler {
	return Hardened(b.Relay, b.cfg)
}

// Build wires the relay. The returned Bundle must be closed when done.
func Build(cfg config.Config, logger *log.Logger) (*Bundle, error) {
	if logger == nil {
		return nil, errors.New("relay: a logger is required")
	}

	dual, err := store.Open(cfg.BaseDBPath, cfg.SearchIndexPath, logger)
	if err != nil {
		return nil, fmt.Errorf("opening the event stores: %w", err)
	}

	rl := khatru.NewRelay()
	rl.Log = logger

	// The public URL is used as the relay tag of the NIP-42 challenge. It may
	// be empty only in local/test setups, where khatru derives it from the
	// request (khatru/relay.go:176-201).
	rl.ServiceURL = cfg.ServiceURL

	// Send the NIP-42 challenge eagerly on connect, so slow signers (browser
	// NIP-07 extensions) have it ready before the first write. The rejection
	// path sends a fresh challenge as well.
	rl.OnConnect = khatru.RequestAuth

	// Per-connection cap on remembered authenticated pubkeys; the khatru
	// default of 8 is too small for multiplexing clients that rotate keys.
	rl.MaxAuthenticatedClients = maxAuthedPubkeys

	// Pin the websocket frame cap explicitly. khatru's default (512000)
	// equals maxMessageBytes only by coincidence of the pinned revision
	// (khatru/relay.go:55); setting it keeps the enforced cap and the
	// advertised limitation.max_message_length from drifting apart.
	rl.MaxMessageSize = maxMessageBytes

	info := rl.Info
	info.Name = cfg.RelayName
	info.Description = cfg.RelayDescription
	info.Contact = cfg.RelayContact
	info.Software = "github.com/crocs-muni/scrutiny-fabric-tools/relay"
	info.Version = Version

	// Fixed operator pubkey published in NIP-11 ("pubkey").
	infoPK, err := nostr.PubKeyFromHex(relayInfoPubKey)
	if err != nil {
		return nil, fmt.Errorf("relay: built-in NIP-11 pubkey is invalid: %w", err)
	}
	info.PubKey = &infoPK

	// Advertise only limits the relay actually enforces: the websocket frame
	// cap, content length, indexable tag count, the query limit, and the
	// allowlist-gated writes. AuthRequired stays false — reads are open.
	info.Limitation = &nip11.RelayLimitationDocument{
		MaxMessageLength: maxMessageBytes,
		MaxContentLength: maxContentBytes,
		MaxEventTags:     maxIndexableTags,
		MaxLimit:         cfg.MaxQueryLimit,
		RestrictedWrites: true,
		AuthRequired:     false,
	}

	// NIP-50 (search) is served by the bleve index. NIP-9 is deliberately NOT
	// advertised: DEL-11 keeps NIP-09 deletion inert, and khatru adds "9" to
	// supported_nips only when DeleteEvent is wired (khatru/nip11.go:14-16).
	// NIP-45 is not advertised either: no Count/CountHLL hook is wired.
	info.AddSupportedNIPs([]string{"50"})
	// Note: Limitation.AuthRequired is intentionally left false/unset; only
	// writes need auth, so advertising auth on reads would be a lie. The write
	// policy is advertised here instead.
	info.PostingPolicy = fmt.Sprintf(
		"Writes require NIP-42 authentication from an allowlisted publisher. "+
			"Accepted events: kind 1 notes carrying at least one of the t tags [%s], "+
			"and kind 5 deletion requests. Deletion requests are stored and served "+
			"but never acted upon (DEL-11): no event is ever deleted and NIP-9 is not implemented. "+
			"Test/probe events (t:probe burst, label-tagged freshness probes) are retained as test data; they are never re-emitted.",
		strings.Join(cfg.AcceptedTags, ", "))

	// The retention stance is prose, but nip11.RelayRetentionDocument only
	// models numeric purge schedules, so it is emitted through the document's
	// Malformed escape hatch. A fresh map is built per request because the
	// easyjson encoder deletes Malformed keys after emitting them
	// (nip11/easyjson.go:611), which would otherwise drop the field from the
	// second request on.
	rl.OverwriteRelayInformation = func(_ context.Context, _ *http.Request, info nip11.RelayInformationDocument) nip11.RelayInformationDocument {
		info.Malformed = map[string]any{"retention": retentionNote}

		// Never advertise NIP-86: the relay does not serve the management
		// API. Hardened answers every NIP-86 request with 404, because
		// khatru's handler reads and hashes the whole unauthenticated body
		// before its auth check (khatru/nip86.go:71 vs 79) and no
		// ManagementAPI method is wired — advertising it was pure noise.
		// NewRelay seeds supported_nips with 86 (khatru/relay.go:36), so it
		// is filtered out here, preserving order. A fresh slice is allocated
		// because info aliases rl.Info's slice and this hook runs once per
		// NIP-11 request, concurrently.
		kept := make([]any, 0, len(info.SupportedNIPs))
		for _, nip := range info.SupportedNIPs {
			switch v := nip.(type) {
			case int:
				if v == 86 {
					continue
				}
			case string:
				if v == "86" {
					continue
				}
			}
			kept = append(kept, nip)
		}
		info.SupportedNIPs = kept

		return info
	}

	// DDoS ceilings, wired to khatru's connection and filter reject hooks. No
	// EventIPRateLimiter is added: the write path already requires NIP-42 from
	// an allowlisted publisher, so an IP limit there would add nothing.
	rl.RejectConnection = policies.ConnectionRateLimiter(connectionRateTokens, connectionRateInterval, connectionRateBurst)
	searchLimit := newSearchLimiter(searchRateTokens, searchRateInterval, searchRateBurst)
	rl.OnRequest = policies.SeqRequest(
		rejectComplexFilter, // capability cap: over-cap filters spend no limiter token
		searchLimit.reject,  // the tighter NIP-50 budget runs next
		policies.FilterIPRateLimiter(filterRateTokens, filterRateInterval, filterRateBurst),
	)

	m := metrics.New()

	writeGate := gate.Seq(
		gate.NewAuthGate(cfg.AllowedPubkeys),
		gate.Func(policies.PreventLargeContent(maxContentBytes)),
		gate.Func(policies.PreventTimestampsInThePast(cfg.MaxEventPastAge)),
		gate.Func(policies.PreventTimestampsInTheFuture(maxFutureAge)),
		// The indexable-tag cap covers both writable kinds: our own kind-5
		// deletion requests carry e/a tags too, and NIP-11 advertises
		// max_event_tags for every kind.
		gate.Func(policies.PreventTooManyIndexableTags(maxIndexableTags, nil, []nostr.Kind{nostr.KindTextNote, nostr.KindDeletion})),
		gate.NewVocabularyGate(cfg.AcceptedTags),
	)

	rl.OnEvent = func(ctx context.Context, evt nostr.Event) (reject bool, msg string) {
		reject, msg = writeGate.Check(ctx, evt)
		if reject {
			m.EventsRejected.Add(1)
		}
		return reject, msg
	}

	// Reads are never authentication-gated: OnCount stays nil and OnRequest is
	// only the rate-limit chain wired above. Every NIP-01 filter (and NIP-50
	// search) is served without authentication, subject to those DDoS ceilings.

	// Manual hook wiring, on purpose. Do NOT call rl.UseEventstore(...): it
	// wires rl.DeleteEvent to store.DeleteEvent and starts the NIP-40
	// expiration manager (khatru/relay.go:141-174), which would make kind 5
	// events actually delete their targets (khatru/deleting.go:71) and make
	// NIP-11 advertise NIP-9 (khatru/nip11.go:14-16). Both contradict DEL-11.
	// rl.DeleteEvent therefore stays nil, which also short-circuits
	// handleDeleteRequest before it looks at any e/a tag (khatru/deleting.go:20-24).
	rl.QueryStored = func(ctx context.Context, filter nostr.Filter) iter.Seq[nostr.Event] {
		if filter.Search != "" {
			m.QueriesWithSearch.Add(1)
		}
		return dual.QueryEvents(filter, cfg.MaxQueryLimit)
	}
	// No Count hook: NIP-45 is not wired (and must not be advertised). COUNT
	// requests are answered by khatru with CLOSED "unsupported".
	rl.StoreEvent = func(ctx context.Context, evt nostr.Event) error {
		err := dual.SaveEvent(evt)
		m.StoreDrift.Store(dual.Drift())
		switch {
		case err == nil:
			m.EventsStored.Add(1)
		case errors.Is(err, eventstore.ErrDupEvent):
			// the duplicate reaches the client as OK:true, so it is neither a
			// stored event nor a rejection
		default:
			// the client gets OK:false
			m.EventsRejected.Add(1)
		}
		return err
	}
	// Replaceable kinds are not part of the pilot vocabulary (kind 1 and kind 5
	// are both regular), so ReplaceEvent stays unwired.
	// DEL-11: rl.DeleteEvent is deliberately left nil. Nothing ever deletes.

	// Ops endpoints, mounted on khatru's extra router (which is served for
	// every path that is not the relay endpoint itself).
	rl.Router().Handle("/healthz", m.HealthzHandler(dual.Healthy))
	rl.Router().Handle("/metrics", m.Handler())

	// The human-facing landing page at "/": plain HTML, no styling. It does
	// not shadow anything — khatru routes websocket upgrades and NIP-11
	// Accepts before its router (khatru/handlers.go:53-68), so the route is
	// only reached by plain GET requests. The handler reads rl.Info the same
	// way HandleNIP11 does (a copy, then OverwriteRelayInformation) so the
	// page's NIP list matches what clients see.
	rl.Router().Handle("/", NewLandingHandler(cfg, func() nip11.RelayInformationDocument {
		info := *rl.Info
		return rl.OverwriteRelayInformation(context.Background(), nil, info)
	}))

	return &Bundle{Relay: rl, Store: dual, Metrics: m, cfg: cfg}, nil
}

// Hardened wraps a relay handler with the transport-level guards khatru does
// not provide. Mount it in front of the khatru relay (Bundle.Handler does):
//
//	srv.Handler = relay.Hardened(bundle.Relay)
//
// The guards, in order:
//
//  1. X-Forwarded-For is deleted unless the transport peer is loopback or in a
//     private range. khatru's limiters prefer the first global-unicast XFF
//     entry over RemoteAddr (khatru/helpers.go:37-47), so without this any
//     client that can reach the relay directly could forge its per-IP
//     identity. The public ingress is Caddy: it reaches the relay from the
//     docker network (a private peer, trusted) and rewrites XFF to the real
//     peer address; the VM-internal tunnel and local development are
//     private/loopback as well.
//
//  2. NIP-86 requests are refused with 404 before khatru's routing can hand
//     them to its management handler, which reads and hashes the whole request
//     body first and only then checks Authorization (khatru/nip86.go:71 vs
//     79). No ManagementAPI method is wired, so the endpoint would exist only
//     as an unauthenticated unbounded read.
//
//  3. Every non-websocket request body is capped at maxRequestBodyBytes.
//     Websocket upgrades are exempt: their frames are already capped by
//     MaxMessageSize, and the upgrade body is not read by anyone.
func Hardened(next http.Handler, cfg config.Config) http.Handler {
	trusted := cfg.TrustedProxyChecker()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !trusted(r) {
			r.Header.Del("X-Forwarded-For")
		}

		// Ops endpoints are operator-only: answering them from a non-loopback
		// peer would hand every LAN peer (and, behind an any-interface port
		// publish, the whole VM network) the health/error text and the metrics
		// surface. Operators reach them through the documented SSH tunnel
		// (deploy/README.md §7) or a loopback dial inside the VM.
		if isOpsPath(r.URL.Path) && !isLoopbackPeer(r) {
			http.NotFound(w, r)
			return
		}

		// Mirror khatru's routing condition (khatru/handlers.go:54): only the
		// bare token is an upgrade here; anything else is a plain HTTP request
		// and gets the body cap below.
		if r.Header.Get("Upgrade") == "websocket" {
			next.ServeHTTP(w, r)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)

		if isNIP86Request(r) {
			http.Error(w, nip86DisabledMessage, http.StatusNotFound)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// isOpsPath reports whether p is one of the operator-only endpoints registered
// on rl.Router(). Kept in sync with the Build() registrations; an exact-match
// list (no wildcards) so a suffix cannot smuggle a hit.
func isOpsPath(p string) bool {
	return p == "/healthz" || p == "/metrics"
}

// isLoopbackPeer reports whether the transport peer address is loopback.
func isLoopbackPeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isNIP86Request reports whether r is a NIP-86 management request. khatru
// routes on an exact Content-Type match (khatru/handlers.go:62); parsing the
// media type here (parameters stripped, case-insensitive) refuses a superset
// of that, never a subset, so a parameterised content type cannot slip
// through.
func isNIP86Request(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return false
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return false
	}
	return mt == "application/nostr+json+rpc"
}

// rejectComplexFilter is the first OnRequest hook: it caps what one filter may
// ask the stores for. Over-cap filters are refused before either rate limiter
// runs, so they consume no limiter token.
func rejectComplexFilter(_ context.Context, filter nostr.Filter) (bool, string) {
	if len(filter.Authors) > maxFilterAuthors || len(filter.IDs) > maxFilterIDs {
		return true, filterTooComplexMessage
	}
	tagValues := 0
	for _, values := range filter.Tags {
		tagValues += len(values)
	}
	if tagValues > maxFilterTagValues {
		return true, filterTooComplexMessage
	}
	return false, ""
}
