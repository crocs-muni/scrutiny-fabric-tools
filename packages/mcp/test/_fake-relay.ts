/**
 * An in-process relay for client tests, speaking NIP-01 and NIP-42 over a real WebSocket. It
 * verifies AUTH signatures with nostr-tools, an implementation independent of this package.
 */

import type { AddressInfo } from 'node:net'
import { verifyEvent } from 'nostr-tools/pure'
import { type WebSocket, WebSocketServer } from 'ws'

export interface WireEvent {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: string[][]
  readonly content: string
  readonly sig: string
}

/** What the relay does with one EVENT frame. `undefined` falls through to the default. */
export type EventHandler = (
  event: WireEvent,
  ctx: { readonly socket: WebSocket; readonly authed: boolean; readonly relay: FakeRelay },
) => 'default' | 'drop' | 'close' | { ok: boolean; message: string } | undefined

export interface FakeRelayOptions {
  /** Send an AUTH challenge as soon as a client connects (khatru `OnConnect = RequestAuth`). */
  readonly challengeOnConnect?: boolean
  /** Writes need a valid NIP-42 auth first; otherwise `auth-required:` plus a fresh challenge. */
  readonly requireAuth?: boolean
  readonly onEvent?: EventHandler
  /** Replaces the default REQ handling. */
  readonly onReq?: (subId: string, filters: Record<string, unknown>[], socket: WebSocket) => void
}

export class FakeRelay {
  readonly frames: unknown[][] = []
  readonly stored = new Map<string, WireEvent>()
  sockets = 0
  readonly #server: WebSocketServer
  readonly #options: FakeRelayOptions
  #challenge = 0

  private constructor(server: WebSocketServer, options: FakeRelayOptions) {
    this.#server = server
    this.#options = options
    server.on('connection', (socket) => this.#accept(socket))
  }

  static async start(options: FakeRelayOptions = {}): Promise<FakeRelay> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    return new FakeRelay(server, options)
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }

  sent(type: string): unknown[][] {
    return this.frames.filter((f) => f[0] === type)
  }

  async stop(): Promise<void> {
    for (const client of this.#server.clients) client.terminate()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  #accept(socket: WebSocket): void {
    this.sockets += 1
    let challenge = ''
    let authed = false
    const sendChallenge = () => {
      challenge = `challenge-${++this.#challenge}`
      socket.send(JSON.stringify(['AUTH', challenge]))
    }
    if (this.#options.challengeOnConnect ?? true) sendChallenge()

    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as unknown[]
      this.frames.push(frame)
      const [type] = frame
      if (type === 'AUTH') {
        const event = frame[1] as WireEvent
        const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1]
        const ok =
          verifyEvent(event) &&
          event.kind === 22242 &&
          tag('challenge') === challenge &&
          tag('relay') === this.url
        authed ||= ok
        socket.send(JSON.stringify(['OK', event.id, ok, ok ? '' : 'auth-required: bad auth']))
        return
      }
      if (type === 'EVENT') {
        const event = frame[1] as WireEvent
        const decision =
          this.#options.onEvent?.(event, { socket, authed, relay: this }) ?? 'default'
        if (decision === 'drop') return
        if (decision === 'close') {
          socket.terminate()
          return
        }
        if (decision !== 'default') {
          socket.send(JSON.stringify(['OK', event.id, decision.ok, decision.message]))
          return
        }
        if ((this.#options.requireAuth ?? true) && !authed) {
          socket.send(
            JSON.stringify(['OK', event.id, false, 'auth-required: writes require authentication']),
          )
          sendChallenge()
          return
        }
        const duplicate = this.stored.has(event.id)
        this.stored.set(event.id, event)
        socket.send(
          JSON.stringify(['OK', event.id, true, duplicate ? 'duplicate: already have it' : '']),
        )
        return
      }
      if (type === 'REQ') {
        const [, subId, ...filters] = frame as [string, string, ...Record<string, unknown>[]]
        if (this.#options.onReq !== undefined) return this.#options.onReq(subId, filters, socket)
        for (const event of this.stored.values()) {
          if (filters.some((f) => matches(event, f)))
            socket.send(JSON.stringify(['EVENT', subId, event]))
        }
        socket.send(JSON.stringify(['EOSE', subId]))
      }
    })
  }
}

function matches(event: WireEvent, filter: Record<string, unknown>): boolean {
  const { ids, kinds, authors } = filter as { ids?: string[]; kinds?: number[]; authors?: string[] }
  return (
    (ids === undefined || ids.includes(event.id)) &&
    (kinds === undefined || kinds.includes(event.kind)) &&
    (authors === undefined || authors.includes(event.pubkey))
  )
}
