/**
 * In-memory NIP-42 / NIP-20 relay for the relay-client tests (#108 A3).
 *
 * It exists to pin the parts a real network would hide: the two handshake orders the pilot relay
 * can produce (eager `OnConnect = khatru.RequestAuth` and the fresh challenge that rides an
 * auth-required rejection), the byte-exact `relay` tag check of `SCRUTINY_SERVICE_URL`, and the
 * gate wording of `relay/internal/gate/gate.go`. No sockets, no crypto: this layer never signs, so
 * neither does the fake — it checks the tags a real relay checks, not the signature.
 *
 * Deferred promises here are executor-form because the package compiles with `lib: ["ES2022"]`
 * (no `Promise.withResolvers`).
 */

import { AUTH_KIND } from '../../src/relay/types.ts'
import type {
  AuthSigner,
  NostrEvent,
  UnsignedEvent,
  WebSocketFactory,
  WebSocketLike,
} from '../../src/relay/types.ts'

/** A key-shaped constant; the fake never verifies signatures, it only needs the fields present. */
const FAKE_PUBKEY = 'cc'.repeat(32)
const FAKE_SIG = 'bb'.repeat(64)

/** NIP-20 verdict the fake answers with when the test did not script one. */
const ACCEPT_ALL = { accepted: true, message: '' } as const

export interface FakeRelayOptions {
  /**
   * The URL the relay's own NIP-42 validator accepts in the AUTH event's `relay` tag
   * (`SCRUTINY_SERVICE_URL`, `relay/README.md:81-82`). A mismatch is rejected, as on the real relay.
   */
  readonly expectedRelay: string
  /** `OnConnect = khatru.RequestAuth`: send a challenge as soon as the socket opens. Default true. */
  readonly eagerChallenge?: boolean
  /** `gate.AuthGate`: an unauthenticated EVENT gets a fresh challenge and `MsgAuthRequired`. */
  readonly gateWrites?: boolean
  /** Scripted NIP-20 verdict per EVENT; defaults to `{accepted: true, message: ''}`. */
  readonly verdict?: (event: NostrEvent) => { readonly accepted: boolean; readonly message: string }
  /** Events a REQ over `{"ids":[…]}` can find. */
  readonly events?: readonly NostrEvent[]
  /** Never answer an EVENT (ack-timeout path). */
  readonly silentEvents?: boolean
  /** Never answer a REQ (read-timeout path). */
  readonly silentReads?: boolean
  /** Answer every REQ with `["CLOSED", sub, <this>]`. */
  readonly closedReads?: string
  /**
   * Drop the connection instead of acking: `first` loses the very first EVENT (the reconnect
   * path), `all` loses every EVENT (the reconnect-budget path).
   */
  readonly dropEvents?: 'none' | 'first' | 'all'
  /** Refuse to open: `open` never fires, `error` and `close` do. */
  readonly failConnect?: boolean
  /** Never open and never fail: the dial window stays open (status/connected checks). */
  readonly stallConnect?: boolean
  /**
   * One challenge per connection, re-sent with every auth-required rejection — nak's bunker
   * behaviour (bunker.go:304-315). Default false: a fresh challenge each time, like khatru.
   */
  readonly reuseChallenge?: boolean
  /** Reject the first AUTH event with this NIP-20 message, then behave normally. */
  readonly rejectFirstAuth?: string
  /** Reject unauthenticated writes without sending a challenge (a relay that gates but never offers). */
  readonly noChallengeOnReject?: boolean
  /** Answer an ids-REQ with a foreign event alongside the real ones (wrong-record check). */
  readonly mismatchedRead?: boolean
  /** Withhold EOSE: the REQ is answered with events only, so the client must time out. */
  readonly stallEose?: boolean
  /** Send `["OK", …]` frames for a foreign and a truncated id before the real verdict. */
  readonly spuriousOk?: boolean
  /**
   * Store accepted events and serve them on a later ids-REQ. Default true, like a real relay;
   * `false` models the "accepted but not returned" case `verify_event` must report honestly.
   */
  readonly storeAccepted?: boolean
}

interface FakeSocket extends WebSocketLike {
  readonly url: string
  /** The challenge this relay last issued on the socket; null before the first one. */
  readonly currentChallenge: string | null
  /** Frames this client sent, parsed, in order. */
  readonly inbound: unknown[][]
  /** Close from the relay side, as a lost connection (no OK). */
  serverClose(code?: number, reason?: string): void
  /** Deliver one frame to the client. */
  deliver(frame: unknown): void
}

