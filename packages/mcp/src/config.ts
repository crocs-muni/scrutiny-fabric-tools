/**
 * Server configuration from the environment (#108).
 *
 * Two axes, both secret-sensitive:
 *
 * - the relay (`SCRUTINY_RELAY_URL`, default {@link DEFAULT_RELAY_URL});
 * - the signer backend: `SCRUTINY_SIGNER_URI` for a NIP-46 bunker (the pilot path), with the
 *   dev-grade `NSEC`/`NSEC_FILE` fallback that keeps mirror `keys.ts` semantics.
 *
 * Errors name the variable and the accepted shape and never the value: this text reaches the
 * user's terminal and an agent's transcript, and a secret echoed once is a secret exfiltrated
 * (report §8.3 — the same reason `nsec`-in-config is rejected as a shipped mode).
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** `Implementation.name` reported to the host; also the scoped package name (report §8.3). */
export const SERVER_NAME = '@scrutiny-fabric/mcp'

/**
 * No published version yet: npm publish of the scope is a post-pilot decision (#108), so the
 * private package's version is the placeholder mirror also uses.
 */
export const SERVER_VERSION = '0.0.0'

/** The public relay #108 targets; a local `ws://` relay is what the integration tests use. */
export const DEFAULT_RELAY_URL = 'wss://relay.scrutiny.cloud'

/** A typed, actionable configuration failure — `index.ts` turns it into exit code 2. */
export class ConfigError extends Error {
  /** The environment variable that is wrong, so the message starts with the fix. */
  readonly variable: string

  constructor(variable: string, detail: string) {
    super(`${variable}: ${detail}`)
    this.name = 'ConfigError'
    this.variable = variable
  }
}

export type Env = Readonly<Record<string, string | undefined>>

/** Dev-grade key material. Held in memory only, never printed, never a tool argument. */
export interface DevKey {
  readonly material: string
  /** `hex` (mirror's hex64 form) or bech32 `nsec1…`; A2 decodes it into BIP-340 bytes. */
  readonly form: 'hex' | 'nsec1'
  readonly source: 'NSEC' | 'NSEC_FILE' | 'SCRUTINY_KEYRING'
}

export interface ServerConfig {
  /** Normalised, no trailing slash, so `status` and the A2 relay client print one spelling. */
  readonly relayUrl: string
  /** `bunker://…` (NIP-46). Present means the bunker is authoritative, whatever `devKey` says. */
  readonly signerUri: string | undefined
  /** Dev fallback. Present only when the pilot path is not configured. */
  readonly devKey: DevKey | undefined
}

/** BIP-340 x-only key material as mirror `loadKey` accepts it: hex64 or bech32 `nsec1…`. */
const HEX_KEY = /^[0-9a-f]{64}$/iu
/** bech32 data characters, 52 payload + 6 checksum. Checksum validation is A2's job. */
const NSEC_KEY = /^nsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/u

/**
 * Variable names in one place: they appear in `ConfigError.variable`, in the messages, and in the
 * README, so a typo should be a single edit rather than five consistent ones.
 */
const ENV = {
  relayUrl: 'SCRUTINY_RELAY_URL',
  signerUri: 'SCRUTINY_SIGNER_URI',
  nsec: 'NSEC',
  nsecFile: 'NSEC_FILE',
  nsecAgeFile: 'NSEC_AGE_FILE',
  keyring: 'SCRUTINY_KEYRING',
} as const

function relayUrlFromEnv(env: Env): string {
  const raw = env[ENV.relayUrl]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_RELAY_URL

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(ENV.relayUrl, `not an absolute URL: ${raw}`)
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new ConfigError(
      ENV.relayUrl,
      `must be ws:// (local relay) or wss:// — got ${url.protocol}`,
    )
  }
  return url.href.replace(/\/+$/u, '')
}

function signerUriFromEnv(env: Env): string | undefined {
  const raw = env[ENV.signerUri]?.trim()
  if (raw === undefined || raw === '') return undefined

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(
      ENV.signerUri,
      'not an absolute URL — expected bunker://<signer-pubkey>?relay=wss://… (NIP-46)',
    )
  }
  if (url.protocol !== 'bunker:') {
    throw new ConfigError(
      ENV.signerUri,
      `must be a bunker:// URI (NIP-46) — got ${url.protocol}//; nostrconnect:// is the client-initiated flow and has no place in server config`,
    )
  }
  return raw
}

