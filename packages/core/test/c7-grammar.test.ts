/**
 * C7 grammar conformance — the second Phase 2 gate item, carried over from Phase 1.
 *
 * C7 obliges a consumer to accept **any** payload matching §5.2's consumer grammar. Phase 1 covered
 * that with fixtures for the shapes someone thought of, which is a materially weaker claim: it
 * proves acceptance of the cases considered, not of every payload the grammar admits. This emits
 * from the grammar productions instead and asserts no `error`-severity issue for any of them.
 *
 * A line body is any sequence of characters other than LF. This was reported as SPEC-FEEDBACK F3
 * against v0.6.0, whose `*VCHAR` was ABNF `%x21-7E` — excluding the space and every non-ASCII
 * byte, and so rejecting the spec's own em-dash example and the `patch -u` timestamps C2 mandates
 * tolerating. **v0.6.1 closed F3 by defining `line-content = *( %x00-09 / %x0B-FF )`**, so this
 * generator now emits from the grammar as written rather than from a reading of it.
 *
 * Note what this does and does not prove. It tests *our reading* of the grammar, so it is paired
 * with the fixtures in `patch-grammar.test.ts` for the two shapes most likely to be wrongly
 * rejected — the N2 header-only block and the zero-context hunk — both of which are also seeded
 * into the generator below.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Issue } from '../src/errors.js'
import { hasError } from '../src/errors.js'
import { MINIMAL_PAYLOAD, fenced, issuesOf, lookup, patch, product } from './_fixtures.js'

const ROOT = product()
/** Hoisted: `lookup` builds a Map and a closure, and the property below runs 10 000 times. */
const OPTS = lookup(ROOT)

const issuesFor = (payload: string): Issue[] =>
  issuesOf(patch(ROOT.id, ROOT.id, fenced(payload)), OPTS)

const errorsFor = (payload: string): string[] =>
  issuesFor(payload)
    .filter((i) => i.severity === 'error')
    .map((i) => `${i.code}: ${i.message}`)

/** A line body: any sequence of characters other than LF (F3), including none. */
const lineBody = fc.oneof(
  fc.constant(''),
  fc.constant('a'),
  fc.constant('Infineon M7794A12 — Rev B (BSI-DSZ-CC-0814-2012, CC EAL4+)'), // the spec's example
  fc.constant('  leading and trailing  '),
  fc.constant('😀 astral'),
  fc.constant('a\tb'),
  fc.string({ maxLength: 12 }).map((s) => s.replace(/\n/g, '')),
)

/** `trailing = SP *VCHAR` — tolerated and ignored: timestamps, whitespace (C2). */
const trailing = fc.oneof(
  fc.constant(''),
  fc.constant('\t2026-07-27 12:00:00 +0200'), // the patch -u form C2 names explicitly
  fc.constant(' '),
  fc.constant('  some trailing words'),
)

const hunkLine = fc.oneof(
  lineBody.map((b) => ` ${b}`),
  lineBody.map((b) => `+${b}`),
  lineBody.map((b) => `-${b}`),
  fc.constant('\\ No newline at end of file'),
)

const lineno = fc.integer({ min: 0, max: 999 })
const count = fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined })

/** `hunk-header LF *hunk-line`, including the zero-hunk-line and zero-context shapes. */
const hunkBlock = fc
  .tuple(lineno, count, lineno, count, trailing, fc.array(hunkLine, { maxLength: 6 }))
  .map(([oldStart, oldCount, newStart, newCount, tail, lines]) => {
    const old = oldCount === undefined ? `${oldStart}` : `${oldStart},${oldCount}`
    const nw = newCount === undefined ? `${newStart}` : `${newStart},${newCount}`
    return [`@@ -${old} +${nw} @@${tail}`, ...lines].join('\n')
  })

/**
 * `patch-payload = [ index-preamble ] [ diff-git-line ] header-block *hunk-block`
 *
 * Every optional production is independently present or absent, and the hunk count includes zero —
 * which is N2, the shape C7 calls out by name.
 */
const grammarPayload = fc
  .tuple(
    fc.boolean(), // index-preamble
    fc.boolean(), // diff-git-line
    trailing,
    trailing,
    trailing,
    fc.array(hunkBlock, { maxLength: 4 }),
  )
  .map(([hasIndex, hasDiffGit, t1, t2, t3, hunks]) =>
    [
      ...(hasIndex ? ['Index: content', '='.repeat(67)] : []),
      ...(hasDiffGit ? [`diff --git a/content b/content${t1}`] : []),
      `--- a/content${t2}`,
      `+++ b/content${t3}`,
      ...hunks,
    ].join('\n'),
  )

/** The two shapes most likely to be wrongly rejected, asserted directly as well as generated. */
const SEEDS = [
  '--- a/content\n+++ b/content', // N2: header block, zero hunks
  MINIMAL_PAYLOAD, // zero context (the spec's own example)
]

describe('C7 — a conforming consumer accepts any payload matching the §5.2 grammar', () => {
  it('rejects none of the seeded shapes', () => {
    for (const payload of SEEDS) {
      expect(errorsFor(payload), payload).toEqual([])
    }
  })

  it('rejects no payload the grammar admits', () => {
    fc.assert(
      fc.property(grammarPayload, (payload) => {
        const issues = issuesFor(payload)
        if (!hasError(issues)) return
        expect(
          issues.filter((i) => i.severity === 'error').map((i) => `${i.code}: ${i.message}`),
          `C7 requires acceptance of:\n${payload}`,
        ).toEqual([])
      }),
      { numRuns: 10_000 },
    )
  })

  it('still rejects what a rule explicitly forbids, so the property is not vacuous', () => {
    // §5.2's grammar is a floor on acceptance, not a ceiling. If nothing were ever rejected the
    // property above would pass trivially, so this pins the other side: P2's forbidden git
    // metadata and C1's wrong path token remain errors.
    const forbidden = [
      'index 7ebcdab..331da67 100644\n--- a/content\n+++ b/content',
      '--- a/wrong\n+++ b/content',
    ]
    for (const payload of forbidden) {
      expect(hasError(issuesFor(payload)), payload).toBe(true)
    }
  })
})
