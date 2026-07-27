/**
 * Content arbitraries for the Phase 2 gate.
 *
 * The property is only as good as the generator, and the default ones produce boring input —
 * exactly what the hand-written tests already cover. These are biased toward the case T1 exists to
 * catch: **repeated and adjacent-duplicate lines**, which make a hunk's context ambiguous and which
 * hand-written tests almost never produce.
 */

import fc from 'fast-check'

/** Join lines into content. An empty line list is empty content, never a lone newline. */
export function join(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return ''
  return trailingNewline ? `${lines.join('\n')}\n` : lines.join('\n')
}

/**
 * A tiny alphabet, so collisions are frequent rather than incidental.
 *
 * Includes the empty line (a blank line in the content) and, deliberately, several strings that
 * look like diff syntax — a content line reading `--- a/content` or `\ No newline at end of file`
 * must survive being diffed and reapplied, and is the obvious way to confuse a line-oriented
 * matcher.
 */
const REPEATY_LINE = fc.constantFrom(
  'a',
  'b',
  'c',
  '',
  ' ',
  '\t',
  'a\r', // CRLF survivor: PB-1 forbids normalising it away
  'ä—é', // non-ASCII, including an em dash
  '😀', // astral, a surrogate pair
  '```', // a backtick fence inside the content
  '````',
  '--- a/content',
  '+++ b/content',
  '@@ -1 +1 @@',
  '-a',
  '+a',
  ' a',
  '\\ No newline at end of file',
)

/** Content built from the repeat-heavy alphabet: 0–40 lines, with or without a trailing newline. */
export const repeatyContent: fc.Arbitrary<string> = fc
  .tuple(fc.array(REPEATY_LINE, { maxLength: 40 }), fc.boolean())
  .map(([lines, nl]) => join(lines, nl))

/**
 * A pair of contents drawn from one globally distinct line pool.
 *
 * Every line in `a`, in `b`, and in every intermediate state of a multi-hunk application is
 * therefore unique, so no hunk pattern can occur more than once and **T1 can never fire**. That
 * makes "must apply, must equal `b`" a total obligation for this arbitrary, which is the guard
 * against an implementation that passes the round-trip by halting on everything.
 */
export const distinctPair: fc.Arbitrary<{ a: string; b: string }> = fc
  .uniqueArray(fc.integer({ min: 0, max: 400 }), { maxLength: 24 })
  .chain((ids) => {
    const pool = ids.map((n) => `L${n}`)
    const mask = fc.array(fc.boolean(), { minLength: pool.length, maxLength: pool.length })
    return fc.tuple(mask, mask, fc.boolean(), fc.boolean()).map(([maskA, maskB, nlA, nlB]) => ({
      a: join(
        pool.filter((_, i) => maskA[i] === true),
        nlA,
      ),
      b: join(
        pool.filter((_, i) => maskB[i] === true),
        nlB,
      ),
    }))
  })