export interface FakeRelay {
  /** Hand this to `RelayClient` / `authedSocket` as `wsFactory`. */
  readonly factory: WebSocketFactory
  /** Every socket created, in order. */
  readonly sockets: FakeSocket[]
  /** Every frame every socket received, in arrival order. */
  readonly inbound: unknown[][]
  /** Resolves once this relay accepted an AUTH event (a no-op after the first). */
  authAccepted(): Promise<void>
  /** Broadcast a NOTICE to every open socket (timeout-diagnostic tests). */
  notice(text: string): void
  /** Add events the relay already has (a read can find them before any publish). */
  seed(...events: readonly NostrEvent[]): void
  /** The most recent socket; throws when the client never dialed. */
  lastSocket(): FakeSocket
}

export interface FakeSigner extends AuthSigner {
  /** Every template the transport asked to sign, in order. */
  readonly templates: readonly UnsignedEvent[]
}

/** A signer that timestamps cleanly and returns a deterministic, NIP-01-shaped event. */
export function fakeSigner(): FakeSigner {
  const templates: UnsignedEvent[] = []
  let seq = 0
  return {
    templates,
    async sign(unsigned: UnsignedEvent) {
      templates.push(unsigned)
      seq += 1
      return {
        ...unsigned,
        id: `aa${seq.toString(16).padStart(62, '0')}`,
        pubkey: FAKE_PUBKEY,
        sig: FAKE_SIG,
      }
    },
  }
}

/**
 * A signed kind 1 event, deterministic per index. `overrides` exists to build the malformed
 * events the validation tests hand to `publish`.
 */
export function signedEvent(index: number, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: `ee${index.toString(16).padStart(62, '0')}`,
    pubkey: FAKE_PUBKEY,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [['t', 'scrutiny-product']],
    content: `event ${index}`,
    sig: FAKE_SIG,
    ...overrides,
  }
}

/**
 * Poll for a state a previous `await` started but no promise reports. Bounded so a regression
 * fails the test rather than hanging the suite.
 */
export async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export function createFakeRelay(options: FakeRelayOptions): FakeRelay {
  return new FakeRelayState(options)
}

class FakeRelayState implements FakeRelay {
  readonly sockets: RelaySocket[] = []
  readonly inbound: unknown[][] = []
  readonly factory: WebSocketFactory = (url: string) => {
    const socket = new RelaySocket(this, url)
    this.sockets.push(socket)
    return socket
  }

  private readonly expectedRelay: string
  private readonly eagerChallenge: boolean
  private readonly gateWrites: boolean
  private readonly verdict: (event: NostrEvent) => { accepted: boolean; message: string }
  private readonly events: NostrEvent[]
  private readonly silentEvents: boolean
  private readonly silentReads: boolean
  private readonly closedReads: string | undefined
  private readonly dropEvents: 'none' | 'first' | 'all'
  private readonly failConnect: boolean
  private readonly stallConnect: boolean
  private readonly reuseChallenge: boolean
  private readonly rejectFirstAuth: string | undefined
  private readonly noChallengeOnReject: boolean
  private readonly mismatchedRead: boolean
  private readonly stallEose: boolean
  private readonly spuriousOk: boolean
  private readonly storeAccepted: boolean

  private challengeSeq = 0
  private eventCount = 0
  private authCount = 0
  private authFrames = 0
  /**
   * Events this relay accepted, served back on an ids-REQ. A real relay stores before it acks
   * (NIP-20), and the #108 handlers fetch every publish back inline, so a fake that only answered
   * scripted `events` would model a relay that accepts writes and forgets them.
   */
  private readonly stored: NostrEvent[] = []

  constructor(options: FakeRelayOptions) {
    this.expectedRelay = options.expectedRelay
    this.eagerChallenge = options.eagerChallenge ?? true
    this.gateWrites = options.gateWrites ?? true
    this.verdict = options.verdict ?? (() => ACCEPT_ALL)
    this.events = [...(options.events ?? [])]
    this.silentEvents = options.silentEvents ?? false
    this.silentReads = options.silentReads ?? false
    this.closedReads = options.closedReads
    this.dropEvents = options.dropEvents ?? 'none'
    this.failConnect = options.failConnect ?? false
    this.stallConnect = options.stallConnect ?? false
    this.reuseChallenge = options.reuseChallenge ?? false
    this.rejectFirstAuth = options.rejectFirstAuth
    this.noChallengeOnReject = options.noChallengeOnReject ?? false
    this.mismatchedRead = options.mismatchedRead ?? false
    this.stallEose = options.stallEose ?? false
    this.spuriousOk = options.spuriousOk ?? false
    this.storeAccepted = options.storeAccepted ?? true
  }

