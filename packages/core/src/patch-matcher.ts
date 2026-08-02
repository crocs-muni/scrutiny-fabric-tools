/**
 * Shared line/hunk matching primitives (`patch.ts`'s T1 machinery, extracted for `build.ts`'s
 * widening loop — `docs/CONTEXT-WIDENING.md` §1).
 *
 * **This module is internal and is never added to the `exports` map — the identical treatment D32
 * already gives `./patch` (CONTEXT-WIDENING.md §1.1).** Nothing in it is a port, a type contract
 * for external implementers, or anything a consumer would construct: it is pure arithmetic on
 * string arrays, owned by neither caller (`patch.ts`'s applier and `build.ts`'s widening loop both
 * import from here; `build.ts` never imports `diff` for this).
 *
 * `parseHunks` stays in `patch.ts` (the widening loop never parses untrusted payload text —
 * `diffHunks` hands it hunks straight from `structuredPatch`). `MalformedPayload` lives here
 * rather than in `patch.ts` because its only raiser, `reduceHunk`, moved here; the intent the
 * mini-spec records ("the parse channel stays in `patch.ts`") is preserved — `patch.ts` imports
 * the class for its `parseHunks`/`applyPatchPayload` catch.
 */

import { structuredPatch } from 'diff'

/**
 * Split content into lines, exactly invertible by {@link fromLines}.
 *
 * `''` → `['']`, `'a\n'` → `['a','']`, `'a\nb'` → `['a','b']`. The trailing `''` element *is* the
 * trailing-newline bit, and it is never itself a line of a diff — which is the whole of the C5
 * mechanism (see {@link spliceAt}). No normalisation of any kind is performed: PB-1 and PB-2 forbid
 * it, so a CRLF payload keeps its `\r` and simply fails to match LF content, which is the correct
 * outcome and is detected at match time where the evidence exists.
 */
export function toLines(content: string): string[] {
  return content.split('\n')
}

export function fromLines(lines: readonly string[]): string {
  return lines.join('\n')
}

/**
 * The number of *lines* in a {@link toLines} array, excluding the trailing-newline bit.
 *
 * `lines.length` is lines-plus-terminator, so it moves by one whenever a hunk changes only the
 * trailing-newline state (C5) without adding or removing a line. T2's carry-forward is defined over
 * the net **line** delta, so it must count lines, not array elements — see the `shift` bookkeeping in
 * `patch.ts`'s `applyPatchPayload`.
 */
