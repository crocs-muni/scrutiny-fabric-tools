/**
 * One WebSocket to one relay: NIP-01 EVENT/OK and REQ, NIP-42 authentication (spec §8.2–§8.3).
 *
 * - Writes authenticate first when the relay has already sent a challenge (khatru sends one on
 *   connect). An `auth-required:` reply triggers one re-authentication, and one resend of the same
 *   bytes only when that authentication succeeded; when the relay never challenged or refused the
 *   AUTH, its reply is the verdict and nothing is resent.
 * - An OK frame resolves a write only when its id is exactly the id that was sent: a forged or
 *   truncated id must never release a child event for signing.
 * - Reads are never authenticated. A REQ accepts only events on its own subscription, and for an
 *   ids-REQ only the ids it asked for. A timeout is an error, never "absent".
 */

import type { NostrEvent } from '@crocs-muni/scrutiny-fabric'
import type { SignerPort } from '../signer/signer.js'

export interface RelayTimeouts {
  readonly connectMs: number
  /** Spec §8.2: wait 15 s for OK. */
  readonly okMs: number
  readonly eoseMs: number
}

const DEFAULT_TIMEOUTS: RelayTimeouts = { connectMs: 10_000, okMs: 15_000, eoseMs: 15_000 }

export interface PublishReply {
  readonly ok: boolean
  /** The relay's message, verbatim. */
  readonly message: string
}

export type RelayErrorKind = 'connect' | 'timeout' | 'closed'

export class RelayError extends Error {
  readonly kind: RelayErrorKind
  /** True when reconnecting and resending the same bytes may succeed. */
  readonly retryable: boolean
  readonly relayMessage: string | null
  constructor(kind: RelayErrorKind, message: string, relayMessage: string | null = null) {
    super(message)
    this.name = 'RelayError'
    this.kind = kind
    this.retryable = kind !== 'closed' || relayMessage === null
    this.relayMessage = relayMessage
  }
}

export interface RelayConnectionOptions {
  readonly url: string
  /** Signs the NIP-42 auth event (kind 22242, not a publishable record). */
  readonly signer: SignerPort
  /** Unix seconds; the clock the signer stamps with. */
  readonly now: () => number
  readonly timeouts?: RelayTimeouts
}

type Filter = Readonly<Record<string, unknown>>

interface Subscription {
  onEvent(event: NostrEvent): void
  onEose(): void
  onClosed(message: string): void
}

const EVENT_ID = /^[0-9a-f]{64}$/u
const EAGER_CHALLENGE_GRACE_MS = 500

function isEvent(value: unknown): value is NostrEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { pubkey?: unknown }).pubkey === 'string' &&
    Array.isArray((value as { tags?: unknown }).tags)
  )
}

export class RelayConnection {
  readonly #ws: WebSocket
  readonly #options: RelayConnectionOptions
  readonly #timeouts: RelayTimeouts
  readonly #pendingOk = new Map<string, (reply: PublishReply) => void>()
  readonly #subs = new Map<string, Subscription>()
  readonly #challengeWaiters = new Set<() => void>()
  readonly #closeWaiters = new Set<(error: RelayError) => void>()
  #challenge: string | null = null
  #authedChallenge: string | null = null
  #closed = false
  #subCounter = 0
  #firstWriteDone = false

  private constructor(ws: WebSocket, options: RelayConnectionOptions) {
    this.#ws = ws
    this.#options = options
    this.#timeouts = options.timeouts ?? DEFAULT_TIMEOUTS
    ws.addEventListener('message', (event) => this.#onMessage(String(event.data)))
    ws.addEventListener('close', () => this.#onClose())
  }

  static open(options: RelayConnectionOptions): Promise<RelayConnection> {
    const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(options.url)
      } catch {
        reject(new RelayError('connect', `cannot open a WebSocket to ${options.url}`))
        return
      }
      // Construct before 'open' so no frame (an eager AUTH challenge) is missed.
      const connection = new RelayConnection(ws, options)
      const timer = setTimeout(() => {
        ws.close()
        reject(
          new RelayError(
            'connect',
            `no WebSocket connection to ${options.url} within ${timeouts.connectMs} ms`,
          ),
        )
      }, timeouts.connectMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(connection)
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new RelayError('connect', `cannot connect to ${options.url}`))
      })
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    if (!this.#closed) this.#ws.close()
    this.#onClose()
  }

