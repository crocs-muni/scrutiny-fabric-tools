/**
 * The signer port (D13) with its two backends behind one shape (#108 A2).
 *
 * - `nip46` — the pilot custody path: a `bunker://` token, key stays in the signer daemon, this
 *   process holds only a disposable client key (report §8.3). `loadSigner` performs the handshake
 *   and learns the user pubkey, because a NIP-46 pubkey is not derivable from configuration.
 * - `dev-key` — `NSEC`/`NSEC_FILE`, dev-grade only, never a shipped mode.
 *
 * Signing is async in both cases: the NIP-46 branch is a network round-trip, and a union that
 * returned `NostrEvent | Promise<NostrEvent>` would push a branch into every caller for no gain.
 *
 * `signerStatus` stays synchronous and side-effect-free: `status` is a tool result, and spending a
 * bunker approval to answer it would be worse than reporting "handshake pending".
 */

import { hexToBytes } from '@noble/hashes/utils.js'
import type { NostrEvent, UnsignedEvent } from '@scrutiny-fabric/core'
import { bech32 } from '@scure/base'
import { ConfigError, type DevKey, SERVER_NAME, type ServerConfig } from './config.ts'
import { createBunkerSigner } from './identity/nip46.ts'
import { type DevKeySigner, createDevKeySigner } from './identity/sign.ts'
import type { RelayTransport } from './identity/transport.ts'

export interface SignerStatus {
  /** Which backend A2 instantiates behind D13's `ScrutinySigner`. */
  readonly mode: 'nip46' | 'dev-key' | 'none'
  /** BIP-340 x-only pubkey, hex, when configuration alone determines it (NIP-01). */
  readonly pubkey: string | undefined
  /** One `status` line. Never carries key material or the bunker URI's `secret` param. */
  readonly detail: string
}

/** The configured backend, once `loadSigner` has resolved it. */
export interface Signer {
  readonly mode: 'nip46' | 'dev-key'
  /** The key events are signed with — the bunker's user pubkey, or the dev key's pubkey. */
  readonly publicKey: string
  /** Fill `id`/`pubkey`/`sig` per D13. Rejects before signing outside the relay's freshness window. */
  sign(template: UnsignedEvent): Promise<NostrEvent>
}

/** Both dev forms decode to the same 32 bytes; the bech32 checksum is verified here, not in config. */
function secretBytes(devKey: DevKey): Uint8Array {
  if (devKey.form === 'hex') return hexToBytes(devKey.material)
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

/** One place turns an invalid dev key into an actionable message, never echoing the material. */
function devKeySigner(devKey: DevKey): DevKeySigner {
  let secret: Uint8Array
  try {
    secret = secretBytes(devKey)
  } catch (cause) {
    // secretBytes errors are material-free by construction; re-wrap with the source only.
    const reason = cause instanceof Error ? cause.message : 'failed to decode'
    throw new Error(`dev key (${devKey.source}): ${reason}`)
  }
  try {
    return createDevKeySigner(secret)
  } catch {
    // @noble scalar errors can name the input; sign.ts's own message is fixed text.
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
      // Only the signer learns the authorizing key, and only after the handshake.
      pubkey: undefined,
      detail:
        'nip46 (bunker) — handshake pending; loadSigner() connects and learns the user pubkey',
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
    pubkey: devKeySigner(devKey).publicKey,
    detail: `dev-key (${devKey.source}) — dev-grade only; the pilot path is a NIP-46 bunker (#108)`,
  }
}

/**
 * Resolve the configured backend into a usable signer.
 *
 * `transport` is required exactly when the URI branch is configured: A2 defines the relay port,
 * A4 supplies the socket. Passing it to a dev-key configuration is harmless and ignored, which
 * keeps the stdio entry point from branching on `signerStatus().mode`.
 */
export async function loadSigner(
  config: ServerConfig,
  transport?: RelayTransport,
): Promise<Signer> {
  if (config.signerUri !== undefined) {
    if (transport === undefined) {
      throw new ConfigError(
        'SCRUTINY_SIGNER_URI',
        'a NIP-46 bunker needs a relay transport, but none was supplied — the stdio entry ' +
          'point wires one in A4',
      )
    }
    const bunker = await createBunkerSigner({
      uri: config.signerUri,
      transport,
      appName: SERVER_NAME,
    })
    return { mode: 'nip46', publicKey: bunker.publicKey, sign: bunker.sign }
  }

  const devKey = config.devKey
  if (devKey === undefined) {
    throw new ConfigError(
      'SCRUTINY_SIGNER_URI',
      'no signer configured — set SCRUTINY_SIGNER_URI (bunker://…) for the pilot path, or ' +
        'NSEC / NSEC_FILE for dev; publishing tools refuse until one is set',
    )
  }
  const signer = devKeySigner(devKey)
  return {
    mode: 'dev-key',
    publicKey: signer.publicKey,
    sign: async (template) => signer.sign(template),
  }
}
