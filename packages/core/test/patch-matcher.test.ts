/**
 * `patch-matcher.ts` — the extraction's own gates (#42 §1/§6): that `diffHunks`
 * may feed `reduceHunk` hunks it was designed against a *parsed* shape for, because
 * `structuredPatch`'s own `hunks` array is shape-identical to what `parsePatch` reconstructs from
 * the formatted text. Verified live against `diff@9.0.0`, per the mini-spec's own standard.
 */

import { formatPatch, parsePatch, structuredPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { diffHunks, reduceHunk } from '../src/patch-matcher.js'

/** The fields `reduceHunk` (and every hunk-index assertion anywhere) actually reads. */
const hunkShape = (h: { oldStart: number; oldLines: number; lines: string[] }) => ({
  oldStart: h.oldStart,
  oldLines: h.oldLines,
  lines: h.lines,
})

const CASES: ReadonlyArray<{ name: string; before: string; after: string }> = [
  {
    name: 'single edit, ample context',
    before: 'a\nb\nc\nd\ne\nf\ng\n',
    after: 'a\nb\nc\nD\ne\nf\ng\n',
  },
  {
    name: 'two edits far enough apart to stay two hunks',
    before: 'h1\nh2\nold\nm1\nm2\nm3\nm4\nold\nt1\nt2\n',
    after: 'h1\nh2\nnew1\nm1\nm2\nm3\nm4\nnew2\nt1\nt2\n',
  },
  {
    name: 'EOF newline state differs — "\\ No newline at end of file" placement',
    before: 'a\nb',
    after: 'a\nb\n',
  },
  {
    name: 'pure insertion (T2 territory)',
    before: 'a\nc\n',
    after: 'a\nb\nc\n',
  },
]

describe('structuredPatch hunks ≡ parsePatch∘formatPatch hunks (diff@9.0.0, #42 §6)', () => {
  for (const { name, before, after } of CASES) {
    it(name, () => {
      for (const context of [0, 1, 3, 10]) {
        const direct = structuredPatch('a/content', 'b/content', before, after, '', '', {
          context,
        }).hunks.map(hunkShape)
        const textual = parsePatch(
          formatPatch(
            structuredPatch('a/content', 'b/content', before, after, '', '', { context }),
          ),
        ).flatMap((f) => f.hunks.map(hunkShape))
        expect(textual).toEqual(direct)
      }
    })
  }

  it('diffHunks reduces each direct hunk without throwing, with insertAt = oldStart - 1', () => {
    const { before, after } = CASES[0] as { before: string; after: string }
    const direct = structuredPatch('a/content', 'b/content', before, after, '', '', {
      context: 3,
    }).hunks
    const reduced = diffHunks(before, after, 3)
    expect(reduced.length).toBe(direct.length)
    for (const [i, raw] of direct.entries()) {
      expect(reduced[i]).toEqual(reduceHunk(raw))
      expect(reduced[i]?.insertAt).toBe(raw.oldStart - 1)
    }
  })
})
