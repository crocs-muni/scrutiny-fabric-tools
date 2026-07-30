/**
 * Scenario arbitrary for the Phase 5 gate (SG1/SG5).
 *
 * Composes several of the same named shapes `store.test.ts` covers directly — a chain, a Binding
 * pair (correctly or incorrectly typed, delivered adjacently or not), a two-relay dedup race, trust
 * churn — rather than a from-scratch grammar, the way AG4's generator composes named admission
 * shapes. Every event is emitted as its own single-event `observe` delta (never batched here), which
 * is what lets SG1 permute the *whole delta sequence*, not just an event array within one delta.
 */

import fc from 'fast-check'
import type { NostrEvent } from '../src/events.js'
import type { StoreDelta } from '../src/store.js'
import { PK_ROOT } from './_fixtures.js'
import { deletion, diffPatch, root } from './_resolve.js'
import { bindingAt, forged, genuine, metadataAt } from './_store.js'

/** Outcome-mix bookkeeping the property assertions read floors from — one field per named bias. */
export interface ScenarioMix {
  readonly bindingsWellTyped: number
  readonly bindingsMisTyped: number
  readonly bindingEndpointsNonAdjacent: number
  readonly dedupRaces: number
  readonly trustThenObserveSameTick: number
}

export const emptyMix = (): ScenarioMix => ({
  bindingsWellTyped: 0,
  bindingsMisTyped: 0,
  bindingEndpointsNonAdjacent: 0,
  dedupRaces: 0,
  trustThenObserveSameTick: 0,
})

/** Field-wise sum — the property test accumulates one `ScenarioMix` per generated scenario into a running total this way. */
export const addMix = (a: ScenarioMix, b: ScenarioMix): ScenarioMix => ({
  bindingsWellTyped: a.bindingsWellTyped + b.bindingsWellTyped,
  bindingsMisTyped: a.bindingsMisTyped + b.bindingsMisTyped,
  bindingEndpointsNonAdjacent: a.bindingEndpointsNonAdjacent + b.bindingEndpointsNonAdjacent,
  dedupRaces: a.dedupRaces + b.dedupRaces,
  trustThenObserveSameTick: a.trustThenObserveSameTick + b.trustThenObserveSameTick,
})

export interface StoreScenario {
  readonly deltas: readonly StoreDelta[]
  readonly rootIds: readonly string[]
  readonly mix: ScenarioMix
}

const observe = (event: NostrEvent): StoreDelta => ({ kind: 'observe', events: [event] })

let scenarioCounter = 0

/**
 * Each entry is a *lone* trust or untrust on one pubkey — never both for the same pubkey within one
 * scenario. Pairing trust(pk) with untrust(pk) makes the two order-dependent on *each other* (the
 * final admission state genuinely differs depending on which came last, which is correct behaviour
 * for a revocation history, not a confluence violation) — freely permuting such a pair across the
 * whole delta sequence would fail SG1 for a reason that has nothing to do with UR-1, which is scoped
 * to the *observed event set*. Distinct pubkeys' trust actions remain mutually independent and safe
 * to permute against everything else, which is what this scenario actually needs to test.
 */
const trustAction = fc.record({
  pubkey: fc.constantFrom('trust-a', 'trust-b'),
  trust: fc.boolean(),
})

const spec = fc.record({
  chainLen: fc.integer({ min: 0, max: 4 }),
  bindingWellTyped: fc.boolean(),
  bindingAdjacent: fc.boolean(),
  includeSecondMistypedBinding: fc.boolean(),
  dedupRaceForgedFirst: fc.boolean(),
  trustActions: fc.uniqueArray(trustAction, { maxLength: 2, selector: (a) => a.pubkey }),
  trustImmediatelyBeforeObserve: fc.boolean(),
  deleteFirstPatch: fc.boolean(),
})

