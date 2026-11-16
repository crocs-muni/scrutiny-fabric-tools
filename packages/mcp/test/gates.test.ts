import { describe, expect, it } from 'vitest'
import {
  MAX_EVENT_BYTES,
  oversizedTagValues,
  signedSize,
  suggestPrefix,
} from '../src/preflight/gates.js'

describe('RL-1 measurement', () => {
  it('counts tag values in UTF-8 bytes, not UTF-16 units', () => {
    // `é` is 2 bytes: 512 of them are 1024 bytes and pass; 513 are 1026 bytes and fail.
    const event = (n: number) => ({ kind: 1, content: '', tags: [['i', `${'é'.repeat(n)}`]] })
    expect(oversizedTagValues(event(512))).toStrictEqual([])
    expect(oversizedTagValues(event(513))).toStrictEqual([0])
  })

  it('measures a ref placeholder at event-id width', () => {
    const tags = [['e', '@ref:product:a', '', 'root', '']]
    const withId = [['e', 'f'.repeat(64), '', 'root', '']]
    expect(signedSize({ kind: 1, content: '', tags })).toBe(
      signedSize({ kind: 1, content: '', tags: withId }),
    )
  })

  it('matches the size of a real signed event: JSON of id, pubkey, created_at, kind, tags, content, sig', () => {
    const content = 'x'.repeat(100)
    const signed = JSON.stringify({
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1_800_000_000,
      kind: 1,
      tags: [['t', 'scrutiny-fabric']],
      content,
      sig: 'c'.repeat(128),
    })
    expect(signedSize({ kind: 1, content, tags: [['t', 'scrutiny-fabric']] })).toBe(signed.length)
  })

  it('sits exactly on the 65 536-byte boundary', () => {
    const base = signedSize({ kind: 1, content: '', tags: [] })
    const at = (n: number) => signedSize({ kind: 1, content: 'x'.repeat(n), tags: [] })
    expect(at(MAX_EVENT_BYTES - base)).toBe(MAX_EVENT_BYTES)
  })
})

describe('suggestPrefix', () => {
  it('suggests the single nearest known prefix within distance 2', () => {
    expect(suggestPrefix('tst')).toBe('test')
    expect(suggestPrefix('vendr')).toBe('vendor')
    expect(suggestPrefix('zzzzzz')).toBeUndefined()
  })
})
