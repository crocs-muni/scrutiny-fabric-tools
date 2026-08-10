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
| 112,565 | 152.3 MB | _in flight_ | — | 1,353 | — |
| 172,430 | _in flight_ | _in flight_ | — | — | — |

Node reproduces hazard #4's ~1.35 KB/event premise (1,297–1,353 B/event across the sweep).
In Chrome the same objects cost ~0.97–0.99 KB/event — **25% lighter**, consistent with the
pointer-compression direction §4 predicted ("conservative upper bounds for a tab").

## Store retained (full ingest through `createStore`)

| Events | Node store (2 runs) | Chrome store (2 loads) | Chrome ÷ Node | Node Δ over corpus | Chrome Δ over corpus |
|---:|---:|---:|---:|---:|---:|
| 31,017 | 48.5 / 48.4 MB | 29.8 / 29.8 MB | 0.61 | +9.2 MB | +0.5 MB |
| 60,015 | 91.1 / 91.1 MB | 55.9 / 55.9 MB | 0.61 | +16.8 MB | +0.4 MB |
| 112,565 | 187.6 MB | _in flight_ | — | +35.3 MB | — |
| 172,430 | _in flight_ | _in flight_ | — | — | — |

Chrome's `stored − corpus` delta stays at ≤0.5 MB at both sizes — even though its retention is
proven (`observedById` == N) and its per-structure costs are ~half of Node's, not ~0 (see
calibration). V8's heap sandbox in Chrome 151 can hold allocations that
`usedJSHeapSize`-derived counters do not attribute; renderer working set is the honest total
and is recorded per run (`ws=` in the runner output). **[INFERENCE]** — the composition of the
delta is not asserted beyond what the counters show; a heap-snapshot attribution pass was
attempted and abandoned (tab stalled past 420 s at the 60k corpus). The totals above are what
four independent modalities (page GC+sample ×2 loads, page cross-eval, CDP metrics) agree on.

## Ingest wall time (the finding the measurement surfaced)

`store.add` is not linear in observed-set size for this corpus shape.

| Events | Node ingest | Chrome ingest |
|---:|---:|---:|
| 31,017 | 0.6 s | 0.45–0.57 s |
| 60,015 | 1.5 s | 1.06–1.14 s |
| 112,565 | **303.0 s** | _in flight_ |
| 172,430 | _in flight_ | _in flight_ |

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
leaves it: 112,565 events took **303 s in Node (~370 events/s average, and falling)**. For a
browser session importing a relay's worth of history, this binds *before* heap does: at ~110k
events the tab is unresponsive for minutes even though the bytes fit.

## Verdict and recommendation

_Filled after the 112k/172k rows land — see HANDOFF.md for the in-flight state._

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
