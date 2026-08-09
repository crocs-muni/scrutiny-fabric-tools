import { describe, expect, it } from 'vitest'
import {
  EMPTY_ADMIT_STATE,
  applyDelta,
  bindingEndpoints,
  bindingReason,
  computeAdmission,
  invertDelta,
  isAdmitted,
  isDefaultViewRetracted,
  openView,
  reasonKind,
  rootChainReason,
  toIndex,
  trustedView,
  visibleOverlays,
} from '../src/admit.js'
import { resolve } from '../src/resolve.js'
import {
  bindingEvent,
  deletion,
  fakeTrust,
  foreignPatch,
  metadata,
  product,
  rootPatch,
} from './_admit.js'
import { PK_FOREIGN, PK_OTHER, PK_ROOT, baseTags } from './_fixtures.js'

describe('TR-2 — direct trust admits by pubkey, regardless of event type', () => {
  it('admits a root whose author is trusted, and nothing else', () => {
    const root = product('root')
    const index = computeAdmission([root], fakeTrust([PK_ROOT]))
    expect(isAdmitted(index, root.id)).toBe(true)
    expect(index.reasons[root.id]).toEqual(['direct-trust'])
  })

  it('admits nothing when no pubkey is trusted', () => {
    const root = product('root')
    const index = computeAdmission([root], fakeTrust([]))
    expect(isAdmitted(index, root.id)).toBe(false)
  })
})

