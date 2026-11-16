/**
 * Signing, the keystore-backed signer port and the identity file (spec §11). The OS keystore is
 * replaced by an in-memory store; nothing here touches the user's real keystore.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hexToBytes } from '@noble/hashes/utils.js'
import { verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { signEvent } from '../src/signer/event.js'
import { identityPath, readIdentity, writeIdentity } from '../src/signer/identity.js'
import { npubEncode } from '../src/signer/keys.js'
import {
  KeystoreSigner,
  type SecretStore,
  SignerError,
  osKeystoreAvailable,
  signerStatus,
} from '../src/signer/signer.js'

const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const OTHER_KEY = 'cd'.repeat(32)

const TEMPLATE = {
  kind: 1,
  created_at: 1_700_000_000,
  tags: [
    ['t', 'scrutiny-fabric'],
    ['e', 'a'.repeat(64), '', 'root', ''],
  ],
  content: 'Example Corp EX-100\n\n- "quoted" \u00e9 \u2713 tab\there \\ back',
}
/** NIP-01 id of TEMPLATE under HEX_PUBKEY, computed with nostr-tools, not with this package. */
const TEMPLATE_ID = 'b63b216fecb4ef695d5d0d450fe0e6792400b331dcf4c0012b436ad8b39a7a65'

/** An in-memory keystore that counts reads, so tests can prove the secret was not touched. */
function memoryStore(secret: string | null): SecretStore & { reads: number; writes: string[] } {
  let value = secret
  const store = {
    reads: 0,
    writes: [] as string[],
    async read() {
      store.reads += 1
      return value
    },
    async write(next: string) {
      store.writes.push(next)
      value = next
    },
  }
  return store
}

const tempIdentity = () => join(mkdtempSync(join(tmpdir(), 'scrutiny-id-')), 'identity.json')

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof SignerError) return cause.refusal.code
    throw cause
  }
  return 'no error'
}

describe('signEvent', () => {
  it('matches a fixed NIP-01 id vector and verifies with an independent implementation', () => {
    const event = signEvent(TEMPLATE, hexToBytes(HEX_KEY))
    expect(event.pubkey).toBe(HEX_PUBKEY)
    expect(event.id).toBe(TEMPLATE_ID)
    expect(event.created_at).toBe(TEMPLATE.created_at)
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/u)
    expect(verifyEvent({ ...event, tags: event.tags.map((t) => [...t]) })).toBe(true)
  })

  it('keeps kind, tags and content exactly as given', () => {
    const event = signEvent(TEMPLATE, hexToBytes(HEX_KEY))
    expect({ kind: event.kind, tags: event.tags, content: event.content }).toStrictEqual({
      kind: TEMPLATE.kind,
      tags: TEMPLATE.tags,
      content: TEMPLATE.content,
    })
  })
})

describe('identity file', () => {
  it('lives under %APPDATA% on Windows and ~/.config elsewhere', () => {
    expect(
      identityPath('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'),
    ).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'scrutiny', 'identity.json'))
    expect(identityPath('linux', {}, '/home/u')).toBe(
      join('/home/u', '.config', 'scrutiny', 'identity.json'),
    )
    expect(identityPath('darwin', {}, '/Users/u')).toBe(
      join('/Users/u', '.config', 'scrutiny', 'identity.json'),
    )
  })

  it('round-trips the pubkey and npub and holds nothing secret', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    expect(await readIdentity(path)).toStrictEqual({
      pubkey: HEX_PUBKEY,
      npub: npubEncode(HEX_PUBKEY),
    })
    expect(readFileSync(path, 'utf8')).not.toContain(HEX_KEY)
  })

  it('reads a missing file as null and a malformed one as null', async () => {
    const path = tempIdentity()
    expect(await readIdentity(path)).toBeNull()
    writeFileSync(path, '{"pubkey":"not-hex"}')
    expect(await readIdentity(path)).toBeNull()
  })
})

