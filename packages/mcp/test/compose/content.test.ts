/**
 * Golden vectors for the composition port (#108 A4): mirror `composeContent` structure, the
 * emit-boundary normalization (mirror `plan.ts:20-31`), and the rule-2a restate-and-verify layer.
 */

import { describe, expect, it } from 'vitest'
import {
  CompositionError,
  RECORD_CARD_LABEL,
  assertNoLostFacts,
  composeBindingContent,
  composeContent,
  composeIndexed,
  imetaTags,
  lostFacts,
  oneLine,
} from '../../src/compose/index.ts'

describe('composeContent — mirror rule 8 structure', () => {
  it('renders headline, bullets, Links block and the record card last, LF only', () => {
    const content = composeContent({
      headline: 'Acme SE-1',
      bullets: ['one', '- two'],
      links: ['https://example.test/a.pdf'],
      card: { part: 'X1', size: 3 },
    })
    expect(content).toBe(
      [
        'Acme SE-1',
        '',
        '- one',
        '- two',
        '',
        'Links:',
        '- https://example.test/a.pdf',
        '',
        'Record card (JSON): {"part":"X1","size":3}',
      ].join('\n'),
    )
    expect(content).not.toContain('\r')
  })

  it('omits optional blocks instead of leaving empty ones', () => {
    expect(composeContent({ headline: 'Only headline' })).toBe('Only headline')
    expect(composeContent({ headline: 'H', bullets: [] })).toBe('H')
    expect(composeContent({ headline: 'H', card: {} })).toBe(`H\n\n${RECORD_CARD_LABEL}{}`)
  })
})

describe('emit-boundary normalization (mirror plan.ts:20-31)', () => {
  it('folds CRLF to LF, strips C0 controls to spaces and normalizes typographic quotes', () => {
    const composed = composeIndexed(
      {
        headline: 'Acme\u0001 SE-1\r\nsecond line «quoted»',
        bullets: ['Firmware\n2.1.0'],
        indexers: ['part:SE-1'],
      },
      'normalize',
    )
    expect(composed.content).toBe(
      ['Acme  SE-1', 'second line "quoted"', '', '- Firmware 2.1.0'].join('\n'),
    )
    expect(composed.appended).toStrictEqual([])
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is that no C0 byte survives normalization.
    const c0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    expect(composed.content).not.toMatch(c0)
    expect(composed.content).not.toContain('\r')
  })

  it('keeps a headline newline as a second headline line (mirror two-line headline)', () => {
    const composed = composeIndexed(
      { headline: 'First line\nSecond line', indexers: ['cve:CVE-2020-1'] },
      'headline',
    )
    expect(composed.content.split('\n').slice(0, 2)).toEqual(['First line', 'Second line'])
  })

  it('oneLine joins continuation lines and trims trailing whitespace', () => {
    expect(oneLine('  a\n\tb  ')).toBe('  a b')
  })
})

describe('rule 2a restate-and-verify', () => {
  it('appends Facts and Identifiers bullets for missing card scalars and indexer spellings', () => {
    const composed = composeIndexed(
      {
        headline: 'Acme SE-1',
        bullets: ['Part number AS-SE1-C2P-T301.'],
        card: { type: 'acme-datasheet@1', eal: 'EAL6+', part: 'AS-SE1-C2P-T301' },
        indexers: ['vendor:acme-secure', 'part:AS-SE1-C2P-T301'],
      },
      'restate',
    )
    expect(composed.appended).toStrictEqual(['Facts: eal=EAL6+', 'Identifiers: vendor:acme-secure'])
    expect(composed.content).toContain('\n- Facts: eal=EAL6+\n- Identifiers: vendor:acme-secure\n')
    // The appended block sits inside the bullets, before the Links block and the card.
    expect(composed.content.indexOf('- Facts:')).toBeLessThan(
      composed.content.indexOf(RECORD_CARD_LABEL),
    )
  })

  it('does not restate facts the prose already carries (casefold and separators ignored)', () => {
    const composed = composeIndexed(
      {
        headline: 'Acme SE-1 — eal6 at bsi dsz cc 1234',
        card: { type: 'acme-datasheet@1', eal: 'EAL6+', certificate: 'BSI-DSZ-CC-1234' },
        indexers: ['cc:BSI-DSZ-CC-1234'],
      },
      'norest',
    )
    expect(composed.appended).toStrictEqual([])
  })

  it('ignores scalars shorter than 4 characters and the documented exemptions', () => {
    const composed = composeIndexed(
      {
        headline: 'Record with a long hash',
        card: {
          type: 'acme-datasheet@1',
          eal: 'EAL6+',
          short: 'abc',
          hash: 'a'.repeat(64),
        },
        indexers: ['jcver-lte:3.0.5'],
      },
      'exempt',
    )
    expect(composed.appended).toStrictEqual(['Facts: eal=EAL6+'])
  })

  it('the post-append guard throws a CompositionError when a fact cannot be restated', () => {
    const content = 'prose without the fact\n\nRecord card (JSON): {"certificate":"BSI-1"}'
    expect(lostFacts(content, [], 'guard')).toStrictEqual(['BSI-1'])
    expect(() => assertNoLostFacts(content, [], 'guard')).toThrow(CompositionError)
    expect(() => assertNoLostFacts(content, [], 'guard')).toThrow(/server bug/u)
  })
})

describe('binding content (rule 8d)', () => {
  it('ends with the mandatory Refs line after the label and bullets', () => {
    const root = 'a'.repeat(64)
    const link = 'b'.repeat(64)
    const content = composeBindingContent('certifies', ['Evidence: CC report.'], root, link)
    expect(content).toBe(
      ['certifies', '', '- Evidence: CC report.', '', `Refs: root ${root} link ${link}`].join('\n'),
    )
    expect(content.split('\n').at(-1)).toBe(`Refs: root ${root} link ${link}`)
  })

  it('renders a label-only binding without an empty bullet block', () => {
    const root = 'a'.repeat(64)
    const link = 'b'.repeat(64)
    expect(composeBindingContent('documents', undefined, root, link)).toBe(
      `documents\n\nRefs: root ${root} link ${link}`,
    )
  })
})

describe('imeta rows', () => {
  it('renders one NIP-92 tag per row in the guide field order', () => {
    const tags = imetaTags([
      {
        url: 'https://example.test/a.pdf',
        m: 'application/pdf',
        x: 'c'.repeat(64),
        size: 412033,
        alt: 'SE-1 datasheet v1.2',
      },
    ])
    expect(tags).toStrictEqual([
      [
        'imeta',
        'url https://example.test/a.pdf',
        'm application/pdf',
        `x ${'c'.repeat(64)}`,
        'size 412033',
        'alt SE-1 datasheet v1.2',
      ],
    ])
    expect(imetaTags(undefined)).toStrictEqual([])
  })
})
