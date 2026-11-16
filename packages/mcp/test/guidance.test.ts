/**
 * Executable documentation (audit: `test/compose/guide.test.ts:50/:56/:77`): the guide's worked
 * example is a valid, ready plan that composes to exactly the content the guide shows, and the
 * guide's prefix list is the preflight vocabulary.
 */

import { describe, expect, it } from 'vitest'
import { renderSummary } from '../src/approval/summary.js'
import { draftPlan } from '../src/plan/draft.js'
import { KNOWN_INDEXER_PREFIXES } from '../src/preflight/gates.js'
import {
  GUIDE_EXAMPLE_PLAN,
  GUIDE_EXAMPLE_PRODUCT_CONTENT,
  PUBLISHER_GUIDE,
} from '../src/server/guidance.js'
import { PUBKEY, makeRoot } from './_fixtures.js'

describe('publisher guide', () => {
  it('worked example drafts ready and composes to the documented product content', async () => {
    const root = makeRoot({
      'datasheets/ex-100-datasheet.pdf': 'datasheet',
      'reports/fi-eval-v1.1.pdf': 'report',
    })
    const draft = await draftPlan({ root, plan: GUIDE_EXAMPLE_PLAN, pubkey: PUBKEY })
    if (draft.status !== 'drafted') throw new Error(JSON.stringify(draft.findings))
    expect(draft.open_questions.filter((q) => q.blocking)).toStrictEqual([])
    expect(draft.graph.events.find((e) => e.ref === 'product:ex-100')?.content).toBe(
      GUIDE_EXAMPLE_PRODUCT_CONTENT,
    )
  })

  it('embeds the example verbatim and lists exactly the known indexer prefixes', () => {
    expect(PUBLISHER_GUIDE).toContain(JSON.stringify(GUIDE_EXAMPLE_PLAN, null, 2))
    const listed = [
      ...(PUBLISHER_GUIDE.split('Known prefixes:')[1]?.split('.\n')[0] ?? '').matchAll(
        /`([a-z0-9-]+)`/gu,
      ),
    ].map((m) => m[1])
    expect(listed).toStrictEqual([...KNOWN_INDEXER_PREFIXES])
  })

  it('names no real vendor: examples use Example Corp', () => {
    expect(PUBLISHER_GUIDE).toContain('Example Corp')
  })
})

describe('approval summary (spec §7.1)', () => {
  it('renders the golden summary from the template graph', async () => {
    const root = makeRoot({
      'datasheets/ex-100-datasheet.pdf': 'datasheet',
      'reports/fi-eval-v1.1.pdf': 'report',
    })
    const draft = await draftPlan({ root, plan: GUIDE_EXAMPLE_PLAN, pubkey: PUBKEY })
    if (draft.status !== 'drafted') throw new Error('not drafted')
    expect(
      renderSummary({
        graph: draft.graph,
        npub: 'npub1example',
        planHash: 'h',
        planPath: '/data/.scrutiny/plans/h.json',
        published: 0,
      }),
    ).toBe(
      [
        'Publish to SCRUTINY Fabric as npub1example',
        'Relays: wss://relay.scrutiny.cloud (primary)',
        'Events: 1 profile · 1 product · 1 metadata · 1 binding = 4',
        'Files:  1 upload (0.0 MB) · 0 verified URLs',
        'Products:',
        '  - Example Corp EX-100 secure element   [vendor:example-corp, part:EX-100]',
        'These are permanent and public. Indexers and files cannot be changed later.',
        'Full plan: /data/.scrutiny/plans/h.json',
        'Plan hash: h',
      ].join('\n'),
    )
  })
})
