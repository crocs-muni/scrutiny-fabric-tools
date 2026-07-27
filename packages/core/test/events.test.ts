import { describe, expect, it } from 'vitest'
import {
  compareVersionTags,
  derivedIndexerKinds,
  eTags,
  eTagsWithMarker,
  indexerKinds,
  indexers,
  isScrutinyEvent,
  parseIndexer,
  parseVersionTag,
  scrutinyEventType,
  tagValues,
  versionTag,
} from '../src/events.js'
import { ev, product } from './_fixtures.js'

describe('tag accessors', () => {
  it('returns values for a tag name and skips valueless tags', () => {
    const e = ev({ tags: [['i', 'cve:CVE-1'], ['i'], ['k', 'cve']] })
    expect(tagValues(e, 'i')).toEqual(['cve:CVE-1'])
  })

  it('parses NIP-10 marked e tags, treating an empty relay hint as no hint (BD-8)', () => {
    const e = ev({
      tags: [
        ['e', 'abc', '', 'root', 'pk1'],
        ['e', 'def', 'wss://r.example', 'reply'],
      ],
    })
    expect(eTags(e)).toEqual([
      { id: 'abc', relay: '', marker: 'root', authorHint: 'pk1' },
      { id: 'def', relay: 'wss://r.example', marker: 'reply' },
    ])
    expect(eTagsWithMarker(e, 'root')).toHaveLength(1)
  })
})

describe('event type identification', () => {
  it('recognises a fabric event', () => {
    expect(isScrutinyEvent(product())).toBe(true)
    expect(isScrutinyEvent(ev({ tags: [['t', 'nostr']] }))).toBe(false)
  })

  it('refuses to guess a type when two type tags are present (TAG-3)', () => {
    const e = ev({
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', 'scrutiny-product'],
        ['t', 'scrutiny-metadata'],
      ],
    })
    expect(scrutinyEventType(e)).toBeUndefined()
  })
})

describe('version tags (VER-1)', () => {
  it('parses the three digits as MAJOR/MINOR/PATCH', () => {
    expect(parseVersionTag('scrutiny-v060')).toEqual({ major: 0, minor: 6, patch: 0 })
  })

  it('rejects forms that do not match the grammar, including the underscored variant', () => {
    expect(parseVersionTag('scrutiny_v032')).toBeUndefined()
    expect(parseVersionTag('scrutiny-v0510')).toBeUndefined()
    expect(parseVersionTag('scrutiny-v06')).toBeUndefined()
  })

  it('orders lexicographically, which coincides with semantic ordering', () => {
    expect(compareVersionTags('scrutiny-v059', 'scrutiny-v060')).toBeLessThan(0)
    expect(compareVersionTags('scrutiny-v060', 'scrutiny-v060')).toBe(0)
    expect(compareVersionTags('scrutiny-v100', 'scrutiny-v099')).toBeGreaterThan(0)
  })

  it('returns no version tag when several are present (TAG-2)', () => {
    const e = ev({
      tags: [
        ['t', 'scrutiny-v059'],
        ['t', 'scrutiny-v060'],
      ],
    })
    expect(versionTag(e)).toBeUndefined()
  })
})

describe('indexer parsing (§9)', () => {
  it('splits on the first colon only, so CPE values survive intact (IR-3)', () => {
    expect(parseIndexer('cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*')).toEqual({
      prefix: 'cpe',
      value: '2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*',
      raw: 'cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*',
    })
  })

  it('accepts prefixes absent from the §9 registry (IR-4)', () => {
    // The registry is a baseline, not a closed set. The previous implementation's closed check
    // rejected every one of these, all of which occur in real data (R13).
    for (const raw of [
      'pp:BSI-CC-PP-0084',
      'vendor:infineon',
      'scheme:BSI',
      'cc-cert-id:BSI-DSZ-CC-0814-2012',
      'cc-scheme:DE',
    ]) {
      expect(parseIndexer(raw), raw).toBeDefined()
    }
  })

  it('preserves the authority value verbatim, including case (IR-2)', () => {
    expect(parseIndexer('cve:CVE-2017-15361')?.value).toBe('CVE-2017-15361')
  })

  it('rejects an uppercase prefix and a value with no colon (IR-1, IR-3)', () => {
    expect(parseIndexer('CVE:CVE-2017-15361')).toBeUndefined()
    expect(parseIndexer('no-colon-here')).toBeUndefined()
    expect(parseIndexer(':leading-colon')).toBeUndefined()
  })

  it('treats k as a set, deduplicating one-k-per-i output (PR-4)', () => {
    const e = product({
      tags: [
        ['t', 'scrutiny-fabric'],
        ['i', 'cve:CVE-1'],
        ['k', 'cve'],
        ['i', 'cve:CVE-2'],
        ['k', 'cve'],
      ],
    })
    expect(indexerKinds(e)).toEqual(new Set(['cve']))
    expect(indexers(e)).toHaveLength(2)
    expect(derivedIndexerKinds(e)).toEqual(new Set(['cve']))
  })
})
