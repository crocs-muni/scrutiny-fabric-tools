/**
 * §5.3 patch application — the T1/T2/T3 determinism gate.
 *
 * **This module is internal and is never added to the `exports` map (D32).** Exposing the applier
 * invites callers to bypass the determinism gate §5.3 says implementations MUST enforce.
 *
 * The gate is hand-written and sits *above* the applier (D30). No stock tool can enforce T1:
 * verified against `diff@9.0.0`, `applyPatch` silently relocates a hunk by context match and picks
 * one of two equally good positions without reporting anything, and its cross-hunk offset
 * bookkeeping corrupts content outright when hunks arrive out of order. jsdiff is therefore used
 * for exactly two things — parsing a payload into hunks, and producing one — with every matching,
 * uniqueness and application decision made here.
 *
 * The full design, including the verified jsdiff transcripts behind each of those claims, is in
 * `docs/PATCH-MATCHER.md`.
 */

import { formatPatch, parsePatch, structuredPatch } from 'diff'
import { type Issue, issue } from './errors.js'
import { findPatchPayload } from './validate.js'

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Why a patch failed to apply. Each maps to one rule; see {@link PatchHalt.issues}. */
export type HaltReason =
  /** T1: the hunk's pattern occurs nowhere in the current content. */
  | 'no-match'
  /** T1: the pattern occurs two or more times, and `@@` line numbers may not disambiguate. */
  | 'ambiguous-match'
  /** C5: a `\ No newline at end of file` marker contradicts where the hunk actually matched. */
  | 'eof-mismatch'
  /** The payload could not be parsed, or carries no header block. */
  | 'malformed-payload'

/** Which ceiling was hit. Never a HALT — see {@link PatchLimit}. */
export type LimitKind = 'hunks' | 'work'

/** The rule a halt cites alongside H1. Surfaced so a caller need not re-scan {@link Issue}s. */
export type HaltRule = 'T1' | 'C5' | 'H1'

export interface PatchApplied {
  readonly status: 'applied'
  readonly content: string
  readonly hunksApplied: number
  /** Characters compared, as charged against `maxWork`. */
  readonly work: number
  /** Always empty. Present on every variant so a caller need not switch on `status` to read it. */
  readonly issues: readonly Issue[]
}

export interface PatchNoop {
  readonly status: 'noop'
  /** Unchanged, per N3. */
  readonly content: string
  /** N1 (no fenced block) or N2 (header block, zero hunks). */
  readonly shape: 'prose-only' | 'header-only'
  /** Always empty; see {@link PatchApplied.issues}. */
  readonly issues: readonly Issue[]
}

/**
 * H1 — the patch genuinely failed to apply.
 *
 * Carries no content: §5.3 defines the patched content as "the state after the last successfully
 * applied patch", which only the chain walker knows. H2's protocol-error annotation needs the event
 * id and author, which never reach this module; `resolve.ts` assembles it from these fields.
 */
export interface PatchHalt {
  readonly status: 'halt'
  readonly reason: HaltReason
  /** The specific rule cited alongside H1, derived from `reason` — never passed in. */
  readonly rule: HaltRule
  /** Index of the offending hunk in document order, or `null` if the payload never parsed. */
  readonly hunkIndex: number | null
  readonly detail: string
  /** One issue citing {@link PatchHalt.rule}, one citing H1. Both `warning` — see below. */
  readonly issues: readonly Issue[]
}

/**
 * RL-3 — a configured ceiling was hit before any verdict was reached.
 *
 * Deliberately **not** a halt. §5.4: "Exceeding a ceiling aborts application and MUST be surfaced
 * as a distinct resource-limit-exceeded annotation, never as HALT. The event remains V-valid."
 * Carries no content, which is how RL-4 ("content abandoned for resource reasons MUST NOT be
 * served or cached as canonical bytes") is enforced structurally: there is nothing to cache.
 */
