/**
 * Phase 21 (mandate §14, AUDIT-2026-07-31.md §5) — the indexed in-memory EventStorage must
 * answer EXACTLY what the naive one did. Gate shape: a differential property over a random
 * corpus and random filters, checked against an oracle that re-derives the answer independently
 * from the EventFilter shape's own semantics (ids/authors/kinds/since/until keys, each `#` key
 * any-value-within-key AND'd across keys, per-filter limit by descending `created_at` with the
 * id tie-break, DEL-1/6/8 deletion hiding). Only the shared tag accessors (`tagValues`/`eTags`)
 * are reused — the filter *decision* logic is re-derived here, never imported from store.ts.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_TAGS, type NostrEvent, eTags, tagValues } from '../src/events.js'
import type { EventFilter } from '../src/interfaces.js'
import { createInMemoryEventStorage } from '../src/store.js'

// ---------------------------------------------------------------------------
// Independent oracle (the naive full scan this phase replaced)
// ---------------------------------------------------------------------------

function naiveMatches(event: NostrEvent, filter: EventFilter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue
    const values = (filter as Readonly<Record<string, readonly string[]>>)[key]
    if (values === undefined) continue
    if (!tagValues(event, key.slice(1)).some((v) => values.includes(v))) return false
  }
  return true
}

function naiveDeleted(byId: ReadonlyMap<string, NostrEvent>): Set<string> {
  const deleted = new Set<string>()
  for (const event of byId.values()) {
    if (event.kind !== 5) continue
    for (const ref of eTags(event)) {
      const target = byId.get(ref.id)
      if (target === undefined) continue // DEL-8
      if (target.kind === 5) continue // DEL-6
      if (target.pubkey !== event.pubkey) continue // DEL-1
      deleted.add(ref.id)
    }
  }
  return deleted
}

function naiveQuery(
  events: readonly NostrEvent[],
  filters: readonly EventFilter[],
  includeDeleted: boolean,
): NostrEvent[] {
  const byId = new Map(events.map((e) => [e.id, e] as const))
  const deletedIds = includeDeleted ? undefined : naiveDeleted(byId)
  const visible = (e: NostrEvent): boolean => includeDeleted || !deletedIds?.has(e.id)

  if (filters.length === 0) return [...byId.values()].filter(visible)

  const matched = new Map<string, NostrEvent>()
  for (const filter of filters) {
    let found = [...byId.values()].filter((e) => visible(e) && naiveMatches(e, filter))
    if (filter.limit !== undefined) {
      found = found
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit)
    }
    for (const e of found) matched.set(e.id, e)
  }
  return [...matched.values()]
}

// ---------------------------------------------------------------------------
// Corpus and filter generators — small pools so index keys collide productively
// ---------------------------------------------------------------------------

const PK_A = `pk${'a'.repeat(62)}`
const PK_B = `pk${'b'.repeat(62)}`
const PK_C = `pk${'c'.repeat(62)}`
const INDEXER_POOL = ['cve', 'cpe:2.3', 'cwe'] as const
const TYPE_TAGS = Object.values(EVENT_TYPE_TAGS)

const makeEventId = (n: number): string => `e${n.toString(16).padStart(63, '0')}`
const makeAnchorId = (n: number): string => `a${n.toString(16).padStart(63, '0')}`

interface CorpusSpec {
  readonly shape: 'product' | 'metadata' | 'binding' | 'patch' | 'deletion' | 'plain'
  readonly pk: string
  readonly indexer: string
  readonly anchorSlotA: number
  readonly anchorSlotB: number
  readonly createdAt: number
}

const corpusSpec: fc.Arbitrary<CorpusSpec> = fc.record({
  shape: fc.constantFrom('product', 'metadata', 'binding', 'patch', 'deletion', 'plain'),
  pk: fc.constantFrom(PK_A, PK_B, PK_C),
  indexer: fc.constantFrom(...INDEXER_POOL),
  anchorSlotA: fc.integer({ min: 0, max: 39 }),
  anchorSlotB: fc.integer({ min: 0, max: 39 }),
  createdAt: fc.integer({ min: 1_700_000_000, max: 1_700_000_030 }),
})

function buildCorpusEvent(s: CorpusSpec, id: string): NostrEvent {
  const base = { id, pubkey: s.pk, created_at: s.createdAt, sig: 'valid' }
  const anchorA = makeAnchorId(s.anchorSlotA)
  const anchorB = makeAnchorId(s.anchorSlotB)
  switch (s.shape) {
    case 'product':
      return {
        ...base,
        kind: 1,
        tags: [
          ['t', 'scrutiny-fabric'],
          ['t', 'scrutiny-v061'],
          ['t', EVENT_TYPE_TAGS.product],
          ['i', s.indexer],
        ],
        content: `product ${id}`,
      }
    case 'metadata':
      return {
        ...base,
        kind: 1,
        tags: [
          ['t', 'scrutiny-fabric'],
          ['t', 'scrutiny-v061'],
          ['t', EVENT_TYPE_TAGS.metadata],
          ['i', s.indexer],
        ],
        content: `metadata ${id}`,
      }
    case 'binding':
      return {
        ...base,
        kind: 1,
        tags: [
          ['t', 'scrutiny-fabric'],
          ['t', 'scrutiny-v061'],
          ['t', EVENT_TYPE_TAGS.binding],
          ['e', anchorA, '', 'root', PK_A],
          ['e', anchorB, '', 'link', PK_B],
        ],
        content: `binding ${id}`,
      }
    case 'patch':
      return {
        ...base,
        kind: 1,
        tags: [
          ['t', 'scrutiny-fabric'],
          ['t', 'scrutiny-v061'],
          ['t', EVENT_TYPE_TAGS.patch],
          ['e', anchorA, '', 'root', s.pk],
          ['e', anchorB, '', 'reply', s.pk],
        ],
        content: 'patch',
      }
    case 'deletion':
      return { ...base, kind: 5, tags: [['e', anchorA, '']], content: 'deletion' }
    default:
      return { ...base, kind: 1, tags: [], content: `plain ${id}` }
  }
}

const corpus: fc.Arbitrary<NostrEvent[]> = fc
  .array(corpusSpec, { minLength: 0, maxLength: 60 })
  .map((specs) => specs.map((s, i) => buildCorpusEvent(s, makeEventId(i))))

/** One filter, drawn from the corpus's own values so index paths fire. */
function filterArb(events: readonly NostrEvent[]): fc.Arbitrary<EventFilter> {
  const ids = events.map((e) => e.id)
  // Empty-corpus case: the id pools shrink to nothing, so those keys are simply never drawn.
  const idArb =
    ids.length === 0
      ? fc.constant(undefined)
      : fc.option(fc.subarray(ids, { maxLength: Math.min(8, ids.length) }), { nil: undefined })
  const tagEArb =
    ids.length === 0
      ? fc.constant(undefined)
      : fc.option(fc.subarray(ids, { minLength: 1, maxLength: Math.min(2, ids.length) }), {
          nil: undefined,
        })
  return fc
    .record({
      kinds: fc.option(fc.subarray([1, 5]), { nil: undefined }),
      ids: idArb,
      authors: fc.option(fc.subarray([PK_A, PK_B, PK_C]), { nil: undefined }),
      since: fc.option(fc.integer({ min: 1_700_000_000, max: 1_700_000_030 }), { nil: undefined }),
      until: fc.option(fc.integer({ min: 1_700_000_000, max: 1_700_000_030 }), { nil: undefined }),
      tagT: fc.option(
        fc.oneof(
          fc.constant(['scrutiny-fabric']),
          fc.subarray(TYPE_TAGS, { minLength: 1, maxLength: 3 }),
        ),
        { nil: undefined },
      ),
      tagI: fc.option(fc.subarray([...INDEXER_POOL], { minLength: 1, maxLength: 2 }), {
        nil: undefined,
      }),
      tagE: tagEArb,
      limit: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
    })
    .map(
      // exactOptionalPropertyTypes: only defined keys may appear at all.
      (r) =>
        ({
          ...(r.kinds !== undefined ? { kinds: r.kinds } : null),
          ...(r.ids !== undefined ? { ids: r.ids } : null),
          ...(r.authors !== undefined ? { authors: r.authors } : null),
          ...(r.since !== undefined ? { since: r.since } : null),
          ...(r.until !== undefined ? { until: r.until } : null),
          ...(r.tagT !== undefined ? { '#t': r.tagT } : null),
          ...(r.tagI !== undefined ? { '#i': r.tagI } : null),
          ...(r.tagE !== undefined ? { '#e': r.tagE } : null),
          ...(r.limit !== undefined ? { limit: r.limit } : null),
        }) as EventFilter,
    )
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('Phase 21 — the indexed EventStorage is observationally identical to the naive one', () => {
  it('query() returns byte-identical results to the independent naive oracle', async () => {
    await fc.assert(
      fc.asyncProperty(
        corpus.chain((events) =>
          fc.array(filterArb(events), { maxLength: 3 }).map((filters) => ({ events, filters })),
        ),
        async ({ events, filters }) => {
          for (const includeDeleted of [false, true]) {
            const expected = naiveQuery(events, filters, includeDeleted)
            const storage = createInMemoryEventStorage()
            for (let offset = 0; offset < events.length; offset += 7) {
              await storage.put(events.slice(offset, offset + 7))
            }
            const actual = await storage.query(filters, { includeDeleted })
            expect(actual).toEqual(expected)
          }
        },
      ),
      { numRuns: 2_000 },
    )
  })

  it('put() overwrites reindex: an event replaced under the same id leaves no stale tag-index entries', async () => {
    const storage = createInMemoryEventStorage()
    const id = makeEventId(1)
    const v1 = buildCorpusEvent(
      { shape: 'product', pk: PK_A, indexer: 'cve', anchorSlotA: 0, anchorSlotB: 0, createdAt: 1 },
      id,
    )
    const v2 = buildCorpusEvent(
      { shape: 'metadata', pk: PK_A, indexer: 'cwe', anchorSlotA: 0, anchorSlotB: 0, createdAt: 2 },
      id,
    )
    await storage.put([v1])
    expect((await storage.query([{ '#i': ['cve'] }])).map((e) => e.id)).toEqual([id])
    await storage.put([v2])
    expect(await storage.query([{ '#i': ['cve'] }])).toEqual([])
    expect((await storage.query([{ '#i': ['cwe'] }])).map((e) => e.id)).toEqual([id])
    expect(await storage.query([{ '#t': [EVENT_TYPE_TAGS.product] }])).toEqual([])
    expect((await storage.query([{ '#t': [EVENT_TYPE_TAGS.metadata] }])).map((e) => e.id)).toEqual([
      id,
    ])
  })

  it('the deletion-hiding cache is invalidated by put: newly-arrived kind 5s hide their targets from the very next query', async () => {
    const storage = createInMemoryEventStorage()
    const target = buildCorpusEvent(
      { shape: 'product', pk: PK_A, indexer: 'cve', anchorSlotA: 0, anchorSlotB: 0, createdAt: 1 },
      makeAnchorId(0),
    )
    const deletion: NostrEvent = {
      id: makeEventId(2),
      pubkey: PK_A,
      created_at: 2,
      kind: 5,
      tags: [['e', target.id, '']],
      content: 'gone',
      sig: 'valid',
    }
    await storage.put([target])
    expect((await storage.query([{ '#i': ['cve'] }])).map((e) => e.id)).toEqual([target.id])
    expect(
      (await storage.query([{ '#i': ['cve'] }], { includeDeleted: true })).map((e) => e.id),
    ).toEqual([target.id])

    await storage.put([deletion])
    expect(await storage.query([{ '#i': ['cve'] }])).toEqual([])
    expect(
      (await storage.query([{ '#i': ['cve'] }], { includeDeleted: true })).map((e) => e.id),
    ).toEqual([target.id])
  })

  it('a deletion from a DIFFERENT pubkey does not hide the target (DEL-1), cached or not', async () => {
    const storage = createInMemoryEventStorage()
    const target = buildCorpusEvent(
      { shape: 'metadata', pk: PK_A, indexer: 'cwe', anchorSlotA: 0, anchorSlotB: 0, createdAt: 1 },
      makeAnchorId(1),
    )
    const foreignDeletion: NostrEvent = {
      id: makeEventId(3),
      pubkey: PK_B,
      created_at: 2,
      kind: 5,
      tags: [['e', target.id, '']],
      content: 'not honoured',
      sig: 'valid',
    }
    await storage.put([target])
    await storage.put([foreignDeletion])
    expect((await storage.query([{ '#i': ['cwe'] }])).map((e) => e.id)).toEqual([target.id])
  })
})
