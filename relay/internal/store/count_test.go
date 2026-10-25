package store

import (
	"io"
	"log"
	"path/filepath"
	"testing"

	"fiatjaf.com/nostr"
)

// deletion builds a signed kind-5 request, the second accepted event kind.
func deletion(t *testing.T, sk nostr.SecretKey) nostr.Event {
	t.Helper()
	evt := nostr.Event{
		Kind:      5,
		CreatedAt: 1700000001,
		Tags:      nostr.Tags{{"e", "ab" + "0"}},
		Content:   "deletion request",
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("signing the deletion: %v", err)
	}
	return evt
}

func TestCountReportsTotalsAndKinds(t *testing.T) {
	sk := nostr.Generate()
	events := []nostr.Event{
		signNote(t, sk, "first"),
		signNote(t, sk, "second"),
		deletion(t, sk),
	}
	baseDB, searchDir := storePaths(t)
	corpus := writeCorpus(t, t.TempDir(), events)
	logger := log.New(io.Discard, "", 0)
	if _, err := ImportNDJSON(corpus, baseDB, searchDir, true, logger); err != nil {
		t.Fatalf("importing: %v", err)
	}

	total, perKind, err := Count(baseDB)
	if err != nil {
		t.Fatalf("counting: %v", err)
	}
	if total != len(events) {
		t.Fatalf("total = %d, want %d", total, len(events))
	}
	if perKind[1] != 2 || perKind[5] != 1 {
		t.Fatalf("perKind = %v, want kind1=2 kind5=1", perKind)
	}
}

func TestCountRejectsMissingStore(t *testing.T) {
	if _, _, err := Count(filepath.Join(t.TempDir(), "missing.bolt")); err == nil {
		t.Fatal("count accepted a store path that does not exist")
	}
}
