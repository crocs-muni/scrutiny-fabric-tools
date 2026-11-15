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

/**
 * Local key material. Held in memory only, never printed, never a tool argument.
 *
 * `expectPubkey` is the identity the source claims to hold (an npub from the signer URI). When it
 * is present the loader refuses a key that derives to a different pubkey: publishing under an
 * unintended identity is permanent, so the mismatch must be a startup error, not a surprise.
 */
export interface LocalKey {
  readonly material: string
  /** `hex` (mirror's hex64 form) or bech32 `nsec1…`; A2 decodes it into BIP-340 bytes. */
  readonly form: 'hex' | 'nsec1'
  readonly source: 'env' | 'file' | 'keyring'
  readonly expectPubkey?: string
}

/** Where the signature comes from — the one question `SCRUTINY_SIGNER` answers. */
type SignerPlan =
  | { readonly kind: 'bunker'; readonly uri: string }
  | { readonly kind: 'keyring'; readonly service: string; readonly account: string }

export interface ServerConfig {
  /** Normalised, no trailing slash, so `status` and the relay client print one spelling. */
  readonly relayUrl: string
  /** The one answer to "who signs": a bunker daemon (NIP-46) or the platform keystore. */
  readonly signer: SignerPlan | undefined
  /** Local material: the keystore key, or the test-only NSEC/NSEC_FILE. */
  readonly localKey: LocalKey | undefined
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
  signer: 'SCRUTINY_SIGNER',
  nsec: 'NSEC',
  nsecFile: 'NSEC_FILE',
  nsecAgeFile: 'NSEC_AGE_FILE',
} as const

/** The keystore namespace every entry of this publisher lives under. */
export const KEYRING_SERVICE = 'scrutiny-fabric'

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

/** An npub or a 64-char pubkey: the identity a keystore entry must hold. */
const NPUB = /^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/u

/**
 * `SCRUTINY_SIGNER` is one question with one answer, spelled as a URI so the backends stay
 * symmetric: `bunker://` is NIP-46's own form, and `keyring://<service>/<npub>` names an identity
 * in the platform keystore. The account is the npub because in Nostr the identity IS the pubkey —
 * and because it lets the loader prove the stored key is the one you meant.
 */
function signerFromEnv(env: Env): SignerPlan | undefined {
  const raw = env[ENV.signer]?.trim()
  if (raw === undefined || raw === '') return undefined

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(
      ENV.signer,
      'not a URI — expected bunker://<signer-pubkey>?relay=wss://… or keyring://<service>/npub1…',
    )
  }

  if (url.protocol === 'bunker:') return { kind: 'bunker', uri: raw }

  if (url.protocol === 'keyring:') {
    // keyring://<service>/<npub> — URL parses the authority as host and the rest as pathname.
    const account = url.pathname.replace(/^\/+/, '')
    if (url.hostname === '' || account === '') {
      throw new ConfigError(
        ENV.signer,
        'keyring:// needs a service and an identity — expected keyring://scrutiny-fabric/npub1… or keyring://scrutiny-fabric/<64-hex pubkey>',
      )
    }
    if (!NPUB.test(account) && !HEX_KEY.test(account)) {
      throw new ConfigError(
        ENV.signer,
        'the keyring account must be the identity it holds (npub1… or 64-char hex pubkey), not a label — the loader refuses a key that derives to a different pubkey',
      )
    }
    return { kind: 'keyring', service: url.hostname, account }
  }

  throw new ConfigError(
    ENV.signer,
    `unsupported scheme ${url.protocol}// — use bunker:// (NIP-46 signer daemon) or keyring:// (platform keystore); nostrconnect:// is the client-initiated flow and has no place in server config`,
  )
}

function classifyLocalKey(
  material: string,
  source: 'env' | 'file' | 'keyring',
  options: { expectPubkey?: string; variable?: string } = {},
): LocalKey {
  const { expectPubkey } = options
  // The error must name the knob the operator set, not the internal source tag.
  const variable = options.variable ?? ENV.signer
  const base = expectPubkey === undefined ? {} : { expectPubkey }
  if (HEX_KEY.test(material)) {
    return { material: material.toLowerCase(), form: 'hex', source, ...base }
  }
  if (NSEC_KEY.test(material)) return { material, form: 'nsec1', source, ...base }
  // Never the value: this message is displayed and may be quoted by an agent.
  throw new ConfigError(
    variable,
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
 * `SCRUTINY_SIGNER=keyring://<service>/<npub>` reads the key from the OS secret store under the
 * identity it claims to hold. It is the publisher-facing default for the pilot: the secret stops
 * living in a host config that gets copied, committed or pasted into a chat, and the account name
 * carries the pubkey so a wrong entry is caught at startup instead of publishing under it.
 *
 * It is NOT a custody boundary — Credential Manager / Keychain entries are readable by any
 * process running as the same user, so an agent with a shell can still ask for them. Say that
 * out loud rather than implying more (see the publisher guide).
 */
function keyFromKeyring(
  plan: Extract<SignerPlan, { kind: 'keyring' }>,
  read: KeyringReader,
): LocalKey {
  const { service, account } = plan
  let secret: string | null
  try {
    secret = read(service, account)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    // The reason names the service/account, never a secret.
    throw new ConfigError(
      ENV.signer,
      `cannot read ${service}/${account} from the OS secret store (${reason}) — create it with the store's own UI or CLI, then restart`,
    )
  }
  if (secret === null || secret.trim() === '') {
    throw new ConfigError(
      ENV.signer,
      `${service}/${account} is not in the OS secret store — add it under that identity, then restart`,
    )
  }
  return classifyLocalKey(secret.trim(), 'keyring', {
    expectPubkey: account,
    variable: ENV.signer,
  })
}

function localKeyFromEnv(env: Env): LocalKey | undefined {
  const direct = env[ENV.nsec]?.trim()
  if (direct !== undefined && direct !== '')
    return classifyLocalKey(direct, 'env', { variable: ENV.nsec })

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
    return classifyLocalKey(raw, 'file', { variable: ENV.nsecFile })
  }

  // Mirror parity, loudly: silently ignoring an age file looks like "key not found" later.
  if (env[ENV.nsecAgeFile] !== undefined) {
    throw new ConfigError(
      ENV.nsecAgeFile,
      'age-encrypted keys are unsupported — use SCRUTINY_SIGNER (keyring://… or bunker://…) for the pilot, or NSEC / NSEC_FILE for tests',
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
  const signer = signerFromEnv(env)
  const keyring = signer?.kind === 'keyring' ? signer : undefined

  if (signer?.kind === 'bunker') {
    // A signer daemon holds the key; local material must not be read at all, so an unrelated
    // stale NSEC/NSEC_FILE cannot fail startup and no key sits in this process's memory.
    return { relayUrl: relayUrlFromEnv(env), signer, localKey: undefined }
  }

  return {
    relayUrl: relayUrlFromEnv(env),
    signer,
    localKey: keyring === undefined ? localKeyFromEnv(env) : keyFromKeyring(keyring, readKeyring),
  }
}
