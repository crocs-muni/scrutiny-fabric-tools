/**
 * NIP-46 client against an in-memory cooperative bunker, plus the adversarial answers a real
 * signer (or a relay that rewrites traffic) can give.
 *
 * The fake lives in `test/identity/fakeBunker.ts` because #108 A4's handler tests publish through
 * the same cooperative bunker; it is correct first and adversarial on a mode switch.
 */

import type { UnsignedEvent } from '@scrutiny-fabric/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVER_NAME, loadConfig } from '../src/config.ts'
import { loadSigner } from '../src/identity.ts'
import {
  type BunkerSigner,
  Nip46Error,
  createBunkerSigner,
  parseBunkerUri,
} from '../src/identity/nip46.ts'
import { verifySignedEvent } from '../src/identity/sign.ts'
import { CLIENT_SECRET, CLOCK, FakeBunker, type FakeRelaySocket } from './identity/fakeBunker.ts'

function template(overrides: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    kind: 1,
    created_at: CLOCK(),
    tags: [['t', 'scrutiny-fabric']],
    content: 'Published through a bunker',
    ...overrides,
  }
}

const openSigners: BunkerSigner[] = []

afterEach(() => {
  for (const signer of openSigners.splice(0)) signer.close()
})

async function connect(
  bunker: FakeBunker,
  options: {
    readonly secret?: string
    readonly appName?: string
    readonly requestTimeoutMs?: number
  } = {},
): Promise<{ signer: BunkerSigner; socket: FakeRelaySocket }> {
  const params = new URLSearchParams({ relay: 'wss://relay.example' })
  if (options.secret !== undefined) params.set('secret', options.secret)
  const uri = `bunker://${bunker.remotePubkey}?${params.toString()}`
  const signer = await createBunkerSigner({
    uri,
    transport: bunker,
    localSecretKey: CLIENT_SECRET,
    ...(options.appName === undefined ? {} : { appName: options.appName }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  })
  openSigners.push(signer)
  const socket = bunker.sockets.at(-1)
  if (socket === undefined) throw new Error('fake transport did not create a socket')
  return { signer, socket }
}

/** Await a rejection that must be a typed NIP-46 failure, and return it for reason assertions. */
async function rejectionOf(promise: Promise<unknown>): Promise<Nip46Error> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Nip46Error)
    return error as Nip46Error
  }
  throw new Error('expected the NIP-46 operation to reject')
}

describe('parseBunkerUri', () => {
  const pubkey = 'ab'.repeat(32)

  it('parses the pubkey, every relay, and the optional secret', () => {
    const parsed = parseBunkerUri(
      `bunker://${pubkey}?relay=${encodeURIComponent('wss://relay.example')}` +
        `&relay=${encodeURIComponent('ws://127.0.0.1:8080')}&secret=s3cret`,
    )
    expect(parsed).toStrictEqual({
      remotePubkey: pubkey,
      relays: ['wss://relay.example', 'ws://127.0.0.1:8080'],
      secret: 's3cret',
    })
  })

  it('treats an empty secret as absent', () => {
    expect(
      parseBunkerUri(`bunker://${pubkey}?relay=wss%3A%2F%2Frelay.example&secret=`).secret,
    ).toBeUndefined()
  })

  it('percent-decodes the secret exactly once and keeps + literal', () => {
    // A secret containing '%' is encoded as %25; a literal '+' must not become a space the way
    // URLSearchParams would decode it (form-urlencoded semantics do not apply to a URI).
    expect(parseBunkerUri(`bunker://${pubkey}?relay=wss%3A%2F%2Fr&secret=a%25b`).secret).toBe('a%b')
    expect(parseBunkerUri(`bunker://${pubkey}?relay=wss%3A%2F%2Fr&secret=a+b`).secret).toBe('a+b')
    expect(parseBunkerUri(`bunker://${pubkey}?relay=wss%3A%2F%2Fr&secret=a%2Bb`).secret).toBe('a+b')
  })

  it('rejects malformed percent-encoding instead of echoing the query', () => {
    expect(() => parseBunkerUri(`bunker://${pubkey}?relay=wss%3A%2F%2Fr&secret=a%zz`)).toThrow(
      /malformed percent-encoding/u,
    )
  })

  it('rejects a URI without a relay', () => {
    expect(() => parseBunkerUri(`bunker://${pubkey}`)).toThrow(/at least one relay/u)
  })

  it('rejects a non-ws relay', () => {
    expect(() => parseBunkerUri(`bunker://${pubkey}?relay=https%3A%2F%2Frelay.example`)).toThrow(
      /ws:\/\/ or wss:\/\//u,
    )
  })

  it('rejects an npub host and a nostrconnect URI', () => {
    expect(() => parseBunkerUri(`bunker://${'npub1abc'}?relay=wss%3A%2F%2Fr`)).toThrow(
      /64-char hex/u,
    )
    expect(() => parseBunkerUri(`nostrconnect://${pubkey}?relay=wss%3A%2F%2Fr`)).toThrow(
      /bunker:\/\/ URI/u,
    )
  })
})

