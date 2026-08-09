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
 * `docs/PATCH-MATCHER.md`. Phase 18 (`docs/CONTEXT-WIDENING.md` §1) extracted the matching
 * primitives (`toLines`/`Hunk`/`occurrences`/`spliceAt`, and the pairing trial primitive
 * `diffHunks`) into the shared internal module `./patch-matcher.js`, which `build.ts`'s widening
 * loop also consumes; the T-gate and the parse channel stay here.
 */

import { formatPatch, parsePatch, structuredPatch } from 'diff'
import { type Issue, issue } from './errors.js'
import {
  type Hunk,
  MalformedPayload,
  fromLines,
  lineCount,
  occurrences,
  reduceHunk,
  scanCost,
  spliceAt,
  toLines,
} from './patch-matcher.js'
import type { ApplyOptions, HaltReason, HaltRule, LimitKind } from './patch-types.js'
import { findPatchPayload } from './validate.js'

// ---------------------------------------------------------------------------
// Result (HaltReason/LimitKind/HaltRule/ApplyOptions live in `./patch-types.js` since
// Phase 20 — re-exported here so existing import paths keep working; the barrel
// (`index.ts`) pulls them from the type module directly per mandate §2)
// ---------------------------------------------------------------------------

export type { ApplyOptions, HaltReason, HaltRule, LimitKind } from './patch-types.js'

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

/** Ceilings for {@link ApplyOptions} — see its doc comment in `./patch-types.js` for the RL-2 rationale. */
const DEFAULT_MAX_HUNKS = 64
const DEFAULT_MAX_WORK = 16 * 1024 * 1024

/** The half of an RL-3 message that must never read like a HALT. §5.4 is emphatic about this. */
const ABANDONED = 'application was abandoned. The event remains valid and this is not a HALT'

// ---------------------------------------------------------------------------
// Parsing (`reduceHunk` and the matching primitives it feeds live in
// `./patch-matcher.js` since Phase 18 — see docs/CONTEXT-WIDENING.md §1)
// ---------------------------------------------------------------------------

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
    // rather than executed and then regretted (RL-2). The formula is F12's per-element floor —
    // see `scanCost`.
    const cost = scanCost(lines, hunk.oldPat)
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
      // about placement, and T2 leaves no uniqueness test to fall back on. Clamp against
      // `lineCount`, not `.length`: the trailing newline rides in a final `''` element, and
      // clamping at `.length` inserts *past* it — silently dropping the file's trailing newline
      // and adding a spurious blank line (2026-08-08 audit, S3-18/S3-19).
      at = Math.min(Math.max(hunk.insertAt + shift, 0), lineCount(lines))
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
