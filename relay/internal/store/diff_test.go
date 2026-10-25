package store

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fiatjaf.com/nostr"
)

func importInto(t *testing.T, baseDB, searchDir, corpus string) {
	t.Helper()
	if _, err := ImportNDJSON(corpus, baseDB, searchDir, true, log.New(io.Discard, "", 0)); err != nil {
		t.Fatalf("importing %s: %v", corpus, err)
	}
}

func TestDiffWritesTheEventsTheOtherStoreLacks(t *testing.T) {
	sk := nostr.Generate()
	shared := signNote(t, sk, "shared event")
	extra := signNote(t, sk, "only in the newer store")

	dirA := t.TempDir()
	aBase, aSearch := filepath.Join(dirA, "base.bolt"), filepath.Join(dirA, "search")
	corpusA := writeCorpus(t, t.TempDir(), []nostr.Event{shared, extra})
	importInto(t, aBase, aSearch, corpusA)

	dirB := t.TempDir()
	bBase, bSearch := filepath.Join(dirB, "base.bolt"), filepath.Join(dirB, "search")
	corpusB := writeCorpus(t, t.TempDir(), []nostr.Event{shared})
	importInto(t, bBase, bSearch, corpusB)

	out := filepath.Join(t.TempDir(), "missing.ndjson")
	missing, compared, err := Diff(aBase, bBase, out)
	if err != nil {
		t.Fatalf("diffing: %v", err)
	}
	if missing != 1 || compared != 2 {
		t.Fatalf("missing=%d compared=%d, want 1 and 2", missing, compared)
	}

	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("reading the diff output: %v", err)
	}
	if !strings.Contains(string(body), extra.ID.Hex()) || strings.Contains(string(body), shared.ID.Hex()) {
		t.Fatalf("diff output holds the wrong events:\n%s", body)
	}

	// the complement is empty
	out2 := filepath.Join(t.TempDir(), "none.ndjson")
	missing2, _, err := Diff(bBase, aBase, out2)
	if err != nil {
		t.Fatalf("reverse diff: %v", err)
	}
	if missing2 != 0 {
		t.Fatalf("reverse diff found %d missing events, want 0", missing2)
	}
}

func TestDiffRejectsMissingStores(t *testing.T) {
	missingPath := filepath.Join(t.TempDir(), "nope.bolt")
	if _, _, err := Diff(missingPath, missingPath, filepath.Join(t.TempDir(), "o.ndjson")); err == nil {
		t.Fatal("diff accepted a store path that does not exist")
	}
}
