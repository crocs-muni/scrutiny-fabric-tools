package store

import (
	"fmt"
	"os"

	"fiatjaf.com/nostr"
)

// Count walks the base store and reports how many events it holds, in total
// and per kind.
//
// It exists for operator verification: after an `import` or a volume restore,
// "the store holds exactly the corpus we expect" is the claim to check, and
// /metrics cannot answer it (events_stored counts accepts since process start).
//
// A missing base.bolt is an error, not an empty store: openBase would happily
// create one, and a mistyped SCRUTINY_DATA_DIR or the wrong volume must not
// report `events: 0` and look like a healthy answer.
//
// The walk reuses scanAll, the same paging reindex uses (with its created_at
// tie-group guard), and de-duplicates across page overlaps, so the number it
// prints is the number of unique events the store can serve. The relay must not
// be running — boltdb takes an exclusive lock on the file.
func Count(baseDBPath string) (total int, perKind map[nostr.Kind]int, err error) {
	if _, statErr := os.Stat(baseDBPath); statErr != nil {
		return 0, nil, fmt.Errorf("no base store to count at %s: %w", baseDBPath, statErr)
	}

	base, err := openBase(baseDBPath)
	if err != nil {
		return 0, nil, err
	}
	defer base.Close()

	perKind = make(map[nostr.Kind]int)
	seen := make(map[nostr.ID]struct{})
	err = scanAll(base, func(evt nostr.Event) error {
		if _, dup := seen[evt.ID]; dup {
			// only possible when a page boundary sat inside a created_at
			// tie group (see scanAll)
			return nil
		}
		seen[evt.ID] = struct{}{}
		total++
		perKind[evt.Kind]++
		return nil
	})
	if err != nil {
		return total, perKind, err
	}
	return total, perKind, nil
}
