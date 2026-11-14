/**
 * NIP-42 authenticated relay socket for the MCP server (#108 A3).
 *
 * Ported from `packages/mirror/src/publish/auth.ts`: the handshake, the NIP-20 ack matching and
 * the wording of the failure paths are that file's work, kept recognisable so a fix reads across.
 *
 * **REUSE DECISION: B (port), not A (import it through a `"./publish/auth"` subpath).** D6 already
 * rules relay adapters a copy-paste concern rather than a shared dependency — "publishing
 * `@scrutiny-fabric/relay` with a hard `nostr-tools` dependency *is* forcing a relay library"
 * (`docs/DECISIONS-2026-07-27.md` D6; `examples/README.md`: "Do not add them as dependencies") —
 * and the same reasoning holds inside the repo. Three concrete reasons settle it here:
 *
 * - the mirror socket builds its own `new WebSocket(relay)` in the constructor (auth.ts:129), so
 *   A3's tests could not drive an in-memory relay and A4's NIP-46 channel could not reuse it
 *   without editing the file — that is a fork, not a reuse;
 * - it publishes only: no REQ/EOSE path (`fetchById`), no reconnect policy, and its ack collapses
 *   "the relay said no" with "the connection died", which `verify_event` must tell apart (#108 A4);
 * - mirror is a bun-script importer (`packages/mirror/tsconfig.json`: `types: ["bun"]`); this
 *   package is a Node 22 stdio server (`lib: ["ES2022"]`, `types: ["node"]`), and a `.ts` subpath
 *   export would pull the CLI's source into this tsc program — `skipLibCheck` covers `.d.ts` only.
 *
 * What the relay enforces, and where the messages a user sees come from:
 *
 * - every write needs NIP-42 (`relay/internal/gate/gate.go` `AuthGate.Check`; unauthenticated
 *   writes are rejected with `MsgAuthRequired`, "auth-required: writes require authentication", so
 *   khatru attaches a fresh challenge — `gate.go:49-51`, `gate.go:82-85`). Reads are never gated:
 *   "Gates only run on writes" (`gate.go:10`), so {@link AuthedSocket.fetchById} never waits for
 *   auth.
 * - the challenge arrives eagerly on connect (`relay/internal/relay/relay.go`: `OnConnect =
 *   khatru.RequestAuth`) *and* with an auth-required rejection, so both orders are handled here.
 * - the AUTH event's `relay` tag must byte-match the relay's `SCRUTINY_SERVICE_URL`
 *   (`relay/README.md:81-82`, `relay/deploy/README.md:53-56`) — the reason
 *   {@link AuthedSocketOptions.authRelayUrl} exists apart from the socket URL, and the reason a
 *   mismatch is reported with both URLs instead of the relay's one line.
 */

import {
  AUTH_KIND,
  type AuthSigner,
  type NostrEvent,
  type PublishResult,
  RelayError,
  WS_OPEN,
  type WebSocketFactory,
  type WebSocketLike,
  assertSignedEvent,
  isEventId,
  isNostrEvent,
  platformWebSocket,
} from './types.ts'

/** khatru prefixes every "you are not authenticated" rejection this way (gate.go:49-51). */
const AUTH_REQUIRED_RE = /auth-required/i

/** Budgets in milliseconds. Generous defaults: a NIP-46 bunker may prompt a human to approve. */
export interface RelayTimeouts {
  /** Opening the socket. */
  readonly connectMs: number
  /** One NIP-42 exchange: challenge signed, AUTH sent, OK awaited. */
  readonly authMs: number
  /** One NIP-20 OK after an EVENT. */
  readonly ackMs: number
  /** One REQ: first matching event or EOSE. */
  readonly readMs: number
}

const DEFAULT_TIMEOUTS: RelayTimeouts = Object.freeze({
  connectMs: 10_000,
  authMs: 10_000,
  ackMs: 15_000,
  readMs: 10_000,
})

