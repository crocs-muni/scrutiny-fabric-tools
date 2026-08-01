/**
 * The Phase 6 gate, items BQ-1/BQ-2 (`docs/QUERY-BUILD.md` §5) — `query.ts`'s filter builders and
 * `classifyByRole`.
 *
 * BQ-1 asserts each builder's output is deep-equal to the literal JSON §8.1/§8.2 show, substituting
 * fixture ids for the spec's illustrative ones — the closest available substitute for a vendored
 * vector file (`discovery.json` remains reserved and unpublished, per the plan's own note).
 */

import { describe, expect, it } from 'vitest'
import {
  bindingsReferencing,
  classifyByRole,
  deletionsFor,
  fullScanFilter,
  indexerFilter,
  searchFilter,
} from '../src/query.js'
import { binding, patch, product } from './_fixtures.js'

describe('BQ-1 — §8.1 discovery filters match the spec text', () => {
  it('step 1/2 — exact indexer', () => {
    expect(indexerFilter('cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*')).toEqual({
      kinds: [1],
      '#t': ['scrutiny-fabric'],
      '#i': ['cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*'],
    })
  })

  it('step 2 — several specificity levels in one filter (OR semantics)', () => {
    const levels = [
      'cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*',
      'cpe:2.3:h:infineon:m7794a12:*',
      'cpe:2.3:h:infineon:*',
    ]
    expect(indexerFilter(levels)).toEqual({
      kinds: [1],
      '#t': ['scrutiny-fabric'],
      '#i': levels,
    })
  })

  it('step 3 — NIP-50 free text (DQ-3)', () => {
    expect(searchFilter('Infineon M7794A12')).toEqual({
      kinds: [1],
      '#t': ['scrutiny-fabric'],
      search: 'Infineon M7794A12',
    })
  })

  it('step 4 — full scan, defaulting to both Product and Metadata', () => {
    expect(fullScanFilter()).toEqual({
      kinds: [1],
      '#t': ['scrutiny-product', 'scrutiny-metadata'],
    })
  })

  it('step 4 — narrowed to a known target type', () => {
    expect(fullScanFilter(['product'])).toEqual({
      kinds: [1],
      '#t': ['scrutiny-product'],
    })
  })
})

describe('BQ-1 — §8.2 traversal filters match the spec text', () => {
  it('Product → Bound Metadata and Metadata → Products are the same filter shape', () => {
    const filter = bindingsReferencing('aaa111')
    expect(filter).toEqual({
      kinds: [1],
      '#t': ['scrutiny-binding'],
      '#e': ['aaa111'],
    })
    expect(bindingsReferencing('bbb222')).toEqual({
      kinds: [1],
      '#t': ['scrutiny-binding'],
      '#e': ['bbb222'],
    })
  })

  it('deletions affecting an event (DQ-2) — no #t, since kind 5 carries none', () => {
    expect(deletionsFor('ddd444')).toEqual({
      kinds: [5],
      '#e': ['ddd444'],
    })
  })
})

describe('BQ-2 — classifyByRole', () => {
  it('reports each result’s actual marker, and excludes non-matches', () => {
    const anchor = product()
    const other = product()
    const link = product()
    const asRoot = binding(anchor.id, link.id)
    const asSomethingElse = binding(other.id, anchor.id) // anchor is the `link`, not the `root`
    const unrelated = binding(other.id, link.id)

    const results = classifyByRole([asRoot, asSomethingElse, unrelated], anchor.id, 'binding')

    expect(results).toHaveLength(2)
    expect(results.find((r) => r.event.id === asRoot.id)?.marker).toBe('root')
    expect(results.find((r) => r.event.id === asSomethingElse.id)?.marker).toBe('link')
    expect(results.some((r) => r.event.id === unrelated.id)).toBe(false)
  })

  it('filters by expected type — a Patch sharing the anchor id is excluded when expecting a Binding', () => {
    const anchor = product()
    const boundBinding = binding(anchor.id, product().id)
    const replyingPatch = patch(anchor.id, anchor.id, 'irrelevant')

    const results = classifyByRole([boundBinding, replyingPatch], anchor.id, 'binding')

    expect(results).toEqual([{ event: boundBinding, marker: 'root' }])
  })

  it('excludes an unmarked e tag naming the anchor — a role, not just a reference', () => {
    const anchor = product()
    const unmarked = binding(product().id, product().id, [['e', anchor.id, '', '', '']])

    expect(classifyByRole([unmarked], anchor.id, 'binding')).toEqual([])
  })
})
