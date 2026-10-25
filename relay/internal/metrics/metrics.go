// Package metrics implements the pilot's tiny operational surface: process
// counters incremented from the relay hooks, plus the /healthz and /metrics
// handlers that get mounted on khatru's extra router.
//
// khatru itself has no metrics or health endpoints (verified against
// khatru @ 58e4c715304e), so these are plain atomics and a stdlib server.
// There is deliberately no Prometheus dependency.
package metrics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

// Metrics holds the process-lifetime counters.
type Metrics struct {
	EventsStored      atomic.Uint64
	EventsRejected    atomic.Uint64
	QueriesWithSearch atomic.Uint64
	// StoreDrift counts search-index writes that failed after the base store
	// accepted the event. Nonzero means NIP-50 results are incomplete until a
	// `relay reindex` runs.
	StoreDrift atomic.Uint64

	started time.Time
}

// New returns zeroed counters. The uptime clock starts now.
func New() *Metrics {
	return &Metrics{started: time.Now()}
}

// Snapshot is the /metrics JSON shape.
type Snapshot struct {
	EventsStored      uint64 `json:"events_stored"`
	EventsRejected    uint64 `json:"events_rejected"`
	QueriesWithSearch uint64 `json:"queries_with_search"`
	StoreDrift        uint64 `json:"store_drift"`
	UptimeSeconds     int64  `json:"uptime_s"`
}

// Snapshot reads all counters.
func (m *Metrics) Snapshot() Snapshot {
	return Snapshot{
		EventsStored:      m.EventsStored.Load(),
		EventsRejected:    m.EventsRejected.Load(),
		QueriesWithSearch: m.QueriesWithSearch.Load(),
		StoreDrift:        m.StoreDrift.Load(),
		UptimeSeconds:     int64(time.Since(m.started).Seconds()),
	}
}

// Handler serves the JSON counters.
func (m *Metrics) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if err := json.NewEncoder(w).Encode(m.Snapshot()); err != nil {
			// response headers are already on the wire; nothing left to do
			return
		}
	}
}

// HealthzHandler serves 200 when healthy() succeeds and 503 otherwise.
// healthy is expected to touch the base store, so a closed or wedged store
// shows up as unhealthy instead of being reported as ready.
func (m *Metrics) HealthzHandler(healthy func() error) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if err := healthy(); err != nil {
			http.Error(w, "unhealthy: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = fmt.Fprintln(w, "ok")
	}
}
