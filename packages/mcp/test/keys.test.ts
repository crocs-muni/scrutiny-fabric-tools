/**
 * Key vectors. Expected values come from outside the code under test: the NIP-49 spec vector, and
 * the fixed scalar/bech32 vectors the prototype audit kept (`test/sign.test.ts:48`,
 * `test/identity.test.ts:32`).
 */

import { hexToBytes } from '@noble/hashes/utils.js'
import { bech32 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import {
  KeyError,
  decryptNcryptsec,
  encryptNcryptsec,
  npubEncode,
  parseKeyInput,
  publicKeyHex,
} from '../src/signer/keys.js'

const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const NSEC_KEY = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'
const NSEC_PUBKEY = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'
/** NIP-49's published test vector: password `nostr`, log_n 16. */
const NIP49_VECTOR =
  'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'
const NIP49_SECRET = '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (cause) {
    if (cause instanceof KeyError) return cause.code
    throw cause
  }
  return 'no error'
}

function secretOf(input: string): Uint8Array {
  const parsed = parseKeyInput(input)
  if (parsed.kind !== 'secret') throw new Error('expected a plain secret')
  return parsed.secret
}

describe('parseKeyInput', () => {
  it('derives the BIP-340 x-only pubkey from hex, case-insensitive and trimmed', () => {
    expect(publicKeyHex(secretOf(HEX_KEY))).toBe(HEX_PUBKEY)
    expect(publicKeyHex(secretOf(` ${HEX_KEY.toUpperCase()}\n`))).toBe(HEX_PUBKEY)
  })

  it('derives the pubkey from an nsec1 key', () => {
    expect(publicKeyHex(secretOf(NSEC_KEY))).toBe(NSEC_PUBKEY)
  })

  it('recognises an ncryptsec without decrypting it', () => {
    expect(parseKeyInput(NIP49_VECTOR)).toStrictEqual({
      kind: 'encrypted',
      ncryptsec: NIP49_VECTOR,
    })
  })

  it('rejects a 64-hex value that is not a valid scalar', () => {
    expect(codeOf(() => parseKeyInput('00'.repeat(32)))).toBe('key.invalid')
    expect(
      codeOf(() =>
        parseKeyInput('ffffffffffffffffffffffffffffffffbaaedce6af48a03bbfd25e8cd0364141'),
      ),
    ).toBe('key.invalid')
  })

  it('rejects junk and an npub', () => {
    for (const input of ['', 'hello', 'ab'.repeat(31), npubEncode(HEX_PUBKEY)]) {
      expect(codeOf(() => parseKeyInput(input))).toBe('key.invalid')
    }
  })

  it('never echoes key material, even when the bech32 checksum fails', () => {
    const corrupted = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe0'
    for (const input of [corrupted, `${HEX_KEY}0`, `x${HEX_KEY.slice(1)}`]) {
      let message = ''
      try {
        parseKeyInput(input)
      } catch (cause) {
        message = String(cause instanceof Error ? `${cause.message} ${cause.stack}` : cause)
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(input.slice(0, 16))
    }
  })
})

describe('NIP-49 (ncryptsec)', () => {
  it('decrypts the NIP-49 spec vector', async () => {
    expect(Buffer.from(await decryptNcryptsec(NIP49_VECTOR, 'nostr')).toString('hex')).toBe(
      NIP49_SECRET,
    )
  }, 30_000)

  it('refuses a wrong password with key.password', async () => {
    await expect(decryptNcryptsec(NIP49_VECTOR, 'wrong')).rejects.toMatchObject({
      code: 'key.password',
    })
  }, 30_000)

  it('round-trips, and NFKC-normalises the password', async () => {
    const secret = hexToBytes(HEX_KEY)
    // U+212B ANGSTROM SIGN normalises (NFKC) to U+00C5.
    const encrypted = await encryptNcryptsec(secret, 'Å', { logN: 4 })
    expect(encrypted.startsWith('ncryptsec1')).toBe(true)
    expect(Buffer.from(await decryptNcryptsec(encrypted, 'Å')).toString('hex')).toBe(HEX_KEY)
  })

  it('uses log_n 16 and key-security byte 0x02 by default', async () => {
    const encrypted = await encryptNcryptsec(hexToBytes(HEX_KEY), 'pw')
    const bytes = bech32.fromWords(bech32.decode(encrypted as `${string}1${string}`, 200).words)
    expect(bytes[0]).toBe(0x02) // version
    expect(bytes[1]).toBe(16) // log_n
    expect(bytes[42]).toBe(0x02) // key security: not tracked
    expect(bytes).toHaveLength(91)
  }, 30_000)

  it('rejects a malformed ncryptsec with key.invalid', async () => {
    await expect(decryptNcryptsec('ncryptsec1qqqq', 'nostr')).rejects.toMatchObject({
      code: 'key.invalid',
    })
  })
})

describe('npubEncode', () => {
  it('encodes the NIP-19 npub of a hex pubkey', () => {
    // NIP-19 spec example.
    expect(npubEncode('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d')).toBe(
      'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
    )
  })
})
