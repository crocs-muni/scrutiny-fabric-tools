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
 * Pinned in Appendix G.1, re-verified 2026-08-02 against the spec repo's `fix/spec-feedback-f13-f14`
 * branch (landed F13/F14, spec v0.7.0) — the vectors were regenerated under the amended version-tag
 * scheme, so their digests moved even though F13/F14 did not otherwise touch these two files' cases.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  'application.json': '969e93e95a3b818daedda8a7b47d3cfcafcfc0d5b3848e1e13a5d4fcffaefdf9',
  'validity.json': 'bff8eaca6c85e8676c15b63b87f836a59a45d4ea9117b0bce8807eb9d4b43f1e',
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
