/**
 * A cooperative NIP-46 bunker with switchable misbehaviour, shared by the NIP-46 protocol tests
 * (`test/nip46.test.ts`) and the #108 A4 handler tests that publish through a bunker.
 *
 * The fake is deliberately *correct first*: it verifies the client's kind-24133 request with the
 * same cryptographic path as the client, decrypts it, and answers with a signature by a distinct
 * "remote-signer" key while the user key is a third keypair. That separation is the point of
 * NIP-46, and it makes a client that confuses remote with user fail here rather than in production.
 *
 * No sockets and no timers of its own: `connect` returns an in-memory socket whose `send` feeds
 * {@link FakeBunker.receive} synchronously.
 */

import { hexToBytes } from '@noble/hashes/utils.js'
import { type NostrEvent, type UnsignedEvent, tagValues } from '@scrutiny-fabric/core'
import { decrypt, encrypt, getConversationKey } from '../../src/identity/nip44.ts'
import { NIP46_KIND } from '../../src/identity/nip46.ts'
import { createDevKeySigner, verifySignedEvent } from '../../src/identity/sign.ts'
import type { RelayFrame, RelaySocket, RelayTransport } from '../../src/identity/transport.ts'

export interface RpcRequest {
  readonly id: string
  readonly method: string
  readonly params: readonly string[]
}

export type BunkerMode =
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
/** The client's disposable NIP-46 key in the protocol tests. */
export const CLIENT_SECRET = new Uint8Array(32).fill(3)
export const CLOCK = (): number => Math.floor(Date.now() / 1000)

export class FakeRelaySocket implements RelaySocket {
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
export class FakeBunker implements RelayTransport {
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
