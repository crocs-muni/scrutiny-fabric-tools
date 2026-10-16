/**
 * NIP-42 authenticated relay socket.
 *
 * The mirror's own relay requires AUTH (npub allowed); public relays may challenge any time.
 * `authedSocket` wraps a raw WebSocket with:
 *
 * - NIP-42 handshake: answer `["AUTH", challenge]` with a signed kind:22242 event
 *   (`relay` + `challenge` tags, empty content), CF. NIP-42 §client.
 * - NIP-20 acks: `publish(event)` resolves `{ok, msg}` from the relay's `["OK", id, ok, msg]`,
 *   with a hard timeout when a relay never answers.
 * - One automatic retry when the first publish is rejected `auth-required` and auth completes.
 *
 * The socket is deliberately single-flight: `publish()` must be awaited before the next call
 * (publish/index.ts is sequential by contract).
 */
import { decode as nip19Decode } from 'nostr-tools/nip19'
import { finalizeEvent } from 'nostr-tools/pure'
import type { Event, EventTemplate } from 'nostr-tools/pure'

/** A secret key as 64-char hex or `nsec1…`, or raw 32 bytes. */
export type SecretKeyInput = string | Uint8Array

/** NIP-20 outcome as the caller sees it. `msg` is the relay's fourth field (may be empty). */
export interface PublishAck {
  ok: boolean
  msg: string
}

/** The publish-facing socket contract (self-delimiting so tests can fake it). */
export interface AuthedSocket {
  readonly relay: string
  readonly closed: boolean
  /** True after the relay accepted our kind:22242 AUTH event. */
  readonly authed: boolean
  publish(event: Event): Promise<PublishAck>
  /** Most recent `["NOTICE", …]` text, for diagnostics. */
  lastNotice(): string | null
  close(): void
}

export interface AuthedSocketOptions {
  /** Websocket connect budget. Default 10 000 ms. */
  connectTimeoutMs?: number
  /** Budget awaiting the NIP-20 OK after sending an EVENT. Default 15 000 ms. */
  ackTimeoutMs?: number
  /** Budget waiting for the relay to accept our AUTH event. Default 10 000 ms. */
  authTimeoutMs?: number
  /**
   * The URL written into the AUTH event's `relay` tag. Needed when the client
   * reaches the relay through a tunnel/proxy: relays verify the tag against
   * their OWN public URL (khatru auth hook: `expected relay URL 'ws://…'`).
   * Defaults to the socket `relay`.
   */
  authRelayUrl?: string
  log?: (line: string) => void
}

const AUTH_REQUIRED_RE = /auth-required/i

/** Decode a secret key from hex, `nsec1…`, or raw bytes. Throws on anything else. */
export function toSecretKey(input: SecretKeyInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 32) return input
    throw new Error(`secret key must be 32 bytes, got ${input.length}`)
  }
  const value = input.trim()
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
  }
  if (value.startsWith('nsec1')) {
    const decoded = nip19Decode(value)
    if (decoded.type === 'nsec') return decoded.data
    throw new Error(`expected nsec1…, decoded ${decoded.type}`)
  }
  throw new Error(
    `unsupported key format: want 64-char hex or nsec1… (got ${value.length > 12 ? `${value.slice(0, 8)}…` : value})`,
  )
}

/** Build the kind:22242 AUTH response for one relay challenge (NIP-42). */
export function buildAuthEvent(relay: string, challenge: string, key: SecretKeyInput): Event {
  const template: EventTemplate = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', relay],
      ['challenge', challenge],
    ],
    content: '',
  }
  return finalizeEvent(template, toSecretKey(key))
}

class AuthedRelaySocket implements AuthedSocket {
  readonly relay: string
  private readonly secretKey: Uint8Array
  private readonly ws: WebSocket
  private readonly options: Required<
    Pick<AuthedSocketOptions, 'connectTimeoutMs' | 'ackTimeoutMs' | 'authTimeoutMs'>
  > & { authRelayUrl: string }
  private readonly log: (line: string) => void

  private readonly openPromise: Promise<void>
  private isClosed = false

  private authChallenge: string | null = null
  private authEventId: string | null = null
  private authSettled = false
  private authWaiters: Array<(ok: boolean) => void> = []

  private readonly ackWaiters = new Map<string, (ack: PublishAck) => void>()
  private notice: string | null = null

  constructor(relay: string, key: SecretKeyInput, options: AuthedSocketOptions) {
    this.relay = relay
    this.secretKey = toSecretKey(key)
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 15_000,
      authTimeoutMs: options.authTimeoutMs ?? 10_000,
      authRelayUrl: options.authRelayUrl ?? '',
    }
    this.log = options.log ?? (() => {})

