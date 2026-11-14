/**
 * NIP-44 v2 — the versioned encrypted payload NIP-46 rides on (#108 A2).
 *
 * Hand-rolled from the spec rather than pulled from `nostr-tools`, matching the repository's
 * `@noble`-only precedent (D6/D12): `@noble/curves` for secp256k1 ECDH, `@noble/hashes` for
 * HKDF/HMAC/SHA-256, `@noble/ciphers` for ChaCha20, `@scure/base` for base64. `test/nip44.test.ts`
 * runs the official `paulmillr/nip44` vector file vendored under `test/fixtures/`, byte-exact,
 * including the invalid-payload corpus — this module is not "roughly NIP-44".
 *
 * The one deliberate ceiling: encryption accepts at most 65,535 plaintext bytes. NIP-46 requests
 * are a few hundred bytes, and the official vectors' `invalid.encrypt_msg_lengths` still lists
 * 65,536 as invalid. The current spec text defines a 6-byte extended length prefix for larger
 * messages, so {@link decrypt} accepts that form (a newer peer stays readable) even though this
 * signer never emits one.
 */

import { chacha20 } from '@noble/ciphers/chacha.js'
import { concatBytes, equalBytes, randomBytes } from '@noble/ciphers/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { base64 } from '@scure/base'

const VERSION = 2
/** Base64 chars: 1 version byte + 32 nonce + 32 mac = 65 bytes asked of the decoder minimum. */
const MIN_PAYLOAD_CHARS = 132
/** 99 bytes = 65 metadata + 34 smallest padded body (2-byte prefix + 32 bytes). */
const MIN_PAYLOAD_BYTES = 99
const EXTENDED_PREFIX_THRESHOLD = 65_536
const MAX_ENCRYPT_PLAINTEXT_BYTES = 65_535
/**
 * Decrypt-side DoS ceiling, checked before base64 allocates. NIP-44 only defines a theoretical
 * 4 GiB maximum and asks implementations to pick their own; 1 MB is far above any NIP-46 request
 * and keeps a hostile relay frame from turning into a large allocation.
 */
const MAX_PAYLOAD_CHARS = 1_000_000
const CONVERSATION_KEY_SALT = utf8ToBytes('nip44-v2')
const NONCE_BYTES = 32
const CONVERSATION_KEY_BYTES = 32

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function assertBytes(value: Uint8Array, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new Error(`NIP-44: ${label} must be ${expected} bytes, got ${value.length}`)
  }
}

/**
 * `conversation_key = hkdf_extract(sha256, ECDH_x(local_secret, remote_pub), salt="nip44-v2")`.
 *
 * **Direction:** the first argument is the *local* secret key, the second the *peer's* x-only
 * pubkey. NIP-44's ECDH is symmetric, so `conv(a, B) == conv(b, A)`; the official vectors pin both
 * orderings and `test/nip44.test.ts:conversation key` asserts the equality explicitly. Both
 * reference implementations (`nostr-tools.getConversationKey(sec, pub)`, nak's
 * `computeConversationKey(sec, remote)`) have this shape.
 *
 * The ECDH output is the raw x coordinate of the shared point — not hashed, and not the compressed
 * point encoding (NIP-44 warns that some libraries hash it). BIP-340 pubkeys are x-only, so the
 * even-y compressed form `0x02 || pubkey` is the point NIP-44 means.
 */
export function getConversationKey(
  localSecretKey: Uint8Array,
  remotePubkey: Uint8Array,
): Uint8Array {
  assertBytes(localSecretKey, 32, 'local secret key')
  assertBytes(remotePubkey, CONVERSATION_KEY_BYTES, 'remote public key')
  const compressed = new Uint8Array(33)
  compressed[0] = 0x02
  compressed.set(remotePubkey, 1)
  const shared = secp256k1.getSharedSecret(localSecretKey, compressed, false)
  if (shared.length !== 65) {
    throw new Error(`NIP-44: unexpected ECDH output length ${shared.length}, expected 65`)
  }
  return extract(sha256, shared.subarray(1, 33), CONVERSATION_KEY_SALT)
}

/** The 76 bytes HKDF-expand yields per message; split exactly as the spec slices them. */
export interface MessageKeys {
  readonly chachaKey: Uint8Array
  readonly chachaNonce: Uint8Array
  readonly hmacKey: Uint8Array
}

/** `hkdf_expand(PRK=conversation_key, info=nonce, L=76)`, sliced 32/12/32. */
export function deriveMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array): MessageKeys {
  assertBytes(conversationKey, CONVERSATION_KEY_BYTES, 'conversation key')
  assertBytes(nonce, NONCE_BYTES, 'nonce')
  const keys = expand(sha256, conversationKey, nonce, 76)
  return {
    chachaKey: keys.slice(0, 32),
    chachaNonce: keys.slice(32, 44),
    hmacKey: keys.slice(44, 76),
  }
}

/**
 * The power-of-two padding length, including the spec's future extended sizes. Split out because
 * the official vectors pin it directly, including `65536`.
 */