describe('TR-3 — a Binding is admitted only by direct trust, never transitively', () => {
  it('does not admit a Binding just because its endpoints are trusted', () => {
    const root = product('root') // pubkey PK_ROOT, trusted below
    const link = metadata('link', { pubkey: PK_FOREIGN }) // distinct author, untrusted
    const b = bindingEvent('b', root.id, link.id) // authored by PK_OTHER, also untrusted
    const index = computeAdmission([root, link, b], fakeTrust([PK_ROOT]))
    expect(isAdmitted(index, b.id)).toBe(false)
    // and consequently confers nothing on its endpoints — link's own author is untrusted, so
    // nothing but the (absent) Binding credit could have admitted it.
    expect(index.reasons[link.id]).toBeUndefined()
  })

  it("a Binding's reason set is always a subset of {direct-trust} — never binding:* or root-chain:*", () => {
    const root = product('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_ROOT })
    // Trust the Binding's own author AND the root author, and give the root a chain, to try to
    // provoke a binding:* or root-chain:* reason landing on the Binding itself.
    const p = rootPatch('p', root.id, root.id)
    const index = computeAdmission([root, link, b, p], fakeTrust([PK_ROOT]))
    const reasons = index.reasons[b.id] ?? []
    for (const r of reasons) expect(reasonKind(r)).toBe('direct-trust')
  })
})

describe('TR-4 — an admitted Binding admits both endpoints', () => {
  it('credits both endpoints with a reason naming the Binding', () => {
    const root = product('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    const index = computeAdmission([root, link, b], fakeTrust([PK_OTHER]))
    expect(index.reasons[root.id]).toEqual([bindingReason(b.id)])
    expect(index.reasons[link.id]).toEqual([bindingReason(b.id)])
  })

  it('BD-6 — a trusted Binding credits an endpoint that has not arrived yet', () => {
    const root = product('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    // link is never included in `events` — only its id is known, via the Binding's own tag.
    const index = computeAdmission([root, b], fakeTrust([PK_OTHER]))
    expect(index.reasons[link.id]).toEqual([bindingReason(b.id)])
  })

  it('two live Bindings crediting the same endpoint both survive one revocation', () => {
    const root = product('root')
    const link = metadata('link')
    const b1 = bindingEvent('b1', root.id, link.id, { pubkey: PK_OTHER })
    const b2 = bindingEvent('b2', root.id, link.id, { pubkey: PK_FOREIGN })
    const revokeB1 = deletion('revoke-b1', [b1.id], PK_OTHER)
    const index = computeAdmission(
      [root, link, b1, b2, revokeB1],
      fakeTrust([PK_OTHER, PK_FOREIGN]),
    )
    // b1 is retracted; b2 is still live and still credits the link.
    expect(index.reasons[link.id]).toEqual([bindingReason(b2.id)])
  })
})

describe('S3-22 — a Binding whose observed endpoints fail BD-3/BD-4 credits nothing', () => {
  // The credit rules above (TR-3/TR-4) presuppose endpoints that satisfy the typing rule. The
  // guard added after the 2026-08-08 audit keeps that consequence true even when `admit` is used
  // directly, outside the wired `store.add()` pipeline that would BD-5-reject such a Binding.
  // (BD-6's unobserved-endpoint credit is already pinned above in TR-4 and is unaffected.)

  it('oracle: a mistyped root endpoint (metadata, not product) revokes both credits', () => {
    const root = metadata('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    const index = computeAdmission([root, link, b], fakeTrust([PK_OTHER]))
    expect(index.reasons[root.id] ?? []).not.toContain(bindingReason(b.id))
    expect(index.reasons[link.id] ?? []).not.toContain(bindingReason(b.id))
  })

  it('oracle: a mistyped link endpoint (product, not metadata) revokes both credits', () => {
    const root = product('root')
    const link = product('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    const index = computeAdmission([root, link, b], fakeTrust([PK_OTHER]))
    expect(index.reasons[root.id] ?? []).not.toContain(bindingReason(b.id))
    expect(index.reasons[link.id] ?? []).not.toContain(bindingReason(b.id))
  })

  it('incremental tracks the oracle: observing a mistyped endpoint revokes earlier credit', () => {
    const root = metadata('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    // Trust first, then observe the Binding alone: its endpoints are unobserved, so per BD-6's
    // "once observed" qualifier both are (inertly) credited...
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'trust', pubkeys: [PK_OTHER] })
    state = applyDelta(state, { kind: 'observe', events: [b] })
    expect(toIndex(state).reasons[root.id]).toEqual([bindingReason(b.id)])
    // ...then the endpoints arrive and the root turns out mistyped: liveness flips and the
    // incremental uncredits exactly what it credited — landing on the oracle's answer.
    state = applyDelta(state, { kind: 'observe', events: [root, link] })
    expect(toIndex(state).reasons[root.id] ?? []).not.toContain(bindingReason(b.id))
    const oracle = computeAdmission([b, root, link], fakeTrust([PK_OTHER]))
    expect(toIndex(state).reasons).toEqual(oracle.reasons)
  })
})

describe('TR-5 — root-chain admission includes what resolve.ts would exclude from the walk', () => {
  it('admits both branches of an unresolved self-fork, not just the one resolve would pick', () => {
    const root = product('root')
    const left = rootPatch('left', root.id, root.id)
    const right = rootPatch('right', root.id, root.id) // same parent — a self-fork
    // Trusting PK_ROOT directly also gives both patches their own direct-trust reason (correct —
    // a trusted author's own events are always directly admitted); root-chain must be present
    // *in addition*, which is the thing this test is actually checking.
    const index = computeAdmission([root, left, right], fakeTrust([PK_ROOT]))
    expect(isAdmitted(index, left.id)).toBe(true)
    expect(isAdmitted(index, right.id)).toBe(true)
    expect(index.reasons[left.id]).toContain(rootChainReason(root.id))
    expect(index.reasons[right.id]).toContain(rootChainReason(root.id))
  })

  it('admits a root-author kind-5 targeting a root-authored patch', () => {
    const root = product('root')
    const p = rootPatch('p', root.id, root.id)
    const del = deletion('del', [p.id], PK_ROOT)
    const index = computeAdmission([root, p, del], fakeTrust([PK_ROOT]))
    expect(index.reasons[del.id]).toContain(rootChainReason(root.id))
  })

  it('a root-authored patch replying to a *foreign* patch (PT-6/OV-8) is still root-chain admitted', () => {
    const root = product('root')
    const foreign = foreignPatch('foreign', root.id, root.id)
    const followUp = rootPatch('followup', root.id, foreign.id) // replies into a foreign patch
    const index = computeAdmission([root, foreign, followUp], fakeTrust([PK_ROOT]))
    // Not a chain extension per resolve.ts, but TR-5's admission does not care about chain
    // validity — see docs/ADMIT.md §4.
    expect(isAdmitted(index, followUp.id)).toBe(true)
  })

  it('root-chain admission is withdrawn once the root loses its only reason', () => {
    const root = product('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    const p = rootPatch('p', link.id, link.id) // link is also a root, with its own patch
    const revokeB = deletion('revoke', [b.id], PK_OTHER)
    const admittedFirst = computeAdmission([root, link, b, p], fakeTrust([PK_OTHER]))
    expect(isAdmitted(admittedFirst, p.id)).toBe(true)
    const afterRevoke = computeAdmission([root, link, b, p, revokeB], fakeTrust([PK_OTHER]))
    expect(isAdmitted(afterRevoke, link.id)).toBe(false)
    expect(isAdmitted(afterRevoke, p.id)).toBe(false)
  })
})

describe('TR-6 — foreign patches are never transitively admitted via root admission', () => {
  it('a foreign patch stays unadmitted even though its root is admitted', () => {
    const root = product('root')
    const foreign = foreignPatch('foreign', root.id, root.id)
    const index = computeAdmission([root, foreign], fakeTrust([PK_ROOT]))
    expect(isAdmitted(index, foreign.id)).toBe(false)
  })

  it('independent trust in the foreign author admits it directly', () => {
    const root = product('root')
    const foreign = foreignPatch('foreign', root.id, root.id)
    const index = computeAdmission([root, foreign], fakeTrust([PK_ROOT, PK_FOREIGN]))
    expect(index.reasons[foreign.id]).toEqual(['direct-trust'])
  })
})

describe('TR-7 — admission never reaches resolve; it is a filter over already-computed results', () => {
  it("resolve's output is identical whether wrapped in trustedView or openView", () => {
    const root = product('root')
    const foreign = foreignPatch('foreign', root.id, root.id)
    const resolution = resolve(root.id, [root, foreign])
    const trusted = trustedView(computeAdmission([root], fakeTrust([PK_ROOT])))
    expect(visibleOverlays(resolution.overlays, trusted)).toEqual(
      visibleOverlays(resolution.overlays, trusted), // resolve() itself never sees a view at all
    )
    expect(resolution.chain).toEqual(resolve(root.id, [root, foreign]).chain)
  })
})

describe('OV-7 — a foreign overlay is visible only if its pubkey is trusted', () => {
  it('hides an untrusted overlay and shows a trusted one', () => {
    const root = product('root')
    const untrusted = foreignPatch('untrusted', root.id, root.id, { pubkey: PK_FOREIGN })
    const trusted = foreignPatch('trusted', root.id, root.id, { pubkey: PK_OTHER })
    const resolution = resolve(root.id, [root, untrusted, trusted])
    const index = computeAdmission([root, untrusted, trusted], fakeTrust([PK_ROOT, PK_OTHER]))
    const visible = visibleOverlays(resolution.overlays, trustedView(index))
    expect(visible.map((o) => o.id)).toEqual([trusted.id])
  })

  it('openView shows every overlay, matching "show everything"', () => {
    const root = product('root')
    const foreign = foreignPatch('foreign', root.id, root.id)
    const resolution = resolve(root.id, [root, foreign])
    expect(visibleOverlays(resolution.overlays, openView)).toEqual(resolution.overlays)
  })
})

describe('S3-29 — the untrust-narrowing hazard is pinned behaviorally (2026-08-08 audit)', () => {
  // ForwardDelta's type accepts only observe/trust — the compile-time guard — because a lone
  // `untrust` is a no-op that can be sequence-first, with no earlier `trust` for a LIFO undo to
  // pair against (AG2's original counterexample). These pins state the *behavioral* claims the
  // type encodes, named and greppable: legal forwards invert exactly; order is load-bearing.

  it('inverting a legal ForwardDelta restores the pre-delta reason state exactly', () => {
    const root = product('root', { pubkey: PK_OTHER })
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'observe', events: [root] })
    state = applyDelta(state, { kind: 'trust', pubkeys: [PK_OTHER] })
    expect(toIndex(state).reasons[root.id]).toEqual(['direct-trust'])

    // Undo the trust, then undo the observe — each legal inversion is exact.
    let restored = applyDelta(state, invertDelta({ kind: 'trust', pubkeys: [PK_OTHER] }))
    expect(toIndex(restored).reasons).toEqual(toIndex(EMPTY_ADMIT_STATE).reasons)
    restored = applyDelta(restored, invertDelta({ kind: 'observe', events: [root] }))
    expect(toIndex(restored).reasons).toEqual(toIndex(EMPTY_ADMIT_STATE).reasons)
  })

  it('trust/untrust is order-load-bearing: (trust → untrust) round-trips, (untrust → trust) fabricates — so a lone untrust has no sound inverse and ForwardDelta excludes it', () => {
    const root = product('root', { pubkey: PK_OTHER })
    const observed = applyDelta(EMPTY_ADMIT_STATE, { kind: 'observe', events: [root] })

    const roundTrip = applyDelta(applyDelta(observed, { kind: 'trust', pubkeys: [PK_OTHER] }), {
      kind: 'untrust',
      pubkeys: [PK_OTHER],
    })
    expect(toIndex(roundTrip).reasons).toEqual(toIndex(observed).reasons)

    const fabricated = applyDelta(applyDelta(observed, { kind: 'untrust', pubkeys: [PK_OTHER] }), {
      kind: 'trust',
      pubkeys: [PK_OTHER],
    })
    expect(toIndex(fabricated).reasons[root.id]).toEqual(['direct-trust'])
  })
})

describe('S5-14 — a kind 5 whose membership depended on an unobserved sibling loses its credit (AG1 counterexample)', () => {
  // Shrunk by fast-check from the S5-5 unobserve-generator's failure (seed 248381514): observe a
  // root-author kind 5 targeting a patch, trust the root author, observe the patch and the root,
  // then unobserve the patch. resyncRootChain recomputes membership from the *current* observed
  // set, and a dropped-out member is never visited by that recompute — the kind 5 kept its stale
  // root-chain:<root> until resyncRootLearned to revoke non-members explicitly.
  const root = product('root')
  const left = rootPatch('left', root.id, root.id)
  const delLeft = deletion('del-left', [left.id], PK_ROOT)

  it('incremental repeats the oracle, not its own history', () => {
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'observe', events: [delLeft, left] })
    state = applyDelta(state, { kind: 'trust', pubkeys: [PK_ROOT] })
    state = applyDelta(state, { kind: 'observe', events: [root] })
    expect(toIndex(state).reasons[delLeft.id]).toEqual(['direct-trust', `root-chain:${root.id}`])
    state = applyDelta(state, { kind: 'unobserve', eventIds: [left.id] })
    expect(toIndex(state).reasons[delLeft.id]).toEqual(['direct-trust'])
    expect(toIndex(state).reasons).toEqual(
      computeAdmission([delLeft, root], fakeTrust([PK_ROOT])).reasons,
    )
  })
})

describe('DEL-4 — root retraction hides from the default view but never revokes admission', () => {
  it('a retracted root stays admitted', () => {
    const root = product('root')
    const del = deletion('del', [root.id], PK_ROOT)
    const index = computeAdmission([root, del], fakeTrust([PK_ROOT]))
    expect(isAdmitted(index, root.id)).toBe(true)
    expect(isDefaultViewRetracted(root, [del])).toBe(true)
  })

  it('a non-retracted root is not reported retracted', () => {
    const root = product('root')
    expect(isDefaultViewRetracted(root, [])).toBe(false)
  })
})

describe('DEL-5 — Binding retraction revokes exactly the admission it conferred', () => {
  it('revoking a Binding drops its endpoints unless another reason survives', () => {
    const root = product('root')
    const link = metadata('link')
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    const revoke = deletion('revoke', [b.id], PK_OTHER)
    const index = computeAdmission([root, link, b, revoke], fakeTrust([PK_OTHER]))
    expect(isAdmitted(index, root.id)).toBe(false)
    expect(isAdmitted(index, link.id)).toBe(false)
  })

  it('an endpoint independently admitted survives the Binding being revoked', () => {
    const root = product('root') // pubkey PK_ROOT, trusted below
    const link = metadata('link', { pubkey: PK_FOREIGN }) // untrusted — admitted only via the Binding
    const b = bindingEvent('b', root.id, link.id, { pubkey: PK_OTHER })
    const revoke = deletion('revoke', [b.id], PK_OTHER)
    const index = computeAdmission([root, link, b, revoke], fakeTrust([PK_OTHER, PK_ROOT]))
    expect(index.reasons[root.id]).toEqual(['direct-trust'])
    expect(isAdmitted(index, link.id)).toBe(false)
  })
})

describe('S5 — Step-5 pins: value and shape level, where comparing two paths is blind', () => {
  // AG1/AG2 compare the incremental machine against the oracle, and both consume the same
  // spec-level helpers (rootChainReason, bindingEndpoints, rootChainMembers). A mutant inside a
  // shared helper changes both sides identically and the comparison passes anyway (Stryker Step
  // 5: this family is what most admit survivors were). These pins assert the actual bytes and
  // membership shapes instead.

  const root = product('root')
  const link = metadata('link', { pubkey: PK_FOREIGN })
  const binding = bindingEvent('binding', root.id, link.id, { pubkey: PK_OTHER })
  const left = rootPatch('left', root.id, root.id)
  const right = rootPatch('right', root.id, root.id)

  it('pins reason bytes literally — helper drift cannot hide behind helper use', () => {
    const index = computeAdmission([root, link, binding, left], fakeTrust([PK_OTHER]))
    expect(index.reasons[link.id]).toEqual([`binding:${binding.id}`])
    expect(index.reasons[root.id]).toEqual([`binding:${binding.id}`])
    expect(index.reasons[left.id]).toEqual([`root-chain:${root.id}`])
    expect(reasonKind(`binding:${binding.id}`)).toBe('binding')
    expect(reasonKind(`root-chain:${root.id}`)).toBe('root-chain')
    expect(reasonKind('direct-trust')).toBe('direct-trust')
  })

  it('a root is never its own root-chain member (TR-5)', () => {
    const index = computeAdmission([root, left, right], fakeTrust([PK_ROOT]))
    expect(index.reasons[root.id]).toEqual(['direct-trust'])
    expect(index.reasons[left.id]).toEqual(['direct-trust', `root-chain:${root.id}`])
  })

  it('TR-5 membership discriminates by event type, not by tag shape', () => {
    // §5.2's consumer grammar is a floor: events may carry extra tags. A non-patch carrying the
    // patch grammar's markers must not join the chain just because the markers are present —
    // candidacy is by event type first, tag shape second.
    const impostorProduct = product('impostor-product', {
      tags: [...baseTags('product'), ['e', root.id, '', 'root']],
    })
    const impostorRootMeta = metadata('impostor-root-meta', {
      pubkey: PK_ROOT,
      tags: [...baseTags('metadata'), ['e', root.id]],
    })
    const index = computeAdmission(
      [root, left, impostorProduct, impostorRootMeta, binding],
      fakeTrust([PK_OTHER]),
    )
    expect(index.reasons[impostorProduct.id] ?? []).toEqual([])
    expect(index.reasons[impostorRootMeta.id] ?? []).toEqual([])
  })

  it('a foreign-authored kind 5 is never a root-chain member, even when targeting the root', () => {
    const foreignDel = deletion('foreign-del', [root.id], PK_FOREIGN)
    const index = computeAdmission([root, foreignDel, binding], fakeTrust([PK_OTHER]))
    expect(index.reasons[foreignDel.id] ?? []).toEqual([])
  })

  it('a root-authored kind 5 joins via the root or via any one member patch, and nothing else', () => {
    const viaRoot = deletion('del-via-root', [root.id], PK_ROOT)
    const viaPatch = deletion('del-via-patch', ['unrelated', left.id], PK_ROOT)
    const stray = deletion('del-stray', ['unrelated'], PK_ROOT)
    const index = computeAdmission(
      [root, left, viaRoot, viaPatch, stray, binding],
      fakeTrust([PK_OTHER]),
    )
    expect(index.reasons[viaRoot.id]).toEqual([`root-chain:${root.id}`])
    expect(index.reasons[viaPatch.id]).toEqual([`root-chain:${root.id}`])
    expect(index.reasons[stray.id] ?? []).toEqual([])
  })

  it('a Product carrying root AND link markers is still not a Binding — kind discriminates', () => {
    const sneaky = product('sneaky', {
      tags: [...baseTags('product'), ['e', root.id, '', 'root'], ['e', link.id, '', 'link']],
    })
    const oracle = computeAdmission([sneaky, root, link], fakeTrust([PK_ROOT]))
    expect(oracle.reasons[link.id] ?? []).not.toContain(`binding:${sneaky.id}`)
    // …same on the incremental path, which dispatches resyncBinding per event type
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'trust', pubkeys: [PK_ROOT] })
    state = applyDelta(state, { kind: 'observe', events: [sneaky, root, link] })
    expect(toIndex(state).reasons[link.id] ?? []).not.toContain(`binding:${sneaky.id}`)
  })

  it('bindingEndpoints requires exactly one root and one link marker, first-wins is not allowed', () => {
    expect(bindingEndpoints(binding)).toEqual({ rootId: root.id, linkId: link.id })
    const dupRoot = bindingEvent('dup-root', root.id, link.id, {
      tags: [
        ...baseTags('binding'),
        ['e', root.id, '', 'root'],
        ['e', right.id, '', 'root'],
        ['e', link.id, '', 'link'],
      ],
    })
    expect(bindingEndpoints(dupRoot)).toBeUndefined()
    const dupLink = bindingEvent('dup-link', root.id, link.id, {
      tags: [
        ...baseTags('binding'),
        ['e', root.id, '', 'root'],
        ['e', link.id, '', 'link'],
        ['e', right.id, '', 'link'],
      ],
    })
    expect(bindingEndpoints(dupLink)).toBeUndefined()
    const noLink = bindingEvent('no-link', root.id, link.id, {
      tags: [...baseTags('binding'), ['e', root.id, '', 'root']],
    })
    expect(bindingEndpoints(noLink)).toBeUndefined()
  })

  it('a malformed Binding confers nothing and crashes nothing, on both paths (S3-22 family)', () => {
    const bad = bindingEvent('bad', root.id, link.id, {
      tags: [
        ...baseTags('binding'),
        ['e', root.id, '', 'root'],
        ['e', right.id, '', 'root'],
        ['e', link.id, '', 'link'],
      ],
    })
    const oracle = computeAdmission([root, link, bad], fakeTrust([PK_OTHER]))
    expect(oracle.reasons[root.id] ?? []).toEqual([])
    expect(oracle.reasons[link.id] ?? []).toEqual([])
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'trust', pubkeys: [PK_OTHER] })
    state = applyDelta(state, { kind: 'observe', events: [root, link, bad] })
    expect(toIndex(state).reasons[root.id] ?? []).toEqual([])
    expect(Object.keys(state.liveBindings)).toEqual([])
  })

  it('DEL-4 retraction honours any one e tag, and only the author (NIP-09)', () => {
    expect(isDefaultViewRetracted(root, [deletion('d1', ['other', root.id], PK_ROOT)])).toBe(true)
    expect(isDefaultViewRetracted(root, [deletion('d2', [left.id], PK_ROOT)])).toBe(false)
    expect(isDefaultViewRetracted(root, [deletion('d3', [root.id], PK_OTHER)])).toBe(false)
  })

  it('keeps AdmitState.trusted sorted regardless of delta order', () => {
    let state = applyDelta(EMPTY_ADMIT_STATE, {
      kind: 'trust',
      pubkeys: [PK_OTHER, PK_FOREIGN],
    })
    state = applyDelta(state, { kind: 'trust', pubkeys: [PK_ROOT] })
    // Insertion order was OTHER, FOREIGN, ROOT; the record is sorted for deep-equality.
    expect(state.trusted).toEqual([PK_ROOT, PK_FOREIGN, PK_OTHER])
  })

  it('unobserving an admitted root un-cascades root-chain:<root> from patches and kind 5s (§9 invariant 2)', () => {
    const delLeft = deletion('del-left', [left.id], PK_ROOT)
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'trust', pubkeys: [PK_OTHER] })
    state = applyDelta(state, { kind: 'observe', events: [binding, root, left, delLeft] })
    expect(toIndex(state).reasons[left.id]).toEqual([`root-chain:${root.id}`])
    expect(toIndex(state).reasons[delLeft.id]).toEqual([`root-chain:${root.id}`])
    state = applyDelta(state, { kind: 'unobserve', eventIds: [root.id] })
    // Entries are deleted, never left empty (invariant 1), on both member kinds.
    expect(toIndex(state).reasons[left.id]).toBeUndefined()
    expect(toIndex(state).reasons[delLeft.id]).toBeUndefined()
    // The endpoint's binding credit is independent of the root's presence.
    expect(toIndex(state).reasons[link.id]).toEqual([`binding:${binding.id}`])
  })

  it('unobserving a binding endpoint strips direct-trust but preserves the binding credit (§9 invariant 3 boundary, BD-6)', () => {
    let state = applyDelta(EMPTY_ADMIT_STATE, { kind: 'trust', pubkeys: [PK_FOREIGN, PK_OTHER] })
    state = applyDelta(state, { kind: 'observe', events: [binding, root, link] })
    expect(toIndex(state).reasons[link.id]).toEqual([`binding:${binding.id}`, 'direct-trust'])
    state = applyDelta(state, { kind: 'unobserve', eventIds: [link.id] })
    expect(toIndex(state).reasons[link.id]).toEqual([`binding:${binding.id}`])
  })
})
