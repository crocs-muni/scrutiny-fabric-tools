/**
 * Key-management CLI (spec §11.1), driven through injected terminal I/O and an in-memory keystore.
 * Every test greps all captured output for the secret (spec §14.1 item 9).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hexToBytes } from '@noble/hashes/utils.js'
import { nip19 } from 'nostr-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { type CliIo, runCli } from '../src/cli/main.js'
import { readIdentity, writeIdentity } from '../src/signer/identity.js'
import { decryptNcryptsec, npubEncode } from '../src/signer/keys.js'
import type { SecretStore } from '../src/signer/signer.js'

const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const NSEC = nip19.nsecEncode(hexToBytes(HEX_KEY))
const NIP49_VECTOR =
  'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'
const NIP49_SECRET = '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683'

interface Harness {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
  readonly prompts: string[]
  readonly store: SecretStore & { value: string | null; writes: number }
  readonly identityPath: string
  run(argv: string[]): Promise<number>
}

/** Secrets the current test must never print; every harness's streams are checked after it. */
let secretsToCheck: string[] = []
let captured: string[][] = []

afterEach(() => {
  const all = captured.flat().join('\n')
  for (const secret of secretsToCheck) expect(all).not.toContain(secret)
  secretsToCheck = []
  captured = []
})

function harness(
  opts: { tty?: boolean; stdin?: string; answers?: string[]; stored?: string } = {},
): Harness {
  const out: string[] = []
  const err: string[] = []
  const prompts: string[] = []
  const answers = [...(opts.answers ?? [])]
  const store = {
    value: opts.stored ?? null,
    writes: 0,
    async read() {
      return store.value
    },
    async write(next: string) {
      store.writes += 1
      store.value = next
    },
  }
  const io: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdinIsTTY: opts.tty ?? true,
    readStdin: async () => opts.stdin ?? '',
    promptHidden: async (prompt) => {
      prompts.push(prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error(`unexpected prompt: ${prompt}`)
      return next
    },
  }
  const identityPath = join(mkdtempSync(join(tmpdir(), 'scrutiny-cli-')), 'identity.json')
  const h: Harness = {
    io,
    out,
    err,
    prompts,
    store,
    identityPath,
    run: (argv) =>
      runCli(argv, io, {
        store: async () => store,
        identityPath,
        randomSecret: () => hexToBytes(HEX_KEY),
        logN: 4,
      }),
  }
  captured.push(out, err, prompts)
  return h
}

describe('keygen', () => {
  it('stores a new key, then prints the ncryptsec backup and the npub', async () => {
    secretsToCheck = [HEX_KEY, NSEC]
    const h = harness({ answers: ['backup pw', 'backup pw'] })
    expect(await h.run(['keygen'])).toBe(0)
    expect(h.store.value).toBe(HEX_KEY)
    expect(await readIdentity(h.identityPath)).toStrictEqual({
      pubkey: HEX_PUBKEY,
      npub: npubEncode(HEX_PUBKEY),
    })

    const printed = h.out.join('\n')
    const backup = /ncryptsec1[0-9a-z]+/u.exec(printed)?.[0] ?? ''
    expect(Buffer.from(await decryptNcryptsec(backup, 'backup pw')).toString('hex')).toBe(HEX_KEY)
    expect(printed.indexOf(backup)).toBeLessThan(printed.indexOf(npubEncode(HEX_PUBKEY)))
    expect(h.prompts).toHaveLength(2)
  })

  it('refuses to overwrite an existing key, asking nothing', async () => {
    secretsToCheck = ['cd'.repeat(32)]
    const h = harness({ stored: 'cd'.repeat(32) })
    expect(await h.run(['keygen'])).toBe(1)
    expect(h.store.writes).toBe(0)
    expect(h.prompts).toStrictEqual([])
  })

  it('stores nothing when the two passwords differ or are empty', async () => {
    secretsToCheck = [HEX_KEY]
    for (const answers of [
      ['one', 'two'],
      ['', ''],
    ]) {
      const h = harness({ answers })
      expect(await h.run(['keygen'])).toBe(1)
      expect(h.store.writes).toBe(0)
      expect(await readIdentity(h.identityPath)).toBeNull()
    }
  })

  it('needs a terminal for the backup password', async () => {
    const h = harness({ tty: false })
    expect(await h.run(['keygen'])).toBe(1)
    expect(h.store.writes).toBe(0)
  })
})

describe('import', () => {
  it('reads a hex or nsec key from piped stdin', async () => {
    secretsToCheck = [HEX_KEY, NSEC]
    for (const stdin of [`${HEX_KEY}\n`, NSEC]) {
      const h = harness({ tty: false, stdin })
      expect(await h.run(['import'])).toBe(0)
      expect(h.store.value).toBe(HEX_KEY)
      expect((await readIdentity(h.identityPath))?.pubkey).toBe(HEX_PUBKEY)
      expect(h.out.join('\n')).toContain(npubEncode(HEX_PUBKEY))
    }
  })

  it('prompts without echo on a terminal, and asks for an ncryptsec password', async () => {
    secretsToCheck = [NIP49_SECRET]
    const h = harness({ answers: [NIP49_VECTOR, 'nostr'] })
    expect(await h.run(['import'])).toBe(0)
    expect(h.store.value).toBe(NIP49_SECRET)
    expect(h.prompts).toHaveLength(2)
  }, 30_000)

  it('replaces a stored key, which is how signer.mismatch is fixed', async () => {
    const h = harness({ tty: false, stdin: HEX_KEY, stored: 'cd'.repeat(32) })
    await writeIdentity(h.identityPath, 'f'.repeat(64))
    expect(await h.run(['import'])).toBe(0)
    expect(h.store.value).toBe(HEX_KEY)
    expect((await readIdentity(h.identityPath))?.pubkey).toBe(HEX_PUBKEY)
  })

  it('refuses a key given as a command-line argument, without echoing it', async () => {
    secretsToCheck = [HEX_KEY, NSEC]
    for (const arg of [HEX_KEY, NSEC]) {
      const h = harness()
      expect(await h.run(['import', arg])).toBe(2)
      expect(h.store.writes).toBe(0)
    }
  })

  it('refuses junk without storing or echoing it', async () => {
    const junk = `${HEX_KEY.slice(0, 60)}zzzz`
    secretsToCheck = [junk]
    const h = harness({ tty: false, stdin: junk })
    expect(await h.run(['import'])).toBe(1)
    expect(h.store.writes).toBe(0)
  })

  it('refuses a wrong ncryptsec password and stores nothing', async () => {
    const h = harness({ answers: [NIP49_VECTOR, 'wrong'] })
    expect(await h.run(['import'])).toBe(1)
    expect(h.store.writes).toBe(0)
  }, 30_000)

  it('cannot ask for an ncryptsec password when stdin is piped', async () => {
    const h = harness({ tty: false, stdin: NIP49_VECTOR })
    expect(await h.run(['import'])).toBe(1)
    expect(h.store.writes).toBe(0)
  })
})

describe('whoami', () => {
  it('prints the npub and never reads the secret', async () => {
    const h = harness()
    h.store.read = async () => {
      throw new Error('whoami must not read the secret')
    }
    await writeIdentity(h.identityPath, HEX_PUBKEY)
    expect(await h.run(['whoami'])).toBe(0)
    expect(h.out).toStrictEqual([npubEncode(HEX_PUBKEY)])
  })

  it('fails when there is no identity', async () => {
    expect(await harness().run(['whoami'])).toBe(1)
  })
})

describe('usage', () => {
  it('exits 2 on an unknown command', async () => {
    expect(await harness().run(['publish'])).toBe(2)
  })
})
