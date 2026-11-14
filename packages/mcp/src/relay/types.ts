/**
 * Wire shapes and the injection points of the relay client (#108 A3).
 *
 * This layer is pure I/O: no key material, no ledger, no event construction. Signing is an
 * injected port ({@link AuthSigner}) so the custody argument survives (report §8.3, D13): the
 * transport asks for one signed kind 22242 event and never learns how it was signed.
 *
 * `NostrEvent` and `UnsignedEvent` repeat `packages/core/src/events.ts` structurally instead of
 * importing core: core's package `exports` resolve through `dist`, and this task must not depend
 * on a build step (#108 A3). The shapes are identical, so an event built by core passes
 * `RelayClient.publish` unchanged once A4 wires the tools.
 */

/** A NIP-01 event, exactly as core's `events.ts` declares it. */
export interface NostrEvent {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string
}

/**
 * An event before signing: no `id`, no `pubkey`, no `sig`.
 *
 * The signer injects those three (D13), so this is the only part of an event the transport ever
 * composes — the kind 22242 AUTH event of NIP-42.
 */
export interface UnsignedEvent {
  readonly kind: number
  readonly created_at: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
}

/**
 * The narrow signing capability NIP-42 needs — D13's `ScrutinySigner`, cut down to what a socket
 * call does.
 *
 * A2 implements it (dev key now, NIP-46 bunker for the pilot path); because it names no backend,
 * the transport cannot tell which one signed. `sign` MUST return a complete NIP-01 event — a
 * relay checks the id, the pubkey and the BIP-340 signature before it accepts the handshake.
 */
export interface AuthSigner {
  sign(unsigned: UnsignedEvent): Promise<NostrEvent>
}

/** NIP-42's client-authentication kind. Not a SCRUTINY event, never stored. */
export const AUTH_KIND = 22242

/**
 * A NIP-20 verdict, reduced to what a single-relay publisher reports.
 *
 * There is no per-relay map (nostr-tools' `publish` returns `{ [url]: message }`): #108 targets one
 * relay, named by `SCRUTINY_RELAY_URL`, and A4 reports one boolean per tool call.
 */
export interface PublishResult {
  /** `["OK", <id>, true, <message>]` → true; `false` covers every rejection NIP-20 defines. */
  readonly accepted: boolean
  /**
   * The relay's fourth field, verbatim and untrimmed. `relay/internal/gate/gate.go` words the
   * rejections this pilot produces — "blocked: not an allowed publisher", "blocked: kind N is not
   * accepted by this relay", "blocked: kind 1 event carries no accepted scrutiny t tag" — and they
   * reach the model unedited, so a fix is readable from the tool output alone.
   */
  readonly message: string
}

/**
 * A failure the caller must handle, as opposed to a relay verdict ({@link PublishResult}).
 *
 * `retryable` is the reconnect policy's input. A fresh socket fixes what it marks `true` (connect
 * failure, connection lost mid-exchange, send on a dead socket) and nothing fixes what it leaves
 * `false`: a NIP-42 rejection under unchanged credentials, a REQ the relay answered with `CLOSED`,
 * or a timeout whose outcome is genuinely unknown (see `AuthedSocket.publish`).
 */
export class RelayError extends Error {
  readonly retryable: boolean

  constructor(
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RelayError'
    this.retryable = options.retryable ?? false
  }
}

/**
 * The slice of the WHATWG `WebSocket` this client uses, declared structurally.
 *
 * Structural, not `lib.dom`'s class: the package compiles against `lib: ["ES2022"]` plus
 * `@types/node`, and the tests must hand in a fake that speaks frames without a network. The
 * platform factories cast once at their boundary.
 */
export interface WebSocketLike {
  /** WHATWG readyState: 0 connecting, 1 open, 2 closing, 3 closed. */
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
}

/** `WebSocket.OPEN` — the only readyState both transports write in. */
export const WS_OPEN = 1

