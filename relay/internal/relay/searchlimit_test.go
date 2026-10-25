package relay

import (
	"context"
	"fmt"
	"testing"
	"time"

	"fiatjaf.com/nostr"
)

func TestSearchLimiterBurstThenRefill(t *testing.T) {
	l := newSearchLimiter(30, time.Minute, 120)
	now := time.Unix(1000, 0)

	for i := range 120 {
		if !l.take("203.0.113.7", now) {
			t.Fatalf("take %d rejected within the burst of 120", i)
		}
	}
	if l.take("203.0.113.7", now) {
		t.Fatal("take accepted after the burst was exhausted")
	}

	// 30 tokens/minute = 0.5/s: two seconds buy exactly one token.
	if !l.take("203.0.113.7", now.Add(2*time.Second)) {
		t.Fatal("take rejected after a full token refilled")
	}
	if l.take("203.0.113.7", now.Add(2*time.Second)) {
		t.Fatal("take accepted with less than a token of credit")
	}

	// A long idle period refills to (and not past) the burst.
	if !l.take("203.0.113.7", now.Add(24*time.Hour)) {
		t.Fatal("take rejected after a long idle")
	}
}

func TestSearchLimiterIsPerIP(t *testing.T) {
	l := newSearchLimiter(30, time.Minute, 2)
	now := time.Unix(0, 0)

	if !l.take("a", now) || !l.take("a", now) {
		t.Fatal("first bucket drained before its burst")
	}
	if l.take("a", now) {
		t.Fatal("first bucket served past its burst")
	}
	if !l.take("b", now) {
		t.Fatal("a second IP must have its own bucket")
	}
}

// The hook must skip non-search filters entirely, so their requests are left to
// the larger filter IP limiter and consume no search token. The empty context
// has no IP: were the hook to touch a token it would panic-free but key on "".
func TestSearchLimiterRejectIgnoresNonSearch(t *testing.T) {
	l := newSearchLimiter(30, time.Minute, 1)
	ctx := context.Background()

	if reject, msg := l.reject(ctx, nostr.Filter{}); reject || msg != "" {
		t.Fatalf("reject on an empty filter = (%v, %q), want (false, \"\")", reject, msg)
	}
	if reject, msg := l.reject(ctx, nostr.Filter{Kinds: []nostr.Kind{nostr.KindTextNote}}); reject || msg != "" {
		t.Fatalf("reject on a non-search filter = (%v, %q), want (false, \"\")", reject, msg)
	}
	if len(l.buckets) != 0 {
		t.Fatalf("a non-search filter created %d buckets, want 0", len(l.buckets))
	}
}

func TestSearchLimiterSweepDropsRefilledBuckets(t *testing.T) {
	l := newSearchLimiter(30, time.Minute, 120)
	now := time.Unix(0, 0)

	l.take("full", now) // 119/120: three seconds later this refills to full
	for range 120 {
		l.take("drained", now) // 0/120: still below the cap after three seconds
	}

	l.sweepLocked(now.Add(3 * time.Second))

	if _, ok := l.buckets["full"]; ok {
		t.Error("a fully refilled bucket should have been swept")
	}
	if _, ok := l.buckets["drained"]; !ok {
		t.Error("a drained bucket must be kept so the per-IP cap still holds")
	}
}

// The bucket map must hold the ceiling under a flood of distinct IPs. Every
// take uses the same clock, so no bucket ever refills, the sweep frees
// nothing, and once the map is full every new IP is refused — fail closed —
// while buckets of known IPs keep working. Once the buckets have had time to
// refill, a sweep clears them and new IPs are admitted again.
func TestSearchLimiterCeilingFailsClosedForNewIPs(t *testing.T) {
	l := newSearchLimiter(30, time.Minute, 120)
	now := time.Unix(0, 0)

	const takes = 20_000
	accepted, refused := 0, 0
	for i := range takes {
		ip := fmt.Sprintf("203.0.%d.%d", i>>8, i&0xff) // all distinct
		if l.take(ip, now) {
			accepted++
		} else {
			refused++
		}
		if got := len(l.buckets); got > searchBucketsCeiling {
			t.Fatalf("bucket map reached %d, past the ceiling of %d", got, searchBucketsCeiling)
		}
	}

	if accepted != searchBucketsCeiling {
		t.Fatalf("accepted %d IPs, want exactly the ceiling of %d", accepted, searchBucketsCeiling)
	}
	if refused != takes-searchBucketsCeiling {
		t.Fatalf("refused %d IPs, want %d", refused, takes-searchBucketsCeiling)
	}
	if got := len(l.buckets); got != searchBucketsCeiling {
		t.Fatalf("bucket map has %d entries at the ceiling, want %d", got, searchBucketsCeiling)
	}

	// Only NEW IPs are refused: a bucket that existed before the ceiling was
	// hit still has its (nearly full) budget.
	if !l.take("203.0.0.0", now) {
		t.Fatal("take for a pre-existing IP was refused at the ceiling")
	}

	// 30 tokens/minute = 0.5/s: after four minutes every 119/120 bucket has
	// refilled to full, so the next take's sweep empties the map and admits a
	// new IP again.
	if !l.take("198.51.100.7", now.Add(4*time.Minute)) {
		t.Fatal("take for a new IP was refused after the buckets refilled")
	}
}
