// Package config loads the relay configuration from environment variables.
//
// The configuration is deliberately boring and explicit: the whole pilot relay
// is describable from the SCRUTINY_* environment of the process, with no
// config files and no hidden defaults beyond the documented ones.
package config

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip19"
)

// Environment variable names.
const (
	EnvListenAddr        = "SCRUTINY_LISTEN_ADDR"
	EnvServiceURL        = "SCRUTINY_SERVICE_URL"
	EnvDataDir           = "SCRUTINY_DATA_DIR"
	EnvAllowedPubkeys    = "SCRUTINY_ALLOWED_PUBKEYS"
	EnvAcceptedTags      = "SCRUTINY_ACCEPTED_TAGS"
	EnvRelayName         = "SCRUTINY_RELAY_NAME"
	EnvRelayDescription  = "SCRUTINY_RELAY_DESCRIPTION"
	EnvRelayContact      = "SCRUTINY_RELAY_CONTACT"
	EnvMaxQueryLimit     = "SCRUTINY_MAX_QUERY_LIMIT"
	EnvMaxEventPastAge   = "SCRUTINY_MAX_EVENT_PAST_AGE"
	EnvTrustedProxyCIDRs = "SCRUTINY_TRUSTED_PROXY_CIDRS"
)

// Defaults.
const (
	DefaultListenAddr    = ":3334"
	DefaultDataDir       = "data"
	DefaultMaxQueryLimit = 500
	DefaultRelayName     = "scrutiny-fabric relay"

	// DefaultRelayContact is the NIP-11 contact published with the relay when
	// SCRUTINY_RELAY_CONTACT is not set.
	DefaultRelayContact = "<operator-email>"

	// DefaultMaxEventPastAge is how far back an accepted event's created_at may
	// lie. Short on purpose (fresh live writes); widened temporarily on the
	// mirror host during backfills via SCRUTINY_MAX_EVENT_PAST_AGE.
	DefaultMaxEventPastAge = 2 * time.Hour
)

// DefaultRelayDescription is the NIP-11 description used when
// SCRUTINY_RELAY_DESCRIPTION is not set. It states the write policy so that
// clients that never read PostingPolicy still see it.
const DefaultRelayDescription = "Pilot relay for the scrutiny-fabric vocabulary. " +
	"Reads are open; writes require NIP-42 authentication from an allowlisted publisher. " +
	"Only kind 1 notes carrying an accepted scrutiny t tag and kind 5 deletion requests are accepted. " +
	"Deletion requests are stored and served but never acted upon (DEL-11): no event is ever deleted, " +
	"so NIP-9 is not implemented and not advertised."

// CanonicalVocabularyTags are the canonical t tag values of the scrutiny
// vocabulary as settled for the pilot.
var CanonicalVocabularyTags = []string{
	"scrutiny-fabric",
	"scrutiny-v0.8.1",
	"scrutiny-product",
	"scrutiny-metadata",
	"scrutiny-binding",
	"scrutiny-patch",
}

// DemoTwinSuffixes are the suffixes the team publishes demo/pilot/test mirrors
// of the canonical values under (for example scrutiny-fabric-test).
var DemoTwinSuffixes = []string{"-test", "-pilot", "-demo"}

// DefaultAcceptedTags returns the canonical vocabulary values plus one twin per
// demo suffix, i.e. scrutiny-fabric, scrutiny-fabric-test, scrutiny-fabric-pilot,
// scrutiny-fabric-demo, and so on for every canonical value.
func DefaultAcceptedTags() []string {
	out := make([]string, 0, len(CanonicalVocabularyTags)*(1+len(DemoTwinSuffixes)))
	for _, base := range CanonicalVocabularyTags {
		out = append(out, base)
		for _, suffix := range DemoTwinSuffixes {
			out = append(out, base+suffix)
		}
	}
	return out
}

// Paths are the on-disk locations derived from SCRUTINY_DATA_DIR.
type Paths struct {
	DataDir         string
	BaseDBPath      string
	SearchIndexPath string
}

// PathsFromEnv derives the on-disk paths. It is also what the `reindex`
// subcommand uses, so maintenance does not require the full relay
// configuration (service URL, allowlist, ...).
func PathsFromEnv(lookup func(string) (string, bool)) (Paths, error) {
	dataDir := DefaultDataDir
	if raw, ok := lookup(EnvDataDir); ok && strings.TrimSpace(raw) != "" {
		dataDir = strings.TrimSpace(raw)
	}

	return Paths{
		DataDir:         dataDir,
		BaseDBPath:      filepath.Join(dataDir, "base.bolt"),
		SearchIndexPath: filepath.Join(dataDir, "search"),
	}, nil
}

