/**
 * Scenario arbitrary for the Phase 3 gate.
 *
 * Phase 2's lesson was that a property is only as good as its bias: the round trip nominally
 * covered T1 while barely reaching its rejecting branch. So this generator is biased hard toward
 * the shapes where arrival order could matter — forks, deletions ahead of their targets, halts,
 * overlays on every position, and dangling references — and the property that consumes it asserts
 * floors on the outcome mix, so no branch can quietly stop being exercised.
 */

import fc from 'fast-check'
import type { NostrEvent } from '../src/events.js'
import { PK_FOREIGN, PK_ROOT } from './_fixtures.js'
import { badPatch, deletion, diffPatch, foreignPatch, idOf, noopPatch, root } from './_resolve.js'

export interface Scenario {
  readonly rootId: string
  readonly events: readonly NostrEvent[]
}

const MAX_CHAIN = 5
const position = fc.integer({ min: 0, max: MAX_CHAIN })

const spec = fc.record({
  chainLen: fc.integer({ min: 0, max: MAX_CHAIN }),
  /** A sibling patch at this position turns it into a self-fork. */
  forkAt: fc.option(position, { nil: null }),
  /** A patch here cannot apply, so the chain HALTs. */
  badAt: fc.option(position, { nil: null }),
  noopAt: fc.array(position, { maxLength: 2 }),
  deleteAt: fc.array(fc.integer({ min: 1, max: MAX_CHAIN }), { maxLength: 2 }),
  /** Deletions signed by the wrong key — DEL-1 must ignore them. */
  forgedDeleteAt: fc.array(fc.integer({ min: 1, max: MAX_CHAIN }), { maxLength: 1 }),
  overlays: fc.array(fc.record({ at: position, applies: fc.boolean() }), { maxLength: 3 }),
  danglingOverlays: fc.integer({ min: 0, max: 1 }),
})

function build(s: {
  chainLen: number
  forkAt: number | null
  badAt: number | null
  noopAt: readonly number[]
  deleteAt: readonly number[]
  forgedDeleteAt: readonly number[]
  overlays: readonly { at: number; applies: boolean }[]
  danglingOverlays: number
}): Scenario {
  const r = root('L0\n')
  const events: NostrEvent[] = [r]

  /** `idAt[0]` is the root; `idAt[i]` is chain patch `i`. Same for `contentAt`. */
  const idAt: string[] = [r.id]
  const contentAt: string[] = ['L0\n']
  let content = 'L0\n'
  let parent = r.id

  for (let i = 1; i <= s.chainLen; i++) {
    let patch: NostrEvent
    if (s.badAt === i) {
      patch = badPatch(`bad${i}`, r.id, parent)
    } else if (s.noopAt.includes(i)) {
      patch = noopPatch(`noop${i}`, r.id, parent)
    } else {
      const next = `${content}L${i}\n`
      patch = diffPatch(`p${i}`, r.id, parent, content, next)
      content = next
    }
    events.push(patch)
    idAt.push(patch.id)
    contentAt.push(content)
    parent = patch.id
  }

  // A second child of an existing position: a self-fork, unless it lands past the chain's end, in
  // which case it is simply an extension — both are scenarios worth generating.
  if (s.forkAt !== null && s.forkAt < idAt.length) {
    const at = s.forkAt
    const base = contentAt[at] ?? 'L0\n'
    const parentId = idAt[at] ?? r.id
    events.push(diffPatch(`sib${at}`, r.id, parentId, base, `${base}SIB\n`))
  }

  for (const at of s.deleteAt) {
    const target = idAt[at]
    if (target !== undefined) events.push(deletion(`del${at}`, [target], PK_ROOT))
  }
  for (const at of s.forgedDeleteAt) {
    const target = idAt[at]
    if (target !== undefined) events.push(deletion(`forged${at}`, [target], PK_FOREIGN))
  }

  for (const [n, overlay] of s.overlays.entries()) {
    const at = Math.min(overlay.at, idAt.length - 1)
    const targetId = idAt[at] ?? r.id
    const base = contentAt[at] ?? 'L0\n'
    events.push(
      overlay.applies
        ? foreignPatch(`ov${n}`, r.id, targetId, base, `${base}NOTE${n}\n`)
        : foreignPatch(`ov${n}`, r.id, targetId, 'ABSENT-FROM-EVERYTHING\n', 'X\n'),
    )
  }

  for (let n = 0; n < s.danglingOverlays; n++) {
    events.push(foreignPatch(`dang${n}`, r.id, idOf(`never-observed-${n}`), 'L0\n', 'X\n'))
  }

  return { rootId: r.id, events }
}

export const scenario: fc.Arbitrary<Scenario> = spec.map(build)

/** A scenario paired with a full permutation of its own event array. */
export const scenarioAndPermutation: fc.Arbitrary<{
  scenario: Scenario
  permuted: readonly NostrEvent[]
}> = scenario.chain((s) =>
  fc
    .shuffledSubarray([...s.events], { minLength: s.events.length, maxLength: s.events.length })
    .map((permuted) => ({ scenario: s, permuted })),
)
