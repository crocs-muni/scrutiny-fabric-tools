package store

import (
	"errors"
	"log"

	"fiatjaf.com/nostr"
)

// countScanCap bounds a full-store scan. It is an iteration cap, not a filter
// limit: no COUNT hook is wired into the relay (NIP-45 is deliberately not
// advertised), so counting means walking the store.
const countScanCap = 1 << 30

// Count walks the base store and reports how many events it holds, in total
// and per kind.
//
// It exists for operator verification: after an `import` or a volume restore,
// "the store holds exactly the corpus we expect" is the claim to check, and
// /metrics cannot answer it (events_stored counts accepts since process start).
// The relay must not be running — boltdb takes an exclusive lock on the file.
func Count(baseDBPath string, logger *log.Logger) (total int, perKind map[nostr.Kind]int, err error) {
	if logger == nil {
		return 0, nil, errors.New("store: a logger is required")
	}

	base, err := openBase(baseDBPath)
	if err != nil {
		return 0, nil, err
	}
	defer base.Close()

	perKind = make(map[nostr.Kind]int)
	for evt := range base.QueryEvents(nostr.Filter{}, countScanCap) {
		total++
		perKind[evt.Kind]++
	}
	return total, perKind, nil
}
