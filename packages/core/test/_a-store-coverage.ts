/**
 * The Phase 5 coverage partition (SG4): the rules `store` owns.
 *
 * Same discipline as every prior phase's (D34). A rule is covered when a test **observes its code
 * being emitted** through the real, integrated path (`createStore().add()`), or it is listed as
 * not-test-covered **with a written reason**. The working expectation was drafted in
 * `docs/STORE.md` §8 before this file existed: BD-7 and SIG-1 (enforcement) are the two rules with a
 * real rejection disposition; the rest are bookkeeping obligations whose violation is silently wrong
 * behaviour rather than a reportable condition.
 */

import type { Issue } from '../src/errors.js'
import { EMPTY_STORE_STATE, applyStoreDelta, sig1RejectionIssue } from '../src/store.js'
import { validateEvent } from '../src/validate.js'
import { type CoverageTable, allIssues, emitted, notCovered } from './_coverage.js'
import { diffPatch, root } from './_resolve.js'
import { bindingAt, genuine, metadataAt } from './_store.js'

const A = 'a\n'
const AB = 'a\nb\n'

/**
 * BD-7 — a Binding whose root endpoint is actually a Patch. Uses the real, synchronous reducer
 * directly (`applyStoreDelta`) rather than `createStore().add()`'s async wrapper — `add()` is
 * genuinely async (it awaits the `EventStorage` port), which the coverage harness's synchronous
 * `emitted(() => Issue[])` shape cannot accommodate. Re-runs `validateEvent` once against the
 * post-fold state (VALIDATION-WIRING.md §1) — the identical call `add()` itself makes to populate
 * `AddResult.rejected`, not a re-derivation of BD-7's own logic, which lives solely in
 * `validate.ts`'s `checkBinding`.
 */
function bd7Issues(): readonly Issue[] {
  const r = genuine(root(A, 'coverage-bd7-root'))
  const notAProduct = genuine(diffPatch('coverage-bd7-not-a-product', r.id, r.id, A, AB))
  const link = genuine(metadataAt('coverage-bd7-link', 'metadata'))
  const binding = genuine(bindingAt('coverage-bd7-binding', notAProduct.id, link.id))

  let state = EMPTY_STORE_STATE
  state = applyStoreDelta(state, { kind: 'observe', events: [r, notAProduct] })
  state = applyStoreDelta(state, { kind: 'observe', events: [binding, link] })

  const verdict = validateEvent(binding, { lookupEvent: (id) => state.admit.observedById[id] })
  return verdict.status === 'invalid' ? verdict.issues.filter((i) => i.code === 'BD-7') : []
}

/** SIG-1 (enforcement) — an event failing `verify()`. The same constructor `add()` itself calls. */
function sig1Issues(): readonly Issue[] {
  const bad = { ...genuine(root(A, 'coverage-sig1-root')), sig: 'not-valid' }
  return [sig1RejectionIssue(bad)]
}

export const A_STORE_COVERAGE: CoverageTable = {
  'UR-1': notCovered(
    'Confluence itself — a property, not an emittable code. SG1 is the coverage: any permutation ' +
      'of the whole delta sequence reaches an identical StoreView and identical resolveRoot output.',
  ),
  'UR-2': notCovered(
    'A patch whose root is unobserved is retained and re-evaluated once the root arrives. STORE.md ' +
      '§2 argues this reduces to chain-epoch bumping rather than a tracked buffer; the failure mode ' +
      'is a stale resolveRoot answer, not an issue. Covered behaviourally in store.test.ts.',
  ),
  'UR-3': notCovered(
    'A caching discipline ("must not cache a classification while it could still change"), not a ' +
      'predicate on an event. The memo key is scoped by chainEpoch, which changes the moment the ' +
      'root arrives, so there is no stale classification to serve. Covered behaviourally by the ' +
      'epoch-gated-memo tests in store.test.ts.',
  ),
  'RC-3': notCovered(
    'An obligation on how a non-UI consumer behaves (recompute canonical bytes on observed-set ' +
      'change), satisfied structurally by the epoch-gated memo rather than by emitting anything ' +
      'when honoured. Covered by the memo tests asserting a bumped chainEpoch always produces a ' +
      'fresh resolve() call (a new Resolution reference). Strengthened per OVERLAY-AWAITING.md §8: ' +
      'the cross-root regression now exists — an event X with no relationship to root R in any of ' +
      'the four original dispatch rows, arriving after an overlay on R names it as a reply target, ' +
      'must bump chainEpoch[R]. This is recorded as a permanent regression in store.test.ts. Under ' +
      'PT-7 the DEL-7 α reclassification the audit trace names is unreachable for that shape (the ' +
      'overlay flips pending→invalid once X is observable and leaves the resolveRoot feed — store.test.ts ' +
      'pins that exclusion-driven staleness through a shared memo as a second permanent regression).',
  ),
  'RC-4': notCovered('As RC-3, and a SHOULD rather than a MUST. Same mechanism, same coverage.'),
  'BD-6': notCovered(
    'admit.ts already implements pending-Binding-endpoint admission correctly; store only threads ' +
      'deltas through admit.applyDelta unmodified. Covered behaviourally (non-adjacent endpoint ' +
      'delivery across two add() calls) and biased by SG5.',
  ),
  'BD-7': emitted(bd7Issues),
  'DEL-8': notCovered(
    'A deletion observed before its target applies retroactively once the target arrives. STORE.md ' +
      "§4 argues this is resolve.ts's purity plus retention, not a store-owned code path — there is " +
      'no deletion-specific cache to invalidate. Covered behaviourally in store.test.ts.',
  ),
  'DEL-9': notCovered(
    'A MUST-cache obligation satisfied by admit.observedById never evicting a reachable kind 5 ' +
      'event; violating it is silent wrong content, not an issue. Covered behaviourally by the ' +
      'unobserve test asserting only the targeted id is removed.',
  ),
  'RL-2': notCovered(
    'A configuration-surface obligation (CreateStoreOptions.applyOptions), not a predicate with a ' +
      'failure mode of its own — the ceiling it configures is enforced and emitted by patch.ts/ ' +
      "resolve.ts, which already own RL-3's emission. Covered behaviourally by a low-ceiling " +
      'configuration surfacing as an aborted/limit outcome on the next resolveRoot call.',
  ),
  'RL-3': notCovered(
    'Emitted by resolve.ts/patch.ts, not by this module — store neither adds nor removes that ' +
      'emission, only threads ApplyOptions through and surfaces the resulting annotations ' +
      'unchanged. Listed here per the module-ownership table because store is what makes RL-3 ' +
      "reachable through the public entry point at all; the code itself is not this module's to " +
      'claim, so it is not re-counted as emitted here.',
  ),
  'SIG-1': emitted(sig1Issues),
}

/** Every issue this partition produces. Consumed by the gate and invariant suites. */
export const ALL_STORE_ISSUES: readonly Issue[] = allIssues(A_STORE_COVERAGE)
