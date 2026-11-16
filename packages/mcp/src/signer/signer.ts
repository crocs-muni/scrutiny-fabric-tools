/**
 * The signer port (spec §11.3) and its Level 1 implementation over the OS keystore (§11.2).
 *
 * The secret is read lazily, at signing time, and the bytes are zeroed right after. The public key
 * comes from the identity file. Signing derives the pubkey from the secret and refuses
 * (`signer.mismatch`) if it differs from the identity, so a wrong key in the keystore can never
 * publish under an identity nobody chose.
 */

import { createRequire } from 'node:module'
import type { NostrEvent, UnsignedEvent } from '@scrutiny-fabric/core'
import type { Refusal } from '../refusal.js'
import { signEvent } from './event.js'
import { readIdentity } from './identity.js'
import { KeyError, parseKeyInput, publicKeyHex } from './keys.js'

export interface SignerPort {
  /** Hex pubkey from the identity file; never touches the secret. */
  publicKey(): Promise<string>
  /** Sets `pubkey`, `id` and `sig`; `created_at` is the caller's. */
  sign(template: UnsignedEvent): Promise<NostrEvent>
}

/** The keystore entry holding the secret as lowercase hex. */
export interface SecretStore {
  read(): Promise<string | null>
  write(secretHex: string): Promise<void>
}

export class SignerError extends Error {
  readonly refusal: Refusal
  constructor(refusal: Refusal) {
    super(refusal.problem)
    this.name = 'SignerError'
    this.refusal = refusal
  }
}

/** The package version is filled in at release (§18 step 6); the CLI name is stable. */
const KEYGEN_FIX =
  'Run `npx @scrutiny-fabric/mcp keygen` in a terminal (or `import` an existing key).'

function refuse(code: string, problem: string, fix: string): SignerError {
  return new SignerError({ code, field: null, problem, fix, source: 'signer', relay_message: null })
}

export class KeystoreSigner implements SignerPort {
  readonly #identityPath: string
  readonly #store: () => Promise<SecretStore>

  constructor(opts: { readonly identityPath: string; readonly store: () => Promise<SecretStore> }) {
    this.#identityPath = opts.identityPath
    this.#store = opts.store
  }

  async publicKey(): Promise<string> {
    const identity = await readIdentity(this.#identityPath)
    if (identity === null)
      throw refuse('signer.missing', 'no publisher identity is set up', KEYGEN_FIX)
    return identity.pubkey
  }

  async sign(template: UnsignedEvent): Promise<NostrEvent> {
    const expected = await this.publicKey()
    let stored: string | null
    try {
      stored = await (await this.#store()).read()
    } catch {
      throw refuse(
        'signer.unavailable',
        'the OS keystore could not be opened or read',
        'Unlock the OS keystore (Keychain, Credential Manager or Secret Service) and retry.',
      )
    }
    if (stored === null)
      throw refuse('signer.missing', 'the OS keystore holds no publisher key', KEYGEN_FIX)

    let secret: Uint8Array
    try {
      const parsed = parseKeyInput(stored)
      if (parsed.kind !== 'secret') throw new KeyError('key.invalid', 'encrypted')
      secret = parsed.secret
    } catch {
      throw refuse(
        'signer.mismatch',
        'the OS keystore entry does not hold a usable key for this identity',
        "Run `npx @scrutiny-fabric/mcp import` with this identity's key.",
      )
    }
    try {
      if (publicKeyHex(secret) !== expected) {
        throw refuse(
          'signer.mismatch',
          'the OS keystore holds a key for a different identity than the identity file',
          'Run `npx @scrutiny-fabric/mcp import` with the key you mean to publish as.',
        )
      }
      return signEvent(template, secret)
    } finally {
      secret.fill(0)
    }
  }
}

export interface SignerStatus {
  readonly state: 'ready' | 'missing' | 'unavailable'
  readonly npub: string | null
  readonly fix: string | null
}

/** Spec §6.1: resolved on every call, never reads the secret. */
export async function signerStatus(opts: {
  readonly identityPath: string
  readonly keystoreAvailable: () => boolean
}): Promise<SignerStatus> {
  if (!opts.keystoreAvailable()) {
    return {
      state: 'unavailable',
      npub: null,
      fix: 'No OS keystore is available on this machine (headless Linux and WSL are not supported in v1).',
    }
  }
  const identity = await readIdentity(opts.identityPath)
  return identity === null
    ? { state: 'missing', npub: null, fix: KEYGEN_FIX }
    : { state: 'ready', npub: identity.npub, fix: null }
}

// ---------------------------------------------------------------------------
// OS keystore (@napi-rs/keyring), loaded lazily so a missing native binary is a status value,
// not a crash at startup (spec §17: the prototype died before JSON-RPC when the keyring failed).
// ---------------------------------------------------------------------------

const KEYSTORE_SERVICE = 'scrutiny-fabric'
const KEYSTORE_ACCOUNT = 'default'

interface KeyringModule {
  readonly AsyncEntry: new (
    service: string,
    account: string,
  ) => {
    getPassword(): Promise<string | null>
    setPassword(password: string): Promise<void>
  }
}

/** Loaded with `require` on purpose; knip.json lists the package under `ignoreDependencies` for that reason. */
function loadKeyring(): KeyringModule {
  return createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule
}

export function osKeystoreAvailable(): boolean {
  try {
    loadKeyring()
    return true
  } catch {
    return false
  }
}

export async function osKeystore(): Promise<SecretStore> {
  const entry = new (loadKeyring().AsyncEntry)(KEYSTORE_SERVICE, KEYSTORE_ACCOUNT)
  return {
    read: () => entry.getPassword(),
    write: (secretHex) => entry.setPassword(secretHex),
  }
}
