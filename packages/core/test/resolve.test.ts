/**
 * §7 chain resolution — canonical chain, cascade, self-fork, HALT, overlays.
 *
 * Design and rule mapping in `docs/RESOLVE.md`. The permanent regression corpus is replayed first,
 * as in Phase 2.
 */

import { describe, expect, it } from 'vitest'
import { resolve } from '../src/resolve.js'
import { PK_FOREIGN, PK_OTHER, PK_ROOT, baseTags, binding, metadata } from './_fixtures.js'
import {
  badPatch,
  deletion,
  diffPatch,
  foreignPatch,
  idOf,
  noopPatch,
  reversed,
  root,
} from './_resolve.js'

const A = 'a\n'
const AB = 'a\nb\n'
const ABC = 'a\nb\nc\n'

describe('CHN-1 / RC-1 — walking the canonical chain', () => {
  it('is the root content when no patches exist, and the root is its own tip (RC-5)', () => {
    const r = root(A)
    const res = resolve(r.id, [r])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
  })

  it('applies root-author patches in chain order, not array order', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    for (const events of [
      [r, p1, p2],
      [p2, p1, r],
      [p1, r, p2],
    ]) {
      const res = resolve(r.id, events)
      expect(res.chain.status).toBe('resolved')
      if (res.chain.status === 'resolved') {
        expect(res.chain.content).toBe(ABC)
        expect(res.chain.applied).toEqual([p1.id, p2.id])
        expect(res.chain.tipId).toBe(p2.id)
      }
    }
  })

  it('treats a no-op patch as a valid link that changes nothing (PT-8)', () => {
    const r = root(A)
    const p1 = noopPatch('n1', r.id, r.id)
    const p2 = diffPatch('p2', r.id, p1.id, A, AB)
    const res = resolve(r.id, [r, p1, p2])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') {
      expect(res.chain.content).toBe(AB)
      expect(res.chain.applied).toEqual([p1.id, p2.id])
    }
  })

  it('never lets a foreign patch into the chain (CHN-3)', () => {
    const r = root(A)
    const f = foreignPatch('f1', r.id, r.id, A, AB)
    const res = resolve(r.id, [r, f])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') {
      expect(res.chain.content).toBe(A)
      expect(res.chain.applied).toEqual([])
    }
  })

  it('ignores a root-author patch replying to a foreign patch (PT-6 / OV-8)', () => {
    const r = root(A)
    const f = foreignPatch('f1', r.id, r.id, A, AB)
    const adopted = diffPatch('adopt', r.id, f.id, AB, ABC)
    const res = resolve(r.id, [r, f, adopted])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') expect(res.chain.applied).toEqual([])
  })
})

describe('RC-2 — overlays are never folded into canonical bytes', () => {
  it('leaves the chain content identical whether or not overlays are present', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const bare = resolve(r.id, [r, p1]).chain
    const withOverlays = resolve(r.id, [
      r,
      p1,
      foreignPatch('f1', r.id, p1.id, AB, ABC),
      foreignPatch('f2', r.id, r.id, A, 'z\n'),
    ]).chain
    expect(withOverlays).toEqual(bare)
  })
})