describe('createBunkerSigner handshake', () => {
  it('authorizes with the URI secret, learns the user key, and sends metadata', async () => {
    const bunker = new FakeBunker()
    bunker.requiredSecret = 's3cret'
    const { signer } = await connect(bunker, { secret: 's3cret', appName: SERVER_NAME })

    expect(signer.remotePubkey).toBe(bunker.remotePubkey)
    expect(signer.publicKey).toBe(bunker.userPubkey)
    expect(bunker.badClientEvents).toStrictEqual([])

    const connectRequest = bunker.requests.find((request) => request.method === 'connect')
    expect(connectRequest?.params).toStrictEqual([
      bunker.remotePubkey,
      's3cret',
      '',
      JSON.stringify({ name: SERVER_NAME }),
    ])
  })

  it('rejects a bunker pubkey that is hex but not on the curve', async () => {
    const bunker = new FakeBunker()
    const uri = `bunker://${'00'.repeat(32)}?relay=${encodeURIComponent('wss://relay.example')}`
    await expect(
      createBunkerSigner({ uri, transport: bunker, localSecretKey: CLIENT_SECRET }),
    ).rejects.toThrow(/not a valid secp256k1 pubkey/u)
    expect(bunker.sockets).toHaveLength(0)
  })

  it('rejects a mismatched secret with the bunker error, not a timeout', async () => {
    const bunker = new FakeBunker()
    bunker.requiredSecret = 'right'
    const error = await rejectionOf(connect(bunker, { secret: 'wrong' }))
    expect(error.reason).toBe('bunker-error')
    expect(error.message).toMatch(/invalid secret/u)
    expect(error.message).not.toMatch(/timed out/u)
    expect(bunker.sockets[0]?.closed).toBe(true)
  })

  it('surfaces an auth challenge instead of a timeout for an unapproved secret', async () => {
    const bunker = new FakeBunker()
    bunker.requiredSecret = 'right'
    bunker.mode = 'auth-url'
    const error = await rejectionOf(connect(bunker, { secret: 'wrong', requestTimeoutMs: 25 }))
    expect(error.reason).toBe('auth-required')
    expect(error.message).toMatch(/https:\/\/signer\.example\/authorize/u)
    expect(error.message).not.toMatch(/timed out/u)
    expect(bunker.sockets[0]?.closed).toBe(true)
  })

  it('rejects the auth challenge with the URL to open', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker)
    bunker.mode = 'auth-url'
    const error = await rejectionOf(signer.sign(template()))
    expect(error.reason).toBe('auth-required')
    expect(error.message).toMatch(
      /interactive authorization.*https:\/\/signer\.example\/authorize/u,
    )
  })

  it('times out when the bunker never answers sign_event', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker, { requestTimeoutMs: 25 })
    bunker.mode = 'drop-sign'
    const error = await rejectionOf(signer.sign(template()))
    expect(error.reason).toBe('timeout')
    expect(error.message).toMatch(/timed out after 25 ms/u)
  })

  it('never adopts a plaintext get_public_key answer', async () => {
    const bunker = new FakeBunker()
    bunker.mode = 'plaintext-gp'
    const error = await rejectionOf(connect(bunker, { requestTimeoutMs: 25 }))
    expect(error.reason).toBe('timeout')
    expect(error.message).toMatch(/did not decrypt with the NIP-44 conversation key/u)
    expect(bunker.sockets[0]?.closed).toBe(true)
  })
})