export interface PatchLimit {
  readonly status: 'limit'
  readonly limit: LimitKind
  readonly observed: number
  readonly ceiling: number
  readonly issues: readonly Issue[]
}

/**
 * The outcome of applying one patch payload.
 *
 * Four variants of a union rather than a nullable content plus an error field, so that no call site
 * can read content from a failure and none can treat a resource limit as a HALT.
 */
export type ApplyResult = PatchApplied | PatchNoop | PatchHalt | PatchLimit

/**
 * Ceilings, per §5.4. Defaults are the spec's recommended bounds.
 *
 * RL-2 asks consumers to bound *total work* in bytes compared rather than trusting hunk counts,
 * because an adversary optimises against whichever unit is counted.
 */
export interface ApplyOptions {
  /** §5.4: hunks per patch payload ≤ 64. */
  readonly maxHunks?: number
  /** Characters compared across the whole patch. */
  readonly maxWork?: number
}

const DEFAULT_MAX_HUNKS = 64
const DEFAULT_MAX_WORK = 16 * 1024 * 1024

/** The half of an RL-3 message that must never read like a HALT. §5.4 is emphatic about this. */
const ABANDONED = 'application was abandoned. The event remains valid and this is not a HALT'

// ---------------------------------------------------------------------------
// Line representation
// ---------------------------------------------------------------------------

/**
 * Split content into lines, exactly invertible by {@link fromLines}.
 *
 * `''` → `['']`, `'a\n'` → `['a','']`, `'a\nb'` → `['a','b']`. The trailing `''` element *is* the
 * trailing-newline bit, and it is never itself a line of a diff — which is the whole of the C5
 * mechanism (see {@link spliceAt}). No normalisation of any kind is performed: PB-1 and PB-2 forbid
 * it, so a CRLF payload keeps its `\r` and simply fails to match LF content, which is the correct
 * outcome and is detected at match time where the evidence exists.
 */
function toLines(content: string): string[] {
  return content.split('\n')
}

function fromLines(lines: readonly string[]): string {
  return lines.join('\n')
}

/**
 * The number of *lines* in a {@link toLines} array, excluding the trailing-newline bit.
 *
 * `lines.length` is lines-plus-terminator, so it moves by one whenever a hunk changes only the
 * trailing-newline state (C5) without adding or removing a line. T2's carry-forward is defined over
 * the net **line** delta, so it must count lines, not array elements — see the `shift` bookkeeping in
 * {@link applyPatchPayload}.
 */
