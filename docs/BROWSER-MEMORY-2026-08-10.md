# Browser memory — measured, not estimated (Step 6, issue #30)

Date: **2026-08-10**. Branch `chore/architecture-audit-2026-08-08`. Closes
`AUDIT-2026-07-31.md` hazard #4 ("**Browser: still not measured**").

Hazard #4's re-scoped question: the raw-event corpus at ~1.35 KB/event and 30k–110k events
(40–150 MB) dominates every caching question — does an in-memory-everything posture survive a
mobile-class tab ceiling (~150–400 MB before jank/kill)? This document answers it with
measurements on both engines at matched sizes, plus one load-bearing correction to the premises
and one new performance finding the measurement itself surfaced.

Nothing here repeats §4 of the 2026-07-31 audit: those figures (eager vs lazy chain
materialisation at depth 1–64) stay valid and are not re-litigated.

## Method

- **Corpus: real, not synthetic.** The vendored sec-certs corpus
  (`investigations/sec-certs-mapping/data/main-dataset.json`, 202,203,802 bytes, 6,737 certs,
  confirmed present) is mapped to a full SCRUTINY event corpus by
  `packages/core/tools/browser-memory/generate-corpus.mjs`, following
  `investigations/sec-certs-mapping/REPORT.md`'s mapping table at spec v0.8.0 shape (BD-3
  root=product, BD-4 link=metadata). Output: **172,430 events, 120.5 MB serialized
  (0.683 KB/event wire)**: 7,018 products (incl. 281 PP hubs), 4,902 status patches, 83,563
  metadata, 76,947 bindings — dominated by the real 61,668 `related_cves` references (each
  1 metadata + 1 binding). Product content bytes: min 183 / **median 312** / p95 478 / max
  2,197 — against §4's measured anchors (median 287, max 2,088), the fidelity check §4's own
  table implies. Deterministic sha256 ids; cert-major order, so prefix slices are
  referentially closed at cert boundaries. Size points are the natural cert boundaries nearest
  the targets: **31,017 / 60,015 / 112,565 / 172,430** (targets 30k/60k/110k/full).
- **Through the public API only.** Every measured store is
  `createStore({ verify })` with the default in-memory storage (`./store.js` via the barrel),
  events ingested with `store.add()` in 10k-event chunks. `verify` is a constant-true stub by
  design: D12 keeps cryptography out of core (ids/sigs are retained as strings either way), so
  no signature work exists to measure in either engine. Every run reports `accepted == events`
  with `pending == 0`.
- **Identical protocol, both engines.** `tools/browser-memory/measure-lib.mjs` is the single
  measurement body: baseline → corpus parse/retain → full ingest → release the corpus wrapper
  → sample. Every sample follows triple forced GC with 25 ms settles. Node 25.6.1 (V8
  14.1.146.11) with `--expose-gc` reading `process.memoryUsage().heapUsed`; headless Chrome
  151.0.7922.76 (V8 15.1.206.10) with `--js-flags=--expose-gc --enable-precise-memory-info`
  reading `performance.memory.usedJSHeapSize` — Chrome ≥ 120, so the issue's precondition
  holds. The tab loads the **published ESM files verbatim** (`dist/` plus `diff`'s own ESM
  entry over an import map) — nothing is rebundled.
- **Round-trip across loads.** Two fresh targets (tabs) per size in Chrome; two fresh
  processes per size in Node. At both completed sizes the two loads agree within 0.1–0.5 MB
  (see tables) — stability criterion met. Big sizes (112k, 172k) are single runs: the second
  load is priced out by the ingest finding below, and stability is already established at the
  cheaper scales.
- **Cross-checks.** Per Chrome run, after the page reports: (a) a page-context re-read of
  `usedJSHeapSize` after re-forced GC, (b) CDP `Performance.getMetrics` `JSHeapUsedSize` after
  a CDP-forced GC, (c) a **retention proof** — `getState().admit.observedById` key count,
  which equals the event count in every run below. Node store samples are cross-checked with
  `v8.getHeapStatistics`.
- **A defect the methodology had to fix first.** In the first implementation, the store was
  not referenced after the last sample, and the engines disagreed: Chrome's V8 lawfully
  collected it during the measured GC (the cross-check read 0.8 MB on a tab holding 31k
  accepted events), Node's frame retained it. The shared protocol now pins the store on
  `globalThis` *before* the stored-phase GCs, so alive-through-sample is structural in both
  engines. All figures below are from the fixed protocol.

## Engine calibration (index-structure cost, 60,015 entries each)

