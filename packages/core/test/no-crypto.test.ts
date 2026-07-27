/**
 * D12: `core` is crypto-free. Hash and signature functions are injected by the caller.
 *
 * `biome.json` already forbids these imports under `packages/*​/src/**`, but that rule sits in
 * biome's `nursery` tier, where rules get promoted and renamed between minor versions. A bump that
 * moves `noRestrictedImports` out of `nursery` makes the config key unknown, and the ban stops
 * applying — silently, since an unknown key is not itself an error. The guarantee is load-bearing
 * enough (it is what makes the package usable in a browser without a polyfill, and what keeps key
 * handling out of this codebase entirely) to be worth asserting directly rather than delegating.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** Matches `from 'node:crypto'`, `from "crypto"`, and the dynamic and require forms. */
const CRYPTO_IMPORT = /(?:from|import|require)\s*\(?\s*['"](?:node:)?crypto['"]/

describe('D12 — core is crypto-free', () => {
  const files = readdirSync(SRC).filter((n) => n.endsWith('.ts'))

  it('has source files to check, so the assertion below is not vacuous', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} imports no crypto module`, () => {
      const source = readFileSync(join(SRC, file), 'utf8')
      expect(CRYPTO_IMPORT.test(source), `${file} must not import crypto (D12)`).toBe(false)
    })
  }
})