    this.ws = new WebSocket(relay)
    this.openPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`connect timeout after ${this.options.connectTimeoutMs}ms`))
      }, this.options.connectTimeoutMs)
      this.ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      this.ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`websocket error connecting to ${relay}`))
      }
      this.ws.onclose = (ev: CloseEvent) => {
        clearTimeout(timer)
        if (!this.isClosed) reject(new Error(`closed before open (code ${ev.code})`))
        this.onClose(ev.code, ev.reason)
      }
      this.ws.onmessage = (ev: MessageEvent) => {
        this.onMessage(typeof ev.data === 'string' ? ev.data : '')
      }
    })
    // If nothing ever awaits the open promise, keep the rejection from surfacing as unhandled.
    this.openPromise.catch(() => {})
  }

  get closed(): boolean {
    return this.isClosed
  }

  get authed(): boolean {
    return this.authSettled
  }

  lastNotice(): string | null {
    return this.notice
  }

  async publish(event: Event): Promise<PublishAck> {
    if (this.isClosed) return { ok: false, msg: 'socket closed' }
    try {
      await this.openPromise
    } catch (err) {
      return {
        ok: false,
        msg: `connect failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    // Relay demanded auth on connect: complete it before writing.
    if (this.authChallenge !== null && !this.authSettled) {
      await this.waitForAuth(this.options.authTimeoutMs)
    }
    let ack = await this.sendAndAwaitAck(event)
    if (!ack.ok && AUTH_REQUIRED_RE.test(ack.msg) && !this.authSettled) {
      const authed = await this.waitForAuth(this.options.authTimeoutMs)
      if (authed) ack = await this.sendAndAwaitAck(event)
    }
    return ack
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    try {
      this.ws.close()
    } catch {
      // Already closing/closed.
    }
    this.flushPending('socket closed by client')
  }

  private send(payload: unknown[]): boolean {
    if (this.ws.readyState !== 1) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  private sendAndAwaitAck(event: Event): Promise<PublishAck> {
    return new Promise<PublishAck>((resolve) => {
      if (this.isClosed) {
        resolve({ ok: false, msg: 'socket closed before send' })
        return
      }
      const timer = setTimeout(() => {
        this.ackWaiters.delete(event.id)
        resolve({ ok: false, msg: `timeout after ${this.options.ackTimeoutMs}ms awaiting OK` })
      }, this.options.ackTimeoutMs)
      this.ackWaiters.set(event.id, (ack) => {
        clearTimeout(timer)
        resolve(ack)
      })
      if (!this.send(['EVENT', event])) {
        clearTimeout(timer)
        this.ackWaiters.delete(event.id)
        resolve({ ok: false, msg: 'socket not open for send' })
      }
    })
  }

  private waitForAuth(timeoutMs: number): Promise<boolean> {
    if (this.authSettled) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.authWaiters.push((ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
    })
  }

  private settleAuth(ok: boolean, msg: string): void {
    this.authSettled = ok
    this.log(`[auth] ${ok ? 'accepted' : `rejected: ${msg}`}`)
    if (!ok) this.authEventId = null
    const waiters = this.authWaiters
    this.authWaiters = []
    for (const waiter of waiters) waiter(ok)
  }

  private onMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
    const [type, ...rest] = parsed as [string, ...unknown[]]
    if (type === 'AUTH') {
      const challenge = rest[0]
      if (typeof challenge !== 'string' || this.authSettled) return
      this.authChallenge = challenge
      const authEvent = buildAuthEvent(this.options.authRelayUrl !== '' ? this.options.authRelayUrl : this.relay, challenge, this.secretKey)
      this.authEventId = authEvent.id
      this.log(`[auth] challenged, responding (event ${authEvent.id.slice(0, 12)}…)`)
      if (!this.send(['AUTH', authEvent])) this.settleAuth(false, 'socket not open for AUTH')
      return
    }
    if (type === 'OK') {
      const [id, ok, msg] = rest as [unknown, unknown, unknown]
      if (typeof id !== 'string') return
      const ack: PublishAck = { ok: ok === true, msg: typeof msg === 'string' ? msg : '' }
      if (id === this.authEventId) {
        this.settleAuth(ack.ok, ack.msg)
        return
      }
      const waiter = this.ackWaiters.get(id)
      if (waiter) {
        this.ackWaiters.delete(id)
        waiter(ack)
      }
      return
    }
    if (type === 'NOTICE') {
      const text = rest[0]
      if (typeof text === 'string') {
        this.notice = text
        this.log(`[notice] ${text}`)
      }
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.isClosed) return
    this.isClosed = true
    const detail = reason ? `: ${reason}` : ''
    this.flushPending(`connection closed (code ${code}${detail})`)
  }

  private flushPending(msg: string): void {
    for (const waiter of this.ackWaiters.values()) waiter({ ok: false, msg })
    this.ackWaiters.clear()
    const authWaiters = this.authWaiters
    this.authWaiters = []
    for (const waiter of authWaiters) waiter(false)
  }
}

/** Open `relay` and return the publish-facing wrapper; `key` may be hex, nsec, or bytes. */
export function authedSocket(
  relay: string,
  key: SecretKeyInput,
  options: AuthedSocketOptions = {},
): AuthedSocket {
  return new AuthedRelaySocket(relay, key, options)
}
