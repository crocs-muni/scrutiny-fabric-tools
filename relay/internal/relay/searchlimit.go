package relay

import (
	"context"
	"sync"
	"time"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
)

// searchRejectMessage is the CLOSED reason sent when the NIP-50 budget is spent.
const searchRejectMessage = "rate-limited: search budget exhausted, retry in a minute"

// searchBucketsCeiling bounds the per-IP map. Once it is reached, buckets that
// have already refilled to full are dropped on the next take (they carry no
// useful state); if the map is still full afterwards — every bucket is
// actively draining — takes from new IPs fail closed until draining buckets
// refill and get swept. Buckets of known IPs keep working throughout.
const searchBucketsCeiling = 1 << 14

// searchLimiter is a per-IP token bucket for NIP-50 search filters. Unlike the
// khatru limiters it deliberately does NOT exempt loopback: the relay's own
// tunnel walks must be bounded too, and the exemption would make the limiter
// untestable. It has no goroutine and no ticker — buckets refill lazily on use.
type searchLimiter struct {
	mu      sync.Mutex
	buckets map[string]*searchBucket
	rate    float64 // tokens added per second
	burst   float64 // bucket capacity
}

type searchBucket struct {
	tokens float64
	last   time.Time
}

// newSearchLimiter builds a limiter that refills tokensPerInterval tokens over
// interval and holds at most burst tokens. A burst <= 0 defaults to
// tokensPerInterval.
func newSearchLimiter(tokensPerInterval int, interval time.Duration, burst int) *searchLimiter {
	rate := float64(tokensPerInterval)
	if interval > 0 {
		rate /= interval.Seconds()
	}
	if burst <= 0 {
		burst = tokensPerInterval
	}
	return &searchLimiter{
		buckets: make(map[string]*searchBucket),
		rate:    rate,
		burst:   float64(burst),
	}
}

// take reports whether ip may spend one token at time now. The clock is a
// parameter so tests are deterministic. A new IP is only admitted when the
// bucket map is below its ceiling after the sweep; at the ceiling the take
// fails closed (see searchBucketsCeiling), and the caller rejects with the
// standard search message.
func (l *searchLimiter) take(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	b := l.buckets[ip]
	if b == nil {
		if len(l.buckets) >= searchBucketsCeiling {
			l.sweepLocked(now)
			if len(l.buckets) >= searchBucketsCeiling {
				// Still at the ceiling: every bucket is actively draining,
				// so admitting a new IP would break the cap. Reject.
				return false
			}
		}
		b = &searchBucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * l.rate
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked drops buckets that have refilled to full. The caller holds mu.
func (l *searchLimiter) sweepLocked(now time.Time) {
	for ip, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, ip)
		}
	}
}

// reject is the filter reject hook: it consumes a search token only when the
// filter actually carries a NIP-50 search string, so plain NIP-01 queries are
// left to the (much larger) filter IP limiter.
func (l *searchLimiter) reject(ctx context.Context, filter nostr.Filter) (bool, string) {
	if filter.Search == "" {
		return false, ""
	}
	if l.take(khatru.GetIP(ctx), time.Now()) {
		return false, ""
	}
	return true, searchRejectMessage
}
