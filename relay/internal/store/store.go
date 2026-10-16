// Package store owns the relay's two on-disk event stores and the routing
// between them:
//
//   - a boltdb base store (pure Go, CGO-free) that holds every event and
//     answers all non-search queries;
//   - a bleve search index that holds ONLY kind-1 content and answers
//     filter.Search queries by hydrating the hits from the base store.
//
// Both are written together on every store operation, so a search-index
// failure after the base-store write is reported as a write error and logged
// instead of silently drifting; `relay reindex` rebuilds the index from the
// base store after such a failure.
package store

import (
	"errors"
	"fmt"
	"iter"
	"log"
	"os"
	"path/filepath"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/eventstore"
	"fiatjaf.com/nostr/eventstore/bleve"
	"fiatjaf.com/nostr/eventstore/boltdb"
	"github.com/pemistahl/lingua-go"
)

// Dual is the base store plus its bleve search index.
type Dual struct {
	Base   *boltdb.BoltBackend
	Search *bleve.BleveBackend

	log *log.Logger
}

// Open opens (creating when missing) both stores. The logger must be non-nil.
func Open(baseDBPath, searchIndexPath string, logger *log.Logger) (*Dual, error) {
	if logger == nil {
		return nil, errors.New("store: a logger is required")
	}

	base, err := openBase(baseDBPath)
	if err != nil {
		return nil, err
	}

	search, err := openSearch(base, searchIndexPath)
	if err != nil {
		base.Close()
		return nil, err
	}

	return &Dual{Base: base, Search: search, log: logger}, nil
}

// openBase opens (creating when missing) the boltdb base store.
func openBase(baseDBPath string) (*boltdb.BoltBackend, error) {
	if err := os.MkdirAll(filepath.Dir(baseDBPath), 0o755); err != nil {
		return nil, fmt.Errorf("creating the directory for the base store %s: %w", baseDBPath, err)
	}

	base := &boltdb.BoltBackend{Path: baseDBPath}
	if err := base.Init(); err != nil {
		return nil, fmt.Errorf("opening the base boltdb store %s: %w", baseDBPath, err)
	}
	return base, nil
}

// Close releases both stores.
func (d *Dual) Close() {
	d.Search.Close()
	d.Base.Close()
}

// Healthy reports whether the base store can serve count queries (the
// metric that backs /healthz). The filter is bounded with Since=<now>, which
// exercises the real CountEvents path (index seek, created_at bound) while
// stopping at the first index entry older than now, so a health probe does not
// scan the whole store.
//
// TODO(verify): if a future backend treats a future Since differently this
// check must be revisited; alternatively switch to a full CountEvents of the
// empty filter and accept the O(events) probe.
func (d *Dual) Healthy() error {
	_, err := d.Base.CountEvents(nostr.Filter{Since: nostr.Now()})
	return err
}

// SaveEvent stores evt in the base store first, then in the search index.
//
// A duplicate that is already in the base store is passed through unchanged as
// eventstore.ErrDupEvent: khatru (adding.go:38-44) catches exactly that
// sentinel and turns it into OK:true without re-broadcasting, which is the
// same behavior as the built-in khatru.UseEventstore wiring. Returning nil
// here would also produce OK:true, but would additionally re-broadcast the
// duplicate. The value comparison in khatru is a bare `switch err`, so the
// sentinel must NOT be wrapped.
//
// If the search-index write fails after the base store accepted the event, the
// error is propagated (the write fails) and logged: the stores are out of sync
// at that point and `relay reindex` is the way back.
func (d *Dual) SaveEvent(evt nostr.Event) error {
	if err := d.Base.SaveEvent(evt); err != nil {
		if errors.Is(err, eventstore.ErrDupEvent) {
			// already stored; nothing new for the search index either
			return eventstore.ErrDupEvent
		}
		return err
	}

	if err := d.Search.SaveEvent(evt); err != nil {
		d.log.Printf("dual-store drift: event %s was stored in the base store but the search index write failed: %v (run `relay reindex`)", evt.ID.Hex(), err)
		return fmt.Errorf("search index write failed after the base store write (stores are out of sync, run `relay reindex`): %w", err)
	}

	return nil
}

// QueryEvents routes search filters to the bleve index and everything else to
// the base store. The two backends are complementary: the base store silently
// ignores filters carrying Search (eventstore/boltdb/query.go:28-31) and bleve
// only answers filters carrying Search (a search string shorter than 2
// characters after trimming returns no events, eventstore/bleve/lib.go:345-348).
func (d *Dual) QueryEvents(filter nostr.Filter, maxLimit int) iter.Seq[nostr.Event] {
	if filter.Search != "" {
		return d.Search.QueryEvents(filter, maxLimit)
	}
	return d.Base.QueryEvents(filter, maxLimit)
}

// Counting: no NIP-45 Count hook is wired on purpose (not advertised in
// NIP-11). Should counting ever be enabled, the store-level entry point must
// refuse search filters: bleve's CountEvents only supports the empty filter
// (eventstore/bleve/lib.go:328-335), and counting the base store for a search
// filter would count events that do not match the search at all.

