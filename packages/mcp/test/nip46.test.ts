/**
 * NIP-46 client against an in-memory cooperative bunker, plus the adversarial answers a real
 * signer (or a relay that rewrites traffic) can give.
 *
 * The fake is deliberately *correct first*: it verifies the client's kind-24133 request with the
 * same cryptographic path as the client, decrypts it, and answers with a signature by a distinct
 * "remote-signer" key while the user key is a third keypair. That separation is the point of
 * NIP-46, and it makes a client that confuses remote with user fail here rather than in production.
 */

import { hexToBytes } from '@noble/hashes/utils.js'
import { type NostrEvent, type UnsignedEvent, tagValues } from '@scrutiny-fabric/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVER_NAME, loadConfig } from '../src/config.ts'
import { loadSigner } from '../src/identity.ts'
import { decrypt, encrypt, getConversationKey } from '../src/identity/nip44.ts'
import {
  type BunkerSigner,
  NIP46_KIND,
  Nip46Error,
  createBunkerSigner,
  parseBunkerUri,
} from '../src/identity/nip46.ts'
import { createDevKeySigner, verifySignedEvent } from '../src/identity/sign.ts'
import type { RelayFrame, RelaySocket, RelayTransport } from '../src/identity/transport.ts'

interface RpcRequest {
  readonly id: string
  readonly method: string
  readonly params: readonly string[]
}

type BunkerMode =
  | 'normal'
  | 'tamper-resigned'
  | 'tamper-raw'
  | 'wrong-author'
  | 'wrong-user-key'
  | 'auth-url'
  | 'refuse-connect'
  | 'drop-sign'
  | 'plaintext-gp'

const REMOTE_SECRET = new Uint8Array(32).fill(9)
const USER_SECRET = new Uint8Array(32).fill(7)
const OTHER_USER_SECRET = new Uint8Array(32).fill(11)
const IMPOSTOR_SECRET = new Uint8Array(32).fill(13)
const CLIENT_SECRET = new Uint8Array(32).fill(3)
const CLOCK = (): number => Math.floor(Date.now() / 1000)

function template(overrides: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    kind: 1,
    created_at: CLOCK(),
    tags: [['t', 'scrutiny-fabric']],
    content: 'Published through a bunker',
    ...overrides,
  }
}

class FakeRelaySocket implements RelaySocket {
  /** Set when the fake sees the client's REQ, so responses use the real subscription id. */
  subscriptionId = ''
  readonly sentFrames: unknown[] = []
  readonly received: RelayFrame[] = []
  readonly url: string
  closed = false
  private readonly bunker: FakeBunker
  private readonly handlers = new Set<(frame: RelayFrame) => void>()

  constructor(url: string, bunker: FakeBunker) {
    this.url = url
    this.bunker = bunker
  }

  send(frame: string): void {
    const parsed: unknown = JSON.parse(frame)
    this.sentFrames.push(parsed)
    this.bunker.receive(this, parsed)
  }

  onMessage(handler: (frame: RelayFrame) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  close(): void {
    this.closed = true
    this.handlers.clear()
  }

  deliver(frame: RelayFrame): void {
    if (this.closed) return
    this.received.push(frame)
    for (const handler of this.handlers) handler(frame)
  }
}

/** A cooperative bunker with switchable misbehaviour; no sockets, no timers of its own. */
class FakeBunker implements RelayTransport {
  readonly remoteSigner = createDevKeySigner(REMOTE_SECRET)
  readonly userSigner = createDevKeySigner(USER_SECRET)
  readonly otherUserSigner = createDevKeySigner(OTHER_USER_SECRET)
  readonly impostorSigner = createDevKeySigner(IMPOSTOR_SECRET)
  readonly sockets: FakeRelaySocket[] = []
  readonly requests: RpcRequest[] = []
  readonly badClientEvents: string[] = []
  mode: BunkerMode = 'normal'
  requiredSecret: string | undefined

  get remotePubkey(): string {
    return this.remoteSigner.publicKey
  }

  get userPubkey(): string {
    return this.userSigner.publicKey
  }

  async connect(url: string): Promise<RelaySocket> {
    const socket = new FakeRelaySocket(url, this)
    this.sockets.push(socket)
    return socket
  }