// Config is the fully parsed and validated relay configuration.
type Config struct {
	Paths

	// ListenAddr is the host:port the HTTP server binds to.
	ListenAddr string

	// ServiceURL is the public relay URL used as the relay tag of the NIP-42
	// challenge (it must survive being behind a reverse proxy). It is empty
	// only for local/test setups, where khatru derives it from the request.
	ServiceURL string

	// AllowedPubkeys is the pilot publishing allowlist. Never empty.
	AllowedPubkeys []nostr.PubKey

	// AcceptedTags are the t tag values accepted on kind 1 events.
	AcceptedTags []string

	RelayName        string
	RelayDescription string
	RelayContact     string

	// MaxQueryLimit caps how many stored events one filter may return.
	MaxQueryLimit int

	// MaxEventPastAge is the freshness window for event created_at: an event
	// older than this (relative to relay receipt time) is rejected as too old.
	// The write path is independently allowlist-gated, so a temporary widen
	// only relaxes freshness for allowlisted publishers.
	MaxEventPastAge time.Duration

	// TrustedProxyCIDRs lists the network ranges whose transport peer may set
	// X-Forwarded-For. Every other peer has its XFF deleted, so the per-IP
	// rate limiters always key on the real socket address of untrusted peers.
	// Empty means only loopback is trusted (direct-exposure deployments).
	TrustedProxyCIDRs []*net.IPNet
}

// Load reads the configuration from the process environment.
func Load() (Config, error) {
	return FromEnv(os.LookupEnv)
}

// FromEnv parses and validates the configuration. lookup follows the
// os.LookupEnv contract; a map-backed function makes this testable.
func FromEnv(lookup func(string) (string, bool)) (Config, error) {
	var cfg Config

	paths, err := PathsFromEnv(lookup)
	if err != nil {
		return cfg, err
	}
	cfg.Paths = paths

	get := func(key, def string) string {
		if v, ok := lookup(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}

	cfg.ListenAddr = get(EnvListenAddr, DefaultListenAddr)
	if err := validateListenAddr(cfg.ListenAddr); err != nil {
		return cfg, err
	}

	rawServiceURL, ok := lookup(EnvServiceURL)
	if !ok || strings.TrimSpace(rawServiceURL) == "" {
		return cfg, fmt.Errorf("%s is required: the public relay URL used as the NIP-42 challenge relay tag, e.g. wss://relay.example.com", EnvServiceURL)
	}
	cfg.ServiceURL, err = normalizeServiceURL(rawServiceURL)
	if err != nil {
		return cfg, err
	}

	rawKeys, _ := lookup(EnvAllowedPubkeys)
	cfg.AllowedPubkeys, err = parsePubkeyList(rawKeys)
	if err != nil {
		return cfg, err
	}
	if len(cfg.AllowedPubkeys) == 0 {
		return cfg, fmt.Errorf("%s must list at least one publisher pubkey (64 hex chars or npub1...)", EnvAllowedPubkeys)
	}

	if rawTags, ok := lookup(EnvAcceptedTags); ok {
		cfg.AcceptedTags = splitCSV(rawTags)
		if len(cfg.AcceptedTags) == 0 {
			return cfg, fmt.Errorf("%s is set but lists no t tag values", EnvAcceptedTags)
		}
	} else {
		cfg.AcceptedTags = DefaultAcceptedTags()
	}

	cfg.RelayName = get(EnvRelayName, DefaultRelayName)
	cfg.RelayDescription = get(EnvRelayDescription, DefaultRelayDescription)
	cfg.RelayContact = get(EnvRelayContact, DefaultRelayContact)

	cfg.MaxQueryLimit = DefaultMaxQueryLimit
	if raw, ok := lookup(EnvMaxQueryLimit); ok && strings.TrimSpace(raw) != "" {
		n, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("%s: %q is not a positive integer", EnvMaxQueryLimit, raw)
		}
		cfg.MaxQueryLimit = n
	}

	cfg.MaxEventPastAge = DefaultMaxEventPastAge
	if raw, ok := lookup(EnvMaxEventPastAge); ok && strings.TrimSpace(raw) != "" {
		d, err := time.ParseDuration(strings.TrimSpace(raw))
		if err != nil || d <= 0 {
			return cfg, fmt.Errorf("%s: %q is not a positive duration (e.g. 2h, 48h, 30m)", EnvMaxEventPastAge, raw)
		}
		cfg.MaxEventPastAge = d
	}

	cfg.TrustedProxyCIDRs, err = parseTrustedProxyCIDRs(lookup)
	if err != nil {
		return cfg, err
	}

	return cfg, nil
}