// reindex paging knobs.
const (
	reindexPageSize    = 1000
	reindexMaxPageSize = 1 << 17
)

// Reindex rebuilds the search index from scratch: the existing index directory
// is removed and every event of the base store is replayed into a fresh index.
// Replayed counts the unique base events fed to the index.
//
// The relay process must not be running (boltdb takes an exclusive lock on its
// file, so a concurrent instance makes the Init below fail with a timeout).
func Reindex(baseDBPath, searchIndexPath string, logger *log.Logger) (int, error) {
	if logger == nil {
		return 0, errors.New("store: a logger is required")
	}

	base, err := openBase(baseDBPath)
	if err != nil {
		return 0, err
	}
	defer base.Close()

	logger.Printf("reindex: wiping the search index at %s", searchIndexPath)
	if err := os.RemoveAll(searchIndexPath); err != nil {
		return 0, fmt.Errorf("removing the old search index %s: %w", searchIndexPath, err)
	}

	search, err := openSearch(base, searchIndexPath)
	if err != nil {
		return 0, err
	}
	defer search.Close()

	seen := make(map[nostr.ID]struct{})
	replayed := 0
	err = scanAll(base, func(evt nostr.Event) error {
		if _, dup := seen[evt.ID]; dup {
			// only possible when a page boundary sat inside a created_at
			// tie group (see scanAll); skip the duplicate
			return nil
		}
		seen[evt.ID] = struct{}{}

		if err := search.SaveEvent(evt); err != nil {
			return fmt.Errorf("indexing event %s: %w", evt.ID.Hex(), err)
		}
		replayed++
		return nil
	})
	if err != nil {
		return replayed, err
	}

	return replayed, nil
}

// openSearch builds and initializes the bleve index on top of the base store.
func openSearch(base *boltdb.BoltBackend, searchIndexPath string) (*bleve.BleveBackend, error) {
	if err := os.MkdirAll(filepath.Dir(searchIndexPath), 0o755); err != nil {
		return nil, fmt.Errorf("creating the directory for the search index %s: %w", searchIndexPath, err)
	}

	search := &bleve.BleveBackend{
		Path:          searchIndexPath,
		RawEventStore: base,
		// Only kind-1 notes carry vocabulary content. Kind 5 deletion
		// requests MUST stay out of the search index: DEL-11 stores them but
		// never acts on them, and a searchable deletion event would suggest
		// the opposite semantics.
		// TODO(verify): revisit this list when the vocabulary gate starts
		// accepting more event kinds.
		IndexableKinds: []nostr.Kind{nostr.KindTextNote},
		// A single language: bleve's own language detector is only built for
		// two or more (eventstore/bleve/lib.go:206-210).
		Languages: []lingua.Language{lingua.English},
	}
	if err := search.Init(); err != nil {
		return nil, fmt.Errorf("opening the bleve search index %s: %w", searchIndexPath, err)
	}
	return search, nil
}

// scanAll calls fn for every event in the base store.
//
// The boltdb backend has no offset or cursor support, so this pages backwards
// using an inclusive `until` bound (the newest pageSize events at or below the
// bound). Corner case: a page can end inside a created_at second that holds
// more events than fit in one page; re-querying with the same bound would then
// return the same prefix forever. That case is detected (the page is full and
// its last event sits exactly on the bound) and the page size is doubled until
// the tie group is crossed. Pages may overlap at tie groups, so callers must
// tolerate seeing an event twice.
//
// TODO(verify): correctness relies on the boltdb backend iterating created_at
// in descending order (eventstore/boltdb/query.go + query_planner.go:139-143);
// re-check after a backend upgrade.
func scanAll(base *boltdb.BoltBackend, fn func(nostr.Event) error) error {
	var until nostr.Timestamp // zero means "no upper bound"
	pageSize := reindexPageSize

	for {
		page := fetchPage(base, until, pageSize)
		if len(page) == 0 {
			return nil
		}

		for _, evt := range page {
			if err := fn(evt); err != nil {
				return err
			}
		}

		if len(page) < pageSize {
			// the page was not full: the end of the store was reached
			return nil
		}

		last := page[len(page)-1].CreatedAt
		if last == until {
			// the whole page sits inside a single created_at second; grow the
			// page until the tie group is crossed
			if pageSize >= reindexMaxPageSize {
				return fmt.Errorf("created_at second %d holds more than %d events, refusing to grow the reindex page further", last, pageSize)
			}
			pageSize *= 2
			continue
		}

		until = last
	}
}

// fetchPage reads at most limit events at or before until, newest first.
func fetchPage(base *boltdb.BoltBackend, until nostr.Timestamp, limit int) []nostr.Event {
	filter := nostr.Filter{}
	if until != 0 {
		filter.Until = until
	}

	page := make([]nostr.Event, 0, limit)
	for evt := range base.QueryEvents(filter, limit) {
		page = append(page, evt)
		if len(page) == limit {
			break
		}
	}
	return page
}
