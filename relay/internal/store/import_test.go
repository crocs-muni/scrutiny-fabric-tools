package store

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fiatjaf.com/nostr"
)

// writeCorpus writes events as NDJSON and returns the path.
func writeCorpus(t *testing.T, dir string, events []nostr.Event) string {
	t.Helper()
	var buf bytes.Buffer
	for _, evt := range events {
		line, err := json.Marshal(evt)
		if err != nil {
			t.Fatalf("marshalling the event: %v", err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	path := filepath.Join(dir, "corpus.ndjson")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("writing the corpus: %v", err)
	}
	return path
}

// signNote builds a signed kind-1 note carrying the given content.
func signNote(t *testing.T, sk nostr.SecretKey, content string) nostr.Event {
	t.Helper()
	evt := nostr.Event{
		Kind:      1,
		CreatedAt: 1700000000,
		Tags:      nostr.Tags{{"t", "scrutiny-fabric-test"}},
		Content:   content,
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("signing the note: %v", err)
	}
	return evt
}


func storePaths(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "base.bolt"), filepath.Join(dir, "search")
}

func TestImportNDJSONStoresEventsAndIndexesThem(t *testing.T) {
	sk := nostr.Generate()
	const magic = "schnitzelverse"
	events := []nostr.Event{
		signNote(t, sk, "first note about "+magic),
		signNote(t, sk, "second note"),
	}
	baseDB, searchDir := storePaths(t)
	corpus := writeCorpus(t, t.TempDir(), events)

	summary, err := ImportNDJSON(corpus, baseDB, searchDir, true, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("importing: %v", err)
	}
	if summary.Read != 2 || summary.Imported != 2 || summary.Duplicates != 0 {
		t.Fatalf("summary = %+v, want read=2 stored=2 duplicates=0", summary)
	}

	dual, err := Open(baseDB, searchDir, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("reopening the store: %v", err)
	}
	defer dual.Close()

	var got []nostr.Event
	for evt := range dual.QueryEvents(nostr.Filter{Kinds: []nostr.Kind{1}}, 10) {
		got = append(got, evt)
	}
	if len(got) != len(events) {
		t.Fatalf("base store returned %d events, want %d", len(got), len(events))
	}

	var hits []nostr.Event
	for evt := range dual.QueryEvents(nostr.Filter{Search: magic, Kinds: []nostr.Kind{1}}, 10) {
		hits = append(hits, evt)
	}
	if len(hits) != 1 || hits[0].ID != events[0].ID {
		t.Fatalf("search for %q returned %d events, want exactly the first note", magic, len(hits))
	}
}

func TestImportNDJSONIsIdempotent(t *testing.T) {
	sk := nostr.Generate()
	events := []nostr.Event{signNote(t, sk, "alpha"), signNote(t, sk, "beta")}
	baseDB, searchDir := storePaths(t)
	corpus := writeCorpus(t, t.TempDir(), events)
	logger := log.New(io.Discard, "", 0)

	if _, err := ImportNDJSON(corpus, baseDB, searchDir, true, logger); err != nil {
		t.Fatalf("first import: %v", err)
	}
	summary, err := ImportNDJSON(corpus, baseDB, searchDir, true, logger)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if summary.Imported != 0 || summary.Duplicates != 2 {
		t.Fatalf("second import summary = %+v, want stored=0 duplicates=2", summary)
	}
}

func TestImportNDJSONRejectsUnverifiableEvents(t *testing.T) {
	sk := nostr.Generate()
	forged := signNote(t, sk, "original content")
	forged.Content = "edited after signing" // id and signature no longer match

	baseDB, searchDir := storePaths(t)
	corpus := writeCorpus(t, t.TempDir(), []nostr.Event{forged})

	summary, err := ImportNDJSON(corpus, baseDB, searchDir, true, log.New(io.Discard, "", 0))
	if err == nil {
		t.Fatal("import accepted an event whose id does not match its content")
	}
	if !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("error %q does not name the offending line", err)
	}
	if summary.Imported != 0 {
		t.Fatalf("summary = %+v, want nothing stored", summary)
	}
}

func TestImportNDJSONReportsMalformedLines(t *testing.T) {
	baseDB, searchDir := storePaths(t)
	corpus := filepath.Join(t.TempDir(), "broken.ndjson")
	if err := os.WriteFile(corpus, []byte("{\"kind\":1}\nnot json\n"), 0o600); err != nil {
		t.Fatalf("writing the corpus: %v", err)
	}

	_, err := ImportNDJSON(corpus, baseDB, searchDir, false, log.New(io.Discard, "", 0))
	if err == nil {
		t.Fatal("import accepted a malformed line")
	}
	if !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("error %q does not name the offending line", err)
	}
}

func TestImportNDJSONRequiresALogger(t *testing.T) {
	if _, err := ImportNDJSON("x", "y", "z", true, nil); err == nil {
		t.Fatal("import accepted a nil logger")
	}
}