  async authAccepted(): Promise<void> {
    await waitUntil(() => this.authCount > 0, 'the fake relay to accept an AUTH event')
  }

  notice(text: string): void {
    for (const socket of this.sockets) socket.deliver(['NOTICE', text])
  }

  seed(...events: readonly NostrEvent[]): void {
    this.events.push(...events)
  }

  lastSocket(): FakeSocket {
    const socket = this.sockets.at(-1)
    if (socket === undefined) throw new Error('fake relay: the client never dialed')
    return socket
  }

  /** Called by a socket as soon as it is created, one microtask later (network-shaped). */
  attach(socket: RelaySocket): void {
    // A close can land before this microtask runs (a test scripting a dead connection); a closed
    // socket must not reopen.
    if (socket.readyState === 3) return
    // A dial that neither opens nor fails: the CONNECTING window tests need it to last.
    if (this.stallConnect) return
    if (this.failConnect) {
      socket.onerror?.({ type: 'error' })
      socket.shutdown(1006, 'connect failed')
      return
    }
    socket.readyState = 1
    socket.onopen?.({ type: 'open' })
    if (this.eagerChallenge) this.challenge(socket)
  }

  /** `khatru.RequestAuth`: a new random challenge, replacing any previous one for this socket. */
  challenge(socket: RelaySocket): void {
    this.challengeSeq += 1
    // nak's bunker reuses one challenge for the connection and only ever sends it with an OK-false
    // (bunker.go:304-315), so a client must re-sign per attempt rather than per challenge value.
    const challenge = this.reuseChallenge ? 'challenge-fixed' : `challenge-${this.challengeSeq}`
    socket.currentChallenge = challenge
    socket.deliver(['AUTH', challenge])
  }

  handle(socket: RelaySocket, frame: unknown[]): void {
    const type = frame[0]
    if (type === 'AUTH') this.handleAuth(socket, frame[1])
    else if (type === 'EVENT') this.handleEvent(socket, frame[1])
    else if (type === 'REQ') this.handleReq(socket, frame[1], frame[2])
    // CLOSE and anything else: nothing to answer, as on a real relay.
  }

  private handleAuth(socket: RelaySocket, raw: unknown): void {
    if (!isEventShaped(raw)) return
    const relayTag = tagValue(raw, 'relay')
    const challengeTag = tagValue(raw, 'challenge')
    const quotesCurrentChallenge =
      challengeTag !== undefined && challengeTag === socket.currentChallenge
    const accepted =
      raw.kind === AUTH_KIND && relayTag === this.expectedRelay && quotesCurrentChallenge
    this.authFrames += 1
    // A transient rejection: the tags are right, the relay says no once (a verifier hiccup). This is
    // the case that must not poison a reused challenge.
    if (accepted && this.rejectFirstAuth !== undefined && this.authFrames === 1) {
      socket.deliver(['OK', raw.id, false, this.rejectFirstAuth])
      return
    }
    if (accepted) {
      this.authCount += 1
      socket.authed = true
      socket.deliver(['OK', raw.id, true, ''])
      return
    }
    // Khatru's auth validator answers a wrong tag with the URL it expected; the client echoes it.
    const message =
      relayTag === undefined || relayTag !== this.expectedRelay
        ? `auth-required: expected relay URL '${this.expectedRelay}'`
        : 'auth-required: invalid challenge'
    socket.deliver(['OK', raw.id, false, message])
  }

  private handleEvent(socket: RelaySocket, raw: unknown): void {
    if (!isEventShaped(raw)) return
    if (this.gateWrites && !socket.authed) {
      // gate.go:82-85: a fresh challenge, then the rejection — in that order. (Unless the relay is
      // scripted to gate without ever offering a handshake.)
      if (!this.noChallengeOnReject) this.challenge(socket)
      socket.deliver(['OK', raw.id, false, 'auth-required: writes require authentication'])
      return
    }
    // Count only writes that pass the gate: `first` means "the first event the relay would have
    // acked", which is what a reconnect test needs regardless of how many auth round trips came
    // before it.
    this.eventCount += 1
    const lose = this.dropEvents === 'all' || (this.dropEvents === 'first' && this.eventCount === 1)
    if (lose) {
      socket.shutdown(1006, 'connection lost before OK')
      return
    }
    if (this.silentEvents) return
    if (this.spuriousOk) {
      // A foreign id and a truncated one, both claiming acceptance: neither may reach an ack waiter.
      socket.deliver(['OK', 'ff'.repeat(32), true, 'spurious'])
      socket.deliver(['OK', 'ab', true, 'spurious'])
    }
    const verdict = this.verdict(raw)
    if (verdict.accepted && this.storeAccepted) this.stored.push(raw)
    socket.deliver(['OK', raw.id, verdict.accepted, verdict.message])
  }