export function calcPaddedLen(unpaddedLen: number): number {
  if (!Number.isSafeInteger(unpaddedLen) || unpaddedLen < 1) {
    throw new Error(`NIP-44: invalid plaintext length ${unpaddedLen}`)
  }
  if (unpaddedLen <= 32) return 32
  // `Math.log2`, not `<<`: the shift operator truncates at 32 bits and the spec's own extended
  // range reaches 2^32.
  const nextPower = 2 ** (Math.floor(Math.log2(unpaddedLen - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1)
}

function pad(unpadded: Uint8Array): Uint8Array {
  const len = unpadded.length
  if (len < 1 || len > MAX_ENCRYPT_PLAINTEXT_BYTES) {
    throw new Error(
      `NIP-44: plaintext length ${len} outside 1..${MAX_ENCRYPT_PLAINTEXT_BYTES} bytes (official vectors reject 65536+; NIP-46 requests are far below this)`,
    )
  }
  const padded = new Uint8Array(2 + calcPaddedLen(len))
  padded[0] = (len >>> 8) & 0xff
  padded[1] = len & 0xff
  padded.set(unpadded, 2)
  return padded
}

function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 2) throw new Error('NIP-44: padded plaintext shorter than its prefix')
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
  const firstTwo = view.getUint16(0)
  let prefixBytes: number
  let len: number
  if (firstTwo === 0) {
    // Extended prefix: two zero bytes then a u32 length. Never emitted here, accepted so a peer
    // on the current spec text stays readable.
    if (padded.length < 6) throw new Error('NIP-44: truncated extended length prefix')
    len = view.getUint32(2)
    if (len < EXTENDED_PREFIX_THRESHOLD) {
      throw new Error('NIP-44: invalid padding — extended prefix below 65536 bytes')
    }
    prefixBytes = 6
  } else {
    len = firstTwo
    prefixBytes = 2
  }
  if (len < 1 || padded.length !== prefixBytes + calcPaddedLen(len)) {
    throw new Error('NIP-44: invalid padding — length does not match the padding scheme')
  }
  const plaintext = padded.subarray(prefixBytes, prefixBytes + len)
  const suffix = padded.subarray(prefixBytes + len)
  // Padding is zeros by definition; a non-zero byte is a covert channel, not a body.
  if (suffix.some((byte) => byte !== 0)) {
    throw new Error('NIP-44: invalid padding — non-zero byte in the padding suffix')
  }
  return plaintext
}

/**
 * NIP-44's AAD is the 32-byte per-message nonce: `mac = HMAC-SHA256(hmac_key, nonce || ciphertext)`
 * (NIP-44 §Encryption step 6 and `hmac_aad`). v2 defines no conversation-topic AAD; adding one
 * would change every official vector byte and break nak/nostr-tools interop. Routing both sides
 * through this helper makes "AAD omitted" impossible to express.
 */
function hmacWithAad(hmacKey: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (aad.length !== NONCE_BYTES) {
    throw new Error(`NIP-44: AAD must be the ${NONCE_BYTES}-byte nonce, got ${aad.length}`)
  }
  return hmac(sha256, hmacKey, concatBytes(aad, ciphertext))
}

/**
 * Encrypt `plaintext` for a conversation key. `nonce` is injectable so vector tests are exact; every
 * production call gets a fresh CSPRNG nonce, per the spec's one-nonce-per-message rule.
 */
export function encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): string {
  const padded = pad(utf8ToBytes(plaintext))
  const { chachaKey, chachaNonce, hmacKey } = deriveMessageKeys(conversationKey, nonce)
  const ciphertext = chacha20(chachaKey, chachaNonce, padded)
  const mac = hmacWithAad(hmacKey, nonce, ciphertext)
  return base64.encode(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac))
}

/** Decrypt a base64 NIP-44 v2 payload. MAC is checked before ChaCha20 runs (encrypt-then-MAC). */
export function decrypt(payload: string, conversationKey: Uint8Array): string {
  // Spec order: the `#` flag means "a future non-base64 encoding", which is a version problem
  // even when the payload is also too short to be v2.
  if (payload.startsWith('#')) {
    throw new Error('NIP-44: unknown encryption version — non-base64 payloads are unsupported')
  }
  if (payload.length < MIN_PAYLOAD_CHARS) {
    throw new Error(
      `NIP-44: invalid payload length ${payload.length}, minimum ${MIN_PAYLOAD_CHARS} characters`,
    )
  }
  if (payload.length > MAX_PAYLOAD_CHARS) {
    throw new Error(
      `NIP-44: payload of ${payload.length} characters exceeds this client's ${MAX_PAYLOAD_CHARS}-character cap`,
    )
  }

  const raw = base64.decode(payload)
  if (raw.length < MIN_PAYLOAD_BYTES) {
    throw new Error(
      `NIP-44: invalid decoded payload length ${raw.length}, minimum ${MIN_PAYLOAD_BYTES} bytes`,
    )
  }
  const version = raw[0]
  if (version !== VERSION) {
    throw new Error(`NIP-44: unknown encryption version ${version}, this client speaks v2`)
  }
  const nonce = raw.subarray(1, 33)
  const ciphertext = raw.subarray(33, raw.length - 32)
  const mac = raw.subarray(raw.length - 32)
  const { chachaKey, chachaNonce, hmacKey } = deriveMessageKeys(conversationKey, nonce)
  const expectedMac = hmacWithAad(hmacKey, nonce, ciphertext)
  if (!equalBytes(mac, expectedMac)) {
    throw new Error('NIP-44: invalid MAC — the payload was altered or encrypted for another key')
  }
  const padded = chacha20(chachaKey, chachaNonce, ciphertext)
  const plaintext = unpad(padded)
  try {
    return utf8Decoder.decode(plaintext)
  } catch {
    throw new Error('NIP-44: plaintext is not valid UTF-8')
  }
}
