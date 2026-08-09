/**
 * The Phase 4 gate, items AG1 and AG2 (`docs/ADMIT.md` §10).
 *
 * AG1 — incremental admission ≡ full recompute, checked after **every prefix** of a delta
 * sequence, not only at the end: D23's sticky-admission bug is specifically a bug that appears
 * after a revocation *following* a redundant re-application, so the property must be checked at a
 * point in the sequence where that has already happened.
 *
 * AG2 — apply-then-invert ≡ exact initial state, inverting in reverse order (a LIFO undo stack).
 *
 * The generator is biased toward the shapes AG4 names: a Binding observed before either endpoint
 * (BD-6), the same delta redelivered adjacently and non-adjacently, a pubkey trusted then
 * untrusted then retrusted within one sequence, two Bindings crediting the same endpoint with only
 * one revoked, a self-fork chain admitted only through a Binding with the root author's own pubkey
 * untrusted, and a root losing its last admission reason while its patches are still being
 * delivered.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type AdmissionDelta,
  type AdmissionIndex,
  EMPTY_ADMIT_STATE,
  type ForwardDelta,
  applyDelta,
  computeAdmission,
  invertDelta,
  isAdmitted,
  reasonKind,
  rootChainReason,
  toIndex,
} from '../src/admit.js'
import type { NostrEvent } from '../src/events.js'
import {
  bindingEvent,
  deletion,
  fakeTrust,
  foreignPatch,
  metadata,
  product,
  rootPatch,
} from './_admit.js'
import { PK_FOREIGN, PK_OTHER, PK_ROOT } from './_fixtures.js'

// ---------------------------------------------------------------------------
// A fixed graph exercising BD-6 (out-of-order endpoints), a self-fork, a foreign overlay, and
// two independent revocation paths (a patch deletion and a binding deletion).
// ---------------------------------------------------------------------------

const root = product('root')
const link = metadata('link', { pubkey: PK_FOREIGN })
const binding = bindingEvent('binding', root.id, link.id, { pubkey: PK_OTHER })
// A second, independent Binding crediting the same two endpoints — lets the generator reach
// "two Bindings crediting the same endpoint, only one revoked" (AG4).
const binding2 = bindingEvent('binding2', root.id, link.id, { pubkey: PK_OTHER })
const left = rootPatch('left', root.id, root.id) // self-fork sibling 1
const right = rootPatch('right', root.id, root.id) // self-fork sibling 2
const overlay = foreignPatch('overlay', root.id, root.id)
const deleteLeft = deletion('delete-left', [left.id], PK_ROOT)
const deleteBinding = deletion('delete-binding', [binding.id], PK_OTHER)
const deleteBinding2 = deletion('delete-binding2', [binding2.id], PK_OTHER)

const FIXED_EVENTS: readonly NostrEvent[] = [
  root,
  link,
  binding,
  binding2,
  left,
  right,
  overlay,
  deleteLeft,
  deleteBinding,
  deleteBinding2,
]
const PUBKEYS = [PK_ROOT, PK_FOREIGN, PK_OTHER]

// ---------------------------------------------------------------------------
// Generator — one event or one pubkey per action, drawn with replacement, so exact duplicates
// (redundant delivery) and revoke-after-redundant-observe are reachable, not just plausible.
// ---------------------------------------------------------------------------

type Action =
  | { readonly kind: 'observe'; readonly index: number }
  | { readonly kind: 'unobserve'; readonly index: number }
  | { readonly kind: 'trust'; readonly pk: string }
  | { readonly kind: 'untrust'; readonly pk: string }

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant('observe' as const),
    index: fc.integer({ min: 0, max: FIXED_EVENTS.length - 1 }),
  }),
  fc.record({ kind: fc.constant('trust' as const), pk: fc.constantFrom(...PUBKEYS) }),
  fc.record({ kind: fc.constant('untrust' as const), pk: fc.constantFrom(...PUBKEYS) }),
)

const sequenceArb: fc.Arbitrary<readonly Action[]> = fc.array(actionArb, { maxLength: 40 })

/** `observe`/`trust` only — the subset {@link invertDelta} accepts; see `docs/ADMIT.md` §9 on
 * why `untrust` cannot originate an invertible sequence: it can be a standalone no-op with no
 * earlier `trust` to pair against under a LIFO undo, which a syntactic inverse cannot detect. */
const forwardActionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant('observe' as const),
    index: fc.integer({ min: 0, max: FIXED_EVENTS.length - 1 }),
  }),
  fc.record({ kind: fc.constant('trust' as const), pk: fc.constantFrom(...PUBKEYS) }),
)

const forwardSequenceArb: fc.Arbitrary<readonly Action[]> = fc.array(forwardActionArb, {
  maxLength: 40,
})

const toDelta = (a: Action): AdmissionDelta => {
  switch (a.kind) {
    case 'observe':
      return { kind: 'observe', events: [FIXED_EVENTS[a.index] as NostrEvent] }
    case 'unobserve':
      return { kind: 'unobserve', eventIds: [(FIXED_EVENTS[a.index] as NostrEvent).id] }
    default:
      return { kind: a.kind, pubkeys: [a.pk] }
  }
}

/** `forwardSequenceArb` never actually produces `'untrust'`, so the fallback branch is safe. */
const toForwardDelta = (a: Action): ForwardDelta =>
  a.kind === 'observe'
    ? { kind: 'observe', events: [FIXED_EVENTS[a.index] as NostrEvent] }
    : { kind: 'trust', pubkeys: [a.pk] }

/** Independently tracks "what is currently observed/trusted" by replaying each delta's own
 * semantics in plain code — never by asking `admit.ts`'s own state machine. */
function replay(deltas: readonly AdmissionDelta[]): { events: NostrEvent[]; trusted: string[] } {
  const byId = new Map<string, NostrEvent>()
  const trusted = new Set<string>()
  for (const d of deltas) {
    switch (d.kind) {
      case 'observe':
        for (const e of d.events) byId.set(e.id, e)
        break
      case 'unobserve':
        for (const id of d.eventIds) byId.delete(id)
        break
      case 'trust':
        for (const pk of d.pubkeys) trusted.add(pk)
        break
      case 'untrust':
        for (const pk of d.pubkeys) trusted.delete(pk)
        break
    }
  }
  return { events: [...byId.values()], trusted: [...trusted] }
}

describe('AG1 — incremental admission ≡ full recompute, after every prefix', () => {
  it('matches the oracle at every point in the sequence, not only at the end', () => {
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        const deltas = actions.map(toDelta)
        let state = EMPTY_ADMIT_STATE
        for (let i = 0; i < deltas.length; i++) {
          state = applyDelta(state, deltas[i] as AdmissionDelta)
          const { events, trusted } = replay(deltas.slice(0, i + 1))
          const oracle = computeAdmission(events, fakeTrust(trusted))
          expect(toIndex(state), `after prefix of length ${i + 1}`).toEqual(oracle)
        }
      }),
      { numRuns: 10_000 },
    )
  })

  /**
   * A pubkey trusted more than once, then later untrusted in the same sequence — the exact D23
   * shape ("a revocation following a redundant re-application") ADMIT.md §10 names, distinct from
   * `redundantObserve` below, which counts any repeated action regardless of whether it is ever
   * revoked.
   */
  function hasRevokeAfterRedundantTrust(actions: readonly Action[]): boolean {
    const trustCounts = new Map<string, number>()
    for (const a of actions) {
      if (a.kind === 'trust') trustCounts.set(a.pk, (trustCounts.get(a.pk) ?? 0) + 1)
      else if (a.kind === 'untrust' && (trustCounts.get(a.pk) ?? 0) >= 2) return true
    }
    return false
  }

  it('reaches the hard shapes often enough for the property above to mean something', () => {
    let redundantObserve = 0
    let retrustChurn = 0
    let multiReasonOverlap = 0
    let twoBindingsOneRevoked = 0
    let selfForkRootChainOnly = 0
    let revokeAfterRedundantObserve = 0
    let admittedCount = 0
    let notAdmittedCount = 0
    const kindCounts: Record<'direct-trust' | 'binding' | 'root-chain', number> = {
      'direct-trust': 0,
      binding: 0,
      'root-chain': 0,
    }
    fc.assert(
      fc.property(sequenceArb, (actions) => {
        const seen = new Set<string>()
        for (const a of actions) {
          const key = JSON.stringify(a)
          if (seen.has(key)) redundantObserve++
          seen.add(key)
        }
        const trustFlips = actions.filter((a) => a.kind !== 'observe').length
        if (trustFlips >= 3) retrustChurn++
        if (hasRevokeAfterRedundantTrust(actions)) revokeAfterRedundantObserve++

        const deltas = actions.map(toDelta)
        const { events, trusted } = replay(deltas)
        const index = computeAdmission(events, fakeTrust(trusted))
        const observedIds = new Set(events.map((e) => e.id))

        for (const reasons of Object.values(index.reasons)) {
          if (reasons.length > 1) multiReasonOverlap++
          for (const r of reasons) kindCounts[reasonKind(r)]++
        }
        for (const e of events) {
          if (isAdmitted(index, e.id)) admittedCount++
          else notAdmittedCount++
        }

        const bothBindingsObserved = observedIds.has(binding.id) && observedIds.has(binding2.id)
        const exactlyOneRevoked =
          observedIds.has(deleteBinding.id) !== observedIds.has(deleteBinding2.id)
        if (bothBindingsObserved && exactlyOneRevoked && trusted.includes(PK_OTHER)) {
          twoBindingsOneRevoked++
        }

        const selfForkObserved =
          observedIds.has(root.id) && observedIds.has(left.id) && observedIds.has(right.id)
        const leftReasons = index.reasons[left.id] ?? []
        const rightReasons = index.reasons[right.id] ?? []
        if (
          selfForkObserved &&
          !trusted.includes(PK_ROOT) &&
          leftReasons.includes(rootChainReason(root.id)) &&
          rightReasons.includes(rootChainReason(root.id)) &&
          !leftReasons.includes('direct-trust') &&
          !rightReasons.includes('direct-trust')
        ) {
          selfForkRootChainOnly++
        }
      }),
      { numRuns: 3_000 },
    )
    console.log(
      `admit generator mix: redundantActions=${redundantObserve} retrustChurn=${retrustChurn} ` +
        `multiReasonOverlap=${multiReasonOverlap} twoBindingsOneRevoked=${twoBindingsOneRevoked} ` +
        `selfForkRootChainOnly=${selfForkRootChainOnly} ` +
        `revokeAfterRedundantObserve=${revokeAfterRedundantObserve}`,
    )
    console.log(
      `admit outcome mix: admitted=${admittedCount} notAdmitted=${notAdmittedCount} ` +
        `directTrust=${kindCounts['direct-trust']} binding=${kindCounts.binding} ` +
        `rootChain=${kindCounts['root-chain']}`,
    )
    expect(redundantObserve, 'redundant/duplicate actions').toBeGreaterThan(200)
    expect(retrustChurn, 'sequences with real trust churn').toBeGreaterThan(50)
    expect(multiReasonOverlap, 'events admitted by more than one reason at once').toBeGreaterThan(
      20,
    )
    expect(
      revokeAfterRedundantObserve,
      'a pubkey redundantly trusted then later untrusted in the same sequence',
    ).toBeGreaterThan(20)
    // twoBindingsOneRevoked and selfForkRootChainOnly are logged, not gated here: both need
    // several specific ids observed together, which the uniform generator above only reaches by
    // chance (twoBindingsOneRevoked swung 5-13 per 3_000 runs across repeated local runs with no
    // fixed seed — too flaky for a floor; selfForkRootChainOnly scored 0). The dedicated, biased
    // generators below carry each shape's floor instead.
  })
})

