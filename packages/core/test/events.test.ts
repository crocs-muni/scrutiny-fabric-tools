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

describe('version tags (VER-1, amended in spec v0.7.0 — F14)', () => {
  it('parses unpadded MAJOR.MINOR.PATCH fields', () => {
    expect(parseVersionTag('scrutiny-v0.7.0')).toEqual({ major: '0', minor: '7', patch: '0' })
  })

  it('has no digit-count ceiling in any field — the exact case D45 hit under the retired form', () => {
    // Under the old ^scrutiny-v\d{3}$ grammar there was no scrutiny-v0510 for v0.5.10; the ceiling
    // forced a MINOR bump instead (D45). The unpadded form has no such wall.
    expect(parseVersionTag('scrutiny-v0.5.10')).toEqual({ major: '0', minor: '5', patch: '10' })
  })

  it('rejects forms that do not match the grammar, including the retired three-digit form', () => {
    expect(parseVersionTag('scrutiny_v032')).toBeUndefined()
    expect(parseVersionTag('scrutiny-v070')).toBeUndefined()
    expect(parseVersionTag('scrutiny-v0.7')).toBeUndefined()
  })

  it('compares fields numerically, never lexicographically', () => {
    // The defect F14 fixes: a two-digit field sorts before a one-digit one under string comparison
    // ("10" < "9"), which the old "zero-padded, so lexicographic coincides with numeric" claim only
    // avoided by capping every field at one digit.
    expect(compareVersionTags('scrutiny-v0.9.0', 'scrutiny-v0.10.0')).toBeLessThan(0)
    expect(compareVersionTags('scrutiny-v0.10.0', 'scrutiny-v0.10.0')).toBe(0)
    expect(compareVersionTags('scrutiny-v1.0.0', 'scrutiny-v0.99.0')).toBeGreaterThan(0)
  })

  it('compares exactly at any field width — Number-based comparison collapses above 2^53', () => {
    // `Number('9007199254740993') === Number('9007199254740992')`, so a numeric compare of these
    // two distinct tags would return 0 (2026-08-08 audit, S3-11). The per-field digit-string
    // comparison stays exact at any width (same algorithm as Go's x/mod/semver, RPM, dpkg).
    expect(
      compareVersionTags('scrutiny-v9007199254740993.0.0', 'scrutiny-v9007199254740992.0.0'),
    ).toBeGreaterThan(0)
    expect(
      compareVersionTags('scrutiny-v9007199254740992.0.0', 'scrutiny-v9007199254740993.0.0'),
    ).toBeLessThan(0)
  })

  it('treats leading-zero-padded fields as numerically equal, though producers emit unpadded', () => {
    expect(compareVersionTags('scrutiny-v007.7.0', 'scrutiny-v7.7.0')).toBe(0)
    expect(compareVersionTags('scrutiny-v0.7.00', 'scrutiny-v0.7.0')).toBe(0)
  })

  it('returns no version tag when several are present (TAG-2)', () => {
    const e = ev({
      tags: [
        ['t', 'scrutiny-v0.6.1'],
        ['t', 'scrutiny-v0.7.0'],
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
