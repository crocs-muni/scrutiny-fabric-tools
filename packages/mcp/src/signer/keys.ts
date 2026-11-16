/**
 * Key material: parsing what `import` accepts (hex, `nsec1…`, `ncryptsec1…`), the BIP-340 public
 * key, NIP-19 npub, and NIP-49 encryption for the `keygen` backup (spec §11.1).
 *
 * No error message or stack ever contains the input: an `nsec`/hex string IS the key, and
 * `@scure/base` names the input string in its own errors, so its exceptions are never rethrown.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { bech32 } from '@scure/base'

export type KeyErrorCode = 'key.invalid' | 'key.password'

/** A key-handling failure. The message describes the problem; it never quotes the input. */
export class KeyError extends Error {
  readonly code: KeyErrorCode
  constructor(code: KeyErrorCode, message: string) {
    super(message)
    this.name = 'KeyError'
    this.code = code
  }
}

const HEX64 = /^[0-9a-f]{64}$/u
/** Bech32 strings above the BIP-173 90-character default: ncryptsec is 162 characters. */
const BECH32_LIMIT = 200

function bech32Bytes(input: string, prefix: string): Uint8Array {
  try {
    const decoded = bech32.decode(input as `${string}1${string}`, BECH32_LIMIT)
    if (decoded.prefix !== prefix) throw new Error('prefix')
    return bech32.fromWords(decoded.words)
  } catch {
    throw new KeyError('key.invalid', `not a valid ${prefix}1… string (mistyped or truncated?)`)
  }
}

function assertSecret(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32 || !secp256k1.utils.isValidSecretKey(secret)) {
    throw new KeyError('key.invalid', 'not a valid secp256k1 secret key')
  }
  return secret
}

export type KeyInput =
  | { readonly kind: 'secret'; readonly secret: Uint8Array }
  | { readonly kind: 'encrypted'; readonly ncryptsec: string }

/** Parses hex (any case), `nsec1…` or `ncryptsec1…`. Surrounding whitespace is ignored. */
export function parseKeyInput(raw: string): KeyInput {
  const input = raw.trim()
  const lower = input.toLowerCase()
  if (HEX64.test(lower)) return { kind: 'secret', secret: assertSecret(hexToBytes(lower)) }
  if (lower.startsWith('nsec1'))
    return { kind: 'secret', secret: assertSecret(bech32Bytes(lower, 'nsec')) }
  if (lower.startsWith('ncryptsec1')) return { kind: 'encrypted', ncryptsec: lower }
  throw new KeyError(
    'key.invalid',
    'expected a 64-character hex key, an nsec1… or an ncryptsec1… key',
  )
}

/** BIP-340 x-only public key, lowercase hex. */
export function publicKeyHex(secret: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secret))
}

export function npubEncode(pubkeyHex: string): string {
  return bech32.encode('npub', bech32.toWords(hexToBytes(pubkeyHex)))
}

export function randomSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey()
}

// ---------------------------------------------------------------------------
// NIP-49
// ---------------------------------------------------------------------------

const NIP49_VERSION = 0x02
/** NIP-49 key-security byte: 0x02 = "the client does not track this". */
const KEY_SECURITY_UNTRACKED = 0x02

async function nip49Key(password: string, salt: Uint8Array, logN: number): Promise<Uint8Array> {
  return scryptAsync(utf8ToBytes(password.normalize('NFKC')), salt, {
    N: 2 ** logN,
    r: 8,
    p: 1,
    dkLen: 32,
    maxmem: 2 ** (logN + 11),
  })
}

/** NIP-49 encryption. `logN` 16 (64 MiB of scrypt memory) unless a test asks for less. */
export async function encryptNcryptsec(
  secret: Uint8Array,
  password: string,
  opts: { readonly logN?: number } = {},
): Promise<string> {
  const logN = opts.logN ?? 16
  const salt = randomBytes(16)
  const nonce = randomBytes(24)
  const aad = Uint8Array.of(KEY_SECURITY_UNTRACKED)
  const key = await nip49Key(password, salt, logN)
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(secret)
  key.fill(0)
  const payload = new Uint8Array([NIP49_VERSION, logN, ...salt, ...nonce, ...aad, ...ciphertext])
  return bech32.encode('ncryptsec', bech32.toWords(payload), BECH32_LIMIT)
}

export async function decryptNcryptsec(ncryptsec: string, password: string): Promise<Uint8Array> {
  const payload = bech32Bytes(ncryptsec.trim().toLowerCase(), 'ncryptsec')
  if (payload.length !== 91 || payload[0] !== NIP49_VERSION) {
    throw new KeyError('key.invalid', 'not a version-2 NIP-49 ncryptsec')
  }
  const logN = payload[1] ?? 0
  if (logN > 22) throw new KeyError('key.invalid', 'ncryptsec asks for an unreasonable scrypt cost')
  const salt = payload.slice(2, 18)
  const nonce = payload.slice(18, 42)
  const aad = payload.slice(42, 43)
  const ciphertext = payload.slice(43)
  const key = await nip49Key(password, salt, logN)
  try {
    return assertSecret(xchacha20poly1305(key, nonce, aad).decrypt(ciphertext))
  } catch (cause) {
    if (cause instanceof KeyError) throw cause
    throw new KeyError('key.password', 'wrong password for this ncryptsec')
  } finally {
    key.fill(0)
  }
}