/** How a socket is created; tests pass a fake relay, production passes {@link platformWebSocket}. */
export type WebSocketFactory = (url: string) => WebSocketLike

/** The platform constructor as this module sees it. */
type WebSocketCtor = new (url: string) => unknown

/**
 * Default factory: resolve `globalThis.WebSocket` per socket, not at import time, so a host that
 * installs a polyfill later still works and a test can swap the global instead of threading an
 * option. Node ≥ 22.5 ships a browser-compatible client; the package `engines` floor is 22.
 */
export function platformWebSocket(url: string): WebSocketLike {
  // A declared-shape view of the global object, not an assertion over it: if the host has no
  // `WebSocket` (or one that is not a constructor), the `undefined` branch or the call throws
  // below instead of a wrong shape slipping through.
  const platform: { readonly WebSocket?: WebSocketCtor } = globalThis
  const ctor = platform.WebSocket
  if (typeof ctor !== 'function') {
    throw new RelayError(
      'no global WebSocket — Node ≥ 22.5 provides one; otherwise pass a wsFactory',
    )
  }
  // One unchecked step, at the boundary: the platform class and WebSocketLike are the same object
  // described with different event types, and only its readyState, send, close and four handlers
  // are ever touched. The platform carries richer event types than NIP-01's JSON text needs.
  const socket = new ctor(url) as WebSocketLike
  return socket
}

/** NIP-01 ids and BIP-340 keys are 32 bytes hex; a signature is 64 bytes, twice that. */
const HEX_64 = /^[0-9a-f]{64}$/u
const HEX_128 = /^[0-9a-f]{128}$/u

/** True for a NIP-01 event id, in the lowercase hex form every signature this repo makes uses. */
export function isEventId(value: string): boolean {
  return HEX_64.test(value)
}

/**
 * Guard against a malformed event reaching the wire, or against a signer that returned one: publish
 * matches the relay's ack by `id`, so an id that is not NIP-01-shaped would wait out the whole
 * budget and then report a "timeout" for what is a local bug. `context` names the caller in the
 * message (`publish`, `AUTH`) so the fix is readable from the error alone.
 */
export function assertSignedEvent(event: NostrEvent, context = 'publish'): void {
  if (!HEX_64.test(event.id)) {
    throw new RelayError(
      `${context}: event.id must be 64-char lowercase hex (NIP-01), got "${event.id}"`,
    )
  }
  if (!HEX_64.test(event.pubkey)) {
    throw new RelayError(`${context}: event.pubkey must be a 64-char lowercase hex key (NIP-01)`)
  }
  if (!HEX_128.test(event.sig)) {
    throw new RelayError(
      `${context}: event.sig must be a 128-char lowercase hex signature (NIP-01)`,
    )
  }
  if (!Number.isInteger(event.kind))
    throw new RelayError(`${context}: event.kind must be an integer`)
  if (typeof event.content !== 'string') {
    throw new RelayError(`${context}: event.content must be text`)
  }
}

/**
 * Shape-only check for a relay-sent event. Deliberately not a signature check: this package has no
 * hashing (D12 keeps crypto out of the package sources anyway), and `verify_event` owns proving
 * that the bytes it fetched are the bytes that were signed.
 */
export function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || typeof value.id !== 'string' || !HEX_64.test(value.id)) return false
  if (!('pubkey' in value) || typeof value.pubkey !== 'string' || !HEX_64.test(value.pubkey)) {
    return false
  }
  if (!('sig' in value) || typeof value.sig !== 'string') return false
  if (!('kind' in value) || typeof value.kind !== 'number') return false
  if (!('created_at' in value) || typeof value.created_at !== 'number') return false
  if (!('content' in value) || typeof value.content !== 'string') return false
  if (!('tags' in value) || !Array.isArray(value.tags)) return false
  return value.tags.every(
    (tag) => Array.isArray(tag) && tag.every((part: unknown) => typeof part === 'string'),
  )
}
