/**
 * Schema contract tests (#108 acceptance: "schemas reject free-form `content` strings and `nsec`
 * arguments"). They run against the same schema objects {@link buildServer} hands to the SDK, so a
 * loosened schema fails here before it can reach a host.
 */

import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { type RegisteredTool, TOOLS } from '../src/tools/register.ts'
import { META_SUBTYPES } from '../src/tools/schemas.ts'

const ID_A = 'a'.repeat(64)
const ID_B = 'b'.repeat(64)
const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'

/** One accepted payload per tool — the shared baseline for the rejection cases below. */
const VALID: Readonly<Record<string, Record<string, unknown>>> = {
  set_profile: { name: 'tropic-square' },
  publish_product: {
    headline: 'TROPIC01 secure element',
    indexers: ['cpe:2.3:h:tropic-square:tropic01:-:*:*:*:*:*:*:*'],
  },
  publish_metadata: {
    headline: 'PSR-001 test report',
    indexers: ['purl:pkg:generic/tropic01@1.0'],
    meta_subtype: 'report',
  },
  publish_binding: { root_ref: { id: ID_A }, link_ref: { id: ID_B }, label: 'certifies' },
  publish_patch: { target_id: ID_A, before: 'old', after: 'new' },
  retract: { target_id: ID_A, reason: 'superseded by v2' },
  verify_event: { event_id: ID_A },
  status: {},
}

function toolNamed(name: string): RegisteredTool {
  const found = TOOLS.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no registered tool named ${name}`)
  return found
}

/** Flattened zod issue messages; empty on success. */
function messages(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join('\n')
}

describe('tool registry', () => {
  it('registers exactly the eight #108 tools', () => {
    expect(TOOLS.map((tool) => tool.name)).toStrictEqual([
      'set_profile',
      'publish_product',
      'publish_metadata',
      'publish_binding',
      'publish_patch',
      'retract',
      'verify_event',
      'status',
    ])
  })

  it('has a baseline payload for every registered tool', () => {
    expect(Object.keys(VALID).sort()).toStrictEqual(TOOLS.map((tool) => tool.name).sort())
  })
})

for (const tool of TOOLS) {
  describe(`${tool.name} schema`, () => {
    it('accepts its baseline payload', () => {
      const result = tool.input.safeParse(VALID[tool.name])
      expect(messages(result)).toBe('')
      expect(result.success).toBe(true)
    })

    it('rejects a free-form content argument', () => {
      const result = tool.input.safeParse({
        ...VALID[tool.name],
        content: 'the agent wrote the event text itself',
      })
      expect(result.success).toBe(false)
      expect(messages(result)).toContain('content')
    })

    it('rejects nsec, hex64 and generic secret arguments', () => {
      for (const [key, value] of [
        ['nsec', NSEC],
        ['nsec', 'ab'.repeat(32)],
        ['private_key', 'cd'.repeat(32)],
        ['secret', 'x'],
      ] as const) {
        const result = tool.input.safeParse({ ...VALID[tool.name], [key]: value })
        expect(result.success).toBe(false)
        expect(messages(result)).toContain(key)
      }
    })
  })
}

describe('indexed event schemas', () => {
  it('rejects an empty indexer value and an empty list', () => {
    const product = toolNamed('publish_product').input
    expect(product.safeParse({ headline: 'x', indexers: [] }).success).toBe(false)
    expect(product.safeParse({ headline: 'x', indexers: [''] }).success).toBe(false)
  })

  it('rejects more than IX-2’s 64 indexers', () => {
    const indexers = Array.from({ length: 65 }, (_, i) => `cve:CVE-2020-${1000 + i}`)
    expect(toolNamed('publish_product').input.safeParse({ headline: 'x', indexers }).success).toBe(
      false,
    )
  })

  it('rejects an imeta alt over Lens’s 60-char limit', () => {
    const row = {
      url: 'https://example.test/psr.pdf',
      m: 'application/pdf',
      x: 'c'.repeat(64),
      size: 2048,
    }
    const product = toolNamed('publish_product').input
    expect(
      product.safeParse({
        headline: 'x',
        indexers: ['cc:EAL5+'],
        imeta: [{ ...row, alt: 'a'.repeat(61) }],
      }).success,
    ).toBe(false)
    expect(
      product.safeParse({ headline: 'x', indexers: ['cc:EAL5+'], imeta: [{ ...row, alt: 'psr' }] })
        .success,
    ).toBe(true)
  })

  it('rejects a content key nested inside an imeta row', () => {
    const result = toolNamed('publish_product').input.safeParse({
      headline: 'x',
      indexers: ['cc:EAL5+'],
      imeta: [
        {
          url: 'https://example.test/psr.pdf',
          m: 'application/pdf',
          x: 'c'.repeat(64),
          size: 2048,
          alt: 'psr',
          content: 'raw',
        },
      ],
    })
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('content')
  })

  it('accepts every documented meta_subtype and rejects an invented one', () => {
    const metadata = toolNamed('publish_metadata').input
    for (const subtype of META_SUBTYPES) {
      expect(
        metadata.safeParse({ headline: 'x', indexers: ['cc:EAL5+'], meta_subtype: subtype })
          .success,
      ).toBe(true)
    }
    expect(
      metadata.safeParse({ headline: 'x', indexers: ['cc:EAL5+'], meta_subtype: 'datasheet' })
        .success,
    ).toBe(false)
  })
})

describe('event references', () => {
  it('rejects ids that are not canonical hex64', () => {
    expect(toolNamed('verify_event').input.safeParse({ event_id: 'nsec1nope' }).success).toBe(false)
    expect(
      toolNamed('verify_event').input.safeParse({ event_id: ID_A.toUpperCase() }).success,
    ).toBe(false)
    expect(toolNamed('retract').input.safeParse({ target_id: 'abc', reason: 'x' }).success).toBe(
      false,
    )
    // A nested endpoint ref is strict too: a bad id cannot hide inside `root_ref`.
    expect(
      toolNamed('publish_binding').input.safeParse({
        root_ref: { id: 'short' },
        link_ref: { id: ID_B },
        label: 'certifies',
      }).success,
    ).toBe(false)
  })
})
