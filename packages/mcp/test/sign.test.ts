/**
 * Dev-key signer: core-assisted NIP-01 id, BIP-340 signature, and the relay freshness gate.
 *
 * The key is the fixed `01…01` scalar the A1 identity tests already use, so a wrong derivation
 * shows up as a changed pubkey rather than as an unexplained signature failure in another test.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  type NostrEvent,
  type Sha256Hex,
  type UnsignedEvent,
  computeEventId,
  eventIdMatches,
} from '@scrutiny-fabric/core'
import { describe, expect, it } from 'vitest'
import {
  CreatedAtWindowError,
  RELAY_MAX_FUTURE_AGE_SECONDS,
  RELAY_MAX_PAST_AGE_SECONDS,
  assertCreatedAtWithinRelayWindow,
  createDevKeySigner,
  isSignedEvent,
  nextCreatedAt,
  verifySignedEvent,
} from '../src/identity/sign.ts'

const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
/** Close enough for the guard below; the boundary cases pass an explicit `now` instead. */
const NOW = Math.floor(Date.now() / 1000)

const sha256Hex: Sha256Hex = (serialized) => bytesToHex(sha256(utf8ToBytes(serialized)))

function template(overrides: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    kind: 1,
    created_at: NOW,
    tags: [['t', 'scrutiny-fabric']],
    content: 'Signed by the dev-key backend',
    ...overrides,
  }
}

describe('createDevKeySigner', () => {
  it('derives the BIP-340 x-only pubkey', () => {
    expect(createDevKeySigner(hexToBytes(HEX_KEY)).publicKey).toBe(HEX_PUBKEY)
  })

  it('rejects a scalar that is not a valid secret key', () => {
    expect(() => createDevKeySigner(new Uint8Array(32))).toThrow(/not a valid secp256k1 secret/u)
  })

  it('rejects the wrong secret-key length', () => {
    expect(() => createDevKeySigner(new Uint8Array(31))).toThrow(/32 secret-key bytes/u)
  })

  it('fills id/pubkey/sig and the id recomputes from the signed event', () => {
    const signer = createDevKeySigner(hexToBytes(HEX_KEY))
    const event = signer.sign(template())
    expect(event.pubkey).toBe(HEX_PUBKEY)
    expect(event.id).toMatch(/^[0-9a-f]{64}$/u)
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/u)
    expect(computeEventId(event, sha256Hex)).toBe(event.id)
    expect(eventIdMatches(event, sha256Hex)).toBe(true)
    expect(
      schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(HEX_PUBKEY)),
    ).toBe(true)
    expect(verifySignedEvent(event)).toBe(true)
  })

  it('refuses to sign a template outside the relay freshness window', () => {
    const signer = createDevKeySigner(hexToBytes(HEX_KEY))
    const now = Math.floor(Date.now() / 1000)
    expect(() =>
      signer.sign(template({ created_at: now + RELAY_MAX_FUTURE_AGE_SECONDS + 1 })),
    ).toThrow(CreatedAtWindowError)
    expect(() =>
      signer.sign(template({ created_at: now - RELAY_MAX_PAST_AGE_SECONDS - 1 })),
    ).toThrow(CreatedAtWindowError)
  })
})

describe('verifySignedEvent', () => {
  const signer = createDevKeySigner(hexToBytes(HEX_KEY))
  const signed = signer.sign(template())

  it('accepts the untouched event', () => {
    expect(verifySignedEvent(signed)).toBe(true)
  })

  it('rejects every single-field tamper', () => {
    const cases: readonly (readonly [string, NostrEvent])[] = [
      ['content', { ...signed, content: `${signed.content} (edited)` }],
      ['tags', { ...signed, tags: [['t', 'edited']] }],
      ['created_at', { ...signed, created_at: signed.created_at + 1 }],
      ['kind', { ...signed, kind: 2 }],
      ['id', { ...signed, id: 'ab'.repeat(32) }],
      ['sig', { ...signed, sig: 'cd'.repeat(64) }],
      ['pubkey', { ...signed, pubkey: 'ef'.repeat(32) }],
    ]
    for (const [field, tampered] of cases) {
      expect(verifySignedEvent(tampered), field).toBe(false)
    }
  })

  it('rejects non-event values without throwing', () => {
    expect(verifySignedEvent(undefined)).toBe(false)
    expect(verifySignedEvent('an event')).toBe(false)
    expect(verifySignedEvent({ ...signed, tags: [['p', 42]] })).toBe(false)
    expect(isSignedEvent(null)).toBe(false)
  })
})

describe('relay freshness window', () => {
  it('accepts both inclusive bounds', () => {
    expect(() =>
      assertCreatedAtWithinRelayWindow(NOW - RELAY_MAX_PAST_AGE_SECONDS, NOW),
    ).not.toThrow()
    expect(() =>
      assertCreatedAtWithinRelayWindow(NOW + RELAY_MAX_FUTURE_AGE_SECONDS, NOW),
    ).not.toThrow()
  })

  it('names the measured future offset', () => {
    try {
      assertCreatedAtWithinRelayWindow(NOW + RELAY_MAX_FUTURE_AGE_SECONDS + 1, NOW)
      expect.unreachable('a too-future created_at must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CreatedAtWindowError)
      expect((error as CreatedAtWindowError).offsetSeconds).toBe(RELAY_MAX_FUTURE_AGE_SECONDS + 1)
      expect((error as Error).message).toContain(`${RELAY_MAX_FUTURE_AGE_SECONDS + 1} s ahead`)
      expect((error as Error).message).toContain('maxFutureAge')
    }
  })

  it('names the measured past offset', () => {
    try {
      assertCreatedAtWithinRelayWindow(NOW - RELAY_MAX_PAST_AGE_SECONDS - 1, NOW)
      expect.unreachable('a too-old created_at must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CreatedAtWindowError)
      expect((error as CreatedAtWindowError).offsetSeconds).toBe(-RELAY_MAX_PAST_AGE_SECONDS - 1)
      expect((error as Error).message).toContain(`${RELAY_MAX_PAST_AGE_SECONDS + 1} s behind`)
      expect((error as Error).message).toContain('SCRUTINY_MAX_EVENT_PAST_AGE')
    }
  })

  it('rejects non-integer timestamps', () => {
    expect(() => assertCreatedAtWithinRelayWindow(Number.NaN, NOW)).toThrow(/non-negative integer/u)
    expect(() => assertCreatedAtWithinRelayWindow(NOW + 0.5, NOW)).toThrow(/non-negative integer/u)
  })
})

describe('nextCreatedAt', () => {
  it('uses now when there is no previous event', () => {
    expect(nextCreatedAt(undefined, NOW)).toBe(NOW)
  })

  it('advances monotonically within the same second', () => {
    expect(nextCreatedAt(NOW, NOW)).toBe(NOW + 1)
    expect(nextCreatedAt(NOW - 5, NOW)).toBe(NOW)
  })

  it('fails before a batch crosses the future limit', () => {
    expect(() => nextCreatedAt(NOW + RELAY_MAX_FUTURE_AGE_SECONDS, NOW)).toThrow(/ahead|future/iu)
  })
})
