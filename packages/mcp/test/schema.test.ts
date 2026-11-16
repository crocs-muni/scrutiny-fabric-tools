/**
 * Plan schema refusals. Every assertion is on `code` and `field` (spec §10), never on wording.
 */

import { describe, expect, it } from 'vitest'
import { parsePlan } from '../src/plan/schema.js'
import { METADATA, PRODUCT, PROFILE, plan } from './_fixtures.js'

function fieldsOf(raw: unknown): string[] {
  const parsed = parsePlan(raw)
  if (parsed.ok) return []
  for (const f of parsed.findings) expect(f.code).toBe('schema.invalid')
  return parsed.findings.map((f) => f.field ?? '<null>')
}

describe('parsePlan', () => {
  it('accepts one minimal record of each type', () => {
    expect(parsePlan(plan([PROFILE, PRODUCT, METADATA])).ok).toBe(true)
    expect(
      parsePlan(
        plan([
          { ref: 'product:p', type: 'product', headline: 'H', indexers: ['part:P-1'] },
          {
            ref: 'metadata:m',
            type: 'metadata',
            subtype: 'report',
            headline: 'H',
            indexers: ['doc:D-1'],
          },
          { ref: 'profile:x', type: 'profile', name: 'x' },
        ]),
      ).ok,
    ).toBe(true)
  })

  it('treats missing or empty relays as an open question, not a schema error', () => {
    expect(parsePlan({ planVersion: 1, records: [PRODUCT] }).ok).toBe(true)
    expect(parsePlan(plan([PRODUCT], [])).ok).toBe(true)
  })

  it('rejects free-form content, raw tags, kind, id, created_at and key material', () => {
    for (const key of ['content', 'tags', 'kind', 'id', 'created_at', 'nsec', 'sig']) {
      expect(fieldsOf(plan([{ ...PRODUCT, [key]: 'x' }]))).toStrictEqual([
        `records[product:ex-100].${key}`,
      ])
      expect(fieldsOf({ ...plan([PRODUCT]), [key]: 'x' })).toStrictEqual([key])
    }
  })

  it('rejects an unknown nested key inside an artifact', () => {
    expect(
      fieldsOf(plan([{ ...METADATA, artifacts: [{ ...METADATA.artifacts[0], content: 'x' }] }])),
    ).toStrictEqual(['records[metadata:fi-test].artifacts[0].content'])
  })

  it('names a record by index when its ref is unusable', () => {
    expect(fieldsOf(plan([{ ...PRODUCT, ref: 'Product:EX' }]))).toStrictEqual(['records[0].ref'])
    expect(fieldsOf(plan([{ ...PRODUCT, ref: 'metadata:ex-100' }]))).toStrictEqual([
      'records[0].ref',
    ])
  })

  it('rejects a multi-line headline or bullet and an over-long headline', () => {
    expect(fieldsOf(plan([{ ...PRODUCT, headline: 'a\nb' }]))).toStrictEqual([
      'records[product:ex-100].headline',
    ])
    expect(fieldsOf(plan([{ ...PRODUCT, bullets: ['ok', 'a\r\nb'] }]))).toStrictEqual([
      'records[product:ex-100].bullets[1]',
    ])
    expect(fieldsOf(plan([{ ...PRODUCT, headline: 'x'.repeat(200) }]))).toStrictEqual([])
    expect(fieldsOf(plan([{ ...PRODUCT, headline: 'x'.repeat(201) }]))).toStrictEqual([
      'records[product:ex-100].headline',
    ])
  })

  it('caps bullets at 20 and each at 500 characters', () => {
    expect(fieldsOf(plan([{ ...PRODUCT, bullets: Array(21).fill('b') }]))).toStrictEqual([
      'records[product:ex-100].bullets',
    ])
    expect(fieldsOf(plan([{ ...PRODUCT, bullets: ['x'.repeat(501)] }]))).toStrictEqual([
      'records[product:ex-100].bullets[0]',
    ])
  })

  it('rejects an empty indexer list and malformed indexer spellings', () => {
    expect(fieldsOf(plan([{ ...PRODUCT, indexers: [] }]))).toStrictEqual([
      'records[product:ex-100].indexers',
    ])
    expect(
      fieldsOf(plan([{ ...PRODUCT, indexers: ['part:X', 'novalue', 'Part:X', 'p:'] }])),
    ).toStrictEqual([
      'records[product:ex-100].indexers[1]',
      'records[product:ex-100].indexers[2]',
      'records[product:ex-100].indexers[3]',
    ])
  })

  it('accepts every documented subtype and rejects an invented one', () => {
    for (const subtype of [
      'specification',
      'test',
      'report',
      'advisory',
      'sbom',
      'maintenance',
      'target',
    ]) {
      expect(fieldsOf(plan([PRODUCT, { ...METADATA, subtype }]))).toStrictEqual([])
    }
    expect(fieldsOf(plan([PRODUCT, { ...METADATA, subtype: 'whitepaper' }]))).toStrictEqual([
      'records[metadata:fi-test].subtype',
    ])
  })

  it('caps alt at 60 characters and a binding label at 28', () => {
    const art = (alt: string) => ({ ...METADATA, artifacts: [{ path: 'r.pdf', alt }] })
    expect(fieldsOf(plan([PRODUCT, art('a'.repeat(60))]))).toStrictEqual([])
    expect(fieldsOf(plan([PRODUCT, art('a'.repeat(61))]))).toStrictEqual([
      'records[metadata:fi-test].artifacts[0].alt',
    ])
    const bind = (label: string) => ({ ...METADATA, bind_to: [{ ref: 'product:ex-100', label }] })
    expect(fieldsOf(plan([PRODUCT, bind('l'.repeat(28))]))).toStrictEqual([])
    expect(fieldsOf(plan([PRODUCT, bind('l'.repeat(29))]))).toStrictEqual([
      'records[metadata:fi-test].bind_to[0].label',
    ])
  })

  it('refuses an artifact URL without a local path, and a non-HTTPS URL', () => {
    expect(
      fieldsOf(
        plan([PRODUCT, { ...METADATA, artifacts: [{ url: 'https://e.x/a.pdf', alt: 'a' }] }]),
      ),
    ).toStrictEqual(['records[metadata:fi-test].artifacts[0].path'])
    expect(
      fieldsOf(
        plan([
          PRODUCT,
          { ...METADATA, artifacts: [{ path: 'a.pdf', url: 'http://e.x/a.pdf', alt: 'a' }] },
        ]),
      ),
    ).toStrictEqual(['records[metadata:fi-test].artifacts[0].url'])
  })

  it('accepts only flat string or number card scalars', () => {
    expect(fieldsOf(plan([{ ...PRODUCT, card: { nested: { a: 'b' } } }]))).toStrictEqual([
      'records[product:ex-100].card.nested',
    ])
    expect(fieldsOf(plan([{ ...PRODUCT, card: { flag: true } }]))).toStrictEqual([
      'records[product:ex-100].card.flag',
    ])
  })

  it('accepts 1..8 wss relays, rejects other schemes and duplicates', () => {
    const relays = (n: number) => Array.from({ length: n }, (_, i) => `wss://r${i}.example`)
    expect(fieldsOf(plan([PRODUCT], relays(8)))).toStrictEqual([])
    expect(fieldsOf(plan([PRODUCT], relays(9)))).toStrictEqual(['relays'])
    expect(fieldsOf(plan([PRODUCT], ['ws://r.example']))).toStrictEqual(['relays[0]'])
    expect(fieldsOf(plan([PRODUCT], ['wss://r.example', 'wss://r.example/']))).toStrictEqual([
      'relays[1]',
    ])
  })

  it('allows at most one profile', () => {
    expect(fieldsOf(plan([PROFILE, { ...PROFILE, ref: 'profile:two' }]))).toStrictEqual([
      'records[profile:two]',
    ])
  })

  it('rejects a planVersion other than 1 and a non-object plan', () => {
    expect(fieldsOf({ ...plan([PRODUCT]), planVersion: 2 })).toStrictEqual(['planVersion'])
    expect(fieldsOf('plan')).toStrictEqual(['<null>'])
  })

  it('only metadata carries subtype, identifier, artifacts and bind_to', () => {
    expect(fieldsOf(plan([{ ...PRODUCT, subtype: 'test' }]))).toStrictEqual([
      'records[product:ex-100].subtype',
    ])
    expect(fieldsOf(plan([{ ...PRODUCT, bind_to: [] }]))).toStrictEqual([
      'records[product:ex-100].bind_to',
    ])
  })
})