export function lineCount(lines: readonly string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

export interface Hunk {
  /** Bodies of the `' '` and `'-'` lines: the pattern T1 requires to occur exactly once. */
  readonly oldPat: readonly string[]
  /** Bodies of the `' '` and `'+'` lines. */
  readonly newRep: readonly string[]
  readonly oldNoEol: boolean
  readonly newNoEol: boolean
  /** 0-based insertion index, used only when `oldPat` is empty (T2). */
  readonly insertAt: number
}

export class MalformedPayload extends Error {}

/**
 * Reduce a parsed or `structuredPatch`-produced hunk to its pattern, replacement and end-of-file
 * flags. Consumes both channels identically: `parsePatch`'s reconstructed hunks and
 * `structuredPatch`'s own `hunks` array are shape-identical (`{oldStart, oldLines, lines}`,
 * verified live against `diff@9.0.0` — `formatPatch` does not transform `hunk.lines`), so one
 * reducer serves both the parse channel (`patch.ts`) and the widening channel (`build.ts`).
 *
 * Three parser details, all verified against `diff@9.0.0`:
 *
 * - The `\ No newline at end of file` marker is a literal element of `hunk.lines`, placed
 *   immediately after the line it qualifies, and emitted twice when both sides lack the newline.
 * - **Any** line whose first character is `\` is treated as that marker, rather than comparing the
 *   English text. GNU diff and git localise the message, and §5.2's grammar admits `\` as a
 *   hunk-line prefix without constraining what follows it.
 * - A wholly empty element `''` is a context line with an empty body, not a malformed line.
 *   Producers strip the trailing space from an empty context line and mail and editor pipelines do
 *   it unconditionally, so this is common in the wild; jsdiff preserves it verbatim.
 */
export function reduceHunk(raw: { oldStart: number; oldLines: number; lines: string[] }): Hunk {
  const oldPat: string[] = []
  const newRep: string[] = []
  let oldNoEol = false
  let newNoEol = false
  let side: 'old' | 'new' | 'both' | null = null

  for (const line of raw.lines) {
    if (line.startsWith('\\')) {
      if (side === 'old' || side === 'both') oldNoEol = true
      if (side === 'new' || side === 'both') newNoEol = true
      continue
    }
    const body = line.slice(1)
    switch (line[0]) {
      case undefined: // '' — a context line whose trailing space was stripped.
        oldPat.push('')
        newRep.push('')
        side = 'both'
        break
      case ' ':
        oldPat.push(body)
        newRep.push(body)
        side = 'both'
        break
      case '-':
        oldPat.push(body)
        side = 'old'
        break
      case '+':
        newRep.push(body)
        side = 'new'
        break
      default:
        throw new MalformedPayload(`hunk line has no recognised prefix: ${JSON.stringify(line)}`)
    }
  }

  // For a pure insertion jsdiff reports `oldStart = L + 1` where the header said `-L,0`, following
  // the unified-diff convention that `-L,0` means "insert after old line L". Verified: `-0,0` → 1,
  // `-5,0` → 6, `-1,0` → 2. The 0-based splice index is therefore `oldStart - 1`.
  return { oldPat, newRep, oldNoEol, newNoEol, insertAt: raw.oldStart - 1 }
}

/** Where `pattern` occurs in `lines`. `first`/`second` are `-1` when there is no such match. */
export interface Occurrences {
  readonly count: number
  readonly first: number
  readonly second: number
}

/**
 * Count every index at which `pattern` occurs in `lines`, counting overlaps independently.
 *
 * The scan is complete and never exits early — the count *is* T1's evidence. Only the first two
 * indices are retained, because those are all the verdict and its message need: on adversarial
 * content (every line identical, a one-line pattern) the match list would otherwise grow to the
 * length of the content, allocating megabytes to describe a failure.
 */
export function occurrences(lines: readonly string[], pattern: readonly string[]): Occurrences {
  let count = 0
  let first = -1
  let second = -1
  const k = pattern.length
  for (let i = 0; i + k <= lines.length; i++) {
    let match = true
    for (let j = 0; j < k; j++) {
      if (lines[i + j] !== pattern[j]) {
        match = false
        break
      }
    }
    if (!match) continue
    count++
    if (first === -1) first = i
    else if (second === -1) second = i
  }
  return { count, first, second }
}

export type SpliceOutcome = { ok: true; lines: string[] } | { ok: false; detail: string }

/**
 * Replace `oldPat` at `at` with `newRep`, reconciling the trailing-newline state (C5).
 *
 * Because `toLines` puts the trailing-newline bit in a final `''` element, and that element is
 * never itself a line of a diff, `at + |oldPat| === |lines|` holds exactly when the current content
 * has *no* trailing newline and this hunk covers its last line.
 */
export function spliceAt(lines: readonly string[], hunk: Hunk, at: number): SpliceOutcome {
  const end = at + hunk.oldPat.length
  const atEnd = end === lines.length
  const head = lines.slice(0, at)

  if (hunk.oldNoEol) {
    // The old side asserts it ends the file without a newline. The match must agree.
    if (!atEnd) {
      return {
        ok: false,
        detail:
          'the hunk carries "\\ No newline at end of file" on its old side, but its pattern does ' +
          'not match at the end of the content',
      }
    }
    // Absent a marker on the new side, the patch asserts the new content *is* newline-terminated.
    return { ok: true, lines: [...head, ...hunk.newRep, ...(hunk.newNoEol ? [] : [''])] }
  }

  if (hunk.newNoEol) {
    // The new side ends the file without a newline, so the current terminator must be consumed.
    // Two ways the match can sit at the end: the pattern already runs to the last element, or it
    // stops exactly on the trailing `''` that carries the newline bit. Dropping the tail does both.
    if (atEnd || (end === lines.length - 1 && lines[end] === '')) {
      return { ok: true, lines: [...head, ...hunk.newRep] }
    }
    return {
      ok: false,
      detail:
        'the hunk carries "\\ No newline at end of file" on its new side, but its pattern does ' +
        'not match at the end of the content',
    }
  }

  return { ok: true, lines: [...head, ...hunk.newRep, ...lines.slice(end)] }
}

/**
 * Produce this pair's hunks at a given context, without formatting to text. Both callers need the
 * reduced `Hunk` shape; only `patch.ts`'s `makePatch` additionally needs the raw `StructuredPatch`
 * object (for `formatPatch`), so `diffHunks` wraps `structuredPatch` for the caller that doesn't.
 */
export function diffHunks(before: string, after: string, context: number): readonly Hunk[] {
  return structuredPatch('a/content', 'b/content', before, after, '', '', { context }).hunks.map(
    reduceHunk,
  )
}
