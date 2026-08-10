# HANDOFF — Step 6: browser memory investigation (issue #30)

**Campaign:** Quality audit 2026-08-08, Step 6. Closes `docs/AUDIT-2026-07-31.md` hazard #4.
**Status: DONE.** All acceptance criteria met; `pnpm verify` green; issue #30 closed with `Done:` comment.

## Goal

Headless-Chrome measurement of retained JS heap at 30k–110k events through
`@scrutiny-fabric/core`'s public API, against the real sec-certs corpus (202 MB, 6,737 certs).
Node-vs-Chrome comparison table, verdict for the in-memory posture vs a mobile-class tab ceiling.

## Result

**Verdict: {safe}** — the in-memory-everything posture survives at corpus scale.

| Events | Node store | Chrome store | Chrome renderer WS | Chrome ÷ Node | Node ingest | Chrome ingest |
|---:|---:|---:|---:|---:|---:|---:|
| 31,017 | 48.5 MB | 29.8 MB | — | 0.61 | 0.6 s | 0.5 s |
| 60,015 | 91.1 MB | 55.9 MB | — | 0.61 | 1.5 s | 1.1 s |
| 112,565 | 187.6 MB | 110.1 MB | 206 MB | 0.59 | 303 s | 204 s |
| 172,430 | 293.9 MB | 172.9 MB | 290 MB | 0.59 | 1,809 s | 1,080 s |

- Chrome 151 (V8 15.1) retains the raw corpus at ~0.97–0.99 KB/event; Node 25.6.1 (V8 14.1) at ~1.30–1.37 KB/event — **25–28% lighter**, stable across all sizes. Engine calibration confirms: V8 15.1's pointer-compression heap prices the store's index structures at 40–57% of V8 14.1's.
- The full 172,430-event corpus fits a mobile-class tab ceiling (~150–400 MB) with headroom (renderer WS 290 MB).
- The binding constraint is **ingest time, not heap**: quadratic cost in `admit.resync()` (every patch re-walks root-chain membership over the entire observed set; `eTags` re-parsing is 56% of CPU). Filed as [issue #34](https://github.com/crocs-muni/scrutiny-fabric-tools/issues/34) (full options record + hardened F1 design + acceptance criteria).

## Decisions

- `appliedCompat` (issue criterion 1) does not exist — zero hits in repo, spec repo, all issues, web search. Measured without it; negative finding documented.
- Chrome runs the published ESM files verbatim (`dist/` + `diff` via import map). Zero new dependencies. CDP over Node 25's built-in WebSocket.
- Corpus generator emits store-valid v0.8.0 shapes; deterministic sha256 ids; cert-major ordering for referentially-closed prefix subsampling.
- Store pinned on `globalThis` before the stored-phase GCs — fixes a liveness defect where Chrome's V8 lawfully collected the store mid-sample.

## Artifacts

- `docs/BROWSER-MEMORY-2026-08-10.md` — full write-up with measured tables + verdict.
- `packages/core/tools/browser-memory/` — `generate-corpus.mjs`, `measure-lib.mjs`, `measure-node.mjs`, `measure-chrome.mjs`, `page-entry.mjs`.
- `investigations/browser-memory/events-full.json` — generated corpus (gitignored, 120.5 MB, 172,430 events).
- `investigations/browser-memory/results-*.json` — Chrome result JSONs (gitignored).
- `investigations/browser-memory/results-node.jsonl` — Node result rows (gitignored).
- `docs/QUALITY-AUDIT-2026-08-08.md` §4 Step 6 marked `[x]` closed.

## Next

Step 7 (#31, doc debt). Do not start without reading the audit doc's RESUME line.
