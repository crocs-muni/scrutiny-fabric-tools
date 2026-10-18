package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"fiatjaf.com/nostr"
)

// Diff writes the events that exist in baseDBPath but not in otherBaseDBPath,
// as NDJSON, so they can be fed straight back into `relay import`.
//
// It exists because a store-level count difference is not actionable on its own:
// after a restore you need the actual events that are missing, and neither the
// relay's query API (dense created_at seconds overflow the 500-event cap) nor a
// created_at watermark (re-published events keep their original timestamp) can
// enumerate them faithfully. Both stores are walked through scanAll, so the
// comparison uses the same paging reindex does.
//
// Neither store may be open in a relay process: boltdb takes an exclusive lock.
func Diff(baseDBPath, otherBaseDBPath, outPath string) (missing int, compared int, err error) {
	for _, path := range []string{baseDBPath, otherBaseDBPath} {
		if _, statErr := os.Stat(path); statErr != nil {
			return 0, 0, fmt.Errorf("no base store at %s: %w", path, statErr)
		}
	}

	other, err := openBase(otherBaseDBPath)
	if err != nil {
		return 0, 0, err
	}
	defer other.Close()

	known := make(map[nostr.ID]struct{})
	if err := scanAll(other, func(evt nostr.Event) error {
		known[evt.ID] = struct{}{}
		return nil
	}); err != nil {
		return 0, 0, fmt.Errorf("reading %s: %w", otherBaseDBPath, err)
	}

	base, err := openBase(baseDBPath)
	if err != nil {
		return 0, 0, err
	}
	defer base.Close()

	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, 0, fmt.Errorf("creating %s: %w", outPath, err)
	}
	defer out.Close()
	buffered := bufio.NewWriterSize(out, 1<<20)

	seen := make(map[nostr.ID]struct{})
	err = scanAll(base, func(evt nostr.Event) error {
		if _, dup := seen[evt.ID]; dup {
			return nil
		}
		seen[evt.ID] = struct{}{}
		compared++
		if _, ok := known[evt.ID]; ok {
			return nil
		}
		line, marshalErr := json.Marshal(evt)
		if marshalErr != nil {
			return fmt.Errorf("marshalling event %s: %w", evt.ID.Hex(), marshalErr)
		}
		if _, writeErr := buffered.Write(append(line, '\n')); writeErr != nil {
			return fmt.Errorf("writing %s: %w", outPath, writeErr)
		}
		missing++
		return nil
	})
	if err != nil {
		return missing, compared, err
	}
	if err := buffered.Flush(); err != nil {
		return missing, compared, fmt.Errorf("flushing %s: %w", outPath, err)
	}
	if err := out.Sync(); err != nil {
		return missing, compared, fmt.Errorf("syncing %s: %w", outPath, err)
	}
	return missing, compared, nil
}