function build(s: {
  chainLen: number
  bindingWellTyped: boolean
  bindingAdjacent: boolean
  includeSecondMistypedBinding: boolean
  dedupRaceForgedFirst: boolean
  trustActions: readonly { pubkey: string; trust: boolean }[]
  trustImmediatelyBeforeObserve: boolean
  deleteFirstPatch: boolean
}): StoreScenario {
  scenarioCounter += 1
  const tag = `s${scenarioCounter}`
  const deltas: StoreDelta[] = []
  const rootIds: string[] = []
  const mix = { ...emptyMix() }

  const r = genuine(root('a\n', `${tag}-root`))
  rootIds.push(r.id)
  deltas.push(observe(r))

  let parent = r.id
  let content = 'a\n'
  const patchIds: string[] = []
  for (let i = 0; i < s.chainLen; i++) {
    const next = `${content}L${i}\n`
    const patch = genuine(diffPatch(`${tag}-p${i}`, r.id, parent, content, next))
    deltas.push(observe(patch))
    patchIds.push(patch.id)
    content = next
    parent = patch.id
  }
  if (s.deleteFirstPatch && patchIds[0] !== undefined) {
    deltas.push(observe(genuine(deletion(`${tag}-del`, [patchIds[0]], PK_ROOT))))
  }

  // A Binding pair — well-typed (product root, metadata link) or mistyped (both roots), and its two
  // endpoints delivered either adjacently or with an unrelated event spliced between them (SG5).
  const linkForWellTyped = genuine(metadataAt(`${tag}-link`, 'metadata'))
  const linkForMistyped = genuine(root('a\n', `${tag}-link2`)) // wrong type on purpose
  const link = s.bindingWellTyped ? linkForWellTyped : linkForMistyped
  const binding = genuine(bindingAt(`${tag}-binding`, r.id, link.id))
  deltas.push(observe(binding))
  if (!s.bindingAdjacent) {
    deltas.push(observe(genuine(root('a\n', `${tag}-filler`))))
    mix.bindingEndpointsNonAdjacent++
  }
  deltas.push(observe(link))
  if (s.bindingWellTyped) mix.bindingsWellTyped++
  else mix.bindingsMisTyped++

  if (s.includeSecondMistypedBinding) {
    const link2 = genuine(root('a\n', `${tag}-link3`))
    const binding2 = genuine(bindingAt(`${tag}-binding2`, r.id, link2.id))
    deltas.push(observe(binding2))
    deltas.push(observe(link2))
    mix.bindingsMisTyped++
  }

  // A two-relay dedup race (D20/SG3), embedded as one generator shape among several.
  const raceTarget = genuine(root('a\n', `${tag}-race`))
  const raceForged = forged(raceTarget)
  if (s.dedupRaceForgedFirst) {
    deltas.push(observe(raceForged))
    deltas.push(observe(raceTarget))
  } else {
    deltas.push(observe(raceTarget))
    deltas.push(observe(raceForged))
  }
  rootIds.push(raceTarget.id)
  mix.dedupRaces++

  // Trust churn — one lone trust or untrust per pubkey (never a pair; see `trustAction`'s comment),
  // sometimes immediately followed (same tick) by an observe.
  for (const action of s.trustActions) {
    deltas.push(
      action.trust
        ? { kind: 'trust', pubkeys: [action.pubkey] }
        : { kind: 'untrust', pubkeys: [action.pubkey] },
    )
    if (s.trustImmediatelyBeforeObserve) {
      deltas.push(observe(genuine(root('a\n', `${tag}-after-trust-${action.pubkey}`))))
      mix.trustThenObserveSameTick++
    }
  }

  return { deltas, rootIds, mix }
}

export const storeScenario: fc.Arbitrary<StoreScenario> = spec.map(build)

/** A scenario paired with a full permutation of its own delta array. */
export const storeScenarioAndPermutation: fc.Arbitrary<{
  scenario: StoreScenario
  permuted: readonly StoreDelta[]
}> = storeScenario.chain((s) =>
  fc
    .shuffledSubarray([...s.deltas], { minLength: s.deltas.length, maxLength: s.deltas.length })
    .map((permuted) => ({ scenario: s, permuted })),
)
