/**
 * Per-gate tests for the #108 preflight table: every refusal must name the schema field, the
 * problem and the fix, and a warning must never block the event.
 */

import { type UnsignedEvent, VERSION_TAG, buildProduct } from '@scrutiny-fabric/core'
import { describe, expect, it } from 'vitest'
import {
  KNOWN_INDEXER_PREFIXES,
  MIRROR_TAG_BUDGET,
  RELAY_TAG_CEILING,
  checkTable,
} from '../../src/preflight/checkTable.ts'

const NOW = 1_700_000_000

function product(indexers: readonly string[], content = 'Acme SE-1'): UnsignedEvent {
  return buildProduct(content, NOW, indexers).template
}

describe('gate 1 — accepted t tags (server-composed invariant)', () => {
  it('accepts a builder-composed event', () => {
    expect(checkTable(product(['cve:CVE-2020-1']), { now: NOW }).findings).toStrictEqual([])
  })

  it('refuses an event missing its version tag and says it is a server bug', () => {
    const broken: UnsignedEvent = {
      kind: 1,
      created_at: NOW,
      content: 'H',
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', 'scrutiny-product'],
      ],
    }
    const [finding] = checkTable(broken, { now: NOW }).findings
    expect(finding?.field).toBe('tags')
    expect(finding?.problem).toContain(VERSION_TAG)
    expect(finding?.fix).toContain('server bug')
  })

  it('refuses a kind 5 deletion without exactly one e tag', () => {
    const broken: UnsignedEvent = { kind: 5, created_at: NOW, content: 'gone', tags: [] }
    const [finding] = checkTable(broken, { now: NOW }).findings
    expect(finding?.field).toBe('target_id')
    expect(finding?.fix).toContain('server bug')
  })
})

describe('gate 2 — single-letter tag budget', () => {
  it(`refuses past the relay ceiling of ${RELAY_TAG_CEILING} and names the indexers to drop`, () => {
    const indexers = Array.from({ length: 64 }, (_, i) => `cve:CVE-2020-${1000 + i}`)
    const result = checkTable(product(indexers), { now: NOW })
    const [finding] = result.findings
    // i 64 + k 1 + t 3 = 68; excess = 4, so the last four indexers are the ones to drop.
    expect(finding?.field).toBe('indexers')
    expect(finding?.problem).toContain('68 single-letter tags')
    expect(finding?.problem).toContain('i 64 + k 1 + e 0 + t 3 + imeta 0')
    expect(finding?.fix).toContain('drop 4 indexers')
    expect(finding?.fix).toContain('"cve:CVE-2020-1060"')
    expect(finding?.fix).toContain('"cve:CVE-2020-1063"')
    expect(finding?.fix).toContain('IX-3')
  })

  it(`warns between the mirror budget (${MIRROR_TAG_BUDGET}) and the relay ceiling, without blocking`, () => {
    const indexers = Array.from({ length: 57 }, (_, i) => `cve:CVE-2020-${1000 + i}`)
    const result = checkTable(product(indexers), { now: NOW })
    expect(result.findings).toStrictEqual([])
    expect(result.warnings[0]).toContain('61 single-letter tags')
    expect(result.warnings[0]).toContain('mirror')
  })

  it('stays silent at or below the mirror budget', () => {
    const indexers = Array.from({ length: 56 }, (_, i) => `cve:CVE-2020-${1000 + i}`)
    expect(checkTable(product(indexers), { now: NOW }).warnings).toStrictEqual([])
  })
})

describe('gate 3 — RL-1 sizes', () => {
  it('refuses an event whose signed size passes 64 KiB and points at imeta', () => {
    const result = checkTable(product(['cve:CVE-2020-1'], 'x'.repeat(70_000)), { now: NOW })
    const finding = result.findings.find((item) => item.field === 'content')
    expect(finding).toBeDefined()
    expect(finding?.problem).toContain('65536')
    expect(finding?.problem).toContain('285 bytes')
    expect(finding?.fix).toContain('`imeta` attachment')
  })

  it('refuses a tag value over 1024 bytes and names the field', () => {
    const long = `cve:CVE-${'9'.repeat(1100)}`
    const result = checkTable(product([long]), { now: NOW })
    const finding = result.findings.find((item) => item.field === 'indexers')
    expect(finding?.problem).toContain('1024 bytes per tag value')
    expect(finding?.fix).toContain('canonical spelling')
  })
})

describe('gate 4 — clock window (reused signer guard)', () => {
  it('refuses a created_at three hours in the past with the measured offset', () => {
    const template: UnsignedEvent = { ...product(['cve:CVE-2020-1']), created_at: NOW - 3 * 3600 }
    const [finding] = checkTable(template, { now: NOW }).findings
    expect(finding?.field).toBe('created_at')
    expect(finding?.problem).toContain('10800 s behind')
    expect(finding?.fix).toContain('NTP')
  })

  it('refuses a created_at far in the future', () => {
    const template: UnsignedEvent = { ...product(['cve:CVE-2020-1']), created_at: NOW + 3600 }
    expect(checkTable(template, { now: NOW }).findings[0]?.problem).toContain('ahead')
  })
})

describe('gate 5 — i-prefix vocabulary (warnings only)', () => {
  it('recognizes every documented prefix', () => {
    const indexers = KNOWN_INDEXER_PREFIXES.map((prefix) => `${prefix}:value-1`)
    const result = checkTable(product(indexers), { now: NOW })
    expect(result.findings).toStrictEqual([])
    // 29 i + 29 k + 3 t crosses the mirror budget; what matters here is that no prefix is unknown.
    expect(result.warnings.filter((warning) => warning.includes('prefix'))).toStrictEqual([])
  })

  it('warns on an unknown but well-formed prefix and still allows the publish', () => {
    const result = checkTable(product(['acme-internal:OBJECT-1']), { now: NOW })
    expect(result.findings).toStrictEqual([])
    expect(result.warnings[0]).toContain('"acme-internal"')
    expect(result.warnings[0]).toContain('IR-4')
    expect(result.warnings[0]).toContain('#48')
  })

  it('warns on a malformed prefix and on a value without one', () => {
    const result = checkTable(product(['CVE:CVE-2020-1', 'no-prefix-value']), { now: NOW })
    expect(result.findings).toStrictEqual([])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('IR-1')
    expect(result.warnings[1]).toContain('`<prefix>:<value>`')
  })
})
