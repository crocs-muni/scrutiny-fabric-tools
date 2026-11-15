/**
 * The official NIP-44 v2 vector file, byte-exact.
 *
 * Source: https://github.com/paulmillr/nip44/blob/main/nip44.vectors.json (linked from NIP-44),
 * vendored under `test/fixtures/` so CI needs no network. Both directions run for every vector:
 * `encrypt` output must equal the recorded payload, and `decrypt` must return the recorded
 * plaintext or throw for the invalid corpus. NIP-46's whole transport confidentiality rests on
 * this module, so "close enough" is not a passing state.
 */

import { readFileSync } from 'node:fs'
import { concatBytes } from '@noble/ciphers/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import {
  calcPaddedLen,
  decrypt,
  deriveMessageKeys,
  encrypt,
  getConversationKey,
} from '../src/identity/nip44.ts'

interface ConversationKeyVector {
  readonly sec1: string
  readonly pub2: string
  readonly conversation_key: string
}

interface MessageKeyVector {
  readonly nonce: string
  readonly chacha_key: string
  readonly chacha_nonce: string
  readonly hmac_key: string
}

interface EncryptDecryptVector {
  readonly sec1: string
  readonly sec2: string
  readonly conversation_key: string
  readonly nonce: string
  readonly plaintext: string
  readonly payload: string
}

interface LongMessageVector {
  readonly conversation_key: string
  readonly nonce: string
  readonly pattern: string
  readonly repeat: number
  readonly plaintext_sha256: string
  readonly payload_sha256: string
}

interface Vectors {
  readonly v2: {
    readonly valid: {
      readonly get_conversation_key: readonly ConversationKeyVector[]
      readonly get_message_keys: {
        readonly conversation_key: string
        readonly keys: readonly MessageKeyVector[]
      }
      readonly calc_padded_len: readonly (readonly [number, number])[]
      readonly encrypt_decrypt: readonly EncryptDecryptVector[]
      readonly encrypt_decrypt_long_msg: readonly LongMessageVector[]
    }
    readonly invalid: {
      readonly get_conversation_key: readonly ConversationKeyVector[]
      readonly encrypt_msg_lengths: readonly number[]
      readonly decrypt: readonly { readonly conversation_key: string; readonly payload: string }[]
    }
  }
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL('./fixtures/nip44.vectors.json', import.meta.url), 'utf8'),
) as Vectors

/** The vector file's `sec2` in `encrypt_decrypt` is a secret key; ECDH needs its pubkey. */
function pubkeyOf(secretHex: string): Uint8Array {
  return schnorr.getPublicKey(hexToBytes(secretHex))
}

function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

describe('NIP-44 v2 vectors: get_conversation_key', () => {
  it('matches every valid (sec1, pub2) pair', () => {
    for (const vector of vectors.v2.valid.get_conversation_key) {
      const key = getConversationKey(hexToBytes(vector.sec1), hexToBytes(vector.pub2))
      expect(bytesToHex(key), vector.sec1).toBe(vector.conversation_key)
    }
  })

  it('derives the same conversation key from either side of a pair', () => {
    // The first two encrypt_decrypt vectors are the same keypair with sec1/sec2 swapped, so they
    // prove the local-secret/remote-pubkey direction is symmetric (NIP-44: conv(a,B) == conv(b,A)).
    const [first, second] = vectors.v2.valid.encrypt_decrypt
    if (first === undefined || second === undefined) throw new Error('vectors missing a pair')
    expect([second.sec1, second.sec2]).toStrictEqual([first.sec2, first.sec1])

    const keyAB = getConversationKey(hexToBytes(first.sec1), pubkeyOf(first.sec2))
    const keyBA = getConversationKey(hexToBytes(second.sec1), pubkeyOf(second.sec2))
    expect(bytesToHex(keyAB)).toBe(first.conversation_key)
    expect(bytesToHex(keyBA)).toBe(first.conversation_key)
  })

  it('throws for every invalid pair', () => {
    for (const vector of vectors.v2.invalid.get_conversation_key) {
      expect(
        () => getConversationKey(hexToBytes(vector.sec1), hexToBytes(vector.pub2)),
        vector.sec1,
      ).toThrow()
    }
  })
})

