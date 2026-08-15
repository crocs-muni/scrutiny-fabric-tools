/**
 * Runs the vendored `vectors/application.json` corpus's `kind: "chain"` cases (Appendix G) against
 * `resolve`.
 *
 * G.2: `expect.chain`/`expect.overlays` pin only the fields a case is about, never asserted as a
 * full-object match. G.3: every case's expectation MUST hold under any permutation of `events` —
 * "a runner that only tries the given order has not run the corpus" — so each case is resolved
 * against the given order, the fully-reversed order, and several random shuffles, asserting all of
 * them are deep-equal to each other before checking any of them against the vector's `expect`.
 */

import { describe, expect, it } from 'vitest'
import type { Resolution } from '../src/resolve.js'
import { resolve } from '../src/resolve.js'
import type { ChainCase } from './_vector-cases.js'
import { permutationsOf, vectorCases } from './_vector-cases.js'
import { loadVectors } from './_vectors.js'

const cases = vectorCases<ChainCase>(loadVectors(), 'application.json').filter(
  (c) => c.kind === 'chain',
)

/** Assert only the keys `expected` names, against whatever shape `actual` happens to carry. */
function assertPartial(actual: unknown, expected: Record<string, unknown>, ctx: string): void {
  const a = actual as Record<string, unknown>
  for (const [key, value] of Object.entries(expected)) {
    expect(a[key], `${ctx} — field "${key}"`).toEqual(value)
  }
}

/**
 * The vector corpus names an *annotation* by the one rule ID that headlines its kind — H2 for a
 * protocol-error annotation, SF-3 for a self-fork report, RL-3 for a resource-limit report — never
 * by an arbitrary issue code nested inside it. Confirmed empirically: across every `chain` case in
 * `application.json`, `annotations`/`noAnnotations` use exactly these three values and no others.
 * H2 in particular is never itself an emitted issue code (#36 §9 — it is satisfied by the
 * annotation's *shape*, carrying event id/author/reason, not by a code inside it), so checking for
 * the literal string "H2" in `issues[].code` would always fail regardless of correctness.
 */
const ANNOTATION_KIND: Readonly<Record<string, string>> = {
  H2: 'protocol-error',
  'SF-3': 'self-fork',
  'RL-3': 'resource-limit',
}

function hasAnnotation(annotations: Resolution['annotations'], rule: string): boolean {
  const kind = ANNOTATION_KIND[rule]
  if (kind === undefined) {
    throw new Error(`unrecognised annotations/noAnnotations rule id in a vector: ${rule}`)
  }
  return annotations.some((a) => a.kind === kind)
}

describe('conformance vectors — application.json, kind: chain (Appendix G)', () => {
  it('loads the corpus', () => {
    expect(Array.isArray(cases)).toBe(true)
  })

  for (const c of cases) {
    it(`${c.name} (${c.rule})`, () => {
      const options = c.options ?? {}
      const permutations = permutationsOf(c.events)
      const results = permutations.map((events) => resolve(c.rootId, events, options))

      // G.3 confluence, checked directly against this vector's own event set rather than a
      // generated one — every permutation must agree with the given order.
      for (const r of results) {
        expect(r, `${c.why} — confluence: a permutation of events changed the result`).toEqual(
          results[0],
        )
      }

      const result = results[0]
      if (result === undefined) throw new Error('unreachable: permutationsOf never returns []')

      if (c.expect.chain !== undefined) {
        expect(result.chain.status, c.why).toBe(c.expect.chain.status)
        assertPartial(result.chain, c.expect.chain, c.why)
      }

      if (c.expect.pending !== undefined) {
        expect(
          result.pending,
          `${c.why} — held patches (UR-2/UR-4) differ from the case's expectation`,
        ).toEqual([...c.expect.pending].sort())
      }

      if (c.expect.overlays !== undefined) {
        const byId = new Map(result.overlays.map((o) => [o.id, o]))
        for (const expected of c.expect.overlays) {
          const actual = byId.get(expected.id)
          expect(actual, `${c.why} — overlay ${expected.id} not found`).toBeDefined()
          assertPartial(actual, expected, c.why)
        }
      }

      for (const rule of c.expect.annotations ?? []) {
        expect(hasAnnotation(result.annotations, rule), `${c.why} — must annotate ${rule}`).toBe(
          true,
        )
      }
      for (const rule of c.expect.noAnnotations ?? []) {
        expect(
          hasAnnotation(result.annotations, rule),
          `${c.why} — must not annotate ${rule}`,
        ).toBe(false)
      }
    })
  }
})