describe('SF-1…SF-6 — root self-fork', () => {
  const forked = () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const left = diffPatch('left', r.id, p1.id, AB, 'a\nb\nLEFT\n')
    const right = diffPatch('right', r.id, p1.id, AB, 'a\nb\nRIGHT\n')
    return { r, p1, left, right, events: [r, p1, left, right] }
  }

  it('freezes at the shared parent and exposes no tip (SF-1, SF-2, G3)', () => {
    const { p1, r, events } = forked()
    const res = resolve(r.id, events)
    expect(res.chain.status).toBe('forked')
    // Not merely "the tip is null" — asking is a category error, so the field is absent.
    expect(res.chain).not.toHaveProperty('tipId')
    if (res.chain.status === 'forked') {
      expect(res.chain.content).toBe(AB)
      expect(res.chain.forkParentId).toBe(p1.id)
    }
  })

  it('surfaces both branches with ids and timestamps (SF-3)', () => {
    const { left, right, r, events } = forked()
    const fork = resolve(r.id, events).annotations.find((a) => a.kind === 'self-fork')
    expect(fork).toBeDefined()
    if (fork?.kind !== 'self-fork') return
    expect(fork.branches.map((b) => b.id).sort()).toEqual([left.id, right.id].sort())
    for (const branch of fork.branches) expect(typeof branch.createdAt).toBe('number')
  })

  it('resolves when one branch is deleted by its author, via cascade (SF-5)', () => {
    const { left, right, r, events } = forked()
    const res = resolve(r.id, [...events, deletion('del', [right.id], PK_ROOT)])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') {
      expect(res.chain.content).toBe('a\nb\nLEFT\n')
      expect(res.chain.tipId).toBe(left.id)
    }
  })

  it('freezes at the earliest fork when several exist (SF-6)', () => {
    const r = root(A)
    const early1 = diffPatch('e1', r.id, r.id, A, 'E1\n')
    const early2 = diffPatch('e2', r.id, r.id, A, 'E2\n')
    // A second fork further along one branch, which must not be the one reported.
    const late1 = diffPatch('l1', r.id, early1.id, 'E1\n', 'L1\n')
    const late2 = diffPatch('l2', r.id, early1.id, 'E1\n', 'L2\n')
    const res = resolve(r.id, [r, early1, early2, late1, late2])
    expect(res.chain.status).toBe('forked')
    if (res.chain.status === 'forked') {
      expect(res.chain.forkParentId).toBe(r.id)
      expect(res.chain.content).toBe(A)
    }
  })
})

describe('DEL — kind 5 deletion', () => {
  it('removes a patch and every canonical descendant (DEL-2)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    const res = resolve(r.id, [r, p1, p2, deletion('del', [p1.id], PK_ROOT)])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') {
      expect(res.chain.content).toBe(A)
      expect(res.chain.applied).toEqual([])
    }
  })

  it('ignores a deletion whose pubkey does not match the target (DEL-1)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const res = resolve(r.id, [r, p1, deletion('del', [p1.id], PK_FOREIGN)])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') expect(res.chain.content).toBe(AB)
  })

  it('gives a kind 5 targeting a kind 5 no effect (DEL-6)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const del = deletion('del', [p1.id], PK_ROOT)
    const undelete = deletion('undel', [del.id], PK_ROOT)
    const res = resolve(r.id, [r, p1, del, undelete])
    // The deletion still stands: NIP-09 defines no reversal.
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') expect(res.chain.content).toBe(A)
  })

  it('applies a deletion retroactively once its target is observed (DEL-8)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const del = deletion('del', [p1.id], PK_ROOT)
    const without = resolve(r.id, [r, del])
    expect(without.chain.status).toBe('resolved')
    if (without.chain.status === 'resolved') expect(without.chain.content).toBe(A)
    const with_ = resolve(r.id, [r, del, p1])
    if (with_.chain.status === 'resolved') expect(with_.chain.content).toBe(A)
  })

  it('hides a deleted foreign overlay from default rendering (DEL-3)', () => {
    const r = root(A)
    const f = foreignPatch('f1', r.id, r.id, A, AB)
    const res = resolve(r.id, [r, f, deletion('del', [f.id], PK_FOREIGN)])
    expect(res.overlays).toEqual([])
  })
})