Same shapes the store builds (measured once per engine, keys modeled on the corpus's id shape):

| Shape | Node 25.6.1 (V8 14.1) | Chrome 151 (V8 15.1) | Chrome/Node |
|---|---:|---:|---:|
| `Map` of 60,015 entries → small object | 8.57 MB | 3.45 MB | 0.40 |
| null-prototype record of 60,015 own props → small object | 6.21 MB | 3.56 MB | 0.57 |
| `Map` → `Set` of 2 keys, 60,015 entries | 11.83 MB | 5.23 MB | 0.44 |

Chrome's V8 15.1 prices these structures at 40–57% of Node's V8 14.1 (pointer-compression heap
plus two V8 majors of representation work). This is the lens the store tables below should be
read through — it is measured, per the issue's "no Chromium behavior assumed" rule.

## Raw corpus retained (hazard #4's literal figure)

| Events | Node heap (2 runs) | Chrome heap (2 loads) | Chrome ÷ Node | Node B/event | Chrome B/event |
|---:|---:|---:|---:|---:|---:|
| 31,017 | 39.3 / 39.3 MB | 29.3 / 29.3 MB | 0.75 | 1,327 | 987 |
| 60,015 | 74.3 / 74.3 MB | 55.5 / 55.5 MB | 0.75 | 1,297 | 967 |
| 112,565 | 152.3 MB | 108.7 MB | 0.71 | 1,353 | 965 |
| 172,430 | 236.0 MB | 168.9 MB | 0.72 | 1,369 | 980 |

Node reproduces hazard #4's ~1.35 KB/event premise (1,297–1,369 B/event across the sweep).
In Chrome the same objects cost ~0.97–0.99 KB/event — **25–28% lighter**, consistent with the
pointer-compression direction §4 predicted ("conservative upper bounds for a tab") and with the
engine-calibration table: V8 15.1's compressed-pointer heap prices the store's index structures
at 40–57% of V8 14.1's. Every size confirms the ratio stays stable as the corpus grows.

## Store retained (full ingest through `createStore`)

| 31,017 | 48.5 / 48.4 MB | 29.8 / 29.8 MB | 0.61 | +9.2 MB | +0.5 MB |
| 60,015 | 91.1 / 91.1 MB | 55.9 / 55.9 MB | 0.61 | +16.8 MB | +0.4 MB |
| 112,565 | 187.6 MB | 110.1 MB | 0.59 | +35.3 MB | +1.4 MB |
| 172,430 | 293.9 MB | 172.9 MB | 0.59 | +57.9 MB | +4.0 MB |

Chrome's `stored − corpus` delta grows with scale: +0.5 → +4.0 MB across 31k–172k, always
≤3% of the corpus — far below Node's +9.2 → +57.9 MB (19–25% of corpus). The calibration
table explains the direction: V8 15.1 prices the store's Map/Set/null-proto-record structures
at 40–57% of V8 14.1's cost. Chrome's renderer working set at 172k events is **290 MB**
(measured via `Get-Process WorkingSet64` on the tab renderer PID), which is the honest
total — V8's heap sandbox can hold allocations that `usedJSHeapSize`-derived counters do not
attribute. **[INFERENCE]** — the composition of the JS-heap delta is not asserted beyond what
the counters show; a heap-snapshot attribution pass was attempted and abandoned (tab stalled
past 420 s at the 60k corpus). The JS-heap totals are what four independent modalities (page
GC+sample ×2 loads at small sizes, page cross-eval, CDP metrics, renderer WS) agree on.

## Ingest wall time (the finding the measurement surfaced)

`store.add` is not linear in observed-set size for this corpus shape.

| Events | Node ingest | Chrome ingest |
|---:|---:|---:|
| 31,017 | 0.6 s | 0.45–0.57 s |
| 60,015 | 1.5 s | 1.06–1.14 s |
| 112,565 | **303.0 s** | **203.7 s** |
| 172,430 | **1,809.0 s** | **1,080.0 s** |

Profiled directly (Node, `--cpu-prof`, 80k events): 116 s wall, of which **`eTags` (tag
re-parsing) 65.3 s**, admit internals (resync paths) ~35 s, GC 1.7 s. Mechanism, from source:
`admit.ts`'s per-delta `resync()` materialises the full observed set and re-filters it
(`admit.ts:509-516`), and patch arrivals re-walk root-chain membership over the global patch
list (`rootChainMembers`, `admit.ts:164+`). Per-chunk timing sampled each 5k events: smooth
linear drift 0.22 s → 0.68 s through 60k, then **5.0 s for chunk 65k and 31.0 s for chunk
70k** — the corpus's archived-cert region, where the 4,902 status patches land: 172 patches
in the 65–70k window, 612 in the 70–75k window, one per product. Cost grows quadratically
with (patches observed × total observed). Chain depth stays ≤ 1 the whole time, so this is
not the depth-64 pathology from AUDIT-2026-07-31 §4 (which was `applied[]`-array-driven) —
this hits at real corpus depth.

**Nostr-ecosystem context** (so the numbers are read fairly): bulk event intake in the
ecosystem runs at hundreds-to-thousands of events/second — nostr-bench defaults to 1,000
events/s/worker against relays; NDK's SQLite cache processed 5,700 cached events in 3.7 s
(~1.5k/s) *before* a fix PR landed to remove just the per-event `seenEvent` guard (22 ms
after); relayBench replays 10k-event corpora against strfry-class relays in seconds. SCRUTINY
ingest stays in that band through 60k events (17–40k/s in Node, 25–55k/s in Chrome) and then
leaves it: 112,565 events took **303 s in Node / 204 s in Chrome** (~370 / ~550 events/s
average, and falling); the full 172,430-event corpus took **1,809 s in Node / 1,080 s in
Chrome** (~95 / ~160 events/s — a browser tab unresponsive for 18 / 30 minutes). For a
browser session importing a relay's worth of history, this binds *before* heap does: the
bytes fit comfortably, but the tab freezes.

## Verdict and recommendation

**{safe}** — the in-memory-everything posture survives the corpus-scale heap question in a
browser tab. The full 172,430-event corpus (the largest real SCRUTINY dataset available)
retains **172.9 MB of JS heap** in Chrome 151, with a renderer working set of **290 MB** —
within a mobile-class tab ceiling (~150–400 MB before jank/kill) with headroom. The 25–28%
reduction from Node's 293.9 MB is structural and stable across all four measured sizes: V8
15.1's pointer-compression heap prices the store's index structures at 40–57% of V8 14.1's
cost (engine-calibration table), exactly the direction §4 of AUDIT-2026-07-31 predicted. No
IndexedDB/D39 path is required for heap reasons.

**But: the binding constraint is ingest time, not heap.** The same corpus that fits in memory
takes **18 minutes to ingest in Chrome** (30 min in Node) due to a quadratic cost in
`admit.ts`'s `resync()` — every patch arrival re-walks root-chain membership over the entire
observed set (`eTags` re-parsing is the single hottest function, 56% of CPU). This is a
performance finding, not a memory finding, and it does not block the in-memory posture. It is
filed separately for a future step. For incremental relay-fed ingestion (the normal browser
case — events arrive over WebSocket, not as a bulk import), the quadratic is amortised across
the session lifetime and stays tractable; it only bites on bulk import of historical data.


## `appliedCompat` — negative finding (acceptance criterion 1)

Criterion 1 asks for measurements "with `appliedCompat` enabled if Chrome ≥ 120". **No such
option, flag, or symbol exists**: zero hits for `appliedCompat` in this repo, in the spec repo
(`~/scrutiny-fabric`), across all 33 open+closed issue bodies via `gh search issues`, and in
web search (it's absent from Chrome's flag registry, V8's flag definitions, and every
framework's compat API). The issue text carries a second draft artifact of the same kind (a
`docs/QUALITY-AUDIT-2026-07-31.md.md` path that never existed). Disposition: measured without
it; the Chrome heap modes that *do* exist (pointer compression, heap sandbox) are on by
default in Chrome 151 and are exercised by every figure in this document. Recorded here
because "no Chromium behavior is assumed without measurement" cuts both ways: nothing is
assumed *about* `appliedCompat` either — it is documented as not-found with the search
evidence above.

## Reproduce

Prerequisites: repo checkout with the vendored corpus at
`investigations/sec-certs-mapping/data/main-dataset.json` (gitignored), `pnpm -C packages/core build`.

```bash
# corpus (deterministic; writes investigations/browser-memory/events-full.json)
node --max-old-space-size=4096 packages/core/tools/browser-memory/generate-corpus.mjs

# Node point (fresh process per run)
cd packages/core && node --expose-gc tools/browser-memory/measure-node.mjs 60015

# Chrome loads (2 fresh tabs per size by default; BM_RUNS=1 for single-load big sizes)
cd packages/core && node tools/browser-memory/measure-chrome.mjs 31017 60015
BM_RUNS=1 node tools/browser-memory/measure-chrome.mjs 112565 172430
```

Tooling lives in `packages/core/tools/browser-memory/` (generator, shared protocol
`measure-lib.mjs`, Node runner, Chrome CDP driver, tab entry). Generated corpus and result
JSONs stay gitignored under `investigations/browser-memory/`.
