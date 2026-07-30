/**
 * Runs the vendored `vectors/validity.json` corpus (Appendix G) against `validateEvent`.
 *
 * D33/G.1: vendored at a pinned checksum (see `vectors-checksum.test.ts`), skipping cleanly when
 * absent (`_vectors.ts`). G.2's `mustEmit`/`mustNotEmit` are containment, not equality — an
 * implementation reporting additional advisory issues still conforms.
 */

import { describe, expect, it } from 'vitest'
import { validateEvent } from '../src/validate.js'
import type { ValidityCase } from './_vector-cases.js'
import { vectorCases } from './_vector-cases.js'
import { loadVectors } from './_vectors.js'

const cases = vectorCases<ValidityCase>(loadVectors(), 'validity.json')

describe('conformance vectors — validity.json (Appendix G)', () => {
  it('loads the corpus', () => {
    expect(Array.isArray(cases)).toBe(true)
  })

  for (const c of cases) {
    it(`${c.name} (${c.rule})`, () => {
      const byId = new Map((c.observed ?? []).map((e) => [e.id, e]))
      const result = validateEvent(c.event, { lookupEvent: (id) => byId.get(id) })

      expect(result.status, c.why).toBe(c.expect.status)

      const codes = result.status === 'not-scrutiny' ? [] : result.issues.map((i) => i.code)
      for (const code of c.expect.mustEmit ?? []) {
        expect(codes, `${c.why} — must emit ${code}`).toContain(code)
      }
      for (const code of c.expect.mustNotEmit ?? []) {
        expect(codes, `${c.why} — must not emit ${code}`).not.toContain(code)
      }

      if (c.expect.awaiting !== undefined) {
        expect(result.status, 'awaiting is only meaningful for a pending verdict').toBe('pending')
        if (result.status === 'pending') {
          expect([...result.awaiting].sort()).toEqual([...c.expect.awaiting].sort())
        }
      }
    })
  }
})
