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
 * one revoked, a self-fork where only one sibling's author is independently trusted, and a root
 * losing its last admission reason while its patches are still being delivered.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type AdmissionDelta,
  EMPTY_ADMIT_STATE,
  type ForwardDelta,
  applyDelta,
  computeAdmission,
  invertDelta,
  isAdmitted,
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
const left = rootPatch('left', root.id, root.id) // self-fork sibling 1
const right = rootPatch('right', root.id, root.id) // self-fork sibling 2
const overlay = foreignPatch('overlay', root.id, root.id)
const deleteLeft = deletion('delete-left', [left.id], PK_ROOT)
const deleteBinding = deletion('delete-binding', [binding.id], PK_OTHER)

const FIXED_EVENTS: readonly NostrEvent[] = [
  root,
  link,
  binding,
  left,
  right,
  overlay,
  deleteLeft,
  deleteBinding,
]
const PUBKEYS = [PK_ROOT, PK_FOREIGN, PK_OTHER]

// ---------------------------------------------------------------------------
// Generator — one event or one pubkey per action, drawn with replacement, so exact duplicates
// (redundant delivery) and revoke-after-redundant-observe are reachable, not just plausible.
// ---------------------------------------------------------------------------

type Action =
  | { readonly kind: 'observe'; readonly index: number }
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

const toDelta = (a: Action): AdmissionDelta =>
  a.kind === 'observe'
    ? { kind: 'observe', events: [FIXED_EVENTS[a.index] as NostrEvent] }
    : { kind: a.kind, pubkeys: [a.pk] }

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

  it('reaches the hard shapes often enough for the property above to mean something', () => {
    let redundantObserve = 0
    let retrustChurn = 0
    let multiReasonOverlap = 0
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

        const deltas = actions.map(toDelta)
        const { events, trusted } = replay(deltas)
        const index = computeAdmission(events, fakeTrust(trusted))
        for (const reasons of Object.values(index.reasons))
          if (reasons.length > 1) multiReasonOverlap++
      }),
      { numRuns: 3_000 },
    )
    console.log(
      `admit generator mix: redundantActions=${redundantObserve} retrustChurn=${retrustChurn} ` +
        `multiReasonOverlap=${multiReasonOverlap}`,
    )
    expect(redundantObserve, 'redundant/duplicate actions').toBeGreaterThan(200)
    expect(retrustChurn, 'sequences with real trust churn').toBeGreaterThan(50)
    expect(multiReasonOverlap, 'events admitted by more than one reason at once').toBeGreaterThan(
      20,
    )
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

describe('D23 regression — sticky admission after revocation', () => {
  it('a Binding delivered twice, then revoked once, does not leave its endpoints stuck admitted', () => {
    const r = product('sticky-root')
    const m = metadata('sticky-link', { pubkey: PK_FOREIGN })
    const b = bindingEvent('sticky-binding', r.id, m.id, { pubkey: PK_OTHER })
    const revoke = deletion('sticky-revoke', [b.id], PK_OTHER)

    let state = EMPTY_ADMIT_STATE
    state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] })
    // The redundant re-delivery: the same Binding, observed twice.
    state = applyDelta(state, { kind: 'observe', events: [r, m, b] })
    state = applyDelta(state, { kind: 'observe', events: [r, m, b] })
    expect(isAdmitted(toIndex(state), m.id)).toBe(true)

    state = applyDelta(state, { kind: 'observe', events: [revoke] })
    expect(isAdmitted(toIndex(state), m.id)).toBe(false)
    expect(isAdmitted(toIndex(state), r.id)).toBe(false)
  })

  it('the same effect holds when the redundancy is a repeated trust delta instead', () => {
    const r = product('sticky-root-2')
    const m = metadata('sticky-link-2', { pubkey: PK_FOREIGN })
    const b = bindingEvent('sticky-binding-2', r.id, m.id, { pubkey: PK_OTHER })
    const revoke = deletion('sticky-revoke-2', [b.id], PK_OTHER)

    let state = EMPTY_ADMIT_STATE
    state = applyDelta(state, { kind: 'observe', events: [r, m, b] })
    state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] })
    state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] }) // redundant — already trusted
    expect(isAdmitted(toIndex(state), m.id)).toBe(true)

    state = applyDelta(state, { kind: 'observe', events: [revoke] })
    expect(isAdmitted(toIndex(state), m.id)).toBe(false)
  })
})
