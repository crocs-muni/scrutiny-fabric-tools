package store

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/eventstore"
)

// maxImportLine bounds one NDJSON line. The relay's own inbound cap is 512 KiB
// per message (SCRUTINY max message length), so 8 MiB leaves headroom for
// corpora produced by tooling that is more generous than the wire.
const maxImportLine = 8 << 20

// importProgressEvery is how often the importer reports progress.
const importProgressEvery = 10000

// ImportSummary counts what ImportNDJSON did.
type ImportSummary struct {
	// Read is the number of non-empty lines consumed.
	Read int
	// Imported is the number of events newly written to both stores.
	Imported int
	// Duplicates is the number of events the base store already held. Those
	// are not errors: replaying a corpus twice must converge, exactly like the
	// wire path answers OK:true to a duplicate.
	Duplicates int
}

// ImportNDJSON replays a corpus of signed events from an NDJSON file into the
// base store and the search index.
//
// It is the offline disaster-recovery path: it deliberately bypasses every
// write-policy gate of the relay (NIP-42 authentication, the publisher
// allowlist, the vocabulary gate and the freshness window), because a restore
// must be able to rebuild a store from an archive whose events are older than
// any allowed past age and without a publisher secret. It must therefore never
// be mounted as a network endpoint; it is an operator command, run against a
// store no relay process has open (boltdb takes an exclusive lock).
//
// The base store is written with fsync disabled and one Sync at the end, so a
// crash mid-import can lose or corrupt the tail; for the base store the operation
// is idempotent (duplicates are counted, not errors), so the answer is to run it
// again. The search index has no such guarantee — a duplicate whose index-heal
// write keeps failing is still counted as a duplicate, and only reindex reconciles
// the index afterwards. The search index is not batched by the backend and still
// commits one document per event, which puts the practical floor near 20 ms per
// event.
//
// verify re-hashes each event's id and checks its BIP-340 signature before the
// write; leave it on for archives that may have been edited after export. It
// cannot rescue a truncated file: a torn final line fails JSON parsing and
// aborts the import regardless of verify.
//
// verify=false is a deliberate, narrow exception to D14.3/D20 (DECISIONS-2026-07-27:
// "dedup only after verification", "the store must key on the recomputed id"), which
// govern the network ingest path. With verification off, events are stored and
// deduplicated under their *declared* id, so a forged-id entry lands in the store.
// That is acceptable here — and only here — because this is an offline operator
// command on a store the operator already has filesystem control over (equal to
// reindex's trust model), never a network endpoint. The flag defaults to true and
// keeps its explicit name so misuse stays visible in review, per D19's standard.
func ImportNDJSON(path, baseDBPath, searchIndexPath string, verify bool, logger *log.Logger) (ImportSummary, error) {
	if logger == nil {
		return ImportSummary{}, errors.New("store: a logger is required")
	}

	file, err := os.Open(path)
	if err != nil {
		return ImportSummary{}, fmt.Errorf("opening the import file %s: %w", path, err)
	}
	defer file.Close()

	base, err := openBase(baseDBPath)
	if err != nil {
		return ImportSummary{}, err
	}
	defer base.Close()

	search, err := openSearch(base, searchIndexPath)
	if err != nil {
		return ImportSummary{}, err
	}
	defer search.Close()

	dual := &Dual{Base: base, Search: search, log: logger}

	base.DB.NoSync = true
	defer func() { base.DB.NoSync = false }()

	var sum ImportSummary
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 1<<20), maxImportLine)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		sum.Read++

		var evt nostr.Event
		if err := json.Unmarshal(line, &evt); err != nil {
			return sum, fmt.Errorf("line %d: parsing the event: %w", sum.Read, err)
		}
		if verify {
			if !evt.CheckID() {
				return sum, fmt.Errorf("line %d: the event id %s does not match its serialized content", sum.Read, evt.ID.Hex())
			}
			if !evt.VerifySignature() {
				return sum, fmt.Errorf("line %d: invalid signature on event %s", sum.Read, evt.ID.Hex())
			}
		}

		switch err := dual.SaveEvent(evt); {
		case err == nil:
			sum.Imported++
		case errors.Is(err, eventstore.ErrDupEvent):
			sum.Duplicates++
		default:
			return sum, fmt.Errorf("line %d: storing event %s: %w", sum.Read, evt.ID.Hex(), err)
		}

		if sum.Read%importProgressEvery == 0 {
			logger.Printf("import: %d events read (%d new, %d duplicates)", sum.Read, sum.Imported, sum.Duplicates)
		}
	}
	if err := scanner.Err(); err != nil {
		return sum, fmt.Errorf("reading the import file after %d events: %w", sum.Read, err)
	}

	if err := base.DB.Sync(); err != nil {
		return sum, fmt.Errorf("flushing the base store after %d events: %w", sum.Read, err)
	}

	return sum, nil
}
