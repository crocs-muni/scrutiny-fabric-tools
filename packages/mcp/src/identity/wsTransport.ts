/**
 * The real `RelayTransport` for the NIP-46 signer (#108 A4).
 *
 * A2 drew the boundary at NIP-01 relay frames (`identity/transport.ts`) and left the socket to
 * A4; this is that socket. It is deliberately tiny: connect, forward decoded frames, send strings,
 * close. NIP-46's client owns the request/subscription protocol, retries and timeouts, so a second
 * reconnect policy here would fight it.
 *
 * Frames that are not JSON arrays are dropped rather than surfaced: the NIP-46 client's contract
 * is `RelayFrame`, and a relay's NOTICE text is diagnostic noise, not a protocol message (the
 * reader's own relay client logs those — `relay/authedSocket.ts`).
 */

import { WS_OPEN, type WebSocketLike, platformWebSocket } from '../relay/types.ts'
import type { RelayFrame, RelaySocket, RelayTransport } from './transport.ts'

/** A bunker may sit behind a relay that never opens the socket; fail the publish, don't hang it. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export interface WebSocketTransportOptions {
  /** Socket factory; defaults to the platform WebSocket (Node ≥ 22.5). */
  readonly wsFactory?: (url: string) => WebSocketLike
  /** Dial budget in milliseconds. */
  readonly connectTimeoutMs?: number
}

function openSocket(url: string, options: WebSocketTransportOptions): Promise<RelaySocket> {
  const factory = options.wsFactory ?? platformWebSocket
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  let socket: WebSocketLike
  try {
    socket = factory(url)
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)))
  }
  const { promise, resolve, reject } = Promise.withResolvers<RelaySocket>()
  let opened = false
  let closed = false
  const handlers = new Set<(frame: RelayFrame) => void>()

  const shutdown = (): void => {
    closed = true
    handlers.clear()
    try {
      socket.close()
    } catch {
      // Already closing/closed: the promise outcome is what matters.
    }
  }

  const timer = setTimeout(() => {
    if (opened) return
    shutdown()
    reject(new Error(`NIP-46 relay ${url}: no open within ${timeoutMs} ms`))
  }, timeoutMs)

  socket.onopen = () => {
    opened = true
    clearTimeout(timer)
    resolve({
      send(frame: string): void {
        if (closed || socket.readyState !== WS_OPEN) {
          throw new Error(`NIP-46 relay ${url}: socket is not open`)
        }
        socket.send(frame)
      },
      onMessage(handler: (frame: RelayFrame) => void): () => void {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      close: shutdown,
    })
  }

  socket.onmessage = (event) => {
    if (!opened || closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(String(event.data))
    } catch {
      return // not a JSON frame; the NIP-46 client would have nothing to correlate it with
    }
    if (!Array.isArray(parsed) || parsed[0] === undefined) return
    const frame = parsed as unknown as RelayFrame
    for (const handler of handlers) handler(frame)
  }

  socket.onerror = () => {
    if (opened) {
      // Post-open transport errors arrive with a close; the NIP-46 client's `closed` path decides
      // what to do about it, so this only stops delivering frames.
      if (!closed) shutdown()
      return
    }
    shutdown()
    reject(new Error(`NIP-46 relay ${url}: the connection failed before open`))
  }

  socket.onclose = (event) => {
    if (!opened) {
      shutdown()
      reject(new Error(`NIP-46 relay ${url}: the connection closed before open (${event.code})`))
      return
    }
    shutdown()
  }

  return promise
}

/** Build the transport `src/index.ts` hands to `buildServer`. Constructing it dials nothing. */
export function createWebSocketTransport(options: WebSocketTransportOptions = {}): RelayTransport {
  return {
    connect: (relayUrl: string) => openSocket(relayUrl, options),
  }
}
