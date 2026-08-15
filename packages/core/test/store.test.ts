/**
 * `store` — reducer behaviour, the pending-reference buffer, epoch-gated memo, and the
 * `EventStorage` default adapter. Design in `docs/STORE.md`, amended by `docs/VALIDATION-WIRING.md`
 * for Phase 14's `invalidIds`/`pendingAwaiting` generalization.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { openView, toIndex, trustedView, visibleOverlays } from '../src/admit.js'
import { resolve } from '../src/resolve.js'
import {
  EMPTY_STORE_STATE,
  applyStoreDelta,
  createInMemoryEventStorage,
  createResolveMemo,
  createStore,
  resolveRootMemoized,
} from '../src/store.js'
import { PK_FOREIGN, PK_ROOT, fenced } from './_fixtures.js'
import { deletion, diffPatch, foreignPatch, root } from './_resolve.js'
import { overlayPatch } from './_store-generators.js'
import { bindingAt, genuine, metadataAt, verifyBySig } from './_store.js'

const A = 'a\n'
const AB = 'a\nb\n'

describe('BD-6 — pending Binding endpoints, delivered non-adjacently', () => {
  it('admits both endpoints once the second arrives in a separate add() call, not before', async () => {
    const store = createStore({ verify: verifyBySig })
    store.trust([PK_ROOT]) // TR-3: the Binding is admitted only if its own pubkey is trusted
    const r = root(A, 'bd6-root')
    const link = metadataAt('bd6-link', 'Some metadata.')
    const b = bindingAt('bd6-binding', r.id, link.id)

    const first = await store.add([genuine(b), genuine(r)], { source: 'relay-1' })
    // Only one endpoint observed so far — BD-6 pending, not yet resolvable either way.
    expect(store.getState().invalidIds).toEqual([])
    const pendingBinding = first.pending.find((p) => p.event.id === b.id)
    expect(pendingBinding?.awaiting).toEqual([link.id])

    await store.add([genuine(link)], { source: 'relay-2' })
    expect(store.getState().invalidIds).toEqual([])
    // admit.ts's own bookkeeping now credits both endpoints via the Binding.
    expect(store.getState().admit.reasons[r.id]).toContain(`binding:${b.id}`)
    expect(store.getState().admit.reasons[link.id]).toContain(`binding:${b.id}`)
  })
})

describe('BD-7 — permanent rejection once both endpoints contradict BD-3/BD-4', () => {
  it('rejects a Binding whose root endpoint is actually a Patch, and reports it', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'bd7-root')
    const notAProduct = diffPatch('bd7-not-a-product', r.id, r.id, A, AB)
    const link = metadataAt('bd7-link', 'Correctly-typed metadata.')
    const b = bindingAt('bd7-binding', notAProduct.id, link.id)

    await store.add([genuine(r), genuine(notAProduct)], { source: 'relay-1' })
    const result = await store.add([genuine(b), genuine(link)], { source: 'relay-2' })

    expect(store.getState().invalidIds).toEqual([b.id])
    const rejection = result.rejected.find((x) => x.event.id === b.id)
    expect(rejection?.issues.map((i) => i.code)).toContain('BD-7')
  })

  it('never re-evaluates a permanently rejected Binding on further, unrelated ingest', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'bd7b-root')
    const notAProduct = diffPatch('bd7b-not-a-product', r.id, r.id, A, AB)
    const link = metadataAt('bd7b-link', 'Correctly-typed metadata.')
    const b = bindingAt('bd7b-binding', notAProduct.id, link.id)

    await store.add([genuine(r), genuine(notAProduct), genuine(b), genuine(link)])
    expect(store.getState().invalidIds).toEqual([b.id])

    const other = root(A, 'bd7b-unrelated')
    await store.add([genuine(other)])
    expect(store.getState().invalidIds).toEqual([b.id]) // unchanged, not re-derived
    expect(store.getState().pendingAwaiting).toEqual({})
  })
})

describe('UR-2 — a patch whose root is unobserved is retained and re-evaluated', () => {
  it('becomes chain-linked once the root arrives, via a separate add() call', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'ur2-root')
    const pEvent = genuine(diffPatch('ur2-patch', r.id, r.id, A, AB))

    const result = await store.add([pEvent])
    expect(store.resolveRoot(r.id).chain).toEqual({ status: 'absent', reason: 'root-unobserved' })
    expect(result.pending).toEqual([{ event: pEvent, awaiting: [r.id], issues: [] }])

    await store.add([genuine(r)])
    const chain = store.resolveRoot(r.id).chain
    expect(chain.status).toBe('resolved')
    if (chain.status === 'resolved') expect(chain.content).toBe(AB)
  })
})

describe('P5/VALIDATION-WIRING — a non-Binding invalid event is admitted but excluded from resolve()', () => {
  it('a C1-malformed Patch is accepted+rejected, and never reaches the canonical chain', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'p5-root')
    const validPatch = genuine(diffPatch('p5-valid', r.id, r.id, A, AB))
    // C1 — a fenced diff block with no proper "--- a/content" header. Well-formed root/reply tags
    // otherwise, so before this phase resolve.ts would have had to process it on tags alone.
    const invalidPatch = genuine(
      diffPatch('p5-invalid', r.id, r.id, A, 'a\nc\n', {
        content: fenced('not a real diff payload'),
      }),
    )

    const result = await store.add([genuine(r), validPatch, invalidPatch])

    // Admitted to storage regardless (DEL-4's "never silently drop" argument, applied here) — never
    // silently discarded for a bug in this project's own validator.
    expect(result.accepted).toContain(invalidPatch.id)
    expect(store.getState().admit.observedById[invalidPatch.id]).toBeDefined()

    // But excluded from the resolved view.
    expect(store.getState().invalidIds).toEqual([invalidPatch.id])
    const rejection = result.rejected.find((x) => x.event.id === invalidPatch.id)
    expect(rejection?.issues.map((i) => i.code)).toContain('C1')

    const chain = store.resolveRoot(r.id).chain
    expect(chain.status).toBe('resolved')
    if (chain.status === 'resolved') expect(chain.content).toBe(AB) // invalidPatch never applied
  })
})

describe('SG6 — resolveRoot’s invalidIds exclusion agrees with a fresh resolve() oracle', () => {
  it('excludes a since-invalidated Patch from the canonical chain, in any arrival order', () => {
    const r = genuine(root('a\n', 'sg6-root'))
    const validPatch = genuine(diffPatch('sg6-valid', r.id, r.id, 'a\n', 'a\nb\n'))
    const invalidPatch = genuine(
      diffPatch('sg6-invalid', r.id, r.id, 'a\n', 'a\nc\n', {
        content: fenced('not a real diff payload'),
      }),
    )
    const events = [r, validPatch, invalidPatch]

    fc.assert(
      fc.property(
        fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length }),
        (order) => {
          let state = EMPTY_STORE_STATE
          for (const event of order) {
            state = applyStoreDelta(state, { kind: 'observe', events: [event] })
          }
          expect(state.invalidIds).toEqual([invalidPatch.id])

          const actual = resolveRootMemoized(state, r.id, createResolveMemo())
          // The direct D29 oracle: a fresh resolve() call over the observed set with the
          // since-invalidated member removed by hand.
          const oracle = resolve(r.id, [r, validPatch])
          expect(actual).toEqual(oracle)
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('DEL-8/DEL-9 — a deletion observed before its target applies retroactively', () => {
  it('honours the deletion once the target arrives, without re-adding it', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'del8-root')
    const p1 = diffPatch('del8-p1', r.id, r.id, A, AB)
    const del = deletion('del8-del', [p1.id])

    await store.add([genuine(r), genuine(del)])
    const beforeTarget = store.resolveRoot(r.id).chain
    expect(beforeTarget.status).toBe('resolved')
    if (beforeTarget.status === 'resolved') expect(beforeTarget.content).toBe(A)

    await store.add([genuine(p1)])
    const afterTarget = store.resolveRoot(r.id).chain
    expect(afterTarget.status).toBe('resolved')
    if (afterTarget.status === 'resolved') expect(afterTarget.content).toBe(A) // p1 was deleted
    expect(afterTarget).toEqual(beforeTarget)
  })
})

describe('the epoch-gated Resolution memo (D28/D38)', () => {
  it('serves the same Resolution reference until the relevant chainEpoch moves', () => {
    let state = EMPTY_STORE_STATE
    const memo = createResolveMemo()
    const r = root(A, 'memo-root')
    state = applyStoreDelta(state, { kind: 'observe', events: [r] })

    const first = resolveRootMemoized(state, r.id, memo)
    const second = resolveRootMemoized(state, r.id, memo)
    expect(second).toBe(first) // same reference — served from the memo, not recomputed

    const p = diffPatch('memo-patch', r.id, r.id, A, AB)
    state = applyStoreDelta(state, { kind: 'observe', events: [p] })
    const third = resolveRootMemoized(state, r.id, memo)
    expect(third).not.toBe(first)
    expect(third.chain.status).toBe('resolved')
    if (third.chain.status === 'resolved') expect(third.chain.content).toBe(AB)
  })

  it('a trustEpoch-only delta never invalidates the memo (SG2 preview — see store-property)', () => {
    let state = EMPTY_STORE_STATE
    const memo = createResolveMemo()
    const r = root(A, 'memo-trust-root')
    state = applyStoreDelta(state, { kind: 'observe', events: [r] })
    const before = resolveRootMemoized(state, r.id, memo)

    const afterTrust = applyStoreDelta(state, { kind: 'trust', pubkeys: ['somepubkey'] })
    const after = resolveRootMemoized(afterTrust, r.id, memo)
    expect(after).toBe(before)
  })
})

describe('unobserve', () => {
  it('removes an event and admit.ts stops crediting it', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'unobserve-root')
    await store.add([genuine(r)])
    expect(Object.keys(store.getState().admit.observedById)).toContain(r.id)

    await store.unobserve([r.id])
    expect(Object.keys(store.getState().admit.observedById)).not.toContain(r.id)
  })

  it('bumps chainEpoch for the affected root, invalidating the Resolution memo (STORE.md §3 symmetry)', () => {
    let state = EMPTY_STORE_STATE
    const memo = createResolveMemo()
    const r = root(A, 'unobserve-epoch-root')
    const p = diffPatch('unobserve-epoch-patch', r.id, r.id, A, AB)
    state = applyStoreDelta(state, { kind: 'observe', events: [r, p] })

    const before = resolveRootMemoized(state, r.id, memo)
    expect(before.chain.status).toBe('resolved')
    if (before.chain.status === 'resolved') expect(before.chain.content).toBe(AB)

    state = applyStoreDelta(state, { kind: 'unobserve', eventIds: [p.id] })
    const after = resolveRootMemoized(state, r.id, memo)
    expect(after).not.toBe(before) // the memo was invalidated, not stale-served
    expect(after.chain.status).toBe('resolved')
    if (after.chain.status === 'resolved') expect(after.chain.content).toBe(A) // patch removed
  })
})

describe('SIG-1 enforcement — the default gate rejects a failing event', () => {
  it('never touches state for an event that fails verify()', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'sig1-root')
    const bad = { ...r, sig: 'not-valid' }

    const result = await store.add([bad])
    expect(result.accepted).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.issues.map((i) => i.code)).toEqual(['SIG-1'])
    expect(store.getState().admit.observedById[r.id]).toBeUndefined()
  })

  it('trustUnverified admits without calling verify at all', async () => {
    const store = createStore({ verify: () => false })
    const r = root(A, 'trust-unverified-root')
    const result = await store.add([r], { trustUnverified: true })
    expect(result.accepted).toEqual([r.id])
    expect(store.getState().admit.observedById[r.id]).toBeDefined()
  })

  it('verified: true skips re-running verify()', async () => {
    let calls = 0
    const store = createStore({
      verify: () => {
        calls += 1
        return true
      },
    })
    const r = root(A, 'verified-skip-root')
    await store.add([r], { verified: true })
    expect(calls).toBe(0)
    expect(store.getState().admit.observedById[r.id]).toBeDefined()
  })
})

describe('the default in-memory EventStorage adapter', () => {
  it('persists added events, retrievable by id and by a simple filter', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'storage-root')
    await store.add([genuine(r)])
    // Exercised indirectly: getState() reflects what put() received, since the default adapter and
    // the reducer are fed the same accepted batch.
    expect(store.getState().admit.observedById[r.id]?.id).toBe(r.id)
  })

  it('query()/get() work directly against a standalone instance (ids, kinds, and a tag filter)', async () => {
    const storage = createInMemoryEventStorage()
    const r = root(A, 'storage-query-root')
    const p = diffPatch('storage-query-patch', r.id, r.id, A, AB)
    await storage.put([r, p])

    expect([...(await storage.get([r.id, 'not-observed']))].map(([id]) => id)).toEqual([r.id])

    const byId = await storage.query([{ ids: [p.id] }])
    expect(byId.map((e) => e.id)).toEqual([p.id])

    const byKind = await storage.query([{ kinds: [5] }])
    expect(byKind).toEqual([])

    const byRootTag = await storage.query([{ '#e': [r.id] }])
    expect(byRootTag.map((e) => e.id)).toEqual([p.id]) // only the patch carries an `e` tag to r.id
  })

  it('hides an honouredly-deleted event from default query(), shows it with includeDeleted (DEL-1/DEL-6)', async () => {
    const storage = createInMemoryEventStorage()
    const r = root(A, 'storage-del-root')
    const p = diffPatch('storage-del-patch', r.id, r.id, A, AB)
    const del = deletion('storage-del-deletion', [p.id]) // pubkey defaults to PK_ROOT, matching p's
    await storage.put([r, p, del])

    expect(await storage.query([{ ids: [p.id] }])).toEqual([])

    const withDeleted = await storage.query([{ ids: [p.id] }], { includeDeleted: true })
    expect(withDeleted.map((e) => e.id)).toEqual([p.id])
  })

  it('does not hide a deletion whose pubkey does not match its target (DEL-1)', async () => {
    const storage = createInMemoryEventStorage()
    const p = diffPatch('storage-del-mismatch-patch', 'ignored-root', 'ignored-root', A, AB)
    const del = deletion('storage-del-mismatch-deletion', [p.id], 'a-different-pubkey')
    await storage.put([p, del])

    const result = await storage.query([{ ids: [p.id] }])
    expect(result.map((e) => e.id)).toEqual([p.id])
  })

  it("applies each filter's own limit to that filter's matches, newest first", async () => {
    const storage = createInMemoryEventStorage()
    const older = { ...root(A, 'storage-limit-older'), created_at: 1_000 }
    const newer = { ...root(AB, 'storage-limit-newer'), created_at: 2_000 }
    await storage.put([older, newer])

    const limited = await storage.query([{ kinds: [1], limit: 1 }])
    expect(limited.map((e) => e.id)).toEqual([newer.id])
  })

  it('P6 — breaks a created_at tie by id, not by arrival/insertion order', async () => {
    const storage = createInMemoryEventStorage()
    const tied = 1_000
    const first = { ...root(A, 'storage-tie-first'), created_at: tied }
    const second = { ...root(AB, 'storage-tie-second'), created_at: tied }
    // Insert in descending id order, so "arrival order" and "ascending id order" disagree —
    // a regression that only an id-order-blind sort could pass by accident.
    const [lower, higher] =
      first.id.localeCompare(second.id) < 0 ? [first, second] : [second, first]
    await storage.put([higher, lower])

    const limited = await storage.query([{ kinds: [1], limit: 1 }])
    expect(limited.map((e) => e.id)).toEqual([lower.id])
  })
})

describe('OVERLAY-AWAITING.md §7 — the P1 worked trace (permanent regression)', () => {
  it('memoized store vs fresh store agreement for a cross-root overlay target arrival', () => {
    // Scenario from OVERLAY-AWAITING.md §7, read in its post-Phase-14 form: Root R (a Product),
    // then foreign overlay O (e root = R, e reply = X) observed while X is absent → resolveRootMemoized(R)
    // through the store's memo includes O (PT-7-pending) as orphaned/β; then X (an unrelated
    // Metadata event, no relationship to R in any of the four original dispatch rows) is observed
    // → O's verdict flips pending→invalid (PT-7: X is neither R's root nor a root-author patch of
    // R) and O leaves resolveRoot's event feed. The mini-spec's own trace says "orphaned/α" at
    // this step, but that state is unreachable for this shape under PT-7 — the stale bytes the
    // memo hole would otherwise leak are O's *continued presence* after it went invalid. What
    // this test genuinely pins is therefore exclusion-driven staleness: the SAME memo must
    // recompute after X's arrival (fifth-row bump) and agree with a fresh store over the same
    // final set. AUDIT-2026-07-31.md §2 P1's reproduction, closed in its post-Phase-14 form.
    const events = overlayPatch('overlay-awaiting-p1')
    const r = events[0]
    const x = events[1]
    const overlayEvent = events[2]
    expect(r).toBeDefined()
    expect(x).toBeDefined()
    expect(overlayEvent).toBeDefined()
    if (!r || !x || !overlayEvent) return

    // Step 1: R observed
    let state = applyStoreDelta(EMPTY_STORE_STATE, { kind: 'observe', events: [r] })
    expect(r.id in state.chainEpoch).toBe(true)
    const epochAfterR = state.chainEpoch[r.id] as number

    // Step 2: overlay O observed (e root = R, e reply = X, X not yet observed)
    state = applyStoreDelta(state, { kind: 'observe', events: [overlayEvent] })
    // Patch row bumps R; overlayAwaiting[X] gains R
    expect(r.id in state.chainEpoch).toBe(true)
    expect(state.chainEpoch[r.id] as number).toBeGreaterThan(epochAfterR) // overlay itself bumps R via Patch row
    expect(state.overlayAwaiting[x.id]).toContain(r.id)

    // Step 3: resolve R with memo while X is absent
    const memo = createResolveMemo()
    const beforeX = resolveRootMemoized(state, r.id, memo)
    const beforeEpoch = state.chainEpoch[r.id] as number

    // Step 4: X observed (unrelated Metadata/root, no e root = R)
    state = applyStoreDelta(state, { kind: 'observe', events: [x] })
    // New row: overlayAwaiting[X] contains R, so chainEpoch[R] bumps
    expect(r.id in state.chainEpoch).toBe(true)
    const epochAfterXArrival = state.chainEpoch[r.id] as number
    expect(epochAfterXArrival).toBeGreaterThan(beforeEpoch)

    // Step 5: resolve R again through SAME memo → must recompute (memo invalidated by epoch bump)
    const afterX = resolveRootMemoized(state, r.id, memo)
    expect(afterX).not.toBe(beforeX) // memo invalidated, recomputed
    // The post-Phase-14 shape of the flip (PT-7): O is invalid and excluded — never orphaned/α.
    expect(state.invalidIds).toContain(overlayEvent.id)
    expect(afterX.overlays.some((v) => v.id === overlayEvent.id)).toBe(false)

    // Fresh store over same final set must agree (D29 oracle property)
    const freshState = [r, x, overlayEvent].reduce(
      (s, e) => applyStoreDelta(s, { kind: 'observe', events: [e] }),
      EMPTY_STORE_STATE,
    )
    const freshResolution = resolveRootMemoized(freshState, r.id, createResolveMemo())
    expect(freshResolution).toEqual(afterX) // memoized vs fresh agreement
  })
})

describe('OVERLAY-AWAITING.md §8 — RC-3 cross-root regression (permanent regression)', () => {
  it('an unrelated event arriving after an overlay on R bumps chainEpoch[R]', () => {
    // RC-3 cross-root shape: event X with no relationship to root R in any of the four original
    // dispatch rows, arriving AFTER an overlay on R names it as a reply target, must bump chainEpoch[R].
    // This closes the second regression path for RC-3 per OVERLAY-AWAITING.md §8.
    const events = overlayPatch('rc3-cross-root')
    const r = events[0]
    const x = events[1]
    const overlayEvent = events[2]
    expect(r).toBeDefined()
    expect(x).toBeDefined()
    expect(overlayEvent).toBeDefined()
    if (!r || !x || !overlayEvent) return

    // Observe R, then overlay (which replies to X), then X
    let state = applyStoreDelta(EMPTY_STORE_STATE, { kind: 'observe', events: [r] })
    expect(r.id in state.chainEpoch).toBe(true)
    const epochAfterR = state.chainEpoch[r.id] as number

    state = applyStoreDelta(state, { kind: 'observe', events: [overlayEvent] })
    expect(r.id in state.chainEpoch).toBe(true)
    const epochAfterOverlay = state.chainEpoch[r.id] as number
    expect(epochAfterOverlay).toBeGreaterThan(epochAfterR) // overlay itself bumps R

    // X arrives — it has no e root = R, but overlayAwaiting[X] contains R
    state = applyStoreDelta(state, { kind: 'observe', events: [x] })
    expect(r.id in state.chainEpoch).toBe(true)
    const epochAfterX = state.chainEpoch[r.id] as number

    // RC-3 assertion: X's arrival must bump chainEpoch[R] because R's resolution depends on X's observedness
    expect(epochAfterX).toBeGreaterThan(epochAfterOverlay)
  })

  it('serves the stale pre-X resolution only until X arrives, then recomputes', () => {
    // One shared memo across both observations: the pre-X resolve caches against the pre-X epoch;
    // X's arrival must invalidate it, and the recomputed result must equal a fresh store's over the
    // same final set (D29). Unlike the epoch assertions above, this fails if memo invalidation is
    // broken for the cross-root path — that is the RC-3 regression in its served-bytes form.
    const events = overlayPatch('rc3-stale-then-fresh')
    const [r, x, overlayEvent] = events

    const memo = createResolveMemo()

    let state = applyStoreDelta(EMPTY_STORE_STATE, { kind: 'observe', events: [r] })
    state = applyStoreDelta(state, { kind: 'observe', events: [overlayEvent] })

    const beforeX = resolveRootMemoized(state, r.id, memo)

    state = applyStoreDelta(state, { kind: 'observe', events: [x] })
    const afterX = resolveRootMemoized(state, r.id, memo)

    expect(afterX).not.toBe(beforeX) // memo invalidated by the cross-root bump → fresh resolve() call

    const freshState = [r, x, overlayEvent].reduce(
      (s, e) => applyStoreDelta(s, { kind: 'observe', events: [e] }),
      EMPTY_STORE_STATE,
    )
    expect(resolveRootMemoized(freshState, r.id, createResolveMemo())).toEqual(afterX)
  })
})

describe('OVERLAY-AWAITING × VALIDATION-WIRING — exclusion-driven staleness (permanent regression)', () => {
  it("a pending foreign overlay that flips to invalid on its awaited target's arrival leaves the resolveRoot feed AND invalidates the memo", () => {
    // The memo hole the audit caught (AUDIT-2026-07-31.md §2 P1 / DECISIONS C5), in its
    // post-Phase-14 form: a foreign overlay passes PT-7 while its reply target is unobserved
    // (pending), so a memoized resolution includes it as orphaned/β; the target's arrival flips
    // the verdict to invalid (PT-7: neither the root nor a root-author patch — validate.ts), and
    // VALIDATION-WIRING.md §4 says it must then leave resolveRoot's event feed. The only signal
    // that R's resolution changed on that arrival is the fifth chainEpochTargets row
    // (overlayAwaiting[target] -> [R]): without it, chainEpoch[R] never moves and the memo keeps
    // serving the stale resolution with the now-invalid overlay still listed as orphaned/β.
    // Asserted end-to-end through a single shared memo, against a fresh store (D29).
    const r = genuine(root(A, 'pt7-r'))
    const x = genuine(metadataAt('pt7-x', 'metadata'))
    const o = genuine(foreignPatch('pt7-o', r.id, x.id, A, AB))

    let s = applyStoreDelta(EMPTY_STORE_STATE, { kind: 'observe', events: [r] })
    s = applyStoreDelta(s, { kind: 'observe', events: [o] })
    const memo = createResolveMemo()
    const pre = resolveRootMemoized(s, r.id, memo)
    const preO = pre.overlays.find((v) => v.id === o.id)
    expect(preO?.state).toBe('orphaned') // pending verdict → included (VALIDATION-WIRING §2)
    expect(preO?.degradation).toBe('beta') // target not yet observable → DEL-7 β

    const epochPre = s.chainEpoch[r.id] as number
    s = applyStoreDelta(s, { kind: 'observe', events: [x] })

    expect(s.chainEpoch[r.id] as number).toBeGreaterThan(epochPre) // fifth row fires on X's arrival
    expect(s.invalidIds).toContain(o.id) // PT-7 flips pending→invalid once X is observable

    const post = resolveRootMemoized(s, r.id, memo)
    expect(post).not.toBe(pre) // memo invalidated — no stale serve (RC-3)
    expect(post.overlays.find((v) => v.id === o.id)).toBeUndefined() // feed exclusion (§4)

    const freshState = [r, x, o].reduce(
      (st, e) => applyStoreDelta(st, { kind: 'observe', events: [e] }),
      EMPTY_STORE_STATE,
    )
    expect(resolveRootMemoized(freshState, r.id, createResolveMemo())).toEqual(post) // D29 oracle agreement
  })
})

describe('TRUST-VIEW.md §2 — the trust-filtered store view (admissionView / viewRoot)', () => {
  /** A store holding root R plus a foreign overlay (reply to R) by an untrusted pubkey. */
  async function storeWithForeignOverlay(): Promise<ReturnType<typeof createStore>> {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'tv-root')
    const overlay = foreignPatch('tv-overlay', r.id, r.id, A, AB)
    await store.add([genuine(r), genuine(overlay)])
    // Never trust PK_FOREIGN — the overlay's own pubkey stays untrusted for the default view.
    return store
  }

  it('reflects trust()/untrust() in the very next admissionView() call, with no intervening resolveRoot', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'tv-trust-root')
    await store.add([genuine(r)])

    // Fresh store: nothing trusted → root not admitted.
    expect(store.admissionView().isAdmitted(r.id)).toBe(false)

    store.trust([PK_ROOT])
    expect(store.admissionView().isAdmitted(r.id)).toBe(true) // the very next call sees it

    store.untrust([PK_ROOT])
    expect(store.admissionView().isAdmitted(r.id)).toBe(false) // and the very next call sees the revoke
  })

  it('viewRoot() filters ONLY overlays — chain/pending/annotations are unchanged from resolveRootMemoized() for an untrusted foreign overlay', async () => {
    const store = await storeWithForeignOverlay()
    const r = root(A, 'tv-root')
    const raw = store.resolveRoot(r.id)
    const viewed = store.viewRoot(r.id)

    // The untrusted overlay renders in the raw (unfiltered) resolution...
    expect(raw.overlays.length).toBe(1)

    // ...but is hidden by the default (empty trust) view.
    expect(viewed.overlays.length).toBe(0)

    // chain/pending/annotations are structurally identical — D25/TR-7: trust never gates the chain.
    expect(viewed.chain).toEqual(raw.chain)
    expect(viewed.pending).toEqual(raw.pending)
    expect(viewed.annotations).toEqual(raw.annotations)
    // Note: the overlay filtering is the only difference; the rest of the projection is passed through.
    expect(viewed).toEqual({ ...raw, overlays: [] })
  })

  it('defaults admission to admissionView() — viewRoot(rootId) equals viewRoot(rootId, { admission: store.admissionView() })', async () => {
    const store = await storeWithForeignOverlay()
    const r = root(A, 'tv-root')
    expect(store.viewRoot(r.id)).toEqual(store.viewRoot(r.id, { admission: store.admissionView() }))
  })

  it('openView is the explicit "show everything" audit case — renders the untrusted overlay', async () => {
    const store = await storeWithForeignOverlay()
    const r = root(A, 'tv-root')
    // PK_FOREIGN is not trusted, so the default view hides the overlay...
    expect(store.viewRoot(r.id).overlays.length).toBe(0)
    // ...but an explicit openView renders it (D22: a view, never a bypass flag).
    const audit = store.viewRoot(r.id, { admission: openView })
    expect(audit.overlays.length).toBe(1)
    expect(audit.overlays[0]?.id).toBe(foreignPatch('tv-overlay', r.id, r.id, A, AB).id)
  })

  it('viewRoot() overlay filtering equals the manual composition — visibleOverlays(resolveRootMemoized(...).overlays, trustedView(toIndex(admit)))', async () => {
    const store = await storeWithForeignOverlay()
    const r = root(A, 'tv-root')

    const viewed = store.viewRoot(r.id)
    const raw = store.resolveRoot(r.id)
    const manual = visibleOverlays(raw.overlays, trustedView(toIndex(store.getState().admit)))

    expect(viewed.overlays).toEqual(manual)
    expect(viewed).toEqual({ ...raw, overlays: manual })

    // And with an explicitly-trusted pubkey, both the store and the oracle render the overlay.
    store.trust([PK_FOREIGN])
    expect(store.viewRoot(r.id).overlays.length).toBe(1)
    const rawAfter = store.resolveRoot(r.id)
    const manualAfter = visibleOverlays(
      rawAfter.overlays,
      trustedView(toIndex(store.getState().admit)),
    )
    expect(store.viewRoot(r.id).overlays).toEqual(manualAfter)
  })

  it('a second trust() call after the first viewRoot() changes the next viewRoot() call (no stale caching)', async () => {
    const store = createStore({ verify: verifyBySig })
    const r = root(A, 'tv-stale-root')
    const overlay = foreignPatch('tv-stale-overlay', r.id, r.id, A, AB)
    await store.add([genuine(r), genuine(overlay)])

    // First view — nothing trusted, hidden.
    const first = store.viewRoot(r.id)
    expect(first.overlays.length).toBe(0)

    // A later trust() must be reflected the next time (admissionView reads state fresh, no cache).
    store.trust([PK_FOREIGN])
    const second = store.viewRoot(r.id)
    expect(second.overlays.length).toBe(1)
    expect(second.overlays[0]?.id).toBe(overlay.id)
  })
})
