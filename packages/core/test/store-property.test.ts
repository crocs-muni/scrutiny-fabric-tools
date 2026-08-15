/**
 * The Phase 5 gate: SG1 (confluence), SG2 (epoch cost), SG3 (dedup-after-verification), SG5
 * (generator bias and floors). SG4 (rule-coverage partition) is `a-store-coverage.test.ts`.
 *
 * Design in `docs/STORE.md` §9. SG1 compares `StoreView`, not raw `StoreState` — see STORE.md §3's
 * correction and §10's regression record for why full-state comparison would be the wrong gate.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { NostrEvent } from '../src/events.js'
import {
  EMPTY_STORE_STATE,
  type StoreDelta,
  type StoreState,
  applyStoreDelta,
  createResolveMemo,
  resolveRootMemoized,
  toStoreView,
} from '../src/store.js'
import { root } from './_resolve.js'
import {
  addMix,
  emptyMix,
  storeScenario,
  storeScenarioAndPermutation,
} from './_store-generators.js'
import { forged, genuine, verifyBySig } from './_store.js'

/** Every `observe` delta's events, filtered through the verify gate — the one thing every fold below shares. */
function gatedObserveEvents(deltas: readonly StoreDelta[]): NostrEvent[] {
  return deltas
    .filter((d) => d.kind === 'observe')
    .flatMap((d) => d.events)
    .filter(verifyBySig)
}

/**
 * `applyStoreDelta` assumes its `observe` events already passed the verify gate (STORE.md §5) —
 * that gate is `createStore`'s `add()`, not the reducer's job. The shared generator's dedup-race
 * shape (SG5) includes a forged submission precisely so SG1/SG2 exercise scenarios *containing* one,
 * but "first arrival wins" idempotent dedup inside the reducer is correctly order-dependent for two
 * distinct objects sharing an id — that is not a confluence violation, it is what the gate exists to
 * prevent ever reaching the reducer in the first place. So every fold in this file simulates the
 * gate first, exactly as `createStore.add()` would, before handing events to `applyStoreDelta`.
 */
function foldGated(deltas: readonly StoreDelta[]): StoreState {
  return deltas.reduce((state, delta) => {
    if (delta.kind !== 'observe') return applyStoreDelta(state, delta)
    const passing = delta.events.filter(verifyBySig)
    return passing.length === 0
      ? state
      : applyStoreDelta(state, { kind: 'observe', events: passing })
  }, EMPTY_STORE_STATE)
}

describe('SG1 — confluence, store-level (UR-1)', () => {
  it('reaches the same StoreView for any permutation of the whole delta sequence', () => {
    fc.assert(
      fc.property(storeScenarioAndPermutation, ({ scenario: s, permuted }) => {
        const ordered = foldGated(s.deltas)
        const shuffled = foldGated(permuted)
        expect(toStoreView(shuffled)).toEqual(toStoreView(ordered))

        // Separately, per STORE.md §9: every root the scenario touches must resolve identically
        // too, with a fresh memo each time so the memo itself is never a confound.
        for (const rootId of s.rootIds) {
          const a = resolveRootMemoized(ordered, rootId, createResolveMemo())
          const b = resolveRootMemoized(shuffled, rootId, createResolveMemo())
          expect(b, `resolveRoot(${rootId}) diverged under permutation`).toEqual(a)
        }
      }),
      { numRuns: 2_000 },
    )
  })

  it('also holds when every event is batched into one observe delta per scenario', () => {
    // Batching is a real code path (`add()` on a multi-event array) single-event folding cannot
    // exercise on its own (STORE.md §9) — a bug reachable only via the batched branch would
    // otherwise slip through every other property here.
    fc.assert(
      fc.property(storeScenario, (s) => {
        const events = gatedObserveEvents(s.deltas)
        const nonObserve = s.deltas.filter((d) => d.kind !== 'observe')

        const perEvent = foldGated(s.deltas)

        let batched: StoreState = EMPTY_STORE_STATE
        if (events.length > 0) {
          batched = applyStoreDelta(batched, { kind: 'observe', events })
        }
        batched = nonObserve.reduce(applyStoreDelta, batched)

        expect(toStoreView(batched)).toEqual(toStoreView(perEvent))
      }),
      { numRuns: 1_000 },
    )
  })
})