describe('AG4 — two Bindings credit the same endpoint, only one revoked', () => {
  /** Guarantees both Bindings are live, then lets the generator choose whether/which to revoke —
   * the natural rate of this combination in the uniform generator above was too low (5-13 per
   * 3_000 runs, no fixed seed) to make a stable floor. */
  const guaranteedPrefix: readonly Action[] = [
    { kind: 'trust', pk: PK_OTHER },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(binding) },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(binding2) },
  ]

  const revocationChoiceArb: fc.Arbitrary<readonly Action[]> = fc.oneof(
    fc.constant([{ kind: 'observe' as const, index: FIXED_EVENTS.indexOf(deleteBinding) }]),
    fc.constant([{ kind: 'observe' as const, index: FIXED_EVENTS.indexOf(deleteBinding2) }]),
    fc.constant([]),
  )

  const twoBindingsSequenceArb: fc.Arbitrary<readonly Action[]> = revocationChoiceArb.map(
    (revocation) => [...guaranteedPrefix, ...revocation],
  )

  it('reaches the shape ADMIT.md §10 names, with a floor', () => {
    let hits = 0
    fc.assert(
      fc.property(twoBindingsSequenceArb, (actions) => {
        const deltas = actions.map(toDelta)
        const { events, trusted } = replay(deltas)
        const observedIds = new Set(events.map((e) => e.id))
        const exactlyOneRevoked =
          observedIds.has(deleteBinding.id) !== observedIds.has(deleteBinding2.id)
        if (exactlyOneRevoked && trusted.includes(PK_OTHER)) hits++
      }),
      { numRuns: 300 },
    )
    expect(hits, 'two Bindings credit the same endpoint, only one revoked').toBeGreaterThan(50)
  })
})

describe('AG4 — self-fork admitted via root-chain only, root author untrusted', () => {
  /**
   * The uniform generator above almost never reaches this shape (it requires five conditions at
   * once: root, both self-fork siblings, and a live Binding all observed, while the root author's
   * own pubkey is never trusted for the whole sequence) — the same lesson Phase 2's zero-context
   * generator names: a property is only as strong as its generator's bias. This one guarantees the
   * shape's prefix and only adds noise that cannot undo it (no action here ever names `PK_ROOT` or
   * touches `binding`'s liveness).
   */
  const guaranteedPrefix: readonly Action[] = [
    { kind: 'trust', pk: PK_OTHER },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(root) },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(binding) },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(left) },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(right) },
  ]

  const harmlessNoiseArb: fc.Arbitrary<Action> = fc.oneof(
    fc.record({
      kind: fc.constant('observe' as const),
      index: fc.constantFrom(
        FIXED_EVENTS.indexOf(link),
        FIXED_EVENTS.indexOf(binding2),
        FIXED_EVENTS.indexOf(overlay),
      ),
    }),
    fc.record({ kind: fc.constant('trust' as const), pk: fc.constant(PK_FOREIGN) }),
    fc.record({ kind: fc.constant('untrust' as const), pk: fc.constant(PK_FOREIGN) }),
  )

  const rootChainOnlySequenceArb: fc.Arbitrary<readonly Action[]> = fc
    .array(harmlessNoiseArb, { maxLength: 15 })
    .map((noise) => [...guaranteedPrefix, ...noise])

  it('reaches the shape ADMIT.md §10 names, with a floor', () => {
    let hits = 0
    fc.assert(
      fc.property(rootChainOnlySequenceArb, (actions) => {
        const deltas = actions.map(toDelta)
        const { events, trusted } = replay(deltas)
        const index = computeAdmission(events, fakeTrust(trusted))
        const leftReasons = index.reasons[left.id] ?? []
        const rightReasons = index.reasons[right.id] ?? []
        if (
          !trusted.includes(PK_ROOT) &&
          leftReasons.includes(rootChainReason(root.id)) &&
          rightReasons.includes(rootChainReason(root.id)) &&
          !leftReasons.includes('direct-trust') &&
          !rightReasons.includes('direct-trust')
        ) {
          hits++
        }
      }),
      { numRuns: 1_000 },
    )
    expect(
      hits,
      'self-fork siblings admitted via root-chain only, root author untrusted',
    ).toBeGreaterThan(500)
  })
})

describe('AG2 — apply-then-invert ≡ exact initial state', () => {
  it('undoes any forward (observe/trust-only) sequence in reverse order', () => {
    fc.assert(
      fc.property(forwardSequenceArb, (actions) => {
        const deltas = actions.map(toForwardDelta)
        const inverses = [...deltas].reverse().map(invertDelta)
        let state = EMPTY_ADMIT_STATE
        for (const d of [...deltas, ...inverses]) state = applyDelta(state, d)
        expect(state).toEqual(EMPTY_ADMIT_STATE)
      }),
      { numRuns: 10_000 },
    )
  })
})