describe('H1 / H2 — HALT', () => {
  it('freezes at the last successfully applied patch', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const bad = badPatch('bad', r.id, p1.id)
    const p3 = diffPatch('p3', r.id, bad.id, ABC, 'later\n')
    const res = resolve(r.id, [r, p1, bad, p3])
    expect(res.chain.status).toBe('halted')
    if (res.chain.status === 'halted') {
      expect(res.chain.content).toBe(AB)
      expect(res.chain.haltedAt).toBe(bad.id)
      expect(res.chain.applied).toEqual([p1.id])
    }
  })

  it('surfaces the event id, author and reason (H2)', () => {
    const r = root(A)
    const bad = badPatch('bad', r.id, r.id)
    const error = resolve(r.id, [r, bad]).annotations.find((a) => a.kind === 'protocol-error')
    expect(error).toBeDefined()
    if (error?.kind !== 'protocol-error') return
    expect(error.eventId).toBe(bad.id)
    expect(error.author).toBe(PK_ROOT)
    expect(error.reason).toBe('no-match')
    expect(error.issues.map((i) => i.code)).toContain('H1')
  })

  it('resumes when the offending patch is deleted by its author', () => {
    // H1: "HALT is reevaluated whenever the chain topology changes — most commonly when the
    // invalid patch is kind 5 deleted by its author." A HALT is explicitly not sticky.
    const r = root(A)
    const bad = badPatch('bad', r.id, r.id)
    const res = resolve(r.id, [r, bad, deletion('del', [bad.id], PK_ROOT)])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') expect(res.chain.content).toBe(A)
  })

  it('reports the halt, not the fork, when both are live (F10)', () => {
    // The walk stops at the fork, so every patch that could halt is at or before the fork parent —
    // a halt is therefore always the earlier freeze point. §5.3 step 5 reads the other way; H1's
    // unconditional "no later patches are applied" is what settles it.
    const r = root(A)
    const bad = badPatch('bad', r.id, r.id)
    const left = diffPatch('left', r.id, bad.id, ABC, 'L\n')
    const right = diffPatch('right', r.id, bad.id, ABC, 'R\n')
    const res = resolve(r.id, [r, bad, left, right])
    expect(res.chain.status).toBe('halted')
    if (res.chain.status === 'halted') expect(res.chain.content).toBe(A)
    // SF-3 is a MUST regardless of which condition froze the content.
    expect(res.annotations.some((a) => a.kind === 'self-fork')).toBe(true)
  })
})

describe('RL-3 — a ceiling is never a HALT', () => {
  it('aborts application without reporting a halt', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const res = resolve(r.id, [r, p1], { apply: { maxHunks: 0 } })
    expect(res.chain.status).toBe('aborted')
    if (res.chain.status === 'aborted') {
      expect(res.chain.content).toBe(A)
      expect(res.chain.abortedAt).toBe(p1.id)
    }
    expect(res.annotations.map((a) => a.kind)).toEqual(['resource-limit'])
    expect(res.annotations.flatMap((a) => a.issues.map((i) => i.code))).not.toContain('H1')
  })

  it('leaves an overlay unclassified rather than calling a ceiling a conflict (F11)', () => {
    // §7.3 offers four overlay states and none of them fits a resource limit: the overlay may well
    // apply, so `conflict` would be a lie, and the target is perfectly well defined, so `orphaned`
    // would be too. Recorded as SPEC-FEEDBACK F11.
    const r = root(A)
    const over = foreignPatch('over', r.id, r.id, A, AB)
    const res = resolve(r.id, [r, over], { apply: { maxHunks: 0 } })
    expect(res.overlays.map((o) => o.state)).toEqual(['unclassified'])
    const limit = res.annotations.find((a) => a.kind === 'resource-limit')
    expect(limit?.kind === 'resource-limit' && limit.eventId).toBe(over.id)
    expect(res.annotations.flatMap((a) => a.issues.map((i) => i.code))).toContain('RL-3')
  })
})

