# HANDOFF — Step 6: browser memory investigation (issue #30)

**Campaign:** Quality audit 2026-08-08, Step 6. Closes `docs/AUDIT-2026-07-31.md` hazard #4
("Browser: still not measured"). Board: milestone 1, issue #30.

## Goal

Headless-Chrome measurement of retained JS heap at 30k–110k events through
`@scrutiny-fabric/core`'s public API, against the real sec-certs corpus
(202,203,802 bytes, 6,737 certs, confirmed on disk). Node-vs-Chrome comparison table, verdict for
the in-memory posture vs a mobile-class tab ceiling (~150–400 MB), recorded in a `docs/` table.

## Progress

- 2026-08-10 kickoff. Corpus statistics measured (see below). Harness in
  `packages/core/tools/browser-memory/` being written.
- Natural mapped-corpus size ≈ **162k events** (dominated by 61,668 `related_cves` → ~123k
  events), so the 30k–110k range is covered by cert-boundary subsamples; NO synthetic replicas
  needed. Measurement points: ~30k / ~60k / ~110k / full.

## Decisions

- `appliedCompat` (issue criterion 1) **does not exist** — zero hits in this repo, the spec repo,
  all 33 issue bodies, and web search (issue text also carries a broken `...2026-07-31.md.md`
  path, same draft quality). Disposition: measure without it, record the negative finding in the
  docs table and the Done comment.
- Chrome runs the **exact published ESM files** (`dist/` + `diff` via import map over a local
  HTTP server) — zero bundling, zero new dependencies. CDP driven over Node 25's built-in
  WebSocket; `--js-flags=--expose-gc --enable-precise-memory-info`; `JSHeapUsedSize` sampled
  after forced GC. Chrome 141 ≥ 120.
- Corpus generator emits store-valid v0.8.0 shapes (BD-3 root=product / BD-4 link=metadata),
  tag conventions imported from `dist/` so they cannot drift; deterministic sha256 ids from
  semantic keys; cert-major ordering for referentially-closed prefix subsampling.
- Raw-corpus-retained and store-retained are measured as separate phases (hazard #4's claim is
  about the raw corpus; store overhead is the added question).

## Next Steps

1. Finish harness: `generate-corpus.mjs`, `measure-lib.mjs`, `measure-node.mjs`,
   `measure-chrome.mjs`.
2. Generate corpus; Node ×2 runs per size; Chrome ×2 loads per size.
3. `docs/BROWSER-MEMORY-2026-08-10.md` with the measured tables + verdict; close §4 Step 6 in
   the audit doc; refresh this file.

(c) update HANDOFF close-out.

Then Gate.

Let me assign the issue and check diff's ESM entry + esbuild/bin situation + chrome version in parallel.