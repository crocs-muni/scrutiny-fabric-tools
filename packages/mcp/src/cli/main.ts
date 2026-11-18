/**
 * Key-management CLI (spec §11.1): `keygen`, `import`, `whoami`. It never runs as an agent tool;
 * the secret is never accepted as a command-line argument (shell history) and never printed. Where
 * input is needed, a hidden TTY prompt and piped stdin are both accepted, so a script can drive it:
 * `keygen` prints only the NIP-49 backup and the npub.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { readIdentity, writeIdentity } from '../signer/identity.js'
import {
  KeyError,
  decryptNcryptsec,
  encryptNcryptsec,
  npubEncode,
  parseKeyInput,
  publicKeyHex,
  randomSecretKey,
} from '../signer/keys.js'
import type { SecretStore } from '../signer/signer.js'

export interface CliIo {
  out(text: string): void
  err(text: string): void
  readonly stdinIsTTY: boolean
  /** All of piped stdin. */
  readStdin(): Promise<string>
  /** A line typed on the terminal without echo. */
  promptHidden(prompt: string): Promise<string>
}

export interface CliDeps {
  readonly store: () => Promise<SecretStore>
  readonly identityPath: string
  readonly randomSecret?: () => Uint8Array
  /** NIP-49 scrypt cost; tests lower it. */
  readonly logN?: number
}

const USAGE = [
  'Usage: scrutiny-fabric-mcp <command>',
  '',
  '  keygen   Create a publisher key in the OS keystore and print its encrypted backup',
  '           (asks for the backup password twice, or reads one line from stdin when piped)',
  '  import   Store an existing key (hex, nsec1… or ncryptsec1…), read from a hidden prompt or stdin',
  '  whoami   Print the publisher npub',
].join('\n')

const LOSS_WARNING = [
  'Keep the backup below somewhere safe, with its password.',
  'If you lose both the keystore entry and this backup, the identity is gone.',
  'Nostr keys cannot be revoked: anyone holding the key can publish as you.',
].join('\n')

class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === 'keygen' && rest.length === 0) return await keygen(io, deps)
    if (command === 'import' && rest.length === 0) return await importKey(io, deps)
    if (command === 'whoami' && rest.length === 0) return await whoami(io, deps)
    if (command === 'import') {
      // Never echo the argument: it is probably the key.
      throw new CliError(
        'import does not take the key as an argument (it would stay in shell history). Run `import` and paste the key at the prompt, or pipe it on stdin.',
        2,
      )
    }
    io.err(USAGE)
    return 2
  } catch (cause) {
    if (cause instanceof CliError) {
      io.err(cause.message)
      return cause.exitCode
    }
    if (cause instanceof KeyError) {
      io.err(`${cause.code}: ${cause.message}`)
      return 1
    }
    // Unknown failures (keystore errors) are reported by kind only, never with their text, which
    // could quote input.
    io.err(`error: ${cause instanceof Error ? cause.name : 'unknown failure'}`)
    return 1
  }
}

async function openStore(deps: CliDeps): Promise<SecretStore> {
  try {
    return await deps.store()
  } catch {
    throw new CliError(
      'No OS keystore is available on this machine (headless Linux and WSL are not supported in v1).',
    )
  }
}

async function keygen(io: CliIo, deps: CliDeps): Promise<number> {
  const store = await openStore(deps)
  if ((await store.read()) !== null) {
    throw new CliError(
      'A publisher key already exists in the OS keystore; keygen never overwrites it. Run `whoami` to see it.',
    )
  }
  const password = await backupPassword(io)

  const secret = (deps.randomSecret ?? randomSecretKey)()
  try {
    const pubkey = publicKeyHex(secret)
    const backup = await encryptNcryptsec(
      secret,
      password,
      deps.logN === undefined ? {} : { logN: deps.logN },
    )
    await store.write(bytesToHex(secret))
    await writeIdentity(deps.identityPath, pubkey)
    io.out(LOSS_WARNING)
    io.out('')
    io.out(`Backup (NIP-49): ${backup}`)
    io.out(`Publisher: ${npubEncode(pubkey)}`)
    return 0
  } finally {
    secret.fill(0)
  }
}

/**
 * The NIP-49 backup password: a hidden TTY prompt typed twice, or exactly one stdin line when
 * stdin is not a terminal, so a script or an agent can run `keygen` without one. The password is
 * never echoed, never an argument (shell history) and never stored by this process.
 */
async function backupPassword(io: CliIo): Promise<string> {
  if (!io.stdinIsTTY) {
    const piped = (await io.readStdin()).replace(/\r?\n$/u, '')
    if (piped === '')
      throw new CliError('The backup password on stdin was empty. Nothing was stored.')
    if (piped.includes('\n') || piped.includes('\r'))
      throw new CliError(
        'Piped input must be exactly one backup password line. Nothing was stored.',
      )
    return piped
  }
  const password = await io.promptHidden('Backup password: ')
  const again = await io.promptHidden('Repeat backup password: ')
  if (password === '')
    throw new CliError('The backup password must not be empty. Nothing was stored.')
  if (password !== again) throw new CliError('The passwords differ. Nothing was stored.')
  return password
}

async function importKey(io: CliIo, deps: CliDeps): Promise<number> {
  const store = await openStore(deps)
  const raw = io.stdinIsTTY
    ? await io.promptHidden('Key (hex, nsec1… or ncryptsec1…): ')
    : await io.readStdin()
  const parsed = parseKeyInput(raw)
  let secret: Uint8Array
  if (parsed.kind === 'secret') {
    secret = parsed.secret
  } else {
    if (!io.stdinIsTTY) {
      throw new CliError(
        'An ncryptsec key needs its password typed on a terminal; run `import` without piping.',
      )
    }
    secret = await decryptNcryptsec(parsed.ncryptsec, await io.promptHidden('ncryptsec password: '))
  }
  try {
    const pubkey = publicKeyHex(secret)
    await store.write(bytesToHex(secret))
    await writeIdentity(deps.identityPath, pubkey)
    io.out(`Publisher: ${npubEncode(pubkey)}`)
    return 0
  } finally {
    secret.fill(0)
  }
}

async function whoami(io: CliIo, deps: CliDeps): Promise<number> {
  const identity = await readIdentity(deps.identityPath)
  if (identity === null) throw new CliError('No publisher identity yet. Run `keygen` or `import`.')
  io.out(identity.npub)
  return 0
}