describe('OV — overlay classification', () => {
  const chain = () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    return { r, p1, p2, events: [r, p1, p2] }
  }

  it('is clean against the tip, stale against an earlier position (OV-2)', () => {
    const { r, p1, p2, events } = chain()
    const atTip = foreignPatch('tip', r.id, p2.id, ABC, 'a\nb\nc\nNOTE\n')
    const atMid = foreignPatch('mid', r.id, p1.id, AB, 'a\nb\nNOTE\n')
    const res = resolve(r.id, [...events, atTip, atMid])
    const byId = new Map(res.overlays.map((o) => [o.id, o]))
    expect(byId.get(atTip.id)?.state).toBe('clean')
    expect(byId.get(atMid.id)?.state).toBe('stale')
  })

  // RC-5 (spec v0.6.1): the tip is the root event itself where the chain carries no patches. An
  // overlay anchored to a never-patched root is therefore anchored to the tip, not to a position
  // the chain has advanced past — this is the *first* annotation published against any new
  // Product, so misclassifying it as `stale` here is the common case, not an edge case.
  it('is clean against a root that has never been patched (RC-5)', () => {
    const r = root(A)
    const over = foreignPatch('over', r.id, r.id, A, AB)
    const res = resolve(r.id, [r, over])
    expect(res.chain.status).toBe('resolved')
    expect(res.overlays.map((o) => o.state)).toEqual(['clean'])
  })

  it('is a conflict when the hunks do not apply to the target snapshot', () => {
    const { r, p2, events } = chain()
    const bad = foreignPatch('bad', r.id, p2.id, 'ABSENT\n', 'X\n')
    const res = resolve(r.id, [...events, bad])
    expect(res.overlays.find((o) => o.id === bad.id)?.state).toBe('conflict')
  })

  it('is orphaned, not conflict, when the target is downstream of a HALT (OV-3)', () => {
    const r = root(A)
    const bad = badPatch('bad', r.id, r.id)
    const over = foreignPatch('over', r.id, bad.id, ABC, 'X\n')
    const res = resolve(r.id, [r, bad, over])
    const o = res.overlays.find((x) => x.id === over.id)
    expect(o?.state).toBe('orphaned')
    expect(o?.degradation).toBe('alpha') // the target is observed, merely unapplied
  })

  it('is orphaned when the target is a fork sibling (OV-3)', () => {
    const r = root(A)
    const left = diffPatch('left', r.id, r.id, A, 'L\n')
    const right = diffPatch('right', r.id, r.id, A, 'R\n')
    const over = foreignPatch('over', r.id, left.id, 'L\n', 'L2\n')
    const res = resolve(r.id, [r, left, right, over])
    expect(res.overlays.find((x) => x.id === over.id)?.state).toBe('orphaned')
  })

  it('degrades to β when the target was never observed (DEL-7)', () => {
    const r = root(A)
    const over = foreignPatch('over', r.id, idOf('never-seen'), A, 'X\n')
    const res = resolve(r.id, [r, over])
    const o = res.overlays.find((x) => x.id === over.id)
    expect(o?.state).toBe('orphaned')
    expect(o?.degradation).toBe('beta')
    // Never re-anchored to the target's parent or to the tip.
    expect(o?.targetId).toBe(idOf('never-seen'))
  })

  it('degrades to α when the target is observed but deleted (DEL-7, §10 audit)', () => {
    const { r, p1, p2, events } = chain()
    const over = foreignPatch('over', r.id, p2.id, ABC, 'X\n')
    const res = resolve(r.id, [...events, over, deletion('del', [p2.id], PK_ROOT)])
    const o = res.overlays.find((x) => x.id === over.id)
    expect(o?.state).toBe('orphaned')
    expect(o?.degradation).toBe('alpha')
    expect(p1.id).toBeDefined()
  })

  it('classifies overlays regardless of author, since trust is applied later (D25, TR-7)', () => {
    const { r, p2, events } = chain()
    const overlays = [PK_FOREIGN, PK_OTHER].map((pk, i) =>
      foreignPatch(`o${i}`, r.id, p2.id, ABC, `a\nb\nc\nN${i}\n`, pk),
    )
    const res = resolve(r.id, [...events, ...overlays])
    expect(res.overlays.map((o) => o.state)).toEqual(['clean', 'clean'])
  })

  it('has no tip while forked, so nothing anchored to it is clean (SF-1)', () => {
    const r = root(A)
    const left = diffPatch('left', r.id, r.id, A, 'L\n')
    const right = diffPatch('right', r.id, r.id, A, 'R\n')
    const over = foreignPatch('over', r.id, r.id, A, 'NOTE\n')
    const res = resolve(r.id, [r, left, right, over])
    expect(res.overlays.find((x) => x.id === over.id)?.state).toBe('stale')
  })
})