describe('KeystoreSigner', () => {
  it('reports its public key from the identity file without reading the secret', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const store = memoryStore(HEX_KEY)
    const signer = new KeystoreSigner({ identityPath: path, store: async () => store })
    expect(await signer.publicKey()).toBe(HEX_PUBKEY)
    expect(store.reads).toBe(0)
  })

  it('signs with the keystore secret, keeping the caller-set created_at', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const store = memoryStore(HEX_KEY)
    const signer = new KeystoreSigner({ identityPath: path, store: async () => store })
    const event = await signer.sign(TEMPLATE)
    expect(event.id).toBe(TEMPLATE_ID)
    expect(store.reads).toBe(1)
  })

  it('refuses with signer.mismatch when the keystore holds a different identity', async () => {
    // The failure this check exists for: publishing, permanently, under an identity nobody chose.
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const signer = new KeystoreSigner({
      identityPath: path,
      store: async () => memoryStore(OTHER_KEY),
    })
    expect(await refusalCode(signer.sign(TEMPLATE))).toBe('signer.mismatch')
  })

  it('refuses with signer.missing when there is no identity file or no secret', async () => {
    const none = new KeystoreSigner({
      identityPath: tempIdentity(),
      store: async () => memoryStore(HEX_KEY),
    })
    expect(await refusalCode(none.publicKey())).toBe('signer.missing')
    expect(await refusalCode(none.sign(TEMPLATE))).toBe('signer.missing')

    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const empty = new KeystoreSigner({ identityPath: path, store: async () => memoryStore(null) })
    expect(await refusalCode(empty.sign(TEMPLATE))).toBe('signer.missing')
  })

  it('refuses with signer.unavailable when the keystore cannot be opened or read', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const noModule = new KeystoreSigner({
      identityPath: path,
      store: async () => {
        throw new Error('native binding missing')
      },
    })
    expect(await refusalCode(noModule.sign(TEMPLATE))).toBe('signer.unavailable')
    const locked = new KeystoreSigner({
      identityPath: path,
      store: async () => ({
        read: async () => {
          throw new Error('locked')
        },
        write: async () => {},
      }),
    })
    expect(await refusalCode(locked.sign(TEMPLATE))).toBe('signer.unavailable')
  })

  it('never puts a malformed stored secret into the refusal', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const junk = `${'ab'.repeat(31)}zz`
    const signer = new KeystoreSigner({ identityPath: path, store: async () => memoryStore(junk) })
    try {
      await signer.sign(TEMPLATE)
      expect.unreachable()
    } catch (cause) {
      expect(cause).toBeInstanceOf(SignerError)
      expect(JSON.stringify((cause as SignerError).refusal)).not.toContain(junk.slice(0, 16))
      expect((cause as SignerError).refusal.code).toBe('signer.mismatch')
    }
  })
})

describe('signerStatus (never reads the secret)', () => {
  it('is ready with the npub when the identity file exists', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    expect(await signerStatus({ identityPath: path, keystoreAvailable: () => true })).toStrictEqual(
      {
        state: 'ready',
        npub: npubEncode(HEX_PUBKEY),
        fix: null,
      },
    )
  })

  it('is missing, with a fix, when there is no identity', async () => {
    const status = await signerStatus({
      identityPath: tempIdentity(),
      keystoreAvailable: () => true,
    })
    expect(status.state).toBe('missing')
    expect(status.npub).toBeNull()
    expect(status.fix).not.toBeNull()
  })

  it('is unavailable when the keystore cannot be loaded', async () => {
    const path = tempIdentity()
    await writeIdentity(path, HEX_PUBKEY)
    const status = await signerStatus({ identityPath: path, keystoreAvailable: () => false })
    expect(status.state).toBe('unavailable')
  })
})

describe('OS keystore module', () => {
  it('loads its native binding on this platform (no entry is read or written)', () => {
    expect(osKeystoreAvailable()).toBe(true)
  })
})