function lineCount(lines: readonly string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

// ---------------------------------------------------------------------------
// Hunks
// ---------------------------------------------------------------------------

interface Hunk {
  /** Bodies of the `' '` and `'-'` lines: the pattern T1 requires to occur exactly once. */
  readonly oldPat: readonly string[]
  /** Bodies of the `' '` and `'+'` lines. */
  readonly newRep: readonly string[]
  readonly oldNoEol: boolean
  readonly newNoEol: boolean
  /** 0-based insertion index, used only when `oldPat` is empty (T2). */
  readonly insertAt: number
}

class MalformedPayload extends Error {}

/**
 * Reduce a parsed hunk to its pattern, replacement and end-of-file flags.
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
function reduceHunk(raw: { oldStart: number; oldLines: number; lines: string[] }): Hunk {
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

/**
 * Parse a payload into hunks, normalising every failure channel jsdiff has.
 *
 * Verified behaviours of `diff@9.0.0`:
 *
 * | input | jsdiff | here |
 * |---|---|---|
 * | hunk declaring 3 old lines, carrying 1 | throws | `MalformedPayload` |
 * | unparseable `@@` header | throws | `MalformedPayload` |
 * | `'total garbage\nno headers\n'` | returns `[{hunks: []}]` | `MalformedPayload` |
 *
 * The third row is the dangerous one: header-less garbage parses to zero hunks and would otherwise
 * be indistinguishable from the N2 header-only no-op, silently turning malformed input into
 * "applied cleanly, no change". N2 requires *valid* headers, so their presence is checked against
 * the payload text directly rather than inferred from the hunk count.
 *
 * `jsdiff.applyPatch`'s `false`-on-mismatch channel cannot arise, because it is never called: once
 * T1 has proven a unique index there is nothing left for a third-party applier to decide, and
 * calling one would reintroduce exactly the relocation T1 exists to forbid.
 */
function parseHunks(payload: string): Hunk[] {
  if (!/^--- /m.test(payload)) {
    throw new MalformedPayload('payload has no "--- a/content" header line')
  }

  let parsed: ReturnType<typeof parsePatch>
  try {
    parsed = parsePatch(payload)
  } catch (cause) {
    throw new MalformedPayload(cause instanceof Error ? cause.message : String(cause))
  }

  // A payload carrying two `--- a/content` blocks is split by jsdiff into two file patches. §5.2's
  // grammar admits exactly one `header-block`, but read literally the second `---` line is also a
  // valid `hunk-line` (it begins with `-`), so the same bytes have two incompatible readings. We
  // take jsdiff's and sequence every hunk under T3, which drops nothing and stays deterministic.
  // Recorded as SPEC-FEEDBACK F5 — resolved in spec v0.6.1 as C8, which codifies exactly this
  // reading: multiple `file-section`s are permitted, a `---` at hunk-line position starts a new
  // section rather than removing a line, and every section's hunks are processed as one sequence
  // in document order under T3. This code already did that before the rule existed to name it.
  return parsed.flatMap((file) => file.hunks.map(reduceHunk))
}

// ---------------------------------------------------------------------------
// Matching and application
// ---------------------------------------------------------------------------

/** Where `pattern` occurs in `lines`. `first`/`second` are `-1` when there is no such match. */
interface Occurrences {
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
function occurrences(lines: readonly string[], pattern: readonly string[]): Occurrences {
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

type SpliceOutcome = { ok: true; lines: string[] } | { ok: false; detail: string }

/**
 * Replace `oldPat` at `at` with `newRep`, reconciling the trailing-newline state (C5).
 *
 * Because `toLines` puts the trailing-newline bit in a final `''` element, and that element is
 * never itself a line of a diff, `at + |oldPat| === |lines|` holds exactly when the current content
 * has *no* trailing newline and this hunk covers its last line.
 */
function spliceAt(lines: readonly string[], hunk: Hunk, at: number): SpliceOutcome {
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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The rule each halt reason cites, alongside H1.
 *
 * Derived rather than passed in, so a reason and its rule cannot drift apart at a call site — the
 * same failure D35 removes from {@link issue} by looking `layer` and `section` up instead of
 * accepting them. A `malformed-payload` cites H1 alone: there is no more specific rule for it.
 */
const HALT_RULE: Readonly<Record<HaltReason, HaltRule>> = Object.freeze({
  'no-match': 'T1',
  'ambiguous-match': 'T1',
  'eof-mismatch': 'C5',
  'malformed-payload': 'H1',
})

/** Empty and shared: every success carries one, and none of them differ. */
const NO_ISSUES: readonly Issue[] = Object.freeze([])

const haltIssues = (code: HaltRule, detail: string): readonly Issue[] =>
  code === 'H1'
    ? [issue('H1', 'warning', detail)]
    : [
        issue(code, 'warning', detail),
        issue('H1', 'warning', `patch application halted: ${detail}`),
      ]

const halt = (reason: HaltReason, hunkIndex: number | null, detail: string): PatchHalt => ({
  status: 'halt',
  reason,
  rule: HALT_RULE[reason],
  hunkIndex,
  detail,
  issues: haltIssues(HALT_RULE[reason], detail),
})

/**
 * A ceiling was hit. Mirrors {@link halt} so the two failure channels stay visibly distinct.
 *
 * Always RL-3 and always `warning`: §5.4 is emphatic that a limit is never a HALT and leaves the
 * event valid, so `observed`/`ceiling` carry the detail and nothing here cites H1.
 */
const limitReached = (
  limit: LimitKind,
  observed: number,
  ceiling: number,
  what: string,
): PatchLimit => ({
  status: 'limit',
  limit,
  observed,
  ceiling,
  issues: [
    issue('RL-3', 'warning', `${what}, above the configured ceiling of ${ceiling}; ${ABANDONED}`),
  ],
})

/**
 * Apply a patch payload to content, enforcing T1, T2 and T3.
 *
 * `payload` is the bytes strictly between the fences (E5) — `undefined` when the event carries no
 * fenced diff block at all, which is the prose-only no-op of E7 and N1. The **empty string** is a
 * different thing entirely: an empty fenced block, which carries no header block and is therefore
 * malformed rather than a no-op. It gets no special case here, so it falls through to
 * {@link parseHunks} and is normalised with every other headerless payload.
 *
 * Application is atomic: a halt on any hunk discards the effect of every prior hunk in the same
 * patch, because §5.3 step 3 pre-validates "in a temporary workspace" and a partially applied patch
 * must never become visible content. The working array is local, so this is structural.
 */
export function applyPatchPayload(
  content: string,
  payload: string | undefined,
  options: ApplyOptions = {},
): ApplyResult {
  if (payload === undefined)
    return { status: 'noop', content, shape: 'prose-only', issues: NO_ISSUES }

  const maxHunks = options.maxHunks ?? DEFAULT_MAX_HUNKS
  const maxWork = options.maxWork ?? DEFAULT_MAX_WORK

  let hunks: Hunk[]
  try {
    hunks = parseHunks(payload)
  } catch (error) {
    if (!(error instanceof MalformedPayload)) throw error
    return halt('malformed-payload', null, error.message)
  }

  // N2: a header block with zero hunks is a valid no-op and MUST NOT be rejected as malformed.
  if (hunks.length === 0)
    return { status: 'noop', content, shape: 'header-only', issues: NO_ISSUES }

  if (hunks.length > maxHunks) {
    return limitReached('hunks', hunks.length, maxHunks, `patch carries ${hunks.length} hunks`)
  }

  let work = 0
  let lines = toLines(content)

  // T2's insertion index comes from the `@@` header, which numbers the *pre-patch* file, while T3
  // requires application against the content prior hunks produced. Once an earlier hunk has added
  // or removed lines those two disagree, so the header number is carried forward by the net line
  // shift so far — what git and jsdiff both do, and the only reading under which T2 and T3 can
  // both hold. Hunks located by T1 are unaffected: they are found by content, not by number.
  // Recorded as SPEC-FEEDBACK F6.
  let shift = 0

  for (const [index, hunk] of hunks.entries()) {
    // Charge the scan's exact upper bound *before* running it, so an adversarial patch is refused
    // rather than executed and then regretted (RL-2).
    // One unit per pattern line on top of its characters, so a pattern of *empty* lines is not
    // free: `occurrences` still runs `|L| x |oldPat|` element comparisons for it, and charging the
    // character total alone bills that scan at zero. RL-2's stated unit is "bytes compared", which
    // is the hole — §5.4's own reasoning is that an adversary optimises against whichever unit is
    // counted. Recorded as SPEC-FEEDBACK F12.
    const patternChars = hunk.oldPat.reduce((sum, line) => sum + line.length + 1, 0)
    const cost = lines.length * patternChars
    if (work + cost > maxWork) {
      return limitReached(
        'work',
        work + cost,
        maxWork,
        `applying this patch would compare at least ${work + cost} characters`,
      )
    }
    work += cost

    let at: number

    if (hunk.oldPat.length === 0) {
      // T2 — the insertion carve-out. A hunk with no context lines and no `-` lines has no pattern
      // to disambiguate, so it applies at the position implied by its `@@` header's `-` line
      // number and the T1 uniqueness check does not apply. The index is clamped rather than
      // rejected: C6 makes the number advisory, so an out-of-range position is a producer error
      // about placement, and T2 leaves no uniqueness test to fall back on.
      at = Math.min(Math.max(hunk.insertAt + shift, 0), lines.length)
    } else {
      // T1 — prove the pattern occurs exactly once across the *full* content. Never stop at the
      // first match and never early-exit at the second: the count itself is the evidence, and
      // `@@` line numbers are not consulted at all, since C6 makes them advisory and the full
      // scan is mandatory regardless.
      const found = occurrences(lines, hunk.oldPat)
      if (found.count === 0) {
        return halt(
          'no-match',
          index,
          `hunk ${index + 1} does not match the current content (T1: the pattern must occur exactly once, found none)`,
        )
      }
      if (found.count > 1) {
        return halt(
          'ambiguous-match',
          index,
          `hunk ${index + 1} matches the current content in ${found.count} places (first at lines ${found.first + 1} and ${found.second + 1}); T1 requires exactly one, and @@ line numbers may not be used to disambiguate`,
        )
      }
      at = found.first
    }

    const spliced = spliceAt(lines, hunk, at)
    if (!spliced.ok) return halt('eof-mismatch', index, `hunk ${index + 1}: ${spliced.detail}`)

    // T3 — the next hunk is matched against the content this one produced, not the pre-patch
    // content, and is re-scanned in full because a splice can shift any position.
    //
    // Counted with {@link lineCount}, not `.length`: the trailing-newline bit is a final `''`
    // element, so a hunk that only changes the EOF newline state (C5) moves `.length` by one while
    // adding and removing no lines at all. Charging that to `shift` displaced every later T2
    // insertion by one position — silently, since T2 has no uniqueness test to catch it.
    shift += lineCount(spliced.lines) - lineCount(lines)
    lines = spliced.lines
  }

  return {
    status: 'applied',
    content: fromLines(lines),
    hunksApplied: hunks.length,
    work,
    issues: NO_ISSUES,
  }
}

/**
 * Apply the patch carried by an event's `content` field.
 *
 * Payload location is E1–E6, already implemented and covered in Phase 1; this does not
 * re-implement fence scanning.
 */
export function applyPatchContent(
  content: string,
  patchEventContent: string,
  options: ApplyOptions = {},
): ApplyResult {
  return applyPatchPayload(content, findPatchPayload(patchEventContent), options)
}

/**
 * Produce a spec-canonical patch payload taking `before` to `after`.
 *
 * The producer half of D31, and the oracle the Phase 2 gate round-trips against. `build.ts`
 * (Phase 6) will call this rather than duplicate it.
 *
 * `structuredPatch` with names `a/content` / `b/content` satisfies C1, and the default `context: 3`
 * is P1's enforcement point — P1 is a producer obligation that cannot be checked on receipt
 * (SPEC-FEEDBACK F1), and note that for content shorter than seven lines jsdiff supplies fewer than
 * three context lines because three is a maximum the tool offers where the content affords it.
 *
 * `context` is a parameter only because zero context is a materially different shape to test
 * against: with three context lines a hunk's pattern is ~7 lines and almost never repeats, so T1's
 * ambiguous branch is barely reached. Producers should leave the default alone.
 *
 * `formatPatch` prefixes a bare `===…===` separator line. §5.2's `index-preamble` production
 * requires an `Index: content` line *before* that separator, so the separator alone is not
 * grammatical and is stripped here. Recorded as SPEC-FEEDBACK F8.
 */
export function makePatch(before: string, after: string, context = 3): string {
  const formatted = formatPatch(
    structuredPatch('a/content', 'b/content', before, after, '', '', { context }),
  )
  if (!formatted.startsWith('=')) return formatted
  const firstBreak = formatted.indexOf('\n')
  return firstBreak === -1 ? formatted : formatted.slice(firstBreak + 1)
}