describe('UR-2 / BD-9 — roots that cannot carry a chain', () => {
  it('retains patches whose root is unobserved rather than discarding them', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const res = resolve(r.id, [p1])
    expect(res.chain).toEqual({ status: 'absent', reason: 'root-unobserved' })
    expect(res.pending).toEqual([p1.id])
  })

  it('builds no chain over a Binding (BD-9)', () => {
    const b = binding(idOf('x'), idOf('y'))
    const res = resolve(b.id, [b])
    expect(res.chain).toEqual({ status: 'absent', reason: 'root-not-patchable' })
  })

  it('resolves a Metadata root the same way as a Product', () => {
    const m = metadata({ content: A })
    const p1 = diffPatch('p1', m.id, m.id, A, AB)
    const res = resolve(m.id, [m, p1])
    expect(res.chain.status).toBe('resolved')
    if (res.chain.status === 'resolved') expect(res.chain.content).toBe(AB)
  })
})

describe('UR-1 — arrival order does not reach the result', () => {
  it('is unchanged by reversing a scenario exercising every branch', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    const gone = diffPatch('gone', r.id, p2.id, ABC, 'gone\n')
    const events = [
      r,
      p1,
      p2,
      gone,
      deletion('del', [gone.id], PK_ROOT),
      foreignPatch('clean', r.id, p2.id, ABC, 'a\nb\nc\nN\n'),
      foreignPatch('stale', r.id, p1.id, AB, 'a\nb\nN\n'),
      foreignPatch('orphan', r.id, idOf('never'), A, 'X\n'),
    ]
    expect(resolve(r.id, reversed(events))).toEqual(resolve(r.id, events))
  })
})

describe('UR-4 — a root-author patch whose `e reply` target is unobserved is held (spec v0.8.0, F16)', () => {
  it('holds the patch out of the chain, reports it pending, and two siblings sharing the unobserved parent are NOT a fork (SF-1 carve-out)', () => {
    const r = root(A)
    const missing = idOf('unobserved-parent')
    const p1 = diffPatch('held-1', r.id, missing, A, 'a\nx\n')
    const p2 = diffPatch('held-2', r.id, missing, A, 'a\ny\n')
    const res = resolve(r.id, [r, p1, p2])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
    expect(res.pending).toEqual([p1.id, p2.id].sort())
    expect(res.annotations.filter((a) => a.kind === 'self-fork')).toEqual([])
  })

  it('re-evaluates on arrival: the patch joins the chain in order once its parent is observed', () => {
    const r = root(A)
    const parent = diffPatch('parent', r.id, r.id, A, AB)
    const late = diffPatch('late', r.id, parent.id, AB, ABC)
    expect(resolve(r.id, [r, late]).pending).toEqual([late.id])
    const res = resolve(r.id, [r, late, parent])
    expect(res.chain).toEqual({
      status: 'resolved',
      content: ABC,
      tipId: late.id,
      applied: [parent.id, late.id],
    })
    expect(res.pending).toEqual([])
  })

  it('holds transitively: a patch replying to a held patch is held with it (§5.3 step 1)', () => {
    const r = root(A)
    const held = diffPatch('held', r.id, idOf('unobserved-grandparent'), A, AB)
    const child = diffPatch('child', r.id, held.id, AB, ABC)
    const res = resolve(r.id, [r, held, child])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
    expect(res.pending).toEqual([child.id, held.id].sort())
  })

  it('keeps PT-6 distinct: replying to an *observed foreign* patch is ignored permanently, never held', () => {
    const r = root(A)
    const foreign = foreignPatch('foreign', r.id, r.id, A, AB)
    const misdirected = diffPatch('misdirected', r.id, foreign.id, AB, ABC)
    const res = resolve(r.id, [r, foreign, misdirected])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
    expect(res.pending).toEqual([])
  })

  it('orphans an overlay whose target is a held patch, α since the target is observed (§7.3/OV-3)', () => {
    const r = root(A)
    const held = diffPatch('held', r.id, idOf('unobserved-parent'), A, AB)
    const overlay = foreignPatch('overlay-on-held', r.id, held.id, AB, ABC)
    const res = resolve(r.id, [r, held, overlay])
    expect(res.pending).toEqual([held.id])
    expect(res.overlays).toEqual([
      expect.objectContaining({ id: overlay.id, state: 'orphaned', degradation: 'alpha' }),
    ])
  })

  it('excludes a retracted held patch from pending — a completed decision is not a pending one', () => {
    const r = root(A)
    const held = diffPatch('held', r.id, idOf('unobserved-parent'), A, AB)
    const res = resolve(r.id, [r, held, deletion('retract-held', [held.id], PK_OTHER)])
    expect(res.pending).toEqual([held.id])
    const res2 = resolve(r.id, [r, held, deletion('retract-held', [held.id], PK_ROOT)])
    expect(res2.pending).toEqual([])
  })
})

