/**
 * The relay facade the #108 tools call (#108 A3): one socket, one connect/reconnect policy.
 *
 * Policy, in full — it is small on purpose, because a publishing tool must never guess:
 *
 * - dial lazily on the first operation, then reuse the socket while it is open (one MCP session
 *   publishes a handful of events; a pool would buy nothing but new races);
 * - concurrent operations share one dial attempt (single-flight), and acks/subscriptions are keyed
 *   by event id / subscription id, so two overlapping calls cannot cross answers;
 * - after a *retryable* failure each operation gets `reconnectAttempts` fresh sockets (default 1).
 *   Retryable means "a new connection can fix it": connect failure, connection lost, send on a dead
 *   socket. A NIP-20 verdict is not a failure and never reconnects — the relay answered;
 * - a timeout is not retried either: the relay may have stored the event and lost the reply, so a
 *   silent second EVENT would blur the report. The caller verifies with `fetchById` first;
 * - `close()` is permanent: a closed client refuses further operations instead of silently dialing.
 */

import { type AuthedSocket, type RelayTimeouts, authedSocket } from './authedSocket.ts'
import {
  type AuthSigner,
  type NostrEvent,
  type PublishResult,
  RelayError,
  type WebSocketFactory,
  platformWebSocket,
} from './types.ts'

export interface RelayClientOptions {
  /** The socket URL (`SCRUTINY_RELAY_URL`, `src/config.ts`). */
  readonly relayUrl: string
  /**
   * The NIP-42 `relay` tag. Defaults to {@link relayUrl}; set it to the relay's public
   * `SCRUTINY_SERVICE_URL` when a tunnel or proxy is what this client actually dials, because the
   * relay compares the tag byte for byte (`relay/README.md:81-82`).
   */
  readonly authRelayUrl?: string
  /** Signs the kind 22242 AUTH event; the facade never sees key material (D13). */
  readonly signer: AuthSigner
  /** Defaults to {@link platformWebSocket}. */
  readonly wsFactory?: WebSocketFactory
  /** Per-field overrides of the socket budgets. */
  readonly timeouts?: Partial<RelayTimeouts>
  /** Fresh sockets one operation may open after a retryable failure. Default 1. */
  readonly reconnectAttempts?: number
  /** Diagnostics only. */
  readonly log?: (line: string) => void
}

export class RelayClient {
  private readonly relayUrl: string
  private readonly authRelayUrl: string
  private readonly signer: AuthSigner
  private readonly wsFactory: WebSocketFactory
  private readonly timeouts: Partial<RelayTimeouts>
  private readonly reconnectAttempts: number
  private readonly log: (line: string) => void

  private socket: AuthedSocket | null = null
  private opening: Promise<AuthedSocket> | null = null
  private permanentlyClosed = false

  constructor(options: RelayClientOptions) {
    this.relayUrl = options.relayUrl
    this.authRelayUrl = options.authRelayUrl ?? options.relayUrl
    this.signer = options.signer
    this.wsFactory = options.wsFactory ?? platformWebSocket
    this.timeouts = options.timeouts ?? {}
    this.reconnectAttempts = Math.max(0, options.reconnectAttempts ?? 1)
    this.log = options.log ?? (() => {})
  }

  /** True while a socket is open. The `status` tool can report it without dialing (A4). */
  get connected(): boolean {
    return this.socket !== null && !this.socket.closed
  }

  /** Publish one signed event and resolve with the relay's NIP-20 verdict. */
  publish(event: NostrEvent): Promise<PublishResult> {
    return this.withSocket((socket) => socket.publish(event))
  }

  /**
   * Read one event back: the event, or `null` when the relay says EOSE with nothing.
   * Throws {@link RelayError} when the relay did not answer — see `AuthedSocket.fetchById`.
   */
  fetchById(id: string): Promise<NostrEvent | null> {
    return this.withSocket((socket) => socket.fetchById(id))
  }

  close(): void {
    this.permanentlyClosed = true
    const socket = this.socket
    this.socket = null
    this.opening = null
    socket?.close()
  }

  private async withSocket<T>(operation: (socket: AuthedSocket) => Promise<T>): Promise<T> {
    let lastFailure: RelayError | null = null
    for (let attempt = 0; attempt <= this.reconnectAttempts; attempt += 1) {
      let socket: AuthedSocket | null = null
      try {
        socket = await this.ensureSocket()
        return await operation(socket)
      } catch (cause) {
        const failure =
          cause instanceof RelayError ? cause : new RelayError(String(cause), { cause })
        if (!failure.retryable) throw failure
        lastFailure = failure
        // A failed dial has already retired itself inside `ensureSocket`; a failed operation leaves
        // a half-dead socket behind, and the next pass must not write into it.
        if (socket !== null) this.drop(socket)
        this.log(`[relay] retryable failure, resetting the socket: ${failure.message}`)
      }
    }
    // Unreachable in practice: the last attempt either returned or threw out of the loop. Kept
    // explicit so the loop's contract (retryable failures never escape silently) is type-visible.
    throw lastFailure ?? new RelayError('relay operation failed on every attempt')
  }

  private async ensureSocket(): Promise<AuthedSocket> {
    if (this.permanentlyClosed) {
      throw new RelayError('relay client closed — construct a new RelayClient to publish again')
    }
    if (this.socket !== null && !this.socket.closed) return this.socket
    // Single-flight: two calls that start together share one dial instead of racing two sockets.
    const pending = this.opening ?? this.openSocket()
    this.opening = pending
    try {
      return await pending
    } finally {
      if (this.opening === pending) this.opening = null
    }
  }

  private async openSocket(): Promise<AuthedSocket> {
    this.socket?.close()
    const socket = authedSocket({
      relayUrl: this.relayUrl,
      authRelayUrl: this.authRelayUrl,
      signer: this.signer,
      wsFactory: this.wsFactory,
      timeouts: this.timeouts,
      log: this.log,
    })
    this.socket = socket
    try {
      await socket.ready()
      return socket
    } catch (cause) {
      this.drop(socket)
      throw cause instanceof RelayError
        ? cause
        : new RelayError(`connect failed: ${String(cause)}`, { retryable: true, cause })
    }
  }

  private drop(socket: AuthedSocket): void {
    socket.close()
    if (this.socket === socket) this.socket = null
  }
}
