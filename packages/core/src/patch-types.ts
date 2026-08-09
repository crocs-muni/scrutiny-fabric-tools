/**
 * The applier's *type* vocabulary (Phase 20, mandate §2), extracted verbatim from `patch.ts`.
 *
 * These four types shape how a caller configures application ceilings or classifies its failures —
 * `ApplyOptions` already leaks transitively through `CreateStoreOptions.applyOptions` and
 * `ResolveOptions.apply` — so they could not stay reachable only by importing the module that
 * defines them: `patch.ts` itself stays unexported (D32), and a consumer should never need to
 * know it exists to name these. Types only; nothing here needs shielding, and nothing here moves
 * or changes meaning — these are the same declarations, moved. The `ApplyResult` union and its
 * four variants joined them for the same reason after the 2026-08-08 audit (S3-20): the union is
 * public through the barrel, so its constituents must be nameable without reaching the applier.
 */

import type { Issue } from './errors.js'

/** Why a patch failed to apply. Each maps to one rule; see `patch.ts`'s halt variant issues. */
export type HaltReason =
  /** T1: the hunk's pattern occurs nowhere in the current content. */
  | 'no-match'
  /** T1: the pattern occurs two or more times, and `@@` line numbers may not disambiguate. */
  | 'ambiguous-match'
  /** C5: a `\ No newline at end of file` marker contradicts where the hunk actually matched. */
  | 'eof-mismatch'
  /** The payload could not be parsed, or carries no header block. */
  | 'malformed-payload'

/** Which ceiling was hit. Never a HALT — see the `limit` variant of `patch.ts`'s result union. */
export type LimitKind = 'hunks' | 'work'

/** The rule a halt cites alongside H1. Surfaced so a caller need not re-scan `Issue`s. */
export type HaltRule = 'T1' | 'C5' | 'H1'

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
 * Deliberately **not** a halt. §5.4: "Exceeding a ceiling aborts application and MUST be surfaced as
 * a distinct resource-limit-exceeded annotation, never as HALT. The event remains V-valid."
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