export interface AuthedSocketOptions {
  /** The URL the socket connects to. */
  readonly relayUrl: string
  /**
   * The URL written into the AUTH event's `relay` tag. Defaults to {@link relayUrl}, which is right
   * whenever the client dials the relay's own public URL. Set it explicitly when a tunnel or proxy
   * fronts the relay: the relay verifies the tag against `SCRUTINY_SERVICE_URL`, byte for byte, and
   * a trailing slash or a `ws://` vs `wss://` difference is a rejected handshake.
   */
  readonly authRelayUrl?: string
  /** Signs the kind 22242 AUTH event (D13); the socket never sees key material. */
  readonly signer: AuthSigner
  /** Defaults to {@link platformWebSocket}; tests pass an in-memory relay. */
  readonly wsFactory?: WebSocketFactory
  /** Overrides for {@link DEFAULT_TIMEOUTS}, per field. */
  readonly timeouts?: Partial<RelayTimeouts>
  /** Diagnostics only; never called with key material or frame contents. */
  readonly log?: (line: string) => void
}

/** The publish/fetch-facing socket; self-delimiting so a test relay can stand in for it. */
export interface AuthedSocket {
  /** The socket URL, for messages. */
  readonly url: string
  /** True once the socket is closed, by either side. A closed socket is never reopened here. */
  readonly closed: boolean
  /** True only after the relay accepted our latest kind 22242 AUTH event. */
  readonly authed: boolean
  /** Resolves on `open`, rejects with a retryable {@link RelayError} on connect failure. */
  ready(): Promise<void>
  /**
   * Send one signed event and resolve with the relay's NIP-20 verdict.
   *
   * Throws {@link RelayError} when there is no verdict: connect failure, connection lost, or no
   * `["OK", <id>, …]` within `ackMs`. A timeout is deliberately *not* a rejection — the write may
   * have landed — so the caller decides whether to verify (`fetchById`) or republish.
   */
  publish(event: NostrEvent): Promise<PublishResult>
  /**
   * `REQ {"ids":[id]}`, then the matching event or `null` when the relay says EOSE with nothing.
   *
   * Throws on a `CLOSED` answer and on timeout: "the relay has no such event" and "the relay did
   * not answer" are different facts, and `verify_event` must report them differently. The returned
   * event is the relay's JSON, shape-checked only — id/signature verification is the caller's job.
   */
  fetchById(id: string, timeoutMs?: number): Promise<NostrEvent | null>
  /** Most recent `["NOTICE", …]` text, for timeout diagnostics. */
  lastNotice(): string | null
  close(): void
}

/** The relay's answer to one EVENT, or a transport-shaped failure with the same discriminant. */
type AckOutcome =
  | { readonly kind: 'answer'; readonly accepted: boolean; readonly message: string }
  | { readonly kind: 'failure'; readonly reason: string; readonly retryable: boolean }

interface ReadWaiter {
  readonly eventId: string
  readonly timer: ReturnType<typeof setTimeout>
  readonly settle: (event: NostrEvent | null) => void
  readonly fail: (error: RelayError) => void
}

class AuthedRelaySocket implements AuthedSocket {
  // Promises here are executor-form on purpose: the package compiles with `lib: ["ES2022"]`, so
  // `Promise.withResolvers` (ES2024) is not in scope, and every one of them needs a resolver kept
  // outside the executor's lifetime anyway (ack and read maps).
  readonly url: string
  private readonly authRelayUrl: string
  private readonly signer: AuthSigner
  private readonly ws: WebSocketLike
  private readonly timeouts: RelayTimeouts
  private readonly log: (line: string) => void
  private readonly readyPromise: Promise<void>

  private opened = false
  private isClosed = false
  private notice: string | null = null

  private challenge: string | null = null
  private challengeAnswered: string | null = null
  /**
   * AUTH event id → the challenge it quotes. A map, not one field: two concurrent writes can each
   * provoke a challenge, and the relay rejects the older one as stale. That rejection must not read
   * as "authentication failed" for the connection while the current attempt is still in flight.
   */
  private readonly authAttempts = new Map<string, string>()
  private authSettled = false
  private authAccepted = false
  private authMessage: string | null = null
  private authWaiters: Array<(ok: boolean) => void> = []

  private readonly acks = new Map<string, (outcome: AckOutcome) => void>()
  private readonly reads = new Map<string, ReadWaiter>()
  private subCounter = 0

