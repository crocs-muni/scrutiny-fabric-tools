/**
 * Raw WebSocket transport for the NIP-46 signer channel (#108 A3).
 *
 * A2 owns the signer, A4 owns the adaptation: this module is the three-call shape the NIP-46
 * client needs — write a message, hear one, close — with no NIP-01 event semantics attached. A4
 * maps `send` to the client's request frame, `onMessage` to its inbound handler and `close` to
 * teardown; the returned unsubscribe is that adapter's `off`.
 *
 * Unauthenticated on purpose: a NIP-46 relay is a message bus between signer and client (there is
 * no stored event the relay gates), so the NIP-42 handshake of `authedSocket.ts` would only add a
 * key to the channel. If the pilot's bunker relay turns out to demand NIP-42, wrap that socket
 * instead of growing this one.
 */

import {
  RelayError,
  type WebSocketFactory,
  type WebSocketLike,
  platformWebSocket,
} from './types.ts'

export interface RawTransportOptions {
  /** Defaults to {@link platformWebSocket}; tests pass an in-memory relay. */
  readonly wsFactory?: WebSocketFactory
  /** Diagnostics only; never called with frame contents. */
  readonly log?: (line: string) => void
}

export interface RawTransport {
  /**
   * Send one NIP-01 message (`["REQ", …]`, `["EVENT", event]`, NIP-46's own payloads).
   *
   * Frames sent before the socket is open are queued in order and flushed on `open`, because this
   * transport deliberately has no `ready()` step: the NIP-46 handshake writes before it knows the
   * connection is up, and dropping that first frame would stall it until its own timeout.
   *
   * Throws {@link RelayError} once the transport is closed — a silent drop would look like a signer
   * that never answers.
   */
  send(payload: unknown[]): void
  /** Subscribe to inbound frames as the raw JSON string. Returns the unsubscribe function. */
  onMessage(handler: (raw: string) => void): () => void
  /** Idempotent; drops anything still queued. */
  close(): void
}

/** Open `url` now; the socket starts connecting immediately. */
export function rawTransport(url: string, options: RawTransportOptions = {}): RawTransport {
  return new QueuedTransport(url, options)
}

class QueuedTransport implements RawTransport {
  private readonly ws: WebSocketLike
  private readonly log: (line: string) => void
  private readonly handlers = new Set<(raw: string) => void>()
  private readonly queue: string[] = []
  private isOpen = false
  private isClosed = false

  constructor(url: string, options: RawTransportOptions) {
    this.log = options.log ?? (() => {})
    this.ws = (options.wsFactory ?? platformWebSocket)(url)
    this.ws.onopen = () => {
      this.isOpen = true
      this.log(`[ws] open ${url}`)
      for (const frame of this.queue.splice(0)) {
        try {
          this.ws.send(frame)
        } catch {
          // The socket died between the open event and this flush; `onclose` follows and clears
          // the rest, and the caller's next `send` reports the closed transport.
          this.isClosed = true
          return
        }
      }
    }
    this.ws.onmessage = (event) => {
      // NIP-01 is JSON text; a binary frame is not a message either side of NIP-46 sends.
      if (typeof event.data !== 'string') return
      for (const handler of this.handlers) handler(event.data)
    }
    this.ws.onerror = () => this.log(`[ws] error on ${url}`)
    this.ws.onclose = (event) => {
      this.isOpen = false
      this.isClosed = true
      this.queue.length = 0
      const detail = event.reason === '' ? '' : `: ${event.reason}`
      this.log(`[ws] closed (code ${event.code}${detail})`)
    }
  }

  send(payload: unknown[]): void {
    if (this.isClosed) throw new RelayError(this.closedMessage())
    const frame = JSON.stringify(payload)
    if (!this.isOpen) {
      this.queue.push(frame)
      return
    }
    try {
      this.ws.send(frame)
    } catch (cause) {
      this.isClosed = true
      throw new RelayError(this.closedMessage(), { cause, retryable: true })
    }
  }

  onMessage(handler: (raw: string) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.queue.length = 0
    try {
      this.ws.close()
    } catch {
      // Already closing or closed; nothing to do.
    }
  }

  private closedMessage(): string {
    return 'raw transport closed — the signer channel is gone; reconnect before sending'
  }
}
