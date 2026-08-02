/**
 * The applier's *type* vocabulary (Phase 20, mandate §2), extracted verbatim from `patch.ts`.
 *
 * These four types shape how a caller configures application ceilings or classifies its failures —
 * `ApplyOptions` already leaks transitively through `CreateStoreOptions.applyOptions` and
 * `ResolveOptions.apply` — so they could not stay reachable only by importing the module that
 * defines them: `patch.ts` itself stays unexported (D32), and a consumer should never need to
 * know it exists to name these. Types only; nothing here needs shielding, and nothing here moves
 * or changes meaning — these are the same declarations, moved.
 */

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
