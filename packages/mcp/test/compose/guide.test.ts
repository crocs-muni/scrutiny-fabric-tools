/**
 * The publisher guide is executable documentation (#108 A4, #109): its §8 composed block and tag
 * block are asserted against the real composer and builder, and its §4 prefix table against the
 * preflight allowlist. Drift is a failing test, not a stale doc.
 */

import { readFileSync } from 'node:fs'
import { buildProduct } from '@scrutiny-fabric/core'
import { describe, expect, it } from 'vitest'
import { type ComposeImeta, composeIndexed, imetaTags } from '../../src/compose/index.ts'
import { KNOWN_INDEXER_PREFIXES } from '../../src/preflight/checkTable.ts'

const GUIDE = readFileSync(new URL('../../docs/publisher-guide.md', import.meta.url), 'utf8')

/** The first fenced block after `marker`: its info string and body, excluding the fences. */
function fencedBlockAfter(marker: string): { info: string; body: string } {
  const at = GUIDE.indexOf(marker)
  if (at < 0) throw new Error(`publisher guide: marker not found: ${marker}`)
  const open = GUIDE.indexOf('```', at)
  const infoEnd = GUIDE.indexOf('\n', open)
  const close = GUIDE.indexOf('\n```', infoEnd)
  if (open < 0 || infoEnd < 0 || close < 0) {
    throw new Error(`publisher guide: no fenced block after: ${marker}`)
  }
  return { info: GUIDE.slice(open + 3, infoEnd), body: GUIDE.slice(infoEnd + 1, close) }
}

describe('guide §8 — the worked example is the server output', () => {
  const request = JSON.parse(
    fencedBlockAfter('Map the facts to a Product and one `publish_product` call:').body,
  ) as {
    headline: string
    bullets: string[]
    links: { url: string }[]
    indexers: string[]
    card: Record<string, string>
    imeta: ComposeImeta[]
  }
  const composed = composeIndexed(
    {
      headline: request.headline,
      bullets: request.bullets,
      links: request.links,
      card: request.card,
      indexers: request.indexers,
    },
    'guide §8',
  )

  it('composes the documented content byte-for-byte, with no restatement bullets', () => {
    const expected = fencedBlockAfter('Composed output — byte-for-byte').body
    expect(composed.content).toBe(expected)
    expect(composed.appended).toStrictEqual([])
  })

  it('derives the documented tag block byte-for-byte', () => {
    const built = buildProduct(composed.content, 1_700_000_000, request.indexers)
    const actual = [...built.template.tags, ...imetaTags(request.imeta)]
    const documented = JSON.parse(fencedBlockAfter('The tags the server emits around this').body)
    expect(documented).toStrictEqual(actual)
  })
})

describe('guide §4 — one prefix table, one allowlist', () => {
  const start = GUIDE.indexOf('## 4. Indexers')
  const end = GUIDE.indexOf('## 5. Artifacts')
  const section = GUIDE.slice(start, end)
  const documented = new Set<string>()
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const firstCell = line.split('|')[1] ?? ''
    for (const match of firstCell.matchAll(/`([a-z0-9-]+)`/gu)) {
      if (match[1] !== undefined) documented.add(match[1])
    }
  }

  it('lists exactly the preflight KNOWN_INDEXER_PREFIXES', () => {
    expect([...documented].sort()).toStrictEqual([...KNOWN_INDEXER_PREFIXES].sort())
  })

  it('documents the warning-not-refusal posture for unknown prefixes', () => {
    expect(section).toMatch(/warning\*\*, never a refusal/u)
  })
})
