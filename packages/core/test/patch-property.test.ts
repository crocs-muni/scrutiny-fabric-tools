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
import { buildPatch } from '../src/build.js'
import { type Hunk, occurrences, spliceAt, toLines, widenContext } from '../src/patch-matcher.js'
import { type ApplyResult, applyPatchContent, applyPatchPayload, makePatch } from '../src/patch.js'
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

const PROD_ROOT = { id: 'a'.repeat(64) } as const
const PROD_REPLY = { id: 'b'.repeat(64) } as const

/**
 * Independent oracle for CONTEXT-WIDENING.md §6: evaluates "resolved" by threading lines across
 * the exact hunks `widenContext` returned — the same T3 sequencing `applyPatchPayload` uses —
 * without re-running `build.ts`'s own trial. If a pattern is ambiguous under this scan, no
 * widening verdict can legitimately say otherwise; this is what keeps the property honest
 * against the implementation, per §6's "re-derived independently in the test."
 */
function threadedSayUnique(a: string, hunks: readonly Hunk[]): boolean {
  let lines = toLines(a)
  for (const hunk of hunks) {
    if (hunk.oldPat.length === 0) continue
    const found = occurrences(lines, hunk.oldPat)
    if (found.count !== 1) return false
    const spliced = spliceAt(lines, hunk, found.first)
    if (!spliced.ok) return false
    lines = spliced.lines
  }
  return true
}

describe('Phase 18 gate — buildPatch’s widening agrees with an independent verdict (CONTEXT-WIDENING.md §6)', () => {
  it('resolved ⟺ no P4 ⟺ the template applies to `after`, over repeat-heavy pairs', () => {
    fc.assert(
      fc.property(repeatyContent, repeatyContent, (a, b) => {
        const res = widenContext(a, b, 3, 1 << 22)
        const { template, issues } = buildPatch({
          root: PROD_ROOT,
          reply: PROD_REPLY,
          before: a,
          after: b,
          createdAt: 1,
          maxWidenWork: 1 << 22,
        })
        const p4s = issues.filter((i) => i.code === 'P4')
        if (res.exhausted) return // the budget-cut fallback (P4 verbatim) is pinned deterministically in build.test.ts
        expect(threadedSayUnique(a, res.hunks)).toBe(true) // independently computed verdict
        expect(p4s).toEqual([])
        const applied = applyPatchContent(a, template.content)
        const reproduced =
          applied.status === 'noop' ? a : applied.status === 'applied' ? applied.content : undefined
        expect(reproduced).toBe(b)
      }),
      { numRuns: 2_000 },
    )
  })
})