  private handleReq(socket: RelaySocket, subId: unknown, filter: unknown): void {
    if (typeof subId !== 'string') return
    if (this.silentReads) return
    if (this.closedReads !== undefined) {
      socket.deliver(['CLOSED', subId, this.closedReads])
      return
    }
    const ids = idsOf(filter)
    for (const event of [...this.events, ...this.stored]) {
      if (ids.includes(event.id)) socket.deliver(['EVENT', subId, event])
    }
    // A relay answering an ids-REQ with some other event: the client must not treat it as the
    // record it asked for, whatever that event's signature says.
    if (this.mismatchedRead) socket.deliver(['EVENT', subId, signedEvent(999)])
    if (this.stallEose) return
    socket.deliver(['EOSE', subId])
  }
}

class RelaySocket implements FakeSocket {
  readyState = 0
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onerror: WebSocketLike['onerror'] = null
  onclose: WebSocketLike['onclose'] = null
  readonly inbound: unknown[][] = []
  readonly url: string
  /** Set by the relay when it issues a challenge; an AUTH must quote the latest one. */
  currentChallenge: string | null = null
  /** Cleared by a new challenge, set by an accepted AUTH — `AuthGate` reads it (`gate.go:79-86`). */
  authed = false

  private readonly relay: FakeRelayState

  constructor(relay: FakeRelayState, url: string) {
    this.relay = relay
    this.url = url
    queueMicrotask(() => relay.attach(this))
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('fake relay: frame sent before open')
    const frame: unknown = JSON.parse(data)
    if (!Array.isArray(frame)) throw new Error('fake relay: frame is not an array')
    this.inbound.push(frame)
    this.relay.inbound.push(frame)
    queueMicrotask(() => this.relay.handle(this, frame))
  }

  close(code?: number, reason?: string): void {
    this.shutdown(code ?? 1000, reason ?? 'client closed')
  }

  serverClose(code = 1006, reason = 'connection lost'): void {
    this.shutdown(code, reason)
  }

  deliver(frame: unknown): void {
    if (this.readyState !== 1) return
    const data = JSON.stringify(frame)
    queueMicrotask(() => this.onmessage?.({ data }))
  }

  /** The one close path, so a client-initiated and a relay-initiated close look identical. */
  shutdown(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    const event = { code, reason }
    queueMicrotask(() => this.onclose?.(event))
  }
}

function isEventShaped(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || typeof value.id !== 'string') return false
  if (!('kind' in value) || typeof value.kind !== 'number') return false
  if (!('pubkey' in value) || typeof value.pubkey !== 'string') return false
  if (!('sig' in value) || typeof value.sig !== 'string') return false
  if (!('content' in value) || typeof value.content !== 'string') return false
  if (!('created_at' in value) || typeof value.created_at !== 'number') return false
  return 'tags' in value && Array.isArray(value.tags)
}

/** Narrow one frame payload to an event for assertions; `null` when it is not event-shaped. */
function asEvent(value: unknown): NostrEvent | null {
  return isEventShaped(value) ? value : null
}

/** Events of one frame type (`AUTH` or `EVENT`) the client sent, narrowed for assertions. */
export function sentEvents(relay: FakeRelay, type: 'AUTH' | 'EVENT'): NostrEvent[] {
  const out: NostrEvent[] = []
  for (const frame of relay.inbound) {
    if (frame[0] !== type) continue
    const event = asEvent(frame[1])
    if (event !== null) out.push(event)
  }
  return out
}

/** Values of a tag on a (possibly absent) event; empty when either is missing. */
export function tagValues(event: NostrEvent | undefined, name: string): string[] {
  if (event === undefined) return []
  const out: string[] = []
  for (const tag of event.tags) {
    const value = tag[1]
    if (tag[0] === name && value !== undefined) out.push(value)
  }
  return out
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  for (const tag of event.tags) if (tag[0] === name) return tag[1]
  return undefined
}

function idsOf(filter: unknown): readonly string[] {
  if (typeof filter !== 'object' || filter === null) return []
  if (!('ids' in filter) || !Array.isArray(filter.ids)) return []
  return filter.ids.filter((id): id is string => typeof id === 'string')
}