describe('SG2 — epoch cost (D24)', () => {
  it('a trust-only delta leaves chainEpoch and chainMembership referentially unchanged', () => {
    fc.assert(
      fc.property(storeScenario, fc.constantFrom('pk-x', 'pk-y'), fc.boolean(), (s, pk, trust) => {
        const before = foldGated(s.deltas)
        const after = applyStoreDelta(
          before,
          trust ? { kind: 'trust', pubkeys: [pk] } : { kind: 'untrust', pubkeys: [pk] },
        )
        expect(after.chainEpoch).toBe(before.chainEpoch) // same reference, not merely deep-equal
        expect(after.chainMembership).toBe(before.chainMembership)
        expect(after.pendingAwaiting).toBe(before.pendingAwaiting)
        expect(after.overlayAwaiting).toBe(before.overlayAwaiting) // trust-only delta is a trust-only delta — overlayAwaiting carried through by reference
        expect(after.invalidIds).toBe(before.invalidIds)
        expect(after.observedEpoch).toBe(before.observedEpoch)
      }),
      { numRuns: 2_000 },
    )
  })

  it('the Resolution memo is never invalidated by a trust-only delta', () => {
    fc.assert(
      fc.property(storeScenario, fc.constantFrom('pk-x', 'pk-y'), (s, pk) => {
        const before = foldGated(s.deltas)
        const memo = createResolveMemo()
        const resolved = s.rootIds.map((id) => resolveRootMemoized(before, id, memo))

        const after = applyStoreDelta(before, { kind: 'trust', pubkeys: [pk] })
        const resolvedAfter = s.rootIds.map((id) => resolveRootMemoized(after, id, memo))

        for (const [i, r] of resolved.entries()) expect(resolvedAfter[i]).toBe(r)
      }),
      { numRuns: 1_000 },
    )
  })
})

describe('SG3 — dedup-after-verification is not bypassable (D20)', () => {
  it('the genuine copy always wins the two-relay race, in either order, across two add() calls', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (forgedFirst, singleCall) => {
        const genuineEvent = genuine(root('a\n', `race-${forgedFirst}-${singleCall}`))
        const forgedEvent = forged(genuineEvent, 'FORGED-CONTENT')

        const order = forgedFirst ? [forgedEvent, genuineEvent] : [genuineEvent, forgedEvent]
        // Each arrival is its own delta (mirroring "across two add() calls"); foldGated is the gate
        // itself (STORE.md §5) — a failing submission never reaches applyStoreDelta at all.
        const state = foldGated(order.map((event) => ({ kind: 'observe', events: [event] })))

        const stored = state.admit.observedById[genuineEvent.id]
        expect(stored, 'the genuine copy must be present regardless of arrival order').toBeDefined()
        expect(stored?.content).toBe(genuineEvent.content)
        expect(stored?.sig).toBe('valid')
      }),
      { numRuns: 200 },
    )
  })
})

describe('SG5 — generator bias and floors', () => {
  it('reaches every named shape often enough for SG1/SG3 to mean something', () => {
    let mix = emptyMix()
    let totalInvalidIds = 0

    fc.assert(
      fc.property(storeScenario, (s) => {
        mix = addMix(mix, s.mix)

        const state = foldGated(s.deltas)
        totalInvalidIds += state.invalidIds.length
      }),
      { numRuns: 1_500 },
    )

    console.log(`store generator mix: ${JSON.stringify(mix)}`)
    console.log(`total invalid ids actually recorded: ${totalInvalidIds}`)

    expect(mix.bindingsWellTyped, 'well-typed Bindings').toBeGreaterThan(200)
    expect(mix.bindingsMisTyped, 'mistyped (BD-7) Bindings').toBeGreaterThan(200)
    expect(mix.bindingEndpointsNonAdjacent, 'non-adjacent endpoint delivery').toBeGreaterThan(200)
    expect(mix.dedupRaces, 'dedup races').toBe(1_500) // emitted once per scenario, unconditionally
    expect(mix.trustThenObserveSameTick, 'trust immediately followed by observe').toBeGreaterThan(
      100,
    )
    expect(
      mix.overlayCrossRoot,
      'cross-root overlay shape (OVERLAY-AWAITING.md §8 RC-3)',
    ).toBeGreaterThan(100)
    expect(totalInvalidIds, 'invalid ids actually recorded').toBeGreaterThan(100)
  })
})
