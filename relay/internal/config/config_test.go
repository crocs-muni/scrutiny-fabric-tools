package config

import (
	"path/filepath"
	"strings"
	"testing"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip19"
)

// These tests never touch the network or the filesystem: FromEnv only reads
// the provided lookup function.

func baseEnv() map[string]string {
	return map[string]string{
		EnvServiceURL:     "wss://relay.example.com",
		EnvAllowedPubkeys: strings.Repeat("ab", 32),
	}
}

func mustLoad(t *testing.T, env map[string]string) Config {
	t.Helper()
	cfg, err := FromEnv(LookupFromMap(env))
	if err != nil {
		t.Fatalf("FromEnv() returned an unexpected error: %v", err)
	}
	return cfg
}

func TestFromEnvDefaults(t *testing.T) {
	cfg := mustLoad(t, baseEnv())

	if cfg.ListenAddr != DefaultListenAddr {
		t.Errorf("ListenAddr = %q, want %q", cfg.ListenAddr, DefaultListenAddr)
	}
	if cfg.ServiceURL != "wss://relay.example.com" {
		t.Errorf("ServiceURL = %q", cfg.ServiceURL)
	}
	if cfg.DataDir != DefaultDataDir {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, DefaultDataDir)
	}
	if want := filepath.Join(DefaultDataDir, "base.bolt"); cfg.BaseDBPath != want {
		t.Errorf("BaseDBPath = %q, want %q", cfg.BaseDBPath, want)
	}
	if want := filepath.Join(DefaultDataDir, "search"); cfg.SearchIndexPath != want {
		t.Errorf("SearchIndexPath = %q, want %q", cfg.SearchIndexPath, want)
	}
	if cfg.MaxQueryLimit != DefaultMaxQueryLimit {
		t.Errorf("MaxQueryLimit = %d, want %d", cfg.MaxQueryLimit, DefaultMaxQueryLimit)
	}
	if cfg.RelayName != DefaultRelayName {
		t.Errorf("RelayName = %q, want %q", cfg.RelayName, DefaultRelayName)
	}
	if cfg.RelayDescription == "" {
		t.Error("RelayDescription default must not be empty")
	}
	if len(cfg.AllowedPubkeys) != 1 {
		t.Fatalf("AllowedPubkeys = %d entries, want 1", len(cfg.AllowedPubkeys))
	}
	if got := cfg.AllowedPubkeys[0].Hex(); got != strings.Repeat("ab", 32) {
		t.Errorf("AllowedPubkeys[0] = %s", got)
	}
}

// TestFromEnvDefaultVocabulary covers the settled default tag set: the
// canonical values plus the -test/-pilot/-demo twins.
func TestFromEnvDefaultVocabulary(t *testing.T) {
	cfg := mustLoad(t, baseEnv())

	got := make(map[string]bool, len(cfg.AcceptedTags))
	for _, tag := range cfg.AcceptedTags {
		got[tag] = true
	}

	want := []string{
		"scrutiny-fabric",
		"scrutiny-v0.8.1",
		"scrutiny-product",
		"scrutiny-metadata",
		"scrutiny-binding",
		"scrutiny-patch",
		"scrutiny-fabric-test",
		"scrutiny-fabric-pilot",
		"scrutiny-fabric-demo",
		"scrutiny-product-test",
		"scrutiny-metadata-pilot",
		"scrutiny-binding-demo",
		"scrutiny-patch-test",
		"scrutiny-v0.8.1-test",
	}
	for _, tag := range want {
		if !got[tag] {
			t.Errorf("default accepted tags are missing %q", tag)
		}
	}
	if wantLen := len(DefaultAcceptedTags()); len(cfg.AcceptedTags) != wantLen {
		t.Errorf("AcceptedTags = %d entries, want %d", len(cfg.AcceptedTags), wantLen)
	}
}

func TestFromEnvPubkeys(t *testing.T) {
	pk := nostr.Generate().Public()

	t.Run("hex and npub together", func(t *testing.T) {
		env := baseEnv()
		env[EnvAllowedPubkeys] = pk.Hex() + ", " + nip19.EncodeNpub(pk) + ","
		cfg := mustLoad(t, env)
		// the same key twice must collapse
		if len(cfg.AllowedPubkeys) != 1 {
			t.Fatalf("AllowedPubkeys = %d entries, want 1", len(cfg.AllowedPubkeys))
		}
		if cfg.AllowedPubkeys[0] != pk {
			t.Errorf("AllowedPubkeys[0] = %s, want %s", cfg.AllowedPubkeys[0].Hex(), pk.Hex())
		}
	})

	t.Run("npub with a broken checksum", func(t *testing.T) {
		env := baseEnv()
		env[EnvAllowedPubkeys] = breakBech32(nip19.EncodeNpub(pk))
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Fatal("expected an error for an invalid npub")
		} else if !strings.Contains(err.Error(), EnvAllowedPubkeys) {
			t.Errorf("error %q does not mention %s", err, EnvAllowedPubkeys)
		}
	})

	t.Run("not hex and not npub", func(t *testing.T) {
		env := baseEnv()
		env[EnvAllowedPubkeys] = "definitely-not-a-pubkey"
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Fatal("expected an error for a non-pubkey entry")
		}
	})

	t.Run("empty list", func(t *testing.T) {
		env := baseEnv()
		env[EnvAllowedPubkeys] = " , "
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Fatal("expected an error for an empty allowlist")
		}
	})

	t.Run("missing", func(t *testing.T) {
		env := baseEnv()
		delete(env, EnvAllowedPubkeys)
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Fatal("expected an error when the allowlist is missing")
		}
	})
}

