/**
 * The Phase 3 gate: G1 confluence and G2 non-heuristic branch choice.
 *
 * These are two properties rather than one because **G1 cannot catch an SF-4 violation.** An
 * implementation that sorts two competing root-author patches by `(created_at, id)` and takes the
 * first is perfectly confluent — permuting the input changes nothing, because the sort erases the
 * input order — and it squarely violates SF-4's "MUST NOT silently pick one branch by `created_at`,
 * event ID, or any other heuristic". G2 is the differential property that sees it.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resolve } from '../src/resolve.js'
import { PK_ROOT } from './_fixtures.js'
import { scenario, scenarioAndPermutation } from './_resolve-generators.js'
import { diffPatch, root } from './_resolve.js'

describe('G1 — confluence (UR-1)', () => {
  it('reaches the same state for any permutation of the observed set', () => {
    fc.assert(
      fc.property(scenarioAndPermutation, ({ scenario: s, permuted }) => {
        const ordered = resolve(s.rootId, s.events)
        const shuffled = resolve(s.rootId, permuted)
        if (JSON.stringify(ordered) !== JSON.stringify(shuffled)) {
          // Built only on the failing branch; these scenarios are large.
          expect(shuffled, JSON.stringify(s.events.map((e) => e.id))).toEqual(ordered)
        }
      }),
      { numRuns: 10_000 },
    )
  })

  it('is not vacuous — the generator really does reorder the array', () => {
    // If `shuffledSubarray` returned identity, G1 above would pass while proving nothing. This
    // measures how often the permutation actually differs, and how often the scenario is big
    // enough for order to be capable of mattering at all.
    let reordered = 0
    let nonTrivial = 0
    fc.assert(
      fc.property(scenarioAndPermutation, ({ scenario: s, permuted }) => {
        if (s.events.length > 3) nonTrivial++
        if (s.events.some((e, i) => permuted[i]?.id !== e.id)) reordered++
      }),
      { numRuns: 1_000 },
    )
    console.log(
      `permutations differing from input order: ${reordered}/1000 (${nonTrivial} non-trivial)`,
    )
    expect(reordered).toBeGreaterThan(700)
    expect(nonTrivial).toBeGreaterThan(500)
  })

  it('is idempotent — resolving twice yields the same result', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        expect(resolve(s.rootId, s.events)).toEqual(resolve(s.rootId, s.events))
      }),
      { numRuns: 1_000 },
    )
  })

  it('reaches every branch often enough for the property above to mean something', () => {
    // Phase 2's zero-context lesson: a property that never enters a branch proves nothing about it.
    const chain = { resolved: 0, halted: 0, forked: 0, aborted: 0, absent: 0 }
    const overlay = { clean: 0, conflict: 0, stale: 0, orphaned: 0, unclassified: 0 }
    fc.assert(
      fc.property(scenario, (s) => {
        const r = resolve(s.rootId, s.events)
        chain[r.chain.status]++
        for (const o of r.overlays) overlay[o.state]++
      }),
      { numRuns: 3_000 },
    )
    console.log(`resolve chain outcomes: ${JSON.stringify(chain)}`)
    console.log(`resolve overlay outcomes: ${JSON.stringify(overlay)}`)
    expect(chain.resolved, 'chains must resolve').toBeGreaterThan(100)
    expect(chain.halted, 'the HALT path must be exercised').toBeGreaterThan(50)
    expect(chain.forked, 'the self-fork path must be exercised').toBeGreaterThan(50)
    expect(overlay.clean, 'clean overlays').toBeGreaterThan(20)
    expect(overlay.stale, 'stale overlays').toBeGreaterThan(20)
    expect(overlay.conflict, 'conflicting overlays').toBeGreaterThan(20)
    expect(overlay.orphaned, 'orphaned overlays').toBeGreaterThan(20)
  })
})

describe('G2 — branch choice is not a heuristic (SF-4)', () => {
  const A = 'a\n'
  const AB = 'a\nb\n'

  /** A self-fork whose two branches carry the given timestamps, optionally label-swapped. */
  const fork = (leftTime: number, rightTime: number, swapLabels: boolean) => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const [leftLabel, rightLabel] = swapLabels ? ['zzz', 'aaa'] : ['aaa', 'zzz']
    const left = diffPatch(leftLabel, r.id, p1.id, AB, 'a\nb\nLEFT\n', { created_at: leftTime })
    const right = diffPatch(rightLabel, r.id, p1.id, AB, 'a\nb\nRIGHT\n', { created_at: rightTime })
    return { rootId: r.id, parentId: p1.id, events: [r, p1, left, right] }
  }

  it('stays forked and frozen however created_at and id ordering fall', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.boolean(),
        (t1, t2, swap) => {
          const f = fork(t1, t2, swap)
          const chain = resolve(f.rootId, f.events).chain
          expect(chain.status, `t1=${t1} t2=${t2} swap=${swap}`).toBe('forked')
          if (chain.status !== 'forked') return
          expect(chain.content).toBe(AB)
          expect(chain.forkParentId).toBe(f.parentId)
          expect(chain).not.toHaveProperty('tipId')
        },
      ),
      { numRuns: 2_000 },
    )
  })

  it('returns an identical chain when the two branches swap timestamps', () => {
    // The sharp form. A `(created_at, id)` tiebreaker returns a *resolved* chain whose content
    // flips as the timestamps swap; a conforming implementation returns the same frozen state.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        (t1, t2) => {
          const a = fork(t1, t2, false)
          const b = fork(t2, t1, false)
          expect(resolve(b.rootId, b.events).chain).toEqual(resolve(a.rootId, a.events).chain)
        },
      ),
      { numRuns: 2_000 },
    )
  })

  it('resolves only once a branch is deleted, never before (SF-5)', () => {
    const f = fork(1, 2, false)
    expect(resolve(f.rootId, f.events).chain.status).toBe('forked')
    const branchIds = resolve(f.rootId, f.events).chain
    if (branchIds.status !== 'forked') return
    for (const victim of branchIds.branchIds) {
      const withDeletion = [
        ...f.events,
        {
          id: `d${victim}`.padEnd(64, '0').slice(0, 64),
          pubkey: PK_ROOT,
          created_at: 1,
          kind: 5,
          tags: [['e', victim]],
          content: '',
          sig: '0'.repeat(128),
        },
      ]
      expect(resolve(f.rootId, withDeletion).chain.status).toBe('resolved')
    }
  })
})