describe('S3-30 — retracting the ROOT itself preserves the canonical chain for audit (DEL-4, 2026-08-08 audit)', () => {
  // DEL-4: the root leaves the default view, but the canonical chain is preserved — `cascade()`
  // seeds `removed` from chain candidates ∩ honouredly-deleted, never from raw `deleted`, so a
  // kind-5 *on the root Event* cannot cascade into its patches. That removed-vs-deleted
  // seeding distinction was what the property generator could not reach (deleteAt ≥ 1 skips the
  // root) and no unit test pinned either — three of the four verification shapes below were
  // previously only true incidentally.
  it('resolve() still applies every chain patch after the root author retracts the root', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    const retract = deletion('retract-root', [r.id], PK_ROOT)
    const res = resolve(r.id, [r, p1, p2, retract])
    expect(res.chain).toEqual({
      status: 'resolved',
      content: ABC,
      tipId: p2.id,
      applied: [p1.id, p2.id],
    })
    expect(res.pending).toEqual([])
  })

  it('a same-author kind-5 on a root-authored PATCH still cascades — the distinction holds in both directions', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    const retractPatch = deletion('retract-p1', [p1.id], PK_ROOT)
    const res = resolve(r.id, [r, p1, p2, retractPatch])
    // deleting p1 removes p1 AND its descendant p2 from the canonical walk (DEL-2) — the root's
    // own deletion above removes nothing but the root's default-view presence.
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
  })
})

