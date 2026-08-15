/**
 * The Phase 4 coverage partition: the rules `admit.ts` owns.
 *
 * Same discipline as Phases 1–3 (D34). Unlike every prior partition, this one is expected to be
 * **entirely** not-test-covered: §6.0's own text says D rules "are not admission criteria for the
 * event itself," and `admit` never rejects or annotates an event — it only computes visibility.
 * There is no defect disposition for any rule here to emit, so an all-`not-covered` partition is
 * not a weaker gate than Phase 3's 3/32 — each entry cites the behavioural test that substitutes,
 * per D34's own instruction that intent is not evidence. See `#37` §10 (AG3).
 */

import type { Issue } from '../src/errors.js'
import { type CoverageTable, allIssues, notCovered } from './_coverage.js'

export const A_ADMIT_COVERAGE: CoverageTable = {
  'TR-2': notCovered(
    'Definitional — "an event is admitted if its pubkey is trusted or reachable via a trusted ' +
      'Binding" states what admission means, not a condition that can be violated. Covered ' +
      'behaviourally by the direct-trust admission tests in admit.test.ts.',
  ),
  'TR-3': notCovered(
    'A prohibition: a Binding is admitted only by direct trust, never transitively through its ' +
      'endpoints. Covered by asserting a Binding with trusted endpoints but an untrusted author ' +
      "stays unadmitted, and that a Binding's reason set is never a superset of " +
      '{direct-trust} even when every other admission path is available to it.',
  ),
  'TR-4': notCovered(
    'The binding cascade mechanism itself — an admitted Binding credits both endpoints. Covered ' +
      'behaviourally, including the BD-6 case (crediting an endpoint that has not arrived) and ' +
      'the multi-binding case (one endpoint credited by two live Bindings survives either one ' +
      'alone being revoked).',
  ),
  'TR-5': notCovered(
    'The root-chain reachability step. Its failure mode is under- or over-admission, not an ' +
      "issue code. Covered behaviourally, including the two cases resolve.ts's own walk would " +
      'exclude but TR-5 does not: both branches of an unresolved self-fork, and a root-authored ' +
      'patch replying into a foreign patch (PT-6/OV-8) — see #37 §4 for why admission ' +
      "must diverge from resolve's walk here.",
  ),
  'TR-6': notCovered(
    'A prohibition, the mirror of TR-3 for patches: a foreign patch is not transitively admitted ' +
      'via its root. Covered by asserting a foreign patch stays unadmitted despite an admitted ' +
      'root, and is admitted only once its own author is independently trusted.',
  ),
  'TR-7': notCovered(
    'An ordering constraint on the implementation, not on any event: trust filtering MUST NOT ' +
      'precede chain construction. There is no event-level violation to detect — resolve.ts ' +
      'structurally never receives a TrustProvider or a view (D25), so there is no call site ' +
      'through which this module could violate it even by accident. Covered by asserting ' +
      "resolve's chain output is unaffected by which view is later applied on top of it.",
  ),
  'OV-7': notCovered(
    "Reduces to the same admission check the rest of this module performs: a foreign patch's " +
      'own admission (which, per TR-6, can only ever be direct-trust) is exactly the predicate ' +
      'OV-7 asks for. Covered by the overlay-visibility tests directly, including that openView ' +
      'shows every overlay.',
  ),
  'DEL-4': notCovered(
    'A non-effect on admission: root retraction hides the root from the default view but MUST ' +
      'NOT revoke the admission its chain and Bindings hold. Covered by asserting admission ' +
      "survives a root's own kind-5 deletion, alongside the isDefaultViewRetracted predicate " +
      'that carries the retraction fact on the orthogonal axis (§8).',
  ),
  'DEL-5': notCovered(
    "The one rule here with a real failure mode — a Binding's retraction not being followed " +
      'through to its endpoints, or the reverse (endpoints staying credited after retraction), ' +
      'the "sticky admission" bug D23 names. Its failure mode is a wrong refcount, not an issue ' +
      "code, so it is covered by AG1/AG2's property tests directly rather than a single fixture " +
      '— a stronger claim than any one test could make. A minimal fixture is included in ' +
      'admit.test.ts for readability.',
  ),
}

/** Always empty — see the module doc above. Kept for parity with the other coverage tables. */
export const ALL_ADMIT_ISSUES: readonly Issue[] = allIssues(A_ADMIT_COVERAGE)
