/**
 * The Phase 3 coverage partition: the rules `resolve.ts` owns.
 *
 * Same discipline and same reason as Phases 1 and 2 (D34). A rule is covered when a test
 * **observes its code being emitted**, or it is listed as not-test-covered **with a written
 * reason**. The reasons were drafted in `docs/RESOLVE.md` §9 *before* the code existed, rather than
 * reverse-engineered from whatever the tests happened to produce.
 *
 * Most of `resolve`'s rules describe how a walk is performed rather than a condition that can fail,
 * so they correctly emit nothing. Inventing an issue for each of them would inflate the ratio in
 * exactly the way D34 exists to prevent.
 */

import type { Issue } from '../src/errors.js'
import { resolve } from '../src/resolve.js'
import { type CoverageTable, allIssues, emitted, notCovered } from './_coverage.js'
import { badPatch, diffPatch, root } from './_resolve.js'

const A = 'a\n'
const AB = 'a\nb\n'

/** Every issue any annotation carries, for a scenario built by `make`. */
const issuesFrom =
  (make: () => { rootId: string; events: Parameters<typeof resolve>[1] }) =>
  (): readonly Issue[] => {
    const { rootId, events } = make()
    return resolve(rootId, events).annotations.flatMap((a) => a.issues)
  }

const haltScenario = () => {
  const r = root(A)
  return { rootId: r.id, events: [r, badPatch('bad', r.id, r.id)] }
}

const forkScenario = () => {
  const r = root(A)
  return {
    rootId: r.id,
    events: [r, diffPatch('l', r.id, r.id, A, 'L\n'), diffPatch('rr', r.id, r.id, A, 'R\n')],
  }
}