describe('createBunkerSigner sign_event', () => {
  it('returns the event signed by the user key, matching the template', async () => {
    const bunker = new FakeBunker()
    const { signer, socket } = await connect(bunker)
    const requested = template()
    const signed = await signer.sign(requested)

    expect(signed.pubkey).toBe(bunker.userPubkey)
    expect(signed.kind).toBe(requested.kind)
    expect(signed.created_at).toBe(requested.created_at)
    expect(signed.content).toBe(requested.content)
    expect(signed.tags).toStrictEqual(requested.tags)
    expect(verifySignedEvent(signed)).toBe(true)

    signer.close()
    expect(socket.closed).toBe(true)
    expect(socket.sentFrames.at(-1)).toStrictEqual(['CLOSE', socket.subscriptionId])
  })

  it('rejects an event re-signed with altered content', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker)
    bunker.mode = 'tamper-resigned'
    const error = await rejectionOf(signer.sign(template()))
    expect(error.reason).toBe('tampered')
    expect(error.message).toMatch(/does not match the requested template/u)
    expect(error.message).toMatch(/kind 1, created_at \d+/u)
    // The bunker-controlled content must not be echoed into a host-visible error.
    expect(error.message).not.toContain('(tampered)')
  })

  it('rejects an event whose id no longer matches its content', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker)
    bunker.mode = 'tamper-raw'
    const error = await rejectionOf(signer.sign(template()))
    expect(error.reason).toBe('tampered')
    expect(error.message).toMatch(/does not verify/u)
  })

  it('rejects a response authored by anyone but the configured bunker', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker, { requestTimeoutMs: 25 })
    bunker.mode = 'wrong-author'
    const error = await rejectionOf(signer.sign(template()))
    expect(error.reason).toBe('unexpected-author')
    expect(error.message).toContain(bunker.impostorSigner.publicKey)
    expect(error.message).toMatch(/not the configured bunker/u)
  })

  it('rejects an event signed by a different user key', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker)
    bunker.mode = 'wrong-user-key'
    const error = await rejectionOf(signer.sign(template()))
    expect(error.reason).toBe('wrong-user-key')
    expect(error.message).toMatch(/connected user key/u)
  })

  it('refuses a stale template before spending a bunker round-trip', async () => {
    const bunker = new FakeBunker()
    const { signer } = await connect(bunker)
    const before = bunker.requests.length
    const error = await rejectionOf(
      signer.sign(template({ created_at: CLOCK() - 2 * 60 * 60 - 1 })),
    )
    expect(error.reason).toBe('stale-template')
    expect(error.message).toMatch(/behind this machine's clock/u)
    expect(bunker.requests.length).toBe(before)
  })
})

describe('loadSigner facade', () => {
  it('signs with a dev key and reports its pubkey', async () => {
    const signer = await loadSigner(loadConfig({ NSEC: '01'.repeat(32) }))
    expect(signer.mode).toBe('dev-key')
    expect(signer.publicKey).toBe(
      '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
    )
    const event = await signer.sign(template())
    expect(verifySignedEvent(event)).toBe(true)
    expect(event.pubkey).toBe(signer.publicKey)
  })

  it('resolves the bunker branch over the injected transport', async () => {
    const bunker = new FakeBunker()
    const uri = `bunker://${bunker.remotePubkey}?relay=${encodeURIComponent('wss://relay.example')}`
    const signer = await loadSigner(loadConfig({ SCRUTINY_SIGNER: uri }), bunker)
    expect(signer.mode).toBe('nip46')
    expect(signer.publicKey).toBe(bunker.userPubkey)
    const event = await signer.sign(template())
    expect(event.pubkey).toBe(bunker.userPubkey)
    expect(verifySignedEvent(event)).toBe(true)
  })

  it('explains that a bunker needs a transport', async () => {
    const signerUri = `bunker://${'ab'.repeat(32)}?relay=wss%3A%2F%2Frelay.example`
    await expect(loadSigner(loadConfig({ SCRUTINY_SIGNER: signerUri }))).rejects.toThrow(
      /needs a relay transport/u,
    )
  })

  it('refuses to load with no signer configured', async () => {
    await expect(loadSigner(loadConfig({}))).rejects.toThrow(/no signer configured/u)
  })
})