  receive(socket: FakeRelaySocket, frame: unknown): void {
    if (!Array.isArray(frame) || frame[0] === undefined) {
      this.badClientEvents.push('frame is not an array')
      return
    }
    if (frame[0] === 'REQ') {
      socket.subscriptionId = String(frame[1] ?? '')
      return
    }
    if (frame[0] !== 'EVENT') return

    const event: unknown = frame[1]
    if (!verifySignedEvent(event)) {
      this.badClientEvents.push('request event does not verify')
      return
    }
    if (event.kind !== NIP46_KIND) {
      this.badClientEvents.push(`request kind ${event.kind}`)
      return
    }
    if (!tagValues(event, 'p').includes(this.remotePubkey)) {
      this.badClientEvents.push('request is not p-tagged to the remote signer')
      return
    }

    const conversationKey = getConversationKey(REMOTE_SECRET, hexToBytes(event.pubkey))
    let request: RpcRequest
    try {
      request = JSON.parse(decrypt(event.content, conversationKey)) as RpcRequest
    } catch {
      this.badClientEvents.push('request content does not decrypt')
      return
    }
    this.requests.push(request)

    const payload = this.answer(request)
    if (payload === undefined) return
    // `plaintext-gp` models a broken/malicious signer that puts the pubkey in the event content
    // without NIP-44. The client must never adopt it; it can only time out or fail authenticated.
    const plaintext = this.mode === 'plaintext-gp' && request.method === 'get_public_key'
    const responseEvent = this.signResponse(request, payload, event.pubkey, plaintext)
    socket.deliver(['EVENT', socket.subscriptionId, responseEvent])
  }

  private answer(request: RpcRequest): { result?: string; error?: string } | undefined {
    switch (request.method) {
      case 'connect':
        if (this.mode === 'auth-url') {
          return { result: 'auth_url', error: 'https://signer.example/authorize' }
        }
        if (this.mode === 'refuse-connect') return { error: 'invalid secret' }
        if (this.requiredSecret !== undefined && request.params[1] !== this.requiredSecret) {
          return { error: 'invalid secret' }
        }
        return { result: 'ack' }
      case 'get_public_key':
        return { result: this.userPubkey }
      case 'sign_event': {
        if (this.mode === 'drop-sign') return undefined
        if (this.mode === 'auth-url') {
          return { result: 'auth_url', error: 'https://signer.example/authorize' }
        }
        const requested = JSON.parse(request.params[0] ?? '{}') as UnsignedEvent
        return { result: JSON.stringify(this.signTemplate(requested)) }
      }
      default:
        return { error: `unsupported method ${request.method}` }
    }
  }

  private signTemplate(requested: UnsignedEvent): NostrEvent {
    switch (this.mode) {
      case 'tamper-resigned':
        // A competent malicious bunker: it re-signs the altered content, so only the template
        // comparison (not the id/sig check) can catch it.
        return this.userSigner.sign({ ...requested, content: `${requested.content} (tampered)` })
      case 'tamper-raw': {
        // A relay-side edit: the id/sig no longer match the content.
        const signed = this.userSigner.sign(requested)
        return { ...signed, content: `${signed.content} (tampered in flight)` }
      }
      case 'wrong-user-key':
        return this.otherUserSigner.sign(requested)
      default:
        return this.userSigner.sign(requested)
    }
  }

  private signResponse(
    request: RpcRequest,
    payload: { result?: string; error?: string },
    clientPubkey: string,
    plaintext = false,
  ): NostrEvent {
    const conversationKey = getConversationKey(REMOTE_SECRET, hexToBytes(clientPubkey))
    const content = plaintext
      ? JSON.stringify({ id: request.id, ...payload })
      : encrypt(JSON.stringify({ id: request.id, ...payload }), conversationKey)
    const signer = this.mode === 'wrong-author' ? this.impostorSigner : this.remoteSigner
    return signer.sign({
      kind: NIP46_KIND,
      created_at: CLOCK(),
      tags: [['p', clientPubkey]],
      content,
    })
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
    const signer = await loadSigner(loadConfig({ SCRUTINY_SIGNER_URI: uri }), bunker)
    expect(signer.mode).toBe('nip46')
    expect(signer.publicKey).toBe(bunker.userPubkey)
    const event = await signer.sign(template())
    expect(event.pubkey).toBe(bunker.userPubkey)
    expect(verifySignedEvent(event)).toBe(true)
  })

  it('explains that a bunker needs a transport', async () => {
    const signerUri = `bunker://${'ab'.repeat(32)}?relay=wss%3A%2F%2Frelay.example`
    await expect(loadSigner(loadConfig({ SCRUTINY_SIGNER_URI: signerUri }))).rejects.toThrow(
      /needs a relay transport/u,
    )
  })

  it('refuses to load with no signer configured', async () => {
    await expect(loadSigner(loadConfig({}))).rejects.toThrow(/no signer configured/u)
  })
})
