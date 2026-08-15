/**
 * `store` — reducer behaviour, the pending-reference buffer, epoch-gated memo, and the
 * `EventStorage` default adapter. Design in `docs/STORE.md`, amended by `docs/VALIDATION-WIRING.md`
 * for Phase 14's `invalidIds`/`pendingAwaiting` generalization.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resolve } from '../src/resolve.js'
import {
  EMPTY_STORE_STATE,
  applyStoreDelta,
  createInMemoryEventStorage,
  createResolveMemo,
  createStore,
  resolveRoot,
} from '../src/store.js'
import { PK_ROOT, fenced } from './_fixtures.js'
import { deletion, diffPatch, root } from './_resolve.js'
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

          const actual = resolveRoot(state, r.id, createResolveMemo())
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

    const first = resolveRoot(state, r.id, memo)
    const second = resolveRoot(state, r.id, memo)
    expect(second).toBe(first) // same reference — served from the memo, not recomputed

    const p = diffPatch('memo-patch', r.id, r.id, A, AB)
    state = applyStoreDelta(state, { kind: 'observe', events: [p] })
    const third = resolveRoot(state, r.id, memo)
    expect(third).not.toBe(first)
    expect(third.chain.status).toBe('resolved')
    if (third.chain.status === 'resolved') expect(third.chain.content).toBe(AB)
  })

  it('a trustEpoch-only delta never invalidates the memo (SG2 preview — see store-property)', () => {
    let state = EMPTY_STORE_STATE
    const memo = createResolveMemo()
    const r = root(A, 'memo-trust-root')
    state = applyStoreDelta(state, { kind: 'observe', events: [r] })
    const before = resolveRoot(state, r.id, memo)

    const afterTrust = applyStoreDelta(state, { kind: 'trust', pubkeys: ['somepubkey'] })
    const after = resolveRoot(afterTrust, r.id, memo)
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

    const before = resolveRoot(state, r.id, memo)
    expect(before.chain.status).toBe('resolved')
    if (before.chain.status === 'resolved') expect(before.chain.content).toBe(AB)

    state = applyStoreDelta(state, { kind: 'unobserve', eventIds: [p.id] })
    const after = resolveRoot(state, r.id, memo)
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
