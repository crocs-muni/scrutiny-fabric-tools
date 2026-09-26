import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  IMETA_TAG,
  compareVersionTags,
  derivedIndexerKinds,
  eTags,
  eTagsWithMarker,
  imetaArtifacts,
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

describe('imeta artifacts (§3.1, §4.6, NIP-92/94)', () => {
  it('parses the §4.6 worked example into a full ref', () => {
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'url https://blossom.example.org/abc123...cdx.json',
          'm application/vnd.cyclonedx+json',
          'x abc1234567890abcdef0123456789abcdef0123456789abcdef0123456789abc',
          'size 1048576',
        ],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([
      {
        url: 'https://blossom.example.org/abc123...cdx.json',
        mime: 'application/vnd.cyclonedx+json',
        sha256: 'abc1234567890abcdef0123456789abcdef0123456789abcdef0123456789abc',
        size: '1048576',
      },
    ])
  })

  it('parses the NIP-92 example verbatim — un-named NIP-94 fields and a non-hex x are omitted', () => {
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'url https://nostr.build/i/my-image.jpg',
          'm image/jpeg',
          'blurhash eVF$^OI:${M{o#*0-nNFxakD-?xVM}WEWB%iNKxvR-oetmo#R-aen$',
          'dim 3024x4032',
          'alt A scenic photo overlooking the coast of Costa Rica',
          'x <sha256 hash as specified in NIP 94>',
          'fallback https://nostrcheck.me/alt1.jpg',
          'fallback https://void.cat/alt1.jpg',
        ],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([
      {
        url: 'https://nostr.build/i/my-image.jpg',
        mime: 'image/jpeg',
        alt: 'A scenic photo overlooking the coast of Costa Rica',
      },
    ])
  })

  it('returns corpus tags verbatim, one ref per tag in document order', () => {
    // Shapes transcribed from the sec-certs mapping corpus (investigations/sec-certs-mapping/
    // REPORT.md): percent-encoded URLs and alt values carrying spaces.
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'url https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Certification%20Report(Rathon-SSO%20v4.0).pdf',
          'm application/pdf',
          'x d54bbde34984620cf5c42ff42f1da196c683d4053b4082429ad84bd5da2fe415',
          'alt report: Certification Report (Rathon-SSO v4.0).pdf',
        ],
        [
          IMETA_TAG,
          'url https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Rathon-SSO%20v4.0%20ST_EN_v1.1.pdf',
          'm application/pdf',
          'x eb8a47aba86cfbc78e8ddee0d8e0b36c850f4e012ecbc609d1ad4ef46252cb58',
        ],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([
      {
        url: 'https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Certification%20Report(Rathon-SSO%20v4.0).pdf',
        mime: 'application/pdf',
        sha256: 'd54bbde34984620cf5c42ff42f1da196c683d4053b4082429ad84bd5da2fe415',
        alt: 'report: Certification Report (Rathon-SSO v4.0).pdf',
      },
      {
        url: 'https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Rathon-SSO%20v4.0%20ST_EN_v1.1.pdf',
        mime: 'application/pdf',
        sha256: 'eb8a47aba86cfbc78e8ddee0d8e0b36c850f4e012ecbc609d1ad4ef46252cb58',
      },
    ])
  })

  it('does not depend on entry order within the tag', () => {
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'alt report: Certification Report (Rathon-SSO v4.0).pdf',
          'size 1048576',
          'x d54bbde34984620cf5c42ff42f1da196c683d4053b4082429ad84bd5da2fe415',
          'm application/pdf',
          'url https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Certification%20Report(Rathon-SSO%20v4.0).pdf',
        ],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([
      {
        url: 'https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Certification%20Report(Rathon-SSO%20v4.0).pdf',
        mime: 'application/pdf',
        sha256: 'd54bbde34984620cf5c42ff42f1da196c683d4053b4082429ad84bd5da2fe415',
        size: '1048576',
        alt: 'report: Certification Report (Rathon-SSO v4.0).pdf',
      },
    ])
  })

  it('accepts a url-only tag — §3.1 makes NIP-92 OPTIONAL, so its url+other-field MUST is not inherited', () => {
    const e = ev({ tags: [[IMETA_TAG, 'url https://blossom.example.org/payload.json']] })
    expect(imetaArtifacts(e)).toEqual([{ url: 'https://blossom.example.org/payload.json' }])
  })

  it('contributes nothing without a valid url — never a partial fabrication', () => {
    for (const entries of [
      ['m application/pdf'],
      ['url'],
      ['url '],
      ['url javascript:alert(1)'],
      ['url data:text/plain;base64,aGVsbG8='],
      ['url ftp://blossom.example.org/a.json'],
      ['url //blossom.example.org/a.json'],
      ['url /local/path'],
      ['url https:'],
      [' url https://blossom.example.org/a.json'],
    ]) {
      const e = ev({ tags: [[IMETA_TAG, ...entries]] })
      expect(imetaArtifacts(e), JSON.stringify(entries)).toEqual([])
    }
  })

  it('takes the first of several valid url entries (IM-3: mirror selection is fetch-time)', () => {
    const e = ev({
      tags: [
        [IMETA_TAG, 'url https://blossom.example.org/a.json', 'url https://cdn.example.org/a.json'],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([{ url: 'https://blossom.example.org/a.json' }])
  })

  it('skips an unusable url entry for the first valid one — the parse-time reading of IM-3', () => {
    const e = ev({
      tags: [[IMETA_TAG, 'url javascript:alert(1)', 'url https://cdn.example.org/a.json']],
    })
    expect(imetaArtifacts(e)).toEqual([{ url: 'https://cdn.example.org/a.json' }])
  })

  it('lets the first occurrence claim each other key (m/x/size/alt)', () => {
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'url https://blossom.example.org/a.json',
          'm application/pdf',
          'm text/plain',
          'alt first label',
          'alt second label',
        ],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([
      { url: 'https://blossom.example.org/a.json', mime: 'application/pdf', alt: 'first label' },
    ])
  })

  it('case-folds entry keys but preserves values verbatim', () => {
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'URL https://blossom.example.org/Case-Sensitive.pdf',
          'M application/pdf',
          'X D54BBDE34984620CF5C42FF42F1DA196C683D4053B4082429AD84BD5DA2FE415',
          'SIZE 705',
          'ALT Report',
        ],
      ],
    })
    expect(imetaArtifacts(e)).toEqual([
      {
        url: 'https://blossom.example.org/Case-Sensitive.pdf',
        mime: 'application/pdf',
        sha256: 'd54bbde34984620cf5c42ff42f1da196c683d4053b4082429ad84bd5da2fe415',
        size: '705',
        alt: 'Report',
      },
    ])
  })

  it('omits an x that is not exactly 64 hex, keeping the rest of the tag', () => {
    for (const x of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      const e = ev({
        tags: [
          [IMETA_TAG, 'url https://blossom.example.org/a.json', 'm application/pdf', `x ${x}`],
        ],
      })
      expect(imetaArtifacts(e), x).toEqual([
        { url: 'https://blossom.example.org/a.json', mime: 'application/pdf' },
      ])
    }
  })

  it('keeps size as decimal text — leading zeros and beyond-2^53 values survive losslessly', () => {
    for (const size of ['0705', '9007199254740993']) {
      const e = ev({
        tags: [[IMETA_TAG, 'url https://blossom.example.org/a.json', `size ${size}`]],
      })
      expect(imetaArtifacts(e), size).toEqual([{ url: 'https://blossom.example.org/a.json', size }])
    }
  })

  it('omits non-decimal size values rather than coercing them', () => {
    for (const size of ['-1', '12.5', '1e6', '']) {
      const e = ev({
        tags: [[IMETA_TAG, 'url https://blossom.example.org/a.json', `size ${size}`]],
      })
      expect(imetaArtifacts(e), size).toEqual([{ url: 'https://blossom.example.org/a.json' }])
    }
  })

  it('keeps alt verbatim with no length guard — display-length policy is consumer-side (#79)', () => {
    const e = ev({
      tags: [[IMETA_TAG, 'url https://blossom.example.org/a.json', `alt ${'r'.repeat(61)}`]],
    })
    expect(imetaArtifacts(e)).toEqual([
      { url: 'https://blossom.example.org/a.json', alt: 'r'.repeat(61) },
    ])
  })

  it('treats an empty-string value as absent — it neither emits nor claims its key', () => {
    const e = ev({
      tags: [[IMETA_TAG, 'url https://blossom.example.org/a.json', 'alt ', 'm ', 'alt report.pdf']],
    })
    expect(imetaArtifacts(e)).toEqual([
      { url: 'https://blossom.example.org/a.json', alt: 'report.pdf' },
    ])
  })

  it('ignores the NIP-94 fields this parse tier does not name (dim/blurhash/thumb/image/summary/ox/magnet/i/fallback/service)', () => {
    const e = ev({
      tags: [
        [
          IMETA_TAG,
          'url https://blossom.example.org/a.torrent',
          'ox b2d94e9d21b12ff1e06851d6b8edc607bb6f231bf1cd4bd7eff611a4c0b58a87',
          'dim 3024x4032',
          'blurhash eVF$^OI:${M{o#*0-nNFxakD-?xVM}WEWB%iNKxvR-oetmo#R-aen$',
          'magnet magnet:?xt=urn:btih:b2d94e9d21b12ff1e06851d6b8edc607bb6f231b',
          'i b2d94e9d21b12ff1e06851d6b8edc607bb6f231b',
          'thumb https://blossom.example.org/thumb.jpg',
          'image https://blossom.example.org/image.jpg',
          'summary A file summary',
          'fallback https://cdn.example.org/a.torrent',
          'service nip96',
        ],
      ],
    })
    // Notably `ox` is well-formed 64-hex and must not surface as sha256.
    expect(imetaArtifacts(e)).toEqual([{ url: 'https://blossom.example.org/a.torrent' }])
  })

  it('returns [] with no imeta tags, a bare imeta tag, or a differently-cased tag name', () => {
    expect(imetaArtifacts(ev())).toEqual([])
    expect(imetaArtifacts(ev({ tags: [[IMETA_TAG]] }))).toEqual([])
    // Tag names match exactly (TAG-4) — an 'Imeta'-named tag is a different, unknown tag (TAG-5).
    expect(
      imetaArtifacts(ev({ tags: [['Imeta', 'url https://blossom.example.org/a.json']] })),
    ).toEqual([])
  })

  it('never throws, and every emitted ref satisfies the stated grammars (property)', () => {
    const entry = fc.oneof(
      fc
        .tuple(
          fc.constantFrom('url', 'URL', 'm', 'x', 'X', 'size', 'alt', 'dim', 'fallback', ''),
          fc.string(),
        )
        .map(([k, v]) => `${k} ${v}`),
      fc.string(),
    )
    const tags = fc.array(fc.array(entry).map((entries) => [IMETA_TAG, ...entries]))
    fc.assert(
      fc.property(tags, (ts) => {
        const refs = imetaArtifacts(ev({ tags: ts }))
        expect(refs.length).toBeLessThanOrEqual(ts.length)
        for (const ref of refs) {
          // The url gate is checked against the emitted string itself, not the input decision:
          // a consumer can always parse it as http(s) with a non-empty hostname.
          const parsed = new URL(ref.url)
          expect(['http:', 'https:']).toContain(parsed.protocol)
          expect(parsed.hostname).not.toBe('')
          if (ref.sha256 !== undefined) expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)
          if (ref.size !== undefined) expect(ref.size).toMatch(/^\d+$/)
          if (ref.alt !== undefined) expect(ref.alt).not.toBe('')
        }
      }),
    )
  })
})