// parseTrustedProxyCIDRs reads SCRUTINY_TRUSTED_PROXY_CIDRS, a comma-separated
// list of IP ranges (CIDR or a bare IP, which means its /32 or /128). An unset
// or empty variable yields nil: only loopback may set X-Forwarded-For.
func parseTrustedProxyCIDRs(lookup func(string) (string, bool)) ([]*net.IPNet, error) {
	raw, ok := lookup(EnvTrustedProxyCIDRs)
	if !ok || strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("%s: %q is not an IP address or CIDR range", EnvTrustedProxyCIDRs, part)
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			part = fmt.Sprintf("%s/%d", ip.String(), bits)
		}
		_, cidr, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("%s: %q is not an IP address or CIDR range", EnvTrustedProxyCIDRs, part)
		}
		out = append(out, cidr)
	}
	return out, nil
}

// TrustedProxyChecker returns a function deciding whether the transport peer
// of a request may supply a client identity through X-Forwarded-For. The
// allowlist is the parsed TrustedProxyCIDRs; when the list is empty only
// loopback peers are trusted. A direct client (not behind the configured
// reverse proxy) gets its XFF deleted, so the per-IP rate limiters key on its
// real socket address: a private-range peer can no longer forge a limiter
// identity just by connecting from inside the same network.
func (c Config) TrustedProxyChecker() func(*http.Request) bool {
	cidrs := c.TrustedProxyCIDRs
	return func(r *http.Request) bool {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr // tolerate a bare IP; net/http always sends host:port
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return false
		}
		if ip.IsLoopback() {
			return true
		}
		for _, n := range cidrs {
			if n.Contains(ip) {
				return true
			}
		}
		return false
	}
}

// LookupFromMap adapts a map to the lookup function shape used by FromEnv.
func LookupFromMap(env map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}
}

func validateListenAddr(addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%s: %q is not a valid host:port address: %w", EnvListenAddr, addr, err)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("%s: %q is not a valid port (want 1-65535)", EnvListenAddr, addr)
	}
	return nil
}

func normalizeServiceURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("%s: %q is not a valid URL: %w", EnvServiceURL, raw, err)
	}
	switch u.Scheme {
	case "ws", "wss":
	default:
		return "", fmt.Errorf("%s: %q must use ws:// or wss://", EnvServiceURL, raw)
	}
	if u.Host == "" {
		return "", fmt.Errorf("%s: %q has no host", EnvServiceURL, raw)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%s: %q must not carry a query or fragment", EnvServiceURL, raw)
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

// parsePubkeyList parses a comma-separated list of hex or npub1... pubkeys.
// Empty entries are skipped, duplicates are collapsed.
func parsePubkeyList(raw string) ([]nostr.PubKey, error) {
	var out []nostr.PubKey
	seen := make(map[nostr.PubKey]struct{})
	for i, part := range strings.Split(raw, ",") {
		entry := strings.TrimSpace(part)
		if entry == "" {
			continue
		}
		pk, err := parsePubkey(entry)
		if err != nil {
			return nil, fmt.Errorf("%s: entry %d (%q): %w", EnvAllowedPubkeys, i+1, entry, err)
		}
		if _, dup := seen[pk]; dup {
			continue
		}
		seen[pk] = struct{}{}
		out = append(out, pk)
	}
	return out, nil
}

func parsePubkey(entry string) (nostr.PubKey, error) {
	if strings.HasPrefix(entry, "npub1") {
		prefix, value, err := nip19.Decode(entry)
		if err != nil {
			return nostr.ZeroPK, fmt.Errorf("invalid npub: %w", err)
		}
		pk, ok := value.(nostr.PubKey)
		if !ok || prefix != "npub" {
			return nostr.ZeroPK, fmt.Errorf("bech32 payload is not a npub pubkey")
		}
		return pk, nil
	}

	pk, err := nostr.PubKeyFromHex(entry)
	if err != nil {
		return nostr.ZeroPK, fmt.Errorf("invalid hex pubkey: %w", err)
	}
	return pk, nil
}

// splitCSV splits a comma-separated list, trimming whitespace and dropping
// empty entries.
func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if entry := strings.TrimSpace(part); entry != "" {
			out = append(out, entry)
		}
	}
	return out
}
