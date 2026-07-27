/**
 * The Phase 2 coverage partition: the rules `patch.ts` owns.
 *
 * Same discipline as `_v-coverage.ts` and the same reason (D34). A rule is covered when a test
 * **observes its code being emitted**, or it is listed as not-test-covered **with a written
 * reason**. Annotations measure citation, not correctness.
 *
 * Most of these rules have no failure mode by construction, and that is the honest answer rather
 * than a gap: T2 and C6 are *permissions* (they switch a check off), N1–N3 and the acceptance half
 * of C5 are MUST-ACCEPT obligations satisfied by emitting nothing, PB-1 and PB-2 are prohibitions
 * on the implementation rather than predicates on an event, and E7 is definitional. Inventing an
 * "info" issue for any of them to raise the score would make the number lie in exactly the way D34
 * exists to prevent.
 */

import type { Issue } from '../src/errors.js'
import { applyPatchPayload } from '../src/patch.js'

type Emitted = { readonly kind: 'emitted'; readonly issues: () => readonly Issue[] }
type NotCovered = { readonly kind: 'not-covered'; readonly reason: string }

const emitted = (issues: () => readonly Issue[]): Emitted => ({ kind: 'emitted', issues })
const notCovered = (reason: string): NotCovered => ({ kind: 'not-covered', reason })

const body = (...lines: string[]): string => `--- a/content\n+++ b/content\n${lines.join('\n')}\n`

const issuesFrom =
  (content: string, payload: string, options = {}) =>
  (): readonly Issue[] => {
    const result = applyPatchPayload(content, payload, options)
    return result.status === 'halt' || result.status === 'limit' ? result.issues : []
  }

/** The rules `docs/IMPLEMENTATION-PLAN.md` assigns to the `patch` module, plus RL-3 which it emits. */
export const A_PATCH_COVERAGE: Readonly<Record<string, Emitted | NotCovered>> = {
  T1: emitted(issuesFrom('x\nDUP\ny\nDUP\nz\n', body('@@ -1,1 +1,1 @@', '-DUP', '+CHANGED'))),

  T2: notCovered(
    'A carve-out, not a check: it *disables* T1 for a hunk with no context and no removed lines, ' +
      'so it has no failure mode and can emit nothing. Covered behaviourally — patch.test.ts ' +
      'asserts a pure insertion applies at the @@ position amid content that is entirely ' +
      'duplicate lines, which is exactly where T1 would otherwise reject it.',
  ),

  T3: notCovered(
    'T3 governs *what content* each hunk is matched against, so its violations surface as T1 ' +
      'codes evaluated against post-prior-hunk content rather than as a code of their own. ' +
      'Covered behaviourally by the descending-hunks and ambiguity-created-by-an-earlier-hunk ' +
      'regressions, and by the atomicity test asserting a halt discards earlier hunks.',
  ),

  H1: emitted(issuesFrom('q\n', body('@@ -1,1 +1,1 @@', '-absent', '+x'))),

  N1: notCovered(
    'A MUST-ACCEPT rule: a prose-only patch event is a valid no-op, satisfied by emitting ' +
      'nothing. Covered behaviourally — applyPatchContent returns a prose-only no-op with the ' +
      'content unchanged.',
  ),

  N2: notCovered(
    'A MUST-ACCEPT rule, and the one most worth a positive test: it is the shape jsdiff ' +
      'createPatch emits when a === b, and "MUST NOT reject this shape as malformed" is the ' +
      'failure someone would otherwise ship. Covered behaviourally, and guarded specifically ' +
      'against the headerless-garbage payload that also parses to zero hunks.',
  ),

  N3: notCovered(
    'States the disposition of N1 and N2 (successful no-op, content unchanged, event recorded in ' +
      'the chain as normal) rather than a constraint that can fail. Covered behaviourally for ' +
      'both shapes.',
  ),

  C5: emitted(
    issuesFrom('a\nb\n', body('@@ -2,1 +2,1 @@', '-b', '\\ No newline at end of file', '+c')),
  ),

  C6: notCovered(
    'A permission: @@ line numbers are advisory and consumers MUST locate hunks by context ' +
      'match. There is nothing to reject, and the risk is the opposite one — an implementation ' +
      'that trusts the numbers. Covered by a positive test applying a hunk whose header claims ' +
      'line 9999 of a three-line content.',
  ),

  'PB-1': notCovered(
    'A prohibition on the implementation, not a predicate on an event: content is consumed ' +
      'verbatim and no normalisation is performed. An implementation that obeys it emits ' +
      'nothing, and one that violates it silently produces wrong content rather than an issue. ' +
      'Covered behaviourally by the CRLF, BOM and trailing-newline round trips.',
  ),

  'PB-2': notCovered(
    'As PB-1, for the patch payload bytes. Covered behaviourally by the CRLF-payload regression ' +
      '(which must fail to match rather than be repaired) and by content whose own lines read ' +
      '"--- a/content".',
  ),

  E7: notCovered(
    'Definitional: absent a fenced block matching E2, the patch is a no-op. Covered ' +
      'behaviourally alongside N1.',
  ),

  'RL-3': emitted(issuesFrom('a\nb\n', body('@@ -1,1 +1,1 @@', '-a', '+z'), { maxHunks: 0 })),
}

/** Every issue this partition produces. Consumed by the gate and invariant suites. */
export const ALL_PATCH_ISSUES: readonly Issue[] = Object.values(A_PATCH_COVERAGE).flatMap(
  (entry) => (entry.kind === 'emitted' ? [...entry.issues()] : []),
)