function classifyDevKey(
  material: string,
  source: 'NSEC' | 'NSEC_FILE' | 'SCRUTINY_KEYRING',
): DevKey {
  if (HEX_KEY.test(material)) return { material: material.toLowerCase(), form: 'hex', source }
  if (NSEC_KEY.test(material)) return { material, form: 'nsec1', source }
  // Never the value: this message is displayed and may be quoted by an agent.
  throw new ConfigError(
    source,
    'must be 64-char hex or a bech32 nsec1… key; fix the value (it is deliberately not echoed here)',
  )
}

/**
 * Where a keyring-stored secret is read from. Injected so unit tests never touch the real OS
 * store: `@napi-rs/keyring` is a native module, and a test that writes to the developer's
 * Credential Manager is a test that fails on someone else's machine.
 */
export type KeyringReader = (service: string, account: string) => string | null

/** ESM has no `require`; the native module is CommonJS, so borrow one from this module's URL. */
const requireNative = createRequire(import.meta.url)

/** Default reader: the OS store (Windows Credential Manager, macOS Keychain, libsecret). */
const osKeyringReader: KeyringReader = (service, account) => {
  // Loaded lazily: the native module must not be required when no keyring is configured.
  const { Entry } = requireNative('@napi-rs/keyring') as {
    Entry: new (
      service: string,
      account: string,
    ) => {
      getPassword(): string | null
    }
  }
  return new Entry(service, account).getPassword()
}

/**
 * `SCRUTINY_KEYRING=service:account` reads the key from the OS secret store instead of an
 * environment variable or a file. It is the publisher-facing default for the pilot: the secret
 * stops living in a host config that gets copied, committed or pasted into a chat.
 *
 * It is NOT a custody boundary — Credential Manager / Keychain entries are readable by any
 * process running as the same user, so an agent with a shell can still ask for them. Say that
 * out loud rather than implying more (see the publisher guide).
 */
function devKeyFromKeyring(env: Env, read: KeyringReader): DevKey | undefined {
  const spec = env[ENV.keyring]?.trim()
  if (spec === undefined || spec === '') return undefined
  const parts = spec.split(/[:/]/u)
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new ConfigError(ENV.keyring, 'must be "service:account", e.g. "scrutiny:publisher"')
  }
  const [service, account] = parts as [string, string]
  let secret: string | null
  try {
    secret = read(service, account)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    // The reason names the service/account, never a secret.
    throw new ConfigError(
      ENV.keyring,
      `cannot read "${service}"/"${account}" from the OS secret store (${reason}) — create it with the store's own UI or CLI, then restart`,
    )
  }
  if (secret === null || secret.trim() === '') {
    throw new ConfigError(
      ENV.keyring,
      `"${service}"/"${account}" is not in the OS secret store — add it there, then restart`,
    )
  }
  return classifyDevKey(secret.trim(), ENV.keyring)
}

function devKeyFromEnv(env: Env): DevKey | undefined {
  const direct = env[ENV.nsec]?.trim()
  if (direct !== undefined && direct !== '') return classifyDevKey(direct, ENV.nsec)

  const file = env[ENV.nsecFile]
  if (file !== undefined && file !== '') {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8').trim()
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new ConfigError(ENV.nsecFile, `cannot read ${file}: ${reason}`)
    }
    if (raw === '') throw new ConfigError(ENV.nsecFile, `${file} is empty`)
    return classifyDevKey(raw, ENV.nsecFile)
  }

  // Mirror parity, loudly: silently ignoring an age file looks like "key not found" later.
  if (env[ENV.nsecAgeFile] !== undefined) {
    throw new ConfigError(
      ENV.nsecAgeFile,
      'age-encrypted keys are unsupported — use SCRUTINY_SIGNER_URI (bunker://…) for the pilot, ' +
        'or NSEC / NSEC_FILE for dev',
    )
  }
  return undefined
}

/**
 * Read and validate the environment. Pure apart from the `NSEC_FILE` read, so tests pass an
 * explicit map instead of mutating `process.env`.
 */
export function loadConfig(
  env: Env = process.env,
  readKeyring: KeyringReader = osKeyringReader,
): ServerConfig {
  const signerUri = signerUriFromEnv(env)
  return {
    relayUrl: relayUrlFromEnv(env),
    signerUri,
    // Bunker mode must not touch local key material at all: an unrelated stale NSEC/NSEC_FILE
    // must not fail startup (#108 custody), and the key must not sit in memory when a signer
    // daemon holds it.
    devKey:
      signerUri === undefined
        ? (devKeyFromKeyring(env, readKeyring) ?? devKeyFromEnv(env))
        : undefined,
  }
}
