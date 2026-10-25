/**
 * emit/keys.ts — publisher key loading and NIP-01 signing for the mirror.
 *
 * One publisher key signs every mirrored event (design §8.1). Key material comes
 * from the environment only — never from the repository:
 *   NSEC       hex64 (`/^[0-9a-f]{64}$/`) or bech32 `nsec1…`
 *   NSEC_FILE  path to a file containing either form
 * (`NSEC_AGE_FILE` + passphrase is explicitly out of pilot scope, per README §Frozen.)
 *
 * Signing is delegated to nostr-tools (`finalizeEvent` performs the NIP-01 id hash +
 * BIP-340 schnorr signature; `getPublicKey` yields the x-only pubkey).
 *
 * `createClock` implements the publish-time `created_at` rule (CA-1: never backdate):
 * without an explicit base it uses `floor(Date.now()/1000)` and bumps past collisions
 * inside a batch; an explicit base makes a batch deterministic (`base, base+1, …`).
 */

import { readFileSync } from 'node:fs'
import { decode as nip19Decode } from 'nostr-tools/nip19'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { SignedEvent } from '../types.js'

/** An unsigned NIP-01 event template (D13: `{kind, created_at, tags, content}`). */
export interface UnsignedEventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

/** A signer bound to one publisher key. */
export interface Signer {
  /** x-only public key, 64-hex. */
  pubkey: string
  /** Fill `id` + `sig` for one template. */
  sign(template: UnsignedEventTemplate): SignedEvent
}

export interface LoadKeyOptions {
  /** Env var holding the secret (hex64 or nsec1…). Default `NSEC`. */
  nsecEnv?: string
  /** Env var holding a path to a secret file. Default `NSEC_FILE`. */
  fileEnv?: string
  /** Environment map override (tests, dry runs). Default `process.env`. */
  env?: Record<string, string | undefined>
}

/** Monotonic `created_at` source for one batch. */
export interface Clock {
  next(): number
}

const HEX64 = /^[0-9a-f]{64}$/u

/** Parse a secret key value: hex64 or bech32 `nsec1…`. Throws with provenance on junk. */
export function secretKeyFromString(value: string, source: string): Uint8Array {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${source}: empty secret key`)
  if (trimmed.startsWith('nsec1')) {
    let decoded: { type: string; data: unknown }
    try {
      decoded = nip19Decode(trimmed) as { type: string; data: unknown }
    } catch (e) {
      throw new Error(`${source}: invalid nsec1 value: ${(e as Error).message}`)
    }
    if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
      throw new Error(`${source}: bech32 value decodes to '${decoded.type}', expected 'nsec'`)
    }
    return decoded.data
  }
  const lower = trimmed.toLowerCase()
  if (!HEX64.test(lower)) {
    throw new Error(
      `${source}: secret key is neither 64-hex nor nsec1… (got ${trimmed.length} chars)`,
    )
  }
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(lower.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** Build a signer from a secret key (Uint8Array or hex64/nsec1 string). */
export function signerFromSecretKey(secret: Uint8Array | string): Signer {
  const sk = typeof secret === 'string' ? secretKeyFromString(secret, 'secret key') : secret
  const pubkey = getPublicKey(sk)
  return {
    pubkey,
    sign(template: UnsignedEventTemplate): SignedEvent {
      const signed = finalizeEvent(template, sk)
      return {
        id: signed.id,
        pubkey: signed.pubkey,
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      }
    },
  }
}

/**
 * Load the publisher key from the environment (README §Frozen): `NSEC` first,
 * then `NSEC_FILE`. Throws with an actionable message when neither is usable.
 */
export function loadKey(opts: LoadKeyOptions = {}): Signer {
  const env = opts.env ?? process.env
  const nsecEnv = opts.nsecEnv ?? 'NSEC'
  const fileEnv = opts.fileEnv ?? 'NSEC_FILE'

  const direct = env[nsecEnv]
  if (direct !== undefined && direct.trim().length > 0) {
    return signerFromSecretKey(direct)
  }

  const filePath = env[fileEnv]
  if (filePath !== undefined && filePath.trim().length > 0) {
    const path = filePath.trim()
    let contents: string
    try {
      contents = readFileSync(path, { encoding: 'utf8' })
    } catch (e) {
      throw new Error(`$${fileEnv} (${path}): cannot read secret file: ${(e as Error).message}`)
    }
    return signerFromSecretKey(contents)
  }

  throw new Error(
    `no publisher key: set $${nsecEnv} (hex64 or nsec1…) or $${fileEnv} (path to a file containing one); NSEC_AGE_FILE + passphrase is not supported in the pilot`,
  )
}

/**
 * `created_at` clock. With an explicit `base`, a batch is deterministic (`base, base+1, …`).
 * Otherwise: the wall clock at signing time — and NO artificial collision bump. The prior
 * `last + 1` bump lets a fast 100k-event build spray events across ~30h of *future*
 * timestamps, which every measured relay freshness policy (past windows AND small forward
 * tolerance: `blocked: event too much in the future`) rejects in the tail of the batch.
 * Event ids differentiate by content anyway; created_at merely must be ≥ the last write per
 * CA-1 — stamping at "now" is exactly honest.
 */
export function createClock(base?: number): Clock {
  if (base !== undefined) {
    let current = Math.floor(base)
    return {
      next(): number {
        const t = current
        current += 1
        return t
      },
    }
  }
  let last = Math.floor(Date.now() / 1000)
  return {
    next(): number {
      const now = Math.floor(Date.now() / 1000)
      last = now > last ? now : last
      return last
    },
  }
}