func TestFromEnvServiceURL(t *testing.T) {
	t.Run("required", func(t *testing.T) {
		env := baseEnv()
		delete(env, EnvServiceURL)
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Fatal("expected an error when the service url is missing")
		}
	})

	t.Run("trailing slash is trimmed", func(t *testing.T) {
		env := baseEnv()
		env[EnvServiceURL] = "wss://relay.example.com/"
		cfg := mustLoad(t, env)
		if cfg.ServiceURL != "wss://relay.example.com" {
			t.Errorf("ServiceURL = %q", cfg.ServiceURL)
		}
	})

	for _, bad := range []string{"relay.example.com", "ftp://relay.example.com", "https://relay.example.com", "wss://", "wss://relay.example.com?x=1"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			env := baseEnv()
			env[EnvServiceURL] = bad
			if _, err := FromEnv(LookupFromMap(env)); err == nil {
				t.Fatalf("expected an error for %q", bad)
			}
		})
	}
}

func TestFromEnvListenAddr(t *testing.T) {
	for _, bad := range []string{"3334", "localhost", ":0", ":99999", "::1:3334"} {
		env := baseEnv()
		env[EnvListenAddr] = bad
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Errorf("expected an error for listen address %q", bad)
		}
	}

	env := baseEnv()
	env[EnvListenAddr] = "127.0.0.1:7777"
	if cfg := mustLoad(t, env); cfg.ListenAddr != "127.0.0.1:7777" {
		t.Errorf("ListenAddr = %q", cfg.ListenAddr)
	}
}

func TestFromEnvAcceptedTagsOverride(t *testing.T) {
	t.Run("override", func(t *testing.T) {
		env := baseEnv()
		env[EnvAcceptedTags] = " scrutiny-fabric , scrutiny-product-test ,, "
		cfg := mustLoad(t, env)
		if len(cfg.AcceptedTags) != 2 {
			t.Fatalf("AcceptedTags = %v, want exactly 2 entries", cfg.AcceptedTags)
		}
		if cfg.AcceptedTags[0] != "scrutiny-fabric" || cfg.AcceptedTags[1] != "scrutiny-product-test" {
			t.Errorf("AcceptedTags = %v", cfg.AcceptedTags)
		}
	})

	t.Run("set but empty", func(t *testing.T) {
		env := baseEnv()
		env[EnvAcceptedTags] = " , "
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Fatal("expected an error for an empty tag list")
		}
	})
}

func TestFromEnvDataDir(t *testing.T) {
	env := baseEnv()
	env[EnvDataDir] = filepath.Join("srv", "scrutiny")
	cfg := mustLoad(t, env)

	if want := filepath.Join("srv", "scrutiny", "base.bolt"); cfg.BaseDBPath != want {
		t.Errorf("BaseDBPath = %q, want %q", cfg.BaseDBPath, want)
	}
	if want := filepath.Join("srv", "scrutiny", "search"); cfg.SearchIndexPath != want {
		t.Errorf("SearchIndexPath = %q, want %q", cfg.SearchIndexPath, want)
	}
}

func TestFromEnvMaxQueryLimit(t *testing.T) {
	for _, bad := range []string{"zero", "0", "-3"} {
		env := baseEnv()
		env[EnvMaxQueryLimit] = bad
		if _, err := FromEnv(LookupFromMap(env)); err == nil {
			t.Errorf("expected an error for max query limit %q", bad)
		}
	}

	env := baseEnv()
	env[EnvMaxQueryLimit] = "1000"
	if cfg := mustLoad(t, env); cfg.MaxQueryLimit != 1000 {
		t.Errorf("MaxQueryLimit = %d, want 1000", cfg.MaxQueryLimit)
	}
}

func TestPathsFromEnv(t *testing.T) {
	paths, err := PathsFromEnv(LookupFromMap(nil))
	if err != nil {
		t.Fatalf("PathsFromEnv() error = %v", err)
	}
	if paths.DataDir != DefaultDataDir {
		t.Errorf("DataDir = %q, want %q", paths.DataDir, DefaultDataDir)
	}
}

// breakBech32 flips the last character of a bech32 string to invalidate its
// checksum while keeping the alphabet valid.
func breakBech32(s string) string {
	b := []byte(s)
	last := len(b) - 1
	if b[last] == 'q' {
		b[last] = 'p'
	} else {
		b[last] = 'q'
	}
	return string(b)
}