describe('S5 — Step-5 pins: walk termination, marker floors, deterministic annotation shape', () => {
  it('a root-author patch without an e reply marker is neither chained nor held (PT grammar floor)', () => {
    const r = root(A)
    const noReply = diffPatch('no-reply', r.id, r.id, A, AB, {
      tags: [...baseTags('patch'), ['e', r.id, '', 'root', PK_ROOT]],
    })
    const res = resolve(r.id, [r, noReply])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
    // It is not an UR-2/UR-4 hold either — those are for patches whose POSITION is unknowable;
    // a missing marker is a grammar-level defect, permanently out of scope for this event set.
    expect(res.pending).toEqual([])
  })

  it('a foreign overlay without an e reply marker is not classified at all', () => {
    // OV-7 families classify by reply-targeted position; with none, §5.2's tolerance means the
    // event is V-invalid somewhere else, not an overlay — resolve does not re-derive that.
    const r = root(A)
    const f = diffPatch('f', r.id, r.id, A, AB, {
      pubkey: PK_FOREIGN,
      tags: [...baseTags('patch'), ['e', r.id, '', 'root', PK_ROOT]],
    })
    expect(resolve(r.id, [r, f]).overlays).toEqual([])
  })

  it('terminates deterministically on reply cycles and self-loops (walk + classify guards)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, idOf('p2'), A, 'a\np1\n')
    const p2 = diffPatch('p2', r.id, idOf('p1'), A, 'a\np2\n')
    const selfLoop = diffPatch('self', r.id, idOf('self'), A, 'a\nself\n')
    const res = resolve(r.id, [r, p1, p2, selfLoop])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
    expect(res.pending).toEqual([])
  })

  it('sorts resource-limit annotations deterministically by event id', () => {
    // RESOLVE.md §7's confluence rows: every output list is sorted by a total, content-derived
    // key. The annotations sort comparator needs ≥2 annotations to even run — this is the only
    // shape that produces them without a fork.
    const r = root(A)
    const f1 = diffPatch('f-one', r.id, r.id, A, AB, { pubkey: PK_FOREIGN })
    const f2 = diffPatch('f-two', r.id, r.id, A, 'a\nc\n', { pubkey: PK_FOREIGN })
    const res = resolve(r.id, [r, f2, f1], { apply: { maxWork: 3 } })
    const rl = res.annotations.filter((a) => a.kind === 'resource-limit')
    expect(rl.map((a) => (a.kind === 'resource-limit' ? a.eventId : ''))).toEqual(
      [f1.id, f2.id].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    )
  })

  it('orders mixed-kind annotations by kind before falling back to the locator', () => {
    const r = root(A)
    const left = diffPatch('left', r.id, r.id, A, AB)
    const right = diffPatch('right', r.id, r.id, A, 'a\nc\n')
    const f = diffPatch('f', r.id, r.id, A, 'a\nd\n', { pubkey: PK_FOREIGN })
    const res = resolve(r.id, [r, left, right, f], { apply: { maxWork: 3 } })
    expect(res.chain.status).toBe('forked')
    expect(res.annotations.map((a) => a.kind)).toEqual(['resource-limit', 'self-fork'])
  })

  it('names the fork, its branch count and its parent in the SF-3 annotation', () => {
    const r = root(A)
    const left = diffPatch('left', r.id, r.id, A, AB)
    const right = diffPatch('right', r.id, r.id, A, 'a\nc\n')
    const res = resolve(r.id, [r, left, right])
    const fork = res.annotations.find((a) => a.kind === 'self-fork')
    if (fork?.kind !== 'self-fork') expect.fail('expected a self-fork annotation')
    expect(fork.issues.map((i) => i.code)).toEqual(['SF-3'])
    // S5-12: severity is the validity claim's own field (never 'error' — the freeze is
    // informational), and the issue message is what the SF-3 surface actually reports.
    expect(fork.issues[0]?.severity).toBe('warning')
    expect(fork.issues[0]?.message).toContain('frozen at the shared parent')
    expect(fork.message).toContain('root self-fork')
    expect(fork.message).toContain(`2 root-author patches reply to ${r.id}`)
    expect(fork.branches.map((b) => b.id)).toEqual(
      [left.id, right.id].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    )
  })

  it('carries the failing patch id and rule in the protocol-error annotation (H2)', () => {
    const r = root(A)
    const bad = badPatch('bad', r.id, r.id)
    const res = resolve(r.id, [r, bad])
    const err = res.annotations.find((a) => a.kind === 'protocol-error')
    if (err?.kind !== 'protocol-error') expect.fail('expected a protocol-error annotation')
    expect(err.eventId).toBe(bad.id)
    expect(err.message).toContain(`patch ${bad.id} failed pre-validation`)
    expect(err.message).toContain(`(${err.reason === 'no-match' ? 'T1' : err.reason})`)
  })

  it('states the ceiling in words on both resource-limit annotation shapes', () => {
    const r = root(AB)
    const heavy = diffPatch('heavy', r.id, r.id, AB, 'a\nLONGER\nb\n')
    const chainLimited = resolve(r.id, [r, heavy], { apply: { maxWork: 1 } })
    const rlChain = chainLimited.annotations.find((a) => a.kind === 'resource-limit')
    if (rlChain?.kind !== 'resource-limit') expect.fail('expected a chain resource-limit')
    expect(rlChain.message).toContain(`patch ${heavy.id} hit the`)
    expect(rlChain.message).toContain('ceiling; application stopped here')

    const f = diffPatch('f', r.id, r.id, AB, 'a\nLONGER\nb\n', { pubkey: PK_FOREIGN })
    const overlayLimited = resolve(r.id, [r, f], { apply: { maxWork: 1 } })
    const rlOverlay = overlayLimited.annotations.find((a) => a.kind === 'resource-limit')
    if (rlOverlay?.kind !== 'resource-limit') expect.fail('expected an overlay resource-limit')
    expect(rlOverlay.message).toContain(`overlay ${f.id} hit the`)
    expect(rlOverlay.message).toContain('ceiling and was not classified')
  })
})

