/**
 * The Phase 2 gate: `applyPatch(a, makePatch(a, b)) === b`.
 *
 * Stated carefully, because the naive form is wrong. `makePatch(a, b)` can legitimately produce a
 * patch whose context is ambiguous in `a` — that is precisely the situation T1 exists to reject —
 * and there a HALT is the *correct* answer, so asserting `=== b` unconditionally would assert that
 * the determinism gate must not work.
 *
 * The obligation is therefore split across two arbitraries:
 *
 * - `distinctPair` draws both sides from one globally unique line pool, so no pattern can ever
 *   occur twice and T1 can never fire. Applying is a **total obligation**: any halt is a bug. This
 *   is what stops an implementation from passing by halting on everything.
 * - `repeatyContent` is biased hard toward repeated lines. There, `applied ⟹ content === b`, and
 *   a halt is permitted — but the halt *rate* is bounded separately, so a degenerate implementation
 *   still fails.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type ApplyResult, applyPatchPayload, makePatch } from '../src/patch.js'
import { distinctPair, repeatyContent } from './_generators.js'
import { describeResult } from './_patch.js'

const roundTrip = (a: string, b: string): ApplyResult => applyPatchPayload(a, makePatch(a, b))

/**
 * Built only on the failing branch.
 *
 * These properties run 18 000 cases between them over inputs of up to 40 lines a side, so
 * serialising both sides unconditionally to fill in an assertion message that is read only on
 * failure is the single most expensive thing in the file.
 */
const ctx = (a: string, b: string, r: ApplyResult): string =>
  `${JSON.stringify({ a, b })} → ${describeResult(r)}`

describe('Phase 2 gate — applyPatch(a, makePatch(a, b)) === b', () => {
  it('always applies, and reproduces b exactly, when no line repeats', () => {
    fc.assert(
      fc.property(distinctPair, ({ a, b }) => {
        const result = roundTrip(a, b)
        if (result.status === 'noop') {
          if (a !== b) expect(a, ctx(a, b, result)).toBe(b)
          return
        }
        if (result.status !== 'applied') expect.fail(ctx(a, b, result))
        if (result.content !== b) expect(result.content, ctx(a, b, result)).toBe(b)
      }),
      { numRuns: 3_000 },
    )
  })

  it('reproduces b exactly whenever it applies, over repeat-heavy content', () => {
    fc.assert(
      fc.property(repeatyContent, repeatyContent, (a, b) => {
        const result = roundTrip(a, b)
        if (result.status === 'limit') expect.fail(ctx(a, b, result))
        if (result.status === 'applied' && result.content !== b) {
          expect(result.content, ctx(a, b, result)).toBe(b)
        }
        if (result.status === 'noop' && a !== b) expect(a, ctx(a, b, result)).toBe(b)
      }),
      { numRuns: 10_000 },
    )
  })

  it('does not reach the round trip by halting on everything', () => {
    // A degenerate implementation that halts unconditionally satisfies "applied ⟹ correct". This
    // measures the rate instead: over repeat-heavy content most pairs are still unambiguous, so a
    // gate that never applies fails here even though the clause above would pass.
    const seen = { applied: 0, halt: 0, noop: 0, limit: 0 }
    fc.assert(
      fc.property(repeatyContent, repeatyContent, (a, b) => {
        seen[roundTrip(a, b).status]++
      }),
      { numRuns: 2_000 },
    )
    const total = seen.applied + seen.halt + seen.noop + seen.limit
    console.log(`round-trip outcomes over ${total} pairs: ${JSON.stringify(seen)}`)
    expect(seen.applied / total).toBeGreaterThan(0.5)
  })

  it('is a no-op whenever a === b', () => {
    fc.assert(
      fc.property(repeatyContent, (a) => {
        const result = roundTrip(a, a)
        if (result.status !== 'noop') expect.fail(ctx(a, a, result))
        if (result.content !== a) expect(result.content, JSON.stringify(a)).toBe(a)
      }),
      { numRuns: 2_000 },
    )
  })

  it('is pure — the same input yields the same result twice', () => {
    fc.assert(
      fc.property(repeatyContent, repeatyContent, (a, b) => {
        const payload = makePatch(a, b)
        expect(applyPatchPayload(a, payload)).toEqual(applyPatchPayload(a, payload))
      }),
      { numRuns: 1_000 },
    )
  })

  it('never throws, whatever bytes it is handed as a payload', () => {
    // The weakest property here, and it earns its place only because the payload is
    // adversary-controlled: SCRUTINY is permissionless, and jsdiff throws on three separate shapes.
    fc.assert(
      fc.property(repeatyContent, fc.string({ maxLength: 200 }), (content, payload) => {
        expect(() => applyPatchPayload(content, payload)).not.toThrow()
      }),
      { numRuns: 5_000 },
    )
  })
})