describe('NIP-44 v2 vectors: get_message_keys', () => {
  it('splits the 76-byte HKDF output exactly', () => {
    const { conversation_key: conversationKey, keys } = vectors.v2.valid.get_message_keys
    for (const vector of keys) {
      const derived = deriveMessageKeys(hexToBytes(conversationKey), hexToBytes(vector.nonce))
      expect(bytesToHex(derived.chachaKey), vector.nonce).toBe(vector.chacha_key)
      expect(bytesToHex(derived.chachaNonce), vector.nonce).toBe(vector.chacha_nonce)
      expect(bytesToHex(derived.hmacKey), vector.nonce).toBe(vector.hmac_key)
    }
  })
})

describe('NIP-44 v2 vectors: calc_padded_len', () => {
  it('matches every recorded input/output pair', () => {
    for (const [input, expected] of vectors.v2.valid.calc_padded_len) {
      expect(calcPaddedLen(input), `calcPaddedLen(${input})`).toBe(expected)
    }
  })
})

describe('NIP-44 v2 vectors: encrypt_decrypt', () => {
  it('produces the recorded payload and decrypts back to the plaintext', () => {
    for (const vector of vectors.v2.valid.encrypt_decrypt) {
      const conversationKey = getConversationKey(hexToBytes(vector.sec1), pubkeyOf(vector.sec2))
      expect(bytesToHex(conversationKey), vector.plaintext).toBe(vector.conversation_key)

      const payload = encrypt(vector.plaintext, conversationKey, hexToBytes(vector.nonce))
      expect(payload, vector.plaintext).toBe(vector.payload)
      expect(decrypt(payload, conversationKey), vector.plaintext).toBe(vector.plaintext)
    }
  })
})

describe('NIP-44 v2 vectors: encrypt_decrypt_long_msg', () => {
  it('hashes both sides of the 65,535-byte boundary messages', () => {
    for (const vector of vectors.v2.valid.encrypt_decrypt_long_msg) {
      const plaintext = vector.pattern.repeat(vector.repeat)
      const plaintextBytes = utf8ToBytes(plaintext)
      expect(sha256Hex(plaintextBytes), vector.pattern).toBe(vector.plaintext_sha256)

      const conversationKey = hexToBytes(vector.conversation_key)
      const payload = encrypt(plaintext, conversationKey, hexToBytes(vector.nonce))
      expect(sha256Hex(utf8ToBytes(payload)), vector.pattern).toBe(vector.payload_sha256)
      expect(decrypt(payload, conversationKey), vector.pattern).toBe(plaintext)
    }
  })
})

describe('NIP-44 v2 invalid corpus', () => {
  it('rejects unpaddable plaintext lengths', () => {
    const conversationKey = getConversationKey(
      hexToBytes('01'.repeat(32)),
      schnorr.getPublicKey(hexToBytes('02'.repeat(32))),
    )
    for (const length of vectors.v2.invalid.encrypt_msg_lengths) {
      expect(() => encrypt('a'.repeat(length), conversationKey), `length ${length}`).toThrow()
    }
  })

  it('rejects every invalid payload', () => {
    for (const vector of vectors.v2.invalid.decrypt) {
      expect(
        () => decrypt(vector.payload, hexToBytes(vector.conversation_key)),
        vector.payload.slice(0, 24),
      ).toThrow()
    }
  })

  it('rejects a MAC computed without the nonce as AAD', () => {
    // NIP-44's AAD is the 32-byte nonce, not a topic string. Recompute the MAC over the
    // ciphertext alone and prove decrypt notices (constant-time mismatch on AAD || ciphertext).
    const vector = vectors.v2.valid.encrypt_decrypt[0]
    if (vector === undefined) throw new Error('vectors missing a sample')
    const conversationKey = hexToBytes(vector.conversation_key)
    const nonce = hexToBytes(vector.nonce)
    const raw = base64.decode(encrypt(vector.plaintext, conversationKey, nonce))
    const ciphertext = raw.subarray(33, raw.length - 32)
    const { hmacKey } = deriveMessageKeys(conversationKey, nonce)
    const macWithoutAad = hmac(sha256, hmacKey, ciphertext)
    const tampered = base64.encode(concatBytes(raw.subarray(0, raw.length - 32), macWithoutAad))
    expect(() => decrypt(tampered, conversationKey)).toThrow(/invalid MAC/u)
  })

  it('enforces the 1 MiB decrypt cap at the boundary', () => {
    const key = new Uint8Array(32)
    expect(() => decrypt('A'.repeat(1_000_001), key)).toThrow(/exceeds/u)
    // At exactly the cap the local ceiling must not be the rejection reason; the payload is still
    // garbage and fails as an unknown version instead.
    expect(() => decrypt('A'.repeat(1_000_000), key)).not.toThrow(/exceeds/u)
  })
})
