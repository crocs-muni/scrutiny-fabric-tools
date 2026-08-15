/**
 * Phase 13 gate (`#46` §7, `PLAN-2026-08-01-rewrite-mandate.md` §1) —
 * `EventFilter` is now a flat NIP-01 shape, not the old `{ tags: {...} }` nesting a real relay
 * silently ignores. This file is the property-test demonstration the audit's own reproduction
 * called for: a hand-rolled NIP-01 matcher, run against both the old (nested) and new (flat) filter
 * shapes, cross-checked against `nostr-tools` — a devDependency only, never a runtime one (D11).
 */

import fc from 'fast-check'
import { matchFilter as nostrToolsMatchFilter } from 'nostr-tools'
import { describe, expect, it } from 'vitest'
import type { NostrEvent } from '../src/events.js'
import type { EventFilter } from '../src/interfaces.js'
import { createInMemoryEventStorage } from '../src/store.js'
import { ev } from './_fixtures.js'

/**
 * A from-scratch NIP-01 matcher, written directly from the spec text — this project stays its own
 * reference implementation for matching, not just for validation/patching/resolution (the same
 * posture `#35`/`#36` already take for their own domains). Unrecognised filter
 * members (e.g. a stray `tags` object under the old, pre-Phase-13 shape) are silently ignored,
 * exactly as a real relay ignores them — this is the mechanism the audit's own reproduction depends
 * on, and the reason a filter shaped the old way degrades to "match everything."
 *
 * `since`/`until` read as inclusive bounds (`created_at >= since`, `created_at <= until`) — flagging
 * `nostr-protocol/nips#650`, which leaves this boundary genuinely ambiguous in NIP-01's own prose.
 * Both this matcher and `store.ts`'s own `matchesFilter` agree on the inclusive reading; this is
 * where that shared choice is exercised against an independent oracle.
 */
function nip01Matches(filter: Readonly<Record<string, unknown>>, event: NostrEvent): boolean {
  // Cast to a plain (non-index-signature) shape for the named fields — `filter`'s real static type
  // (`EventFilter`) mixes named optional fields with a `#${string}` index signature, and TypeScript
  // requires bracket access for any property reachable through an index signature; destructuring
  // through this narrower cast keeps the named-field reads as plain dot access.
  const { ids, authors, kinds, since, until } = filter as {
    ids?: readonly string[]
    authors?: readonly string[]
    kinds?: readonly number[]
    since?: number
    until?: number
  }

  if (ids !== undefined && !ids.includes(event.id)) return false
  if (authors !== undefined && !authors.includes(event.pubkey)) return false
  if (kinds !== undefined && !kinds.includes(event.kind)) return false
  if (since !== undefined && event.created_at < since) return false
  if (until !== undefined && event.created_at > until) return false

  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue
    const values = filter[key] as readonly string[] | undefined
    if (values === undefined) continue
    const letter = key.slice(1)
    if (!event.tags.some((tag) => tag[0] === letter && values.includes(tag[1] ?? ''))) return false
  }
  return true
}

describe('#46 §7 — reproduction and fix', () => {
  it('the old nested `tags` shape silently drops every constraint under a real NIP-01 matcher', () => {
    // The exact pre-Phase-13 shape `query.ts` used to emit — no longer expressible as an
    // `EventFilter`, constructed here as a plain object to reproduce what a real relay actually saw.
    const oldShapeFilter = {
      kinds: [39701],
      tags: { '#t': ['scrutiny-fabric'], '#i': ['cve:CVE-2017-15361'] },
    }
    const a = ev({
      kind: 39701,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['i', 'cve:CVE-2017-15361'],
      ],
    })
    const b = ev({ kind: 39701, tags: [['t', 'unrelated']] }) // wrong #t — would fail if honoured
    const c = ev({ kind: 39701, tags: [] }) // no tags at all — would fail if honoured

    // A real NIP-01 matcher ignores the unrecognised `tags` key entirely, reproducing the audit's
    // own "matches -> a,b,c (3/3), every constraint silently dropped" finding.
    expect([a, b, c].filter((e) => nip01Matches(oldShapeFilter, e))).toEqual([a, b, c])
  })

  it('the new flat shape is honoured by a real NIP-01 matcher — only the true match passes', () => {
    const newShapeFilter: EventFilter = {
      kinds: [39701],
      '#t': ['scrutiny-fabric'],
      '#i': ['cve:CVE-2017-15361'],
    }
    const a = ev({
      kind: 39701,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['i', 'cve:CVE-2017-15361'],
      ],
    })
    const b = ev({ kind: 39701, tags: [['t', 'unrelated']] })
    const c = ev({ kind: 39701, tags: [] })

    expect([a, b, c].filter((e) => nip01Matches(newShapeFilter, e))).toEqual([a])
  })
})

