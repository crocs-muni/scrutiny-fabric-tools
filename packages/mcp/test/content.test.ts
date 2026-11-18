/**
 * Rule 8 composition goldens, ported from the prototype audit
 * (investigations/mcp-prototype/REPORT.md, `test/compose/content.test.ts:20/:43/:51/:140/:160`).
 * Literals are written out by hand so a change in composition cannot pass by agreeing with itself.
 */

import { describe, expect, it } from 'vitest'
import {
  bindingContent,
  composeContent,
  imetaTag,
  lostFacts,
  normalizeProse,
} from '../src/compose/content.js'

describe('composeContent (rule 8, as the mirror does it)', () => {
  it('renders headline, bullets, Links block and the record card last, LF only', () => {
    const content = composeContent({
      headline: 'Example Corp EX-100',
      bullets: ['one', 'two'],
      links: ['https://example.com/ex-100'],
      card: { part: 'EX-100', size: 3 },
    })
    expect(content).toBe(
      [
        'Example Corp EX-100',
        '',
        '- one',
        '- two',
        '',
        'Links:',
        '- https://example.com/ex-100',
        '',
        'Record card (JSON): {"part":"EX-100","size":3}',
      ].join('\n'),
    )
  })

  it('omits optional blocks instead of leaving empty ones', () => {
    expect(composeContent({ headline: 'Only headline' })).toBe('Only headline')
    expect(composeContent({ headline: 'H', bullets: [], links: [] })).toBe('H')
    expect(composeContent({ headline: 'H', card: {} })).toBe('H')
  })

  it('keeps a bullet that already starts with "- " as one bullet', () => {
    expect(composeContent({ headline: 'H', bullets: ['- two'] })).toBe('H\n\n- two')
  })
})

describe('emit-boundary normalisation', () => {
  it('replaces C0 controls with spaces and folds typographic quotes to ASCII', () => {
    expect(normalizeProse('Example\u0001 EX-100 «quoted» “q” „q')).toBe(
      'Example  EX-100 "quoted" "q" "q',
    )
  })

  it('keeps tabs, which are not C0 controls in the rule-8 sense', () => {
    expect(normalizeProse('a\tb')).toBe('a\tb')
  })
})

describe('binding content (rule 8d)', () => {
  it('is the label, a blank line, and the Refs line holding ref placeholders', () => {
    expect(bindingContent('Fault-injection test', 'product:ex-100', 'metadata:fi-test')).toBe(
      'Fault-injection test\n\nRefs: root @ref:product:ex-100 link @ref:metadata:fi-test',
    )
  })
})

describe('imeta rows (NIP-92)', () => {
  it('renders url, m, x, size, alt in that order', () => {
    expect(
      imetaTag({
        url: 'https://relay.example/aa.pdf',
        m: 'application/pdf',
        x: 'a'.repeat(64),
        size: 412033,
        alt: 'EX-100 datasheet v1.2',
      }),
    ).toStrictEqual([
      'imeta',
      'url https://relay.example/aa.pdf',
      'm application/pdf',
      `x ${'a'.repeat(64)}`,
      'size 412033',
      'alt EX-100 datasheet v1.2',
    ])
  })
})

describe('rule 2a check (reports; never rewrites prose)', () => {
  const prose = (headline: string, card: Record<string, string | number>, indexers: string[]) =>
    lostFacts({ headline, bullets: [], links: [], card, indexers })

  it('reports a card scalar and an indexer value missing from the prose', () => {
    expect(
      prose('Example Corp secure element', { eal: 'EAL6+', part: 'EX-100' }, ['part:EX-100']),
    ).toStrictEqual([
      { from: 'card', key: 'eal', value: 'EAL6+' },
      { from: 'card', key: 'part', value: 'EX-100' },
      { from: 'indexer', index: 0, value: 'EX-100' },
    ])
  })

  it('matches casefolded and separator-insensitive', () => {
    expect(
      prose('ex100 at bsi dsz cc 1234', { cert: 'BSI-DSZ-CC-1234', part: 'EX-100' }, [
        'cc:BSI-DSZ-CC-1234',
      ]),
    ).toStrictEqual([])
  })

  it('checks numbers too, as their decimal spelling', () => {
    expect(prose('H', { size: 3, year: 2026 }, [])).toStrictEqual([
      { from: 'card', key: 'size', value: '3' },
      { from: 'card', key: 'year', value: '2026' },
    ])
  })

  it('checks a two- or three-character code the prose omits, and passes one it mentions', () => {
    expect(prose('Example Corp secure element', { lab: 'LLE', rev: 'B2' }, [])).toStrictEqual([
      { from: 'card', key: 'lab', value: 'LLE' },
      { from: 'card', key: 'rev', value: 'B2' },
    ])
    expect(
      prose('Example Corp LLE rev B2 secure element', { lab: 'LLE', rev: 'B2' }, []),
    ).toStrictEqual([])
  })

  it('checks a short numeric scalar, and passes one the headline spells out', () => {
    expect(prose('Example Corp secure element', { fips: 140, eal: 6 }, [])).toStrictEqual([
      { from: 'card', key: 'fips', value: '140' },
      { from: 'card', key: 'eal', value: '6' },
    ])
    expect(
      prose('Example Corp FIPS 140 EAL 6 secure element', { fips: 140, eal: 6 }, []),
    ).toStrictEqual([])
  })

  it('still exempts long hex, type strings, the jcver-lte cohort and «-marked values', () => {
    expect(
      prose(
        'H',
        {
          hash: 'a'.repeat(64),
          type: 'example-datasheet@1',
          marked: '«template»',
        },
        ['jcver-lte:3.0.5'],
      ),
    ).toStrictEqual([])
  })

  it('does not exempt a short scalar: only isExempt can excuse an omission', () => {
    expect(prose('H', { short: 'abc' }, [])).toStrictEqual([
      { from: 'card', key: 'short', value: 'abc' },
    ])
  })

  it('does not count the record card line itself as prose', () => {
    expect(prose('H', { part: 'EX-100' }, [])).toHaveLength(1)
  })
})