  constructor(options: AuthedSocketOptions) {
    this.url = options.relayUrl
    this.authRelayUrl = options.authRelayUrl ?? options.relayUrl
    this.signer = options.signer
    this.timeouts = resolveTimeouts(options.timeouts)
    this.log = options.log ?? (() => {})

    this.ws = (options.wsFactory ?? platformWebSocket)(this.url)
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new RelayError(`connect timeout after ${this.timeouts.connectMs}ms`, { retryable: true }),
        )
      }, this.timeouts.connectMs)
      this.ws.onopen = () => {
        clearTimeout(timer)
        this.opened = true
        this.log('[ws] open')
        resolve()
      }
      this.ws.onerror = () => {
        clearTimeout(timer)
        reject(new RelayError(`websocket error connecting to ${this.url}`, { retryable: true }))
      }
      this.ws.onclose = (event) => {
        clearTimeout(timer)
        if (!this.opened) {
          reject(
            new RelayError(
              `connection closed before open (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
              { retryable: true },
            ),
          )
        }
        this.onClose(event.code, event.reason)
      }
      this.ws.onmessage = (event) => this.onFrame(event.data)
    })
    // A caller may check the socket's state without ever awaiting `ready`; keep the rejection from
    // surfacing as an unhandled one, the caller still sees it on `ready()` / the next operation.
    this.readyPromise.catch(() => {})
  }

  get closed(): boolean {
    return this.isClosed
  }

  get authed(): boolean {
    return this.authSettled && this.authAccepted
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  lastNotice(): string | null {
    return this.notice
  }

  async publish(event: NostrEvent): Promise<PublishResult> {
    assertSignedEvent(event)
    await this.ready()

    // khatru challenges on connect (`OnConnect = khatru.RequestAuth`), so a write attempted before
    // the handshake finished would be rejected once for free. Wait it out when a challenge is
    // already in hand; a rejected handshake is not fatal here — the write that follows carries the
    // relay's own verdict, which is what the caller needs to read.
    if (this.challenge !== null && !this.authSettled) {
      await this.waitForAuth(this.timeouts.authMs)
    }

    let outcome = await this.exchange(event)
    if (outcome.kind === 'answer' && !outcome.accepted && AUTH_REQUIRED_RE.test(outcome.message)) {
      // The rejection is accompanied by a fresh challenge (gate.go:82-85), usually delivered just
      // before the OK, so this second wait normally finds the handshake already complete.
      const authed = await this.waitForAuth(this.timeouts.authMs)
      if (!authed) throw this.authFailure(outcome.message)
      outcome = await this.exchange(event)
    }
    if (outcome.kind === 'failure') {
      throw new RelayError(outcome.reason, { retryable: outcome.retryable })
    }
    return { accepted: outcome.accepted, message: outcome.message }
  }

  async fetchById(
    id: string,
    timeoutMs: number = this.timeouts.readMs,
  ): Promise<NostrEvent | null> {
    if (!isEventId(id)) {
      throw new RelayError(
        `fetchById: want a 64-char lowercase hex event id (NIP-01), got "${id.slice(0, 32)}"`,
      )
    }
    await this.ready()
    // No auth wait: the relay gates writes only (relay/internal/gate/gate.go:10).
    this.subCounter += 1
    const subId = `mcp-read-${this.subCounter}`
    return await new Promise<NostrEvent | null>((resolve, reject) => {
      const finish = (event: NostrEvent | null): void => {
        clearTimeout(timer)
        this.reads.delete(subId)
        // NIP-01 §subscriptions: a finished read closes its subscription, so a long-lived socket
        // does not accumulate them (the MCP server keeps one socket for the whole session).
        this.send(['CLOSE', subId])
        resolve(event)
      }
      const abort = (error: RelayError): void => {
        clearTimeout(timer)
        this.reads.delete(subId)
        reject(error)
      }
      const timer = setTimeout(() => {
        abort(
          new RelayError(
            `no EOSE for REQ {"ids":["${id}"]} within ${timeoutMs}ms${this.noticeSuffix()}`,
          ),
        )
      }, timeoutMs)
      this.reads.set(subId, { eventId: id, timer, settle: finish, fail: abort })
      if (!this.send(['REQ', subId, { ids: [id] }])) {
        abort(new RelayError('socket not open for REQ', { retryable: true }))
      }
    })
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    try {
      this.ws.close()
    } catch {
      // Already closing or closed; the pending work is flushed below either way.
    }
    this.flush('socket closed by client', false)
  }

  private logAck(outcome: AckOutcome): void {
    if (outcome.kind === 'failure') this.log(`[ack] ${outcome.reason}`)
    else this.log(`[ack] ${outcome.accepted ? 'accepted' : `rejected: ${outcome.message}`}`)
  }

  private send(payload: unknown[]): boolean {
    if (this.isClosed || this.ws.readyState !== WS_OPEN) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  private exchange(event: NostrEvent): Promise<AckOutcome> {
    return new Promise<AckOutcome>((resolve) => {
      if (this.isClosed) {
        resolve({ kind: 'failure', reason: 'socket closed before send', retryable: true })
        return
      }
      const seq = event.id.slice(0, 12)
      const timer = setTimeout(() => {
        this.acks.delete(event.id)
        resolve({
          kind: 'failure',
          reason: `no NIP-20 OK for event ${seq}… within ${this.timeouts.ackMs}ms${this.noticeSuffix()}`,
          // Unknown, not rejected: the relay may have stored the event and lost the reply. A retry
          // with the same id cannot duplicate the event (ids are content-addressed), but it can
          // confuse a caller's success reporting, so verification (`fetchById`) is the honest
          // follow-up and this stays out of the automatic reconnect path.
          retryable: false,
        })
      }, this.timeouts.ackMs)
      this.acks.set(event.id, (outcome) => {
        clearTimeout(timer)
        this.logAck(outcome)
        resolve(outcome)
      })
      if (!this.send(['EVENT', event])) {
        clearTimeout(timer)
        this.acks.delete(event.id)
        resolve({ kind: 'failure', reason: 'socket not open for send', retryable: true })
      }
    })
  }

  private waitForAuth(timeoutMs: number): Promise<boolean> {
    if (this.authSettled) return Promise.resolve(this.authAccepted)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.authWaiters.push((ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
    })
  }

  private async signAndSendAuth(challenge: string): Promise<void> {
    let authEvent: NostrEvent
    try {
      authEvent = await this.signer.sign({
        kind: AUTH_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['relay', this.authRelayUrl],
          ['challenge', challenge],
        ],
        content: '',
      })
    } catch (cause) {
      // A failure signing a superseded challenge says nothing about the current handshake.
      if (this.challengeAnswered === challenge) {
        this.settleAuth(
          false,
          `signer failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      return
    }
    if (this.isClosed) {
      this.settleAuth(false, 'socket closed before AUTH was sent')
      return
    }
    if (this.challengeAnswered !== challenge) return // a newer challenge superseded this one
    this.authAttempts.set(authEvent.id, challenge)
    this.log(`[auth] challenged, responding (event ${authEvent.id.slice(0, 12)}…)`)
    if (!this.send(['AUTH', authEvent])) this.settleAuth(false, 'socket not open for AUTH')
  }

  private settleAuth(accepted: boolean, message: string): void {
    this.authSettled = true
    this.authAccepted = accepted
    this.authMessage = message
    this.log(`[auth] ${accepted ? 'accepted' : `rejected: ${message}`}`)
    const waiters = this.authWaiters
    this.authWaiters = []
    for (const waiter of waiters) waiter(accepted)
  }

  /**
   * The footgun, reported as one line: a handshake the relay refused names what was signed, the
   * relay's own words, and both places the byte-match is specified.
   */
  private authFailure(reason: string): RelayError {
    const relaySaid = this.authMessage === null ? 'no message' : `"${this.authMessage}"`
    return new RelayError(
      [
        `NIP-42 authentication failed (${reason}): relay said ${relaySaid}.`,
        `The AUTH event's relay tag was "${this.authRelayUrl}"; the relay accepts it only when it`,
        'byte-matches SCRUTINY_SERVICE_URL (relay/README.md:81-82) — set SCRUTINY_RELAY_URL to',
        'that URL, or pass authRelayUrl explicitly when a proxy fronts the relay.',
      ].join(' '),
    )
  }

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return // NIP-01 messages are JSON text; binary frames are not ours
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
    const [type, ...rest] = parsed as [string, ...unknown[]]
    switch (type) {
      case 'AUTH':
        this.onAuth(rest[0])
        return
      case 'OK':
        this.onOk(rest[0], rest[1], rest[2])
        return
      case 'EVENT':
        this.onEvent(rest[0], rest[1])
        return
      case 'EOSE':
        this.onEose(rest[0])
        return
      case 'CLOSED':
        this.onClosed(rest[0], rest[1])
        return
      case 'NOTICE':
        if (typeof rest[0] === 'string') {
          this.notice = rest[0]
          this.log(`[notice] ${rest[0]}`)
        }
        return
      default:
        return // `COUNT`, `AUTH`-less extensions, and anything else are not this client's traffic
    }
  }

  private onAuth(challenge: unknown): void {
    if (typeof challenge !== 'string' || this.isClosed) return
    this.challenge = challenge
    // A repeat of the answered challenge is a relay replay; a new one is a new handshake (khatru
    // sends a fresh challenge with every auth-required rejection — gate.go:82-85).
    if (challenge === this.challengeAnswered && this.authSettled) return
    this.challengeAnswered = challenge
    this.authAccepted = false
    this.authSettled = false
    this.signAndSendAuth(challenge).catch(() => {}) // failures are settled inside, never thrown here
  }

  private onOk(id: unknown, ok: unknown, message: unknown): void {
    if (typeof id !== 'string') return
    const accepted = ok === true
    const text = typeof message === 'string' ? message : ''
    const authChallenge = this.authAttempts.get(id)
    if (authChallenge !== undefined) {
      this.authAttempts.delete(id)
      // A superseded attempt is not a verdict on this connection: the relay rejected the challenge
      // it replaced (two writes can each provoke one), and the current attempt is still in flight.
      if (authChallenge !== this.challenge) return
      this.settleAuth(accepted, text)
      return
    }
    const waiter = this.acks.get(id)
    if (waiter === undefined) return
    this.acks.delete(id)
    waiter({ kind: 'answer', accepted, message: text })
  }

  private onEvent(subId: unknown, event: unknown): void {
    if (typeof subId !== 'string') return
    const waiter = this.reads.get(subId)
    if (waiter === undefined) return
    if (!isNostrEvent(event) || event.id !== waiter.eventId) return
    waiter.settle(event)
  }

  private onEose(subId: unknown): void {
    if (typeof subId !== 'string') return
    this.reads.get(subId)?.settle(null)
  }

  private onClosed(subId: unknown, message: unknown): void {
    if (typeof subId !== 'string') return
    const waiter = this.reads.get(subId)
    if (waiter === undefined) return
    const text = typeof message === 'string' && message !== '' ? message : 'closed by relay'
    // Non-retryable: the relay made a decision about this filter, and a new socket would face the
    // same one. (A relay that changed its mind says so with a different message on the next REQ.)
    waiter.fail(new RelayError(`relay CLOSED the REQ: ${text}`))
  }

  private onClose(code: number, reason: string): void {
    if (this.isClosed) return
    this.isClosed = true
    const detail = reason === '' ? '' : `: ${reason}`
    this.flush(`connection closed (code ${code}${detail})`, true)
  }

  private flush(reason: string, retryable: boolean): void {
    for (const waiter of this.acks.values()) {
      waiter({ kind: 'failure', reason, retryable })
    }
    this.acks.clear()
    for (const waiter of [...this.reads.values()]) {
      waiter.fail(new RelayError(reason, { retryable }))
    }
    this.reads.clear()
    this.authAttempts.clear()
    const authWaiters = this.authWaiters
    this.authWaiters = []
    for (const waiter of authWaiters) waiter(false)
  }

  private noticeSuffix(): string {
    return this.notice === null ? '' : `; relay NOTICE: ${this.notice}`
  }
}

/**
 * Open `relayUrl` and return the publish-facing wrapper. The connection starts immediately, so an
 * eager NIP-42 challenge is in hand before the first `publish`; `ready()` gates writes on `open`.
 *
 * Throws {@link RelayError} if the socket factory itself fails (no `WebSocket` global).
 */
export function authedSocket(options: AuthedSocketOptions): AuthedSocket {
  return new AuthedRelaySocket(options)
}

function resolveTimeouts(input: Partial<RelayTimeouts> | undefined): RelayTimeouts {
  return {
    connectMs: input?.connectMs ?? DEFAULT_TIMEOUTS.connectMs,
    authMs: input?.authMs ?? DEFAULT_TIMEOUTS.authMs,
    ackMs: input?.ackMs ?? DEFAULT_TIMEOUTS.ackMs,
    readMs: input?.readMs ?? DEFAULT_TIMEOUTS.readMs,
  }
}