// ---------------------------------------------------------------------------
// Property tests: a small, collision-prone pool so tag/id/pubkey overlaps are frequent rather than
// incidental (the same generator-design lesson every prior phase's own gate already applies).
// ---------------------------------------------------------------------------

const ID_POOL = ['id-1', 'id-2', 'id-3'] as const
const PUBKEY_POOL = ['pk-1', 'pk-2'] as const
const KIND_POOL = [1, 5, 39701] as const
const TAG_VALUE_POOL = ['v1', 'v2', 'v3'] as const

const eventArb: fc.Arbitrary<NostrEvent> = fc
  .record({
    id: fc.constantFrom(...ID_POOL),
    pubkey: fc.constantFrom(...PUBKEY_POOL),
    created_at: fc.integer({ min: 1, max: 10 }),
    kind: fc.constantFrom(...KIND_POOL),
    tags: fc.array(fc.tuple(fc.constantFrom('e', 't', 'i'), fc.constantFrom(...TAG_VALUE_POOL)), {
      maxLength: 4,
    }),
  })
  .map(({ id, pubkey, created_at, kind, tags }) => ev({ id, pubkey, created_at, kind, tags }))

/**
 * `since`/`until` are drawn from `[1, 10]`, never `0` — `nostr-tools`' own `matchFilter` tests both
 * with a plain `filter.since &&`/`filter.until &&` truthy check (`nostr-tools/filter.js`), so a
 * `since`/`until` of exactly `0` is silently treated as "unset" by their implementation, not ours.
 * This is the falsy-zero shape of ambiguity `nostr-protocol/nips#650` names; excluding `0` here
 * keeps the cross-check comparing the same semantics both matchers actually agree on, rather than
 * failing on a divergence that belongs to `nostr-tools`' own implementation quirk, not to whether
 * this project's filter shape is correct.
 */
const flatFilterArb: fc.Arbitrary<EventFilter> = fc
  .record({
    ids: fc.option(fc.uniqueArray(fc.constantFrom(...ID_POOL), { maxLength: 2 }), {
      nil: undefined,
    }),
    authors: fc.option(fc.uniqueArray(fc.constantFrom(...PUBKEY_POOL), { maxLength: 2 }), {
      nil: undefined,
    }),
    kinds: fc.option(fc.uniqueArray(fc.constantFrom(...KIND_POOL), { maxLength: 2 }), {
      nil: undefined,
    }),
    since: fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }),
    until: fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }),
    '#e': fc.option(fc.uniqueArray(fc.constantFrom(...TAG_VALUE_POOL), { maxLength: 2 }), {
      nil: undefined,
    }),
    '#t': fc.option(fc.uniqueArray(fc.constantFrom(...TAG_VALUE_POOL), { maxLength: 2 }), {
      nil: undefined,
    }),
  })
  .map((record) => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined) out[key] = value
    }
    return out as EventFilter
  })

describe('EventFilter property gate', () => {
  it('the hand-rolled NIP-01 matcher agrees with nostr-tools’ matchFilter', () => {
    fc.assert(
      fc.property(flatFilterArb, eventArb, (filter, event) => {
        const ours = nip01Matches(filter, event)
        const theirs = nostrToolsMatchFilter(
          filter as unknown as Parameters<typeof nostrToolsMatchFilter>[0],
          event as unknown as Parameters<typeof nostrToolsMatchFilter>[1],
        )
        expect(ours).toBe(theirs)
      }),
      { numRuns: 2000 },
    )
  })

  it('store.ts’s own matchesFilter (via createInMemoryEventStorage) agrees with the oracle', async () => {
    await fc.assert(
      fc.asyncProperty(
        flatFilterArb,
        fc.uniqueArray(eventArb, { maxLength: 6, selector: (e) => e.id }),
        async (filter, events) => {
          const storage = createInMemoryEventStorage()
          await storage.put(events)
          const matched = new Set((await storage.query([filter])).map((e) => e.id))
          const expected = new Set(events.filter((e) => nip01Matches(filter, e)).map((e) => e.id))
          expect(matched).toEqual(expected)
        },
      ),
      { numRuns: 1000 },
    )
  })
})