describe('AG2 regression — unobserving a root-chain member must strip its root-chain reason too', () => {
  it('pinned counterexample: trust(root author), observe(root), observe(root-chain member), invert', () => {
    // Shrunk from AG2's fast-check failure. Forward: trust(PK_ROOT) credits nothing yet (nothing
    // observed); observe(root) credits root's own direct-trust; observe(left) credits left's own
    // direct-trust *and*, via resync, left's root-chain:<root.id> (left qualifies as a root-chain
    // member of root). The bug: undoing observe(left) via unobserve stripped only direct-trust,
    // leaving root-chain:<root.id> stranded on `left` forever, since once `left` is removed from
    // observedById nothing will ever revisit it to clean the reason up.
    const state0 = EMPTY_ADMIT_STATE
    const forward: readonly ForwardDelta[] = [
      { kind: 'trust', pubkeys: [PK_ROOT] },
      { kind: 'observe', events: [root] },
      { kind: 'observe', events: [left] },
    ]
    const inverses = [...forward].reverse().map(invertDelta)
    let state = state0
    for (const d of [...forward, ...inverses]) state = applyDelta(state, d)
    expect(state).toEqual(state0)
  })
})

// ---------------------------------------------------------------------------
// S5-5 — the AG1 generator never emitted `unobserve` (Step-5/Stryker, 2026-08-09). 14 mutants
// inside applyDelta's unobserve branch (the un-cascade and the member strip) survived the first
// mutation pass: no property ever drove a root-with-members or a member-with-reasons out of
// `observedById`. `replay` already modelled unobserve; the action pool simply never drew it.
// The uniform generator above is deliberately left untouched — its floors were calibrated
// against its mix — and the four-action generator below carries the gap instead.
// ---------------------------------------------------------------------------

const unobserveActionArb: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant('unobserve' as const),
  index: fc.integer({ min: 0, max: FIXED_EVENTS.length - 1 }),
})

const sequenceWithUnobserveArb: fc.Arbitrary<readonly Action[]> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('observe' as const),
      index: fc.integer({ min: 0, max: FIXED_EVENTS.length - 1 }),
    }),
    unobserveActionArb,
    fc.record({ kind: fc.constant('trust' as const), pk: fc.constantFrom(...PUBKEYS) }),
    fc.record({ kind: fc.constant('untrust' as const), pk: fc.constantFrom(...PUBKEYS) }),
  ),
  { maxLength: 40 },
)

/** True when `state` shows root admitted with at least one member holding its root-chain
 * reason and delta `d` unobserves the root, or when `d` unobserves an id that currently holds
 * at least one reason — the two transitions ADMIT.md §9 invariants 2 and 3 name. */
function isCascadeShape(state: AdmissionIndex, d: AdmissionDelta): boolean {
  if (d.kind !== 'unobserve') return false
  const rootAdmitted = (state.reasons[root.id]?.length ?? 0) > 0
  const hasMember = Object.entries(state.reasons).some(
    ([id, reasons]) => id !== root.id && reasons.includes(rootChainReason(root.id)),
  )
  if (rootAdmitted && hasMember && d.eventIds.includes(root.id)) return true
  return d.eventIds.some((id) => (state.reasons[id]?.length ?? 0) > 0)
}

describe('AG1 (S5-5) — the oracle check, now fed unobserve deltas', () => {
  it('matches the oracle at every prefix across observation gaps, with a cascade floor', () => {
    let cascadeShapes = 0
    let sequencesWithCascade = 0
    fc.assert(
      fc.property(sequenceWithUnobserveArb, (actions) => {
        const deltas = actions.map(toDelta)
        let state = EMPTY_ADMIT_STATE
        let hit = false
        for (let i = 0; i < deltas.length; i++) {
          if (isCascadeShape(toIndex(state), deltas[i] as AdmissionDelta)) {
            cascadeShapes++
            hit = true
          }
          state = applyDelta(state, deltas[i] as AdmissionDelta)
          const { events, trusted } = replay(deltas.slice(0, i + 1))
          const oracle = computeAdmission(events, fakeTrust(trusted))
          expect(toIndex(state), `after prefix of length ${i + 1}`).toEqual(oracle)
        }
        if (hit) sequencesWithCascade++
      }),
      { numRuns: 10_000 },
    )
    console.log(
      `admit unobserve generator mix: cascadeShapes=${cascadeShapes} ` +
        `sequencesWithCascade=${sequencesWithCascade}`,
    )
    // The check above is only as strong as the shapes it reaches: a member-with-reasons or an
    // admitted-root-with-members must actually be unobserved, not just generatable.
    expect(sequencesWithCascade, 'sequences reaching an unobserve cascade shape').toBeGreaterThan(
      100,
    )
  })
})