  /** Sends one signed event and returns the relay's verdict for exactly that id. */
  async publish(event: NostrEvent): Promise<PublishReply> {
    const frame = JSON.stringify(['EVENT', event])
    if (!this.#firstWriteDone) {
      // khatru sends its challenge right after the upgrade, which can land just after 'open'.
      // Waiting briefly once saves the auth-required round trip on every connection.
      this.#firstWriteDone = true
      await this.#nextChallenge(EAGER_CHALLENGE_GRACE_MS)
    }
    if (this.#challenge !== null && this.#challenge !== this.#authedChallenge)
      await this.#authenticate()
    const reply = await this.#send(event.id, frame)
    if (reply.ok || !reply.message.startsWith('auth-required:')) return reply
    // §8.3: re-authenticate once **and** resend. The resend is conditional on the authentication
    // having succeeded: a relay that never challenged, or that refused the AUTH, gets no second
    // unauthenticated EVENT — its `auth-required:` reply is the verdict the caller acts on.
    if (!(await this.#authenticate())) return reply
    return this.#send(event.id, frame)
  }

  /** Stored events among `ids`, keyed by id. Batching to the relay's `max_limit` is the caller's. */
  async fetchByIds(ids: readonly string[]): Promise<Map<string, NostrEvent>> {
    const wanted = new Set(ids)
    const found = new Map<string, NostrEvent>()
    await this.#request({ ids: [...wanted] }, (event) => {
      if (wanted.has(event.id)) found.set(event.id, event)
    })
    return found
  }

  /** Every event the relay returns for `filter` before EOSE. */
  async query(filter: Filter): Promise<NostrEvent[]> {
    const events: NostrEvent[] = []
    await this.#request(filter, (event) => events.push(event))
    return events
  }

  // -------------------------------------------------------------------------

  #send(id: string, frame: string): Promise<PublishReply> {
    return this.#await<PublishReply>(this.#timeouts.okMs, `no OK for event ${id}`, (resolve) => {
      this.#pendingOk.set(id, resolve)
      this.#ws.send(frame)
      return () => this.#pendingOk.delete(id)
    })
  }

  async #authenticate(): Promise<boolean> {
    const challenge = await this.#freshChallenge()
    if (challenge === null) return false
    const auth = await this.#options.signer.sign({
      kind: 22242,
      created_at: this.#options.now(),
      tags: [
        ['relay', this.#options.url],
        ['challenge', challenge],
      ],
      content: '',
    })
    const reply = await this.#send(auth.id, JSON.stringify(['AUTH', auth]))
    if (!reply.ok) return false
    this.#authedChallenge = challenge
    return true
  }

  /** A challenge not yet answered: the current one, or the next to arrive within the OK window. */
  async #freshChallenge(): Promise<string | null> {
    if (this.#challenge === null || this.#challenge === this.#authedChallenge) {
      await this.#nextChallenge(this.#timeouts.okMs)
    }
    return this.#challenge !== this.#authedChallenge ? this.#challenge : null
  }

  /** Waits up to `ms` for an unanswered challenge; returns early if one is already there. */
  async #nextChallenge(ms: number): Promise<void> {
    if (this.#challenge !== null && this.#challenge !== this.#authedChallenge) return
    try {
      await this.#await<void>(ms, 'no AUTH challenge', (resolve) => {
        const waiter = () => resolve()
        this.#challengeWaiters.add(waiter)
        return () => this.#challengeWaiters.delete(waiter)
      })
    } catch (cause) {
      if (!(cause instanceof RelayError && cause.kind === 'timeout')) throw cause
    }
  }

  #request(filter: Filter, onEvent: (event: NostrEvent) => void): Promise<void> {
    const subId = `scrutiny-${++this.#subCounter}`
    return this.#await<void>(
      this.#timeouts.eoseMs,
      `no EOSE for subscription ${subId}`,
      (resolve, reject) => {
        this.#subs.set(subId, {
          onEvent,
          onEose: resolve,
          onClosed: (message) =>
            reject(new RelayError('closed', `the relay closed subscription ${subId}`, message)),
        })
        this.#ws.send(JSON.stringify(['REQ', subId, filter]))
        return () => {
          const open = this.#subs.delete(subId)
          if (open && !this.#closed) this.#ws.send(JSON.stringify(['CLOSE', subId]))
        }
      },
    )
  }

  /**
   * Runs `start`, which registers a waiter and returns its cleanup. Settles on the waiter, on a
   * timeout, or on the socket closing; cleanup runs exactly once.
   */
  #await<T>(
    timeoutMs: number,
    timeoutMessage: string,
    start: (resolve: (value: T) => void, reject: (error: RelayError) => void) => () => void,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new RelayError('closed', 'the connection is closed'))
    return new Promise<T>((resolve, reject) => {
      let cleanup: () => void = () => {}
      const settle = (fn: () => void) => {
        clearTimeout(timer)
        this.#closeWaiters.delete(onClose)
        cleanup()
        fn()
      }
      const onClose = (error: RelayError) => settle(() => reject(error))
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(new RelayError('timeout', `${timeoutMessage} within ${timeoutMs} ms`)),
          ),
        timeoutMs,
      )
      this.#closeWaiters.add(onClose)
      cleanup = start(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      )
    })
  }

  #onMessage(data: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(frame)) return
    const [type, a, b, c] = frame as unknown[]
    if (type === 'AUTH' && typeof a === 'string') {
      this.#challenge = a
      for (const waiter of [...this.#challengeWaiters]) waiter()
    } else if (type === 'OK' && typeof a === 'string' && EVENT_ID.test(a)) {
      this.#pendingOk.get(a)?.({ ok: b === true, message: typeof c === 'string' ? c : '' })
    } else if (type === 'EVENT' && typeof a === 'string' && isEvent(b)) {
      this.#subs.get(a)?.onEvent(b)
    } else if (type === 'EOSE' && typeof a === 'string') {
      this.#subs.get(a)?.onEose()
    } else if (type === 'CLOSED' && typeof a === 'string') {
      const sub = this.#subs.get(a)
      this.#subs.delete(a)
      sub?.onClosed(typeof b === 'string' ? b : '')
    }
  }

  #onClose(): void {
    if (this.#closed) return
    this.#closed = true
    const error = new RelayError('closed', `the connection to ${this.#options.url} closed`)
    for (const waiter of [...this.#closeWaiters]) waiter(error)
  }
}