export const A_RESOLVE_COVERAGE: CoverageTable = {
  // --- emitting ------------------------------------------------------------
  H1: emitted(issuesFrom(haltScenario)),
  H2: notCovered(
    'H2 requires that an invalid patch be *surfaced* with its event id, author and failure ' +
      'reason. That is the shape of the annotation, not a rule code inside it: the issue list on ' +
      'a protocol-error annotation cites H1 and the specific determinism rule. Covered ' +
      'behaviourally by asserting the annotation carries all three fields H2 names.',
  ),
  'SF-3': emitted(issuesFrom(forkScenario)),
  'RL-3': emitted(() => {
    const r = root(A)
    return resolve(r.id, [r, diffPatch('p1', r.id, r.id, A, AB)], {
      apply: { maxHunks: 0 },
    }).annotations.flatMap((a) => a.issues)
  }),

  // --- structural: the walk, not a condition that can fail -----------------
  'CHN-1': notCovered(
    'Defines how the chain is walked (root-author patches threaded by NIP-10 e reply), not a ' +
      'constraint that can be violated by an event. Covered behaviourally by chain-order tests ' +
      'that assert patches apply in reply order rather than array order.',
  ),
  'CHN-2': notCovered(
    'Says the kind 5 cascade runs during chain construction. Its failure mode is a deleted patch ' +
      'still being applied, which is wrong content rather than an issue. Covered behaviourally by ' +
      'the DEL-2 cascade tests.',
  ),
  'CHN-3': notCovered(
    'An exclusion: foreign patches never enter the canonical chain. A foreign patch that is not ' +
      'in the chain is simply absent from it; there is nothing to report. Covered positively by ' +
      'asserting a foreign patch leaves chain content untouched.',
  ),
  'RC-1': notCovered(
    'Restates CHN-1 as the definition of the canonical chain. Definitional, no failure mode.',
  ),
  'RC-2': notCovered(
    'A prohibition on the implementation — overlays MUST NOT be folded into canonical bytes. An ' +
      'implementation that obeys it emits nothing; one that violates it silently returns wrong ' +
      'content. Covered by asserting chain content is byte-identical with and without overlays.',
  ),
  'RC-3': notCovered(
    'An obligation on the *consumer* to recompute when its observed set changes, not on this ' +
      'function. resolve is pure, so recomputation is the caller calling again; there is nothing ' +
      'here that could emit.',
  ),
  'RC-4': notCovered('As RC-3, and a SHOULD rather than a MUST. Out of this function’s reach.'),
  'SF-1': notCovered(
    'Defines what a self-fork *is*. Its consequence — the chain being undefined — is expressed ' +
      'structurally: the forked variant of ChainState carries no tipId, so reading the tip of a ' +
      'forked chain does not typecheck and is asserted absent at runtime too.',
  ),
  'SF-2': notCovered(
    'The freeze itself. Covered behaviourally by asserting content equals the shared parent’s ' +
      'resolved content; the accompanying SF-3 annotation is what carries a code.',
  ),
  'SF-4': notCovered(
    'A prohibition: MUST NOT pick a branch by created_at, event ID, or any heuristic. An ' +
      'implementation that obeys it emits nothing — the violation is a wrong answer, not an ' +
      'issue. This is the one rule with a dedicated property rather than a fixture, because ' +
      'confluence cannot see it: a (created_at, id) tiebreaker is perfectly confluent. Covered by ' +
      'the G2 differential property, which swaps timestamps and id ordering and asserts the chain ' +
      'never moves.',
  ),
  'UR-4': notCovered(
    'Hold-pending semantics, new in spec v0.8.0 (F16): while a root-author patch\u2019s `e reply` ' +
      'parent is unobserved, the patch and its descendants take no walk position, no fork part, ' +
      'and no PT-6 judgment (eligibility in resolve.ts classifies chain/held/ignored per patch); ' +
      'they surface in `Resolution.pending` and rejoin on the target\u2019s arrival. Not an ' +
      'emittable code — the pending list is the surface. Covered by six pins in resolve.test.ts ' +
      '(direct hold + no-fork sharing an unobserved parent, arrival flip, transitive hold, ' +
      'PT-6-vs-held distinction, \u03b1-orphaned overlay targeting a held patch, ' +
      'retracted-while-held exclusion) and by the vendored chain vector ' +
      '`root-author-patches-sharing-an-unobserved-reply-parent-are-held`, for which the runner ' +
      'now also asserts `expect.pending`.',
  ),
  'SF-5': notCovered(
    'The resolution path: a kind 5 on one branch eliminates it by cascade and the chain resolves. ' +
      'A success path emits nothing. Covered positively for both branches.',
  ),
  'SF-6': notCovered(
    'Multiple forks resolve independently and content freezes at the earliest. The walk stops at ' +
      'the first fork reached from the root, which is by construction the earliest, so this is ' +
      'structural. Covered by a two-fork fixture asserting the earlier parent is reported.',
  ),
  'OV-2': notCovered(
    'The target-state snapshot: an overlay is evaluated against its target’s resolved content, ' +
      'never against the tip. Definitional. Covered by the clean-versus-stale pair, which can ' +
      'only both hold if the snapshot is taken at the target rather than at the tip.',
  ),
  'OV-3': notCovered(
    'The outcome is a *state on the overlay* — `state: "orphaned"` — not a rule code. That is the ' +
      'stronger form: a caller reading the classification cannot miss it, whereas an annotation ' +
      'can go unread. This entry began life as `emitted` and the gate rejected it, which is the ' +
      'partition working as intended (D34 measures observed emission, not intent). Covered ' +
      'behaviourally for all three undefined-target cases OV-3 names: downstream of a HALT, a ' +
      'fork sibling, and inside an unresolved fork — each asserted to be orphaned, never conflict.',
  ),
  'OV-4': notCovered(
    'Classification MUST be a pure function of (overlay payload, target resolved content) and ' +
      'deterministic across clients. A purity requirement has no failure code. Covered by the ' +
      'idempotence property and by classification being independent of the trust set.',
  ),
  'OV-6': notCovered(
    'Overlays render against their original target; rebase preview is explicitly outside the ' +
      'normative surface and is not implemented, so there is nothing to emit or to test beyond ' +
      'the OV-2 snapshot behaviour already covered.',
  ),
  'OV-8': notCovered(
    'An exclusion: a root-author patch replying to a foreign patch is ignored for chain ' +
      'construction. It is not invalid and not rejected, merely not a link. Covered positively.',
  ),
  'DEL-1': notCovered(
    'The NIP-09 pubkey check. A deletion that fails it is ignored, which is silence rather than ' +
      'an issue — reporting every unauthorised deletion would be a denial-of-service surface on a ' +
      'permissionless network. Covered by asserting a forged deletion changes nothing.',
  ),
  'DEL-2': notCovered(
    'The topology cascade. Its effect is which patches are absent from the chain, not a code. ' +
      'Covered by asserting a deleted patch takes its descendants with it and content reverts.',
  ),
  'DEL-3': notCovered(
    'A deleted foreign overlay is hidden from default rendering. Covered by asserting it is ' +
      'absent from the overlay list while canonical bytes are unchanged.',
  ),
  'DEL-6': notCovered(
    '"No effect" — the correct behaviour for a kind 5 targeting a kind 5 is to change nothing. ' +
      'Worth a positive test rather than an issue, because it is the shape an attacker reaches ' +
      'for to undelete a retraction, and NIP-09 defines no reversal.',
  ),
  'DEL-7': notCovered(
    'The α/β degradation rule. The outcome is a rendering hint carried on the overlay ' +
      '(degradation: alpha | beta), not an issue. Covered for both: an observed-but-deleted ' +
      'target is α, a never-observed target is β, and neither is re-anchored.',
  ),
  'PT-5': notCovered(
    'Authorship classification (root-author versus foreign) is the definition the whole module ' +
      'rests on, not a rule that fails. Covered behaviourally throughout.',
  ),
  'PT-6': notCovered('Paired with OV-8; see that entry. The same exclusion stated from §4.4.'),
  'PT-8': notCovered(
    'A permission: no-op patches are valid chain links contributing no change. The failure mode ' +
      'is treating one as an error, so it is covered positively — a prose-only patch mid-chain ' +
      'must not break the chain.',
  ),
  'PT-9': notCovered(
    'Append-only is a producer obligation and unenforceable on receipt: an inserted patch is ' +
      'indistinguishable from a legitimately published one, since nothing signs the chain shape. ' +
      'Same class as P1 (SPEC-FEEDBACK F1). A cycle guard in the walk keeps a crafted set from ' +
      'looping, which is the only reachable consequence.',
  ),
  'IX-3': notCovered(
    'i and k tags on root events are immutable. Structurally satisfied: a patch carries a content ' +
      'diff and resolve never reads or writes tags on the root, so there is no code path that ' +
      'could mutate them.',
  ),
  'BD-9': notCovered(
    'No patch-based Binding update. Enforced by refusing to build a chain over any root that is ' +
      'not a Product or Metadata, reported as a chain status rather than an issue because the ' +
      'events involved are perfectly valid — there is simply no chain. Covered positively.',
  ),

  // --- new in spec v0.6.1 — all four already implemented before the rule existed to name it ---
  'RC-5': notCovered(
    'Tip identification: the tip is the last chain event, the root itself where the chain carries ' +
      "no patches. Definitional, like RC-1. This exposed a real bug (an unpatched root's overlay " +
      'misclassified stale instead of clean) fixed in fix/spec-v061-drift; covered by the RC-5 ' +
      'regression test asserting a never-patched root is its own tip.',
  ),
  'SF-7': notCovered(
    'Precedence between a self-fork and a HALT when both are live: canonical bytes freeze at ' +
      'whichever is earlier in chain order. This module already argued the halt-always-wins ' +
      'corollary from H1 before the rule existed (SPEC-FEEDBACK F10), and SF-7 confirms that ' +
      'reading. Structural — the walk stops at the fork, so a halt can only be at or before it — ' +
      'covered by the "reports the halt, not the fork, when both are live" test.',
  ),
  'OV-9': notCovered(
    'A ceiling reached before overlay classification is a fifth outcome, unclassified, distinct ' +
      'from all four classifications. Already implemented as SPEC-FEEDBACK F11 before the rule ' +
      'existed; the disposition is a state on the overlay, not an issue code (same shape as OV-3). ' +
      'Covered by the "leaves an overlay unclassified rather than calling a ceiling a conflict" test.',
  ),
  'RL-5': notCovered(
    'Chain disposition under a ceiling: aborted, distinct from both resolved and HALT. Already ' +
      "implemented as SPEC-FEEDBACK F11's `aborted` ChainState variant before the rule existed. " +
      'The disposition is the `status` discriminant, not an issue code — RL-3 is the issue this ' +
      'module emits alongside it. Covered by the aborted-chain tests asserting the status and that ' +
      'no H1 is ever cited alongside it.',
  ),
}

/** Every issue this partition produces. Consumed by the gate and invariant suites. */
export const ALL_RESOLVE_ISSUES: readonly Issue[] = allIssues(A_RESOLVE_COVERAGE)