describe('AG4 (S5-5) — unobserving an admitted root un-cascades its root-chain members', () => {
  /**
   * The uniform generator reaches "admitted root with members, then removed" only by chance; as
   * with the two AG4 describes above, the shape is guaranteed by the prefix and only the teardown
   * varies: remove the root (un-cascade), remove a member (invariant-3 strip), remove the
   * revoking kind 5 (binding liveness *restored* by un-observation), or nothing.
   */
  const rootIndex = FIXED_EVENTS.indexOf(root)
  const leftIndex = FIXED_EVENTS.indexOf(left)
  const guaranteedPrefix: readonly Action[] = [
    { kind: 'trust', pk: PK_OTHER },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(binding) },
    { kind: 'observe', index: rootIndex },
    { kind: 'observe', index: leftIndex },
    { kind: 'observe', index: FIXED_EVENTS.indexOf(right) },
  ]
  const tailArb: fc.Arbitrary<readonly Action[]> = fc.oneof(
    fc.constant([{ kind: 'unobserve' as const, index: rootIndex }]),
    fc.constant([{ kind: 'unobserve' as const, index: leftIndex }]),
    fc.constant([{ kind: 'unobserve' as const, index: FIXED_EVENTS.indexOf(deleteBinding) }]),
    fc.constant([]),
  )
  const cascadeSequenceArb: fc.Arbitrary<readonly Action[]> = tailArb.map((tail) => [
    ...guaranteedPrefix,
    ...tail,
  ])

  it('matches the oracle exactly through root/member/revoker removal, with a shape floor', () => {
    let hits = 0
    fc.assert(
      fc.property(cascadeSequenceArb, (actions) => {
        const deltas = actions.map(toDelta)
        let state = EMPTY_ADMIT_STATE
        for (let i = 0; i < deltas.length; i++) {
          if (isCascadeShape(toIndex(state), deltas[i] as AdmissionDelta)) hits++
          state = applyDelta(state, deltas[i] as AdmissionDelta)
          const { events, trusted } = replay(deltas.slice(0, i + 1))
          const oracle = computeAdmission(events, fakeTrust(trusted))
          expect(toIndex(state), `after prefix of length ${i + 1}`).toEqual(oracle)
        }
      }),
      { numRuns: 1_000 },
    )
    expect(
      hits,
      'unobserve landing on an admitted root or on a member holding reasons',
    ).toBeGreaterThan(400)
  })
})

describe('D23 regression — sticky admission after revocation', () => {
  it.each(['observe', 'trust'] as const)(
    'redundant delivery via a repeated %s delta does not leave the endpoint stuck admitted',
    (redundancy) => {
      const r = product(`sticky-root-${redundancy}`)
      const m = metadata(`sticky-link-${redundancy}`, { pubkey: PK_FOREIGN })
      const b = bindingEvent(`sticky-binding-${redundancy}`, r.id, m.id, { pubkey: PK_OTHER })
      const revoke = deletion(`sticky-revoke-${redundancy}`, [b.id], PK_OTHER)

      let state = EMPTY_ADMIT_STATE
      if (redundancy === 'observe') {
        state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] })
        // The redundant re-delivery: the same Binding, observed twice.
        state = applyDelta(state, { kind: 'observe', events: [r, m, b] })
        state = applyDelta(state, { kind: 'observe', events: [r, m, b] })
      } else {
        state = applyDelta(state, { kind: 'observe', events: [r, m, b] })
        state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] })
        state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] }) // redundant — already trusted
      }
      expect(isAdmitted(toIndex(state), m.id)).toBe(true)

      state = applyDelta(state, { kind: 'observe', events: [revoke] })
      expect(isAdmitted(toIndex(state), m.id)).toBe(false)
      expect(isAdmitted(toIndex(state), r.id)).toBe(false)
    },
  )
})
