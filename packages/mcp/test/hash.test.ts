import { describe, expect, it } from 'vitest'
import { canonicalJson, planHash } from '../src/plan/hash.js'

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    }
    const keys = Object.keys(JSON.parse(canonicalJson(input)) as object)
    // JSON.parse re-orders integer-like keys first, so compare the serialised order instead.
    expect(keys).toContain('1')
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    )
  })

  it('serialises numbers, literals and string escapes as RFC 8785 §3.2.2', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
    expect(() => canonicalJson({ a: undefined })).toThrow()
  })
})

describe('planHash', () => {
  it('is sha256 over the canonical bytes, stable across key order', () => {
    const a = { planVersion: 1, pubkey: null, relays: ['wss://r.example'], events: [], blobs: [] }
    const b = { blobs: [], events: [], relays: ['wss://r.example'], pubkey: null, planVersion: 1 }
    expect(planHash(a)).toBe(planHash(b))
    // Golden, computed with node:crypto over the hand-written canonical string. The approval binds
    // this value, so it must not drift between releases.
    expect(planHash(a)).toBe('860224a530c6668ae2ec0d23fc08eac06d90c51435696b7ca648077251f50105')
  })
})