describe('S5-11 — Step-5 pins: cascade fixpoint, absent-shape fields, partition floors', () => {
  it('cascades a patch deletion through every canonical descendant, however deep (DEL-2/CHN-2)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const p2 = diffPatch('p2', r.id, p1.id, AB, ABC)
    const p3 = diffPatch('p3', r.id, p2.id, ABC, 'a\nb\nc\nd\n')
    const del = deletion('del-p1', [p1.id], PK_ROOT)
    const res = resolve(r.id, [r, p1, p2, p3, del])
    // Two levels below the deletion must also be gone — a first-order cascade leaves the
    // grandchild hanging and the chain wrongly extensible past the deletion.
    expect(res.chain).toEqual({
      status: 'resolved',
      content: A,
      tipId: r.id,
      applied: [],
    })
    // And the same holds when the edges arrive in the worst possible order for a one-pass scan:
    // the fixed point, not the array order, decides membership.
    const res2 = resolve(r.id, [del, p3, p2, r, p1])
    expect(res2.chain).toEqual(res.chain)
  })

  it('a binding root yields a fully absent resolution, overlay/pending/annotations empty (BD-9 fields)', () => {
    const b = binding('some-root', 'some-link')
    const res = resolve(b.id, [b])
    expect(res).toEqual({
      chain: { status: 'absent', reason: 'root-not-patchable' },
      overlays: [],
      pending: [],
      annotations: [],
    })
  })

  it('an unobserved root reports every held patch, sorted, with nothing else attached (UR-2 fields)', () => {
    const ghost = idOf('ghost-root')
    const p1 = diffPatch('p1', ghost, ghost, A, AB)
    const p2 = diffPatch('p2', ghost, ghost, A, ABC)
    const res = resolve(ghost, [p2, p1])
    expect(res).toEqual({
      chain: { status: 'absent', reason: 'root-unobserved' },
      overlays: [],
      pending: [p1.id, p2.id].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      annotations: [],
    })
  })

  it('a Product wearing patch markers is not partitioned as a patch (kind discriminates, PT-5 floor)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    // §5.2 tolerance means tag-soup can exist; here the tags scream "patch" but the t-tag says
    // product, so it must never enter the patch bucket (and never the chain).
    const impostor = diffPatch('impostor', r.id, p1.id, AB, ABC, {
      tags: [
        ...baseTags('product'),
        ['e', r.id, '', 'root', PK_ROOT],
        ['e', p1.id, '', 'reply', PK_ROOT],
      ],
    })
    const res = resolve(r.id, [r, p1, impostor])
    expect(res.chain).toEqual({
      status: 'resolved',
      content: AB,
      tipId: p1.id,
      applied: [p1.id],
    })
    expect(res.chain).not.toHaveProperty('forkParentId')
  })

  it('a patch belonging to a different root is neither chained nor held here (partition pollution)', () => {
    const r = root(A)
    const other = root('x\n', 'other-root')
    const alien = diffPatch('alien', other.id, other.id, 'x\n', 'x\ny\n')
    const res = resolve(r.id, [r, alien])
    expect(res.chain).toEqual({ status: 'resolved', content: A, tipId: r.id, applied: [] })
    expect(res.pending).toEqual([])
  })

  it('a root-author patch replying to a FOREIGN patch never enters the chain, even well-parented (PT-6)', () => {
    const r = root(A)
    const p1 = diffPatch('p1', r.id, r.id, A, AB)
    const fA = diffPatch('fA', r.id, p1.id, AB, ABC, { pubkey: PK_FOREIGN })
    const adopted = diffPatch('adopted', r.id, fA.id, ABC, 'a\nb\nc\nd\n')
    const res = resolve(r.id, [r, p1, fA, adopted])
    // The PT-6 patch carries a real, uniquely-matchable diff — if it were chained, content
    // would advance past ABC. It is ignored as a link, and it is not held: its parent IS
    // observed, the hold is for unobserved lineage only.
    expect(res.chain).toEqual({
      status: 'resolved',
      content: AB,
      tipId: p1.id,
      applied: [p1.id],
    })
    expect(res.pending).toEqual([])
  })
})
