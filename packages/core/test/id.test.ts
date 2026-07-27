import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Sha256Hex, computeEventId, eventIdMatches, serializeForId } from '../src/id.js'
import { ev } from './_fixtures.js'

// A real SHA-256, wired the way a consumer wires one. core itself never imports this — the whole
// point of D12/D14 is that the hash arrives as a parameter.
const sha256: Sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('serializeForId', () => {
  it('produces the NIP-01 canonical array with no whitespace', () => {
    const e = ev({
      pubkey: 'ab'.repeat(32),
      created_at: 1714000000,
      kind: 1,
      tags: [['t', 'scrutiny-fabric']],
      content: 'hello',
    })
    expect(serializeForId(e)).toBe(
      `[0,"${'ab'.repeat(32)}",1714000000,1,[["t","scrutiny-fabric"]],"hello"]`,
    )
  })

  it('applies NIP-01 escaping and leaves other characters verbatim', () => {
    // NIP-01's rule exists to defeat encoder-specific escaping: Go HTML-escapes by default and
    // .NET escapes non-ASCII. JSON.stringify does neither, which is why R11 retracted the
    // "write a custom serializer" conclusion twice.
    const e = ev({ content: 'quote " backslash \\ newline \n tab \t em—dash <html> & ünïcode' })
    const serialized = serializeForId(e)
    expect(serialized).toContain('\\"')
    expect(serialized).toContain('\\\\')
    expect(serialized).toContain('\\n')
    expect(serialized).toContain('\\t')
    expect(serialized).toContain('em—dash')
    expect(serialized).toContain('<html>')
    expect(serialized).toContain('ünïcode')
    expect(serialized).not.toContain('\\u003c')
    expect(serialized).not.toContain('\\u00fc')
  })

  it('ignores the declared id, pubkey excepted, and only serialises the six signed fields', () => {
    const base = ev({ content: 'x' })
    expect(serializeForId({ ...base, id: 'f'.repeat(64) })).toBe(serializeForId(base))
    expect(serializeForId({ ...base, sig: '9'.repeat(128) })).toBe(serializeForId(base))
  })
})

describe('eventIdMatches (SIG-1, recompute half)', () => {
  it('accepts an event whose id is the hash of its own contents', () => {
    const base = ev({ content: 'authentic' })
    const signed = { ...base, id: computeEventId(base, sha256) }
    expect(eventIdMatches(signed, sha256)).toBe(true)
  })

  it('detects content altered while the original id and sig are retained', () => {
    // This is the attack SIG-1 exists for. The signature commits to the id, which is a hash, so a
    // relay can rewrite content and a signature-only check still passes. Only the recompute
    // catches it.
    const base = ev({ content: 'authentic' })
    const signed = { ...base, id: computeEventId(base, sha256) }
    const tampered = { ...signed, content: 'substituted by a relay' }

    expect(eventIdMatches(signed, sha256)).toBe(true)
    expect(eventIdMatches(tampered, sha256)).toBe(false)
  })

  it('detects altered tags just as it detects altered content', () => {
    const base = ev({ tags: [['t', 'scrutiny-fabric']] })
    const signed = { ...base, id: computeEventId(base, sha256) }
    const tampered = {
      ...signed,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['e', 'injected'],
      ],
    }
    expect(eventIdMatches(tampered, sha256)).toBe(false)
  })

  it('compares hex case-insensitively', () => {
    const base = ev({ content: 'x' })
    const id = computeEventId(base, sha256)
    expect(eventIdMatches({ ...base, id: id.toUpperCase() }, sha256)).toBe(true)
  })

  it('never receives a secret key — the injected function takes only the serialization', () => {
    const calls: string[] = []
    const spy: Sha256Hex = (s) => {
      calls.push(s)
      return sha256(s)
    }
    const e = ev({ content: 'x' })
    computeEventId(e, spy)
    expect(calls).toEqual([serializeForId(e)])
  })
})
