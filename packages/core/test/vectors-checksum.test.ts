/**
 * D33 / Appendix G.1 — the vendored corpus is pinned by digest so a released implementation stays
 * testable offline against the exact vectors it claimed to pass. CI enforces both directions: this
 * file is the "vendored copy matches Appendix G" direction. The reverse (Appendix G matches the
 * spec repo's actual corpus) is the spec repo's own responsibility, not this one's.
 *
 * `node:crypto` is confined to the test tree, exactly as `node:fs` is in `_vectors.ts` — `src/`
 * stays free of both (D12, D18).
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Pinned in Appendix G.1. Re-vendored 2026-08-09 against the spec repo's main after the F15/F16/F17
 * landing (v0.7.1 added the T2 out-of-range case, v0.8.0 added the UR-4 hold-pending chain case —
 * 46 → 48 cases). `validity.json` was untouched by that landing, so its digest did not move.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  'application.json': '282269ca13abded438a8d4869c4a607d1fe8256021c048021fff7834be793e7a',
  'validity.json': '9acc6af188941b413a0f5d2275cb116c75fe82812dc3afccd69ced3725533c35',
}

describe('vendored vector checksum (D33, Appendix G.1)', () => {
  for (const [file, expected] of Object.entries(PINNED_SHA256)) {
    it(`${file} matches its Appendix G.1 digest`, () => {
      const path = fileURLToPath(new URL(`../vectors/${file}`, import.meta.url))
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
      expect(
        actual,
        `${file} has drifted from the pinned digest — re-vendor from the spec repo`,
      ).toBe(expected)
    })
  }
})
