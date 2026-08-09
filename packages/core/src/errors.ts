import { RULES, type Rule, type RuleId, type RuleLayer } from './rules.js'

/**
 * Whether an issue rejects the event.
 *
 * `error` means the event is invalid and MUST NOT be processed or rendered as a Product, Metadata,
 * Binding, or Patch. `warning` is advisory and never rejects.
 *
 * **This distinction has no basis in the spec text.** §6.0 gives the Validity layer exactly one
 * disposition — a V failure keeps the event out of processing entirely — so rules that are really
 * advisory to producers (P3's LF clause) or obligations to *accept* (C7) have no disposition that
 * fits them. Severity is a local affordance for that gap, recorded as item F-crosscutting in
 * `docs/SPEC-FEEDBACK-v0.6.0.md`.
 *
 * The invariant that keeps it honest is TR-1: no issue citing an A-layer *or* D-layer rule may be
 * an `error`, because a V-valid event MUST NOT be rejected by an A or D rule — §6.0 gives the
 * Validity layer the only rejection disposition, so an A or D finding can only ever be
 * annotation-shaped. `test/invariants.test.ts` asserts the full A∪D form across every issue the
 * suite produces.
 */
export type Severity = 'error' | 'warning'

/**
 * A single normative finding, carrying the Appendix F rule it cites.
 *
 * One object serves four consumers (D40): the conformance suite asserts on `code`, a CLI prints it,
 * a UI links it to the spec section, and an agent dereferences the exact rule.
 */
export interface Issue {
  /** Appendix F rule ID. */
  readonly code: RuleId
  /** The rule's layer. Derived from {@link RULES}, never supplied by the caller. */
  readonly layer: RuleLayer | null
  /** The spec section defining the rule. Derived from {@link RULES}. */
  readonly section: string
  readonly severity: Severity
  /** Human-readable detail. The rule's own summary is available via {@link Issue.code}. */
  readonly message: string
}

/**
 * Build an {@link Issue} for a rule.
 *
 * `layer` and `section` are looked up rather than passed, so an issue can never cite a rule with
 * the wrong layer or section attached — the failure mode D35 exists to prevent. `code` is typed as
 * {@link RuleId}, so citing a rule absent from the spec is a compile error rather than a CI check.
 */
export function issue(code: RuleId, severity: Severity, message: string): Issue {
  const rule = RULES[code]
  return { code, layer: rule.layer, section: rule.section, severity, message }
}

/** The Appendix F entry an issue cites, for callers that want the summary or inheritance source. */
export function ruleOf(i: Issue): Rule {
  return RULES[i.code]
}

/** Whether any issue in the list rejects the event. */
export function hasError(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}
