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
 * Pinned in Appendix G.1. Re-vendored 2026-08-21 from the spec repo's scrutiny-v0.8.0 release
 * (the spec repo's main at commit cd996e1). The spec's released corpus deliberately keeps
 * `scrutiny-v0.7.0` tags inside the fixture events (the `specVersion` field stays `0.6.1` for
 * the same reason — freezing corpus cosmetics so vectors exercise lower-version acceptance on
 * newer implementations). A prior commit (061390e) retagged the events to v0.8.0, breaking the
 * byte-pinned digest; this restores the spec's verbatim bytes (48 application cases,
 * 19 validity cases).
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  'application.json': '546e29f6ee4a898218646fac1ae0342554c1c186bc3e72286aaa5e6b541de0ce',
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
