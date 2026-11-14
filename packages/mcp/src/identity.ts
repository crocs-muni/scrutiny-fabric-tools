/**
 * The signer port, as far as this scaffold needs it (D13 `ScrutinySigner`, deferred in `core`
 * until this server became its first consumer — #108).
 *
 * A stub on purpose: it answers "which backend will sign, and with which pubkey" and never
 * signs. A2 replaces the dev backend with a NIP-46 `BunkerSigner` behind the same port; key
 * material stays inside this module either way, because a `ScrutinySigner` the caller cannot read
 * is the whole custody argument (report §8.3).
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'
import type { DevKey, ServerConfig } from './config.ts'

export interface SignerStatus {
  /** Which backend A2 instantiates behind D13's `ScrutinySigner`. */
  readonly mode: 'nip46' | 'dev-key' | 'none'
  /** BIP-340 x-only pubkey, hex, when configuration alone determines it (NIP-01). */
  readonly pubkey: string | undefined
  /** One `status` line. Never carries key material or the bunker URI's `secret` param. */
  readonly detail: string
}

function hexFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Both dev forms decode to the same 32 bytes; the bech32 checksum is verified here, not in config. */
function secretBytes(devKey: DevKey): Uint8Array {
  if (devKey.form === 'hex') return bytesFromHex(devKey.material)
  // @scure/base names the offending string in its checksum error — the string IS the key, so
  // nothing thrown from inside decode may escape (status reaches the model context via the SDK).
  let decoded: { prefix: string; bytes: Uint8Array }
  try {
    decoded = bech32.decodeToBytes(devKey.material)
  } catch {
    throw new Error('not a valid bech32 nsec1… key — check for a mistyped or truncated character')
  }
  if (decoded.prefix !== 'nsec') {
    throw new Error(`expected a bech32 nsec1… key, got ${decoded.prefix}1…`)
  }
  return decoded.bytes
}

function pubkeyOf(devKey: DevKey): string {
  let bytes: Uint8Array
  try {
    bytes = secretBytes(devKey)
  } catch (cause) {
    // secretBytes errors are material-free by construction; re-wrap with the source only.
    const reason = cause instanceof Error ? cause.message : 'failed to decode'
    throw new Error(`dev key (${devKey.source}): ${reason}`)
  }
  try {
    return hexFromBytes(schnorr.getPublicKey(bytes))
  } catch {
    // Includes the out-of-range scalar case; never echo the material, it is the one secret here.
    throw new Error(`dev key (${devKey.source}): not a valid secp256k1 secret — regenerate it`)
  }
}

/**
 * Describe the configured backend. A NIP-46 URI wins over dev key material when both are set:
 * the bunker keeps the key outside this process, which is the pilot custody decision (#108).
 */
export function signerStatus(config: ServerConfig): SignerStatus {
  if (config.signerUri !== undefined) {
    return {
      mode: 'nip46',
      // Only the signer learns the authorizing key, and only after the handshake — A2.
      pubkey: undefined,
      detail:
        'nip46 (bunker) — handshake pending; the authorizing pubkey appears after connect (A2)',
    }
  }
  const devKey = config.devKey
  if (devKey === undefined) {
    return {
      mode: 'none',
      pubkey: undefined,
      detail:
        'none — set SCRUTINY_SIGNER_URI (bunker://…) for the pilot path, or NSEC / NSEC_FILE ' +
        'for dev; publishing tools will refuse until one is set',
    }
  }
  return {
    mode: 'dev-key',
    pubkey: pubkeyOf(devKey),
    detail: `dev-key (${devKey.source}) — dev-grade only; the pilot path is a NIP-46 bunker (#108)`,
  }
}
