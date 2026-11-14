/**
 * NIP-42 / NIP-20 protocol behaviour of `authedSocket` (#108 A3), driven through the in-memory
 * relay: both challenge orders the pilot relay produces, the byte-exact `relay` tag, verdict
 * passthrough, and the read path (`REQ`/`EOSE`) including its failure modes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { type AuthedSocket, authedSocket } from '../../src/relay/authedSocket.ts'
import {
  AUTH_KIND,
  type AuthSigner,
  RelayError,
  type UnsignedEvent,
} from '../../src/relay/types.ts'
import {
  type FakeRelay,
  type FakeRelayOptions,
  createFakeRelay,
  fakeSigner,
  sentEvents,
  signedEvent,
  tagValues,
  waitUntil,
} from './fakeRelay.ts'

/** `SCRUTINY_SERVICE_URL` on the pilot relay; the AUTH tag must quote it byte for byte. */
const RELAY = 'wss://relay.scrutiny.cloud'

/** Budgets small enough that failure-path tests finish quickly; success paths never wait on them. */
const TINY = { connectMs: 50, authMs: 50, ackMs: 50, readMs: 50 }

const sockets: AuthedSocket[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close()
})

interface OpenOptions {
  readonly relay?: Partial<FakeRelayOptions>
  readonly relayUrl?: string
  readonly authRelayUrl?: string
}

function open(options: OpenOptions = {}): { relay: FakeRelay; socket: AuthedSocket } {
  const relay = createFakeRelay({ expectedRelay: RELAY, ...options.relay })
  const socket = authedSocket({
    relayUrl: options.relayUrl ?? RELAY,
    signer: fakeSigner(),
    wsFactory: relay.factory,
    timeouts: TINY,
    ...(options.authRelayUrl === undefined ? {} : { authRelayUrl: options.authRelayUrl }),
  })
  sockets.push(socket)
  return { relay, socket }
}

/**
 * A signer that does not answer until the test releases it, so the relay's eager challenge can be
 * left unanswered while something else is checked (a pending handshake must not block reads).
 */
function gatedSigner(): { signer: AuthSigner; release: () => void } {
  const inner = fakeSigner()
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    signer: {
      sign: async (unsigned) => {
        await gate
        return inner.sign(unsigned)
      },
    },
    release,
  }
}

describe('NIP-42 handshake', () => {
  it('answers the eager OnConnect challenge with the socket URL by default', async () => {
    const { relay, socket } = open()
    await socket.ready()
    await relay.authAccepted()

    expect(socket.authed).toBe(true)
    const auth = sentEvents(relay, 'AUTH')
    expect(auth).toHaveLength(1)
    expect(auth[0]?.kind).toBe(AUTH_KIND)
    // NIP-42 §client: `relay` + `challenge` tags, empty content, one signature over them.
    expect(tagValues(auth[0], 'relay')).toEqual([RELAY])
    expect(tagValues(auth[0], 'challenge')).toEqual(['challenge-1'])
    expect(auth[0]?.content).toBe('')
    expect(auth[0]?.sig).toMatch(/^[0-9a-f]{128}$/u)

    const published = await socket.publish(signedEvent(1))
    expect(published).toEqual({ accepted: true, message: '' })
    // The handshake was already done, so the write needed no auth-required round trip.
    expect(sentEvents(relay, 'EVENT')).toHaveLength(1)
    expect(sentEvents(relay, 'AUTH')).toHaveLength(1)
  })

  it('retries once when the relay rejects the write auth-required and challenges afresh', async () => {
    const { relay, socket } = open({ relay: { eagerChallenge: false } })
    const event = signedEvent(2)

    const published = await socket.publish(event)
    expect(published.accepted).toBe(true)
    // gate.go:82-85 order: fresh challenge, then the auth-required OK; the client then repeats
    // the same bytes under the completed handshake.
    const types = relay.inbound.map((frame) => frame[0])
    expect(types).toEqual(['EVENT', 'AUTH', 'EVENT'])
    expect(sentEvents(relay, 'AUTH')).toHaveLength(1)
    expect(tagValues(sentEvents(relay, 'AUTH')[0], 'challenge')).toEqual(['challenge-1'])
    const events = sentEvents(relay, 'EVENT')
    expect(events.map((sent) => sent.id)).toEqual([event.id, event.id])
    expect(socket.authed).toBe(true)
  })

  it('names both URLs when the relay rejects the tag, and does not retry a verdict', async () => {
    // A proxy/tunnel dial: the socket hangs off localhost but the relay still expects its public
    // URL in the tag. Omitting authRelayUrl is exactly the day-of mistake.
    const dial = 'ws://127.0.0.1:3334'
    const { relay, socket } = open({ relayUrl: dial })

    const failure = await socket.publish(signedEvent(3)).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.retryable).toBe(false)
    expect(failure.message).toContain(`expected relay URL '${RELAY}'`)
    expect(failure.message).toContain(`The AUTH event's relay tag was "${dial}"`)
    expect(failure.message).toContain('SCRUTINY_SERVICE_URL')

    // Every handshake attempt quotes the dial URL, which is what the relay refuses; the write
    // itself never got a verdict beyond auth-required. The exact number of attempts is a race
    // between the eager challenge and the auth-required one, so only the first is pinned.
    const auth = sentEvents(relay, 'AUTH')
    expect(auth.length).toBeGreaterThanOrEqual(1)
    for (const event of auth) expect(tagValues(event, 'relay')).toEqual([dial])
    expect(tagValues(auth[0], 'challenge')).toEqual(['challenge-1'])
  })

  it('re-signs a reused challenge after a rejection and publishes (nak bunker)', async () => {
    const { relay, socket } = open({
      relay: {
        eagerChallenge: false,
        // One challenge per connection, re-sent with every auth-required rejection; the first
        // handshake is refused by a transient verifier, the second must succeed.
        reuseChallenge: true,
        rejectFirstAuth: 'auth-required: verifier temporarily unavailable',
      },
    })

    const first = await socket.publish(signedEvent(16)).catch((cause: unknown) => cause)
    expect(first).toBeInstanceOf(RelayError)
    if (!(first instanceof RelayError)) throw new Error('expected a RelayError')
    expect(first.message).toContain('verifier temporarily unavailable')

    expect((await socket.publish(signedEvent(17))).accepted).toBe(true)
    const auth = sentEvents(relay, 'AUTH')
    expect(auth).toHaveLength(2)
    // Same challenge value, two distinct signed events: signing per attempt is what keeps a
    // reused challenge from poisoning the rest of the session.
    expect(tagValues(auth[0], 'challenge')).toEqual(['challenge-fixed'])
    expect(tagValues(auth[1], 'challenge')).toEqual(['challenge-fixed'])
    expect(auth[0]?.id).not.toBe(auth[1]?.id)
  })

  it('refuses an AUTH event the signer returned malformed', async () => {
    const relay = createFakeRelay({ expectedRelay: RELAY })
    // The signer's output is the one event this layer never composes; a short id would otherwise
    // reach the map key and the log slice.
    const brokenSigner = {
      sign: async (unsigned: UnsignedEvent) => ({
        ...unsigned,
        id: 'short',
        pubkey: 'x',
        sig: 'y',
      }),
    }
    const socket = authedSocket({
      relayUrl: RELAY,
      signer: brokenSigner,
      wsFactory: relay.factory,
      timeouts: TINY,
    })
    sockets.push(socket)

    const failure = await socket.publish(signedEvent(25)).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toContain('signer failed: AUTH: event.id must be 64-char lowercase hex')
    expect(sentEvents(relay, 'AUTH')).toHaveLength(0)
  })

  it('names a missing challenge when the relay gates writes without challenging', async () => {
    const { relay, socket } = open({
      relay: { eagerChallenge: false, noChallengeOnReject: true },
    })

    const failure = await socket.publish(signedEvent(22)).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toContain('never sent an ["AUTH", <challenge>]')
    expect(failure.message).toContain('SCRUTINY_RELAY_URL')
    expect(sentEvents(relay, 'AUTH')).toHaveLength(0)
  })
})

describe('NIP-20 verdicts', () => {
  it('passes a rejection message through verbatim', async () => {
    const { relay, socket } = open({
      relay: { verdict: () => ({ accepted: false, message: 'blocked: not an allowed publisher' }) },
    })
    await relay.authAccepted()

    expect(await socket.publish(signedEvent(4))).toEqual({
      accepted: false,
      message: 'blocked: not an allowed publisher',
    })
  })

  it.each([
    'blocked: kind 7 is not accepted by this relay',
    'blocked: kind 1 event carries no accepted scrutiny t tag',
    'invalid: event is too old',
    'pow: difficulty 20 is required',
  ])('keeps %j readable for the model', async (message) => {
    const { relay, socket } = open({ relay: { verdict: () => ({ accepted: false, message }) } })
    await relay.authAccepted()

    const published = await socket.publish(signedEvent(5))
    expect(published).toEqual({ accepted: false, message })
  })

  it('fails with the event id and the last NOTICE when no OK arrives', async () => {
    const { relay, socket } = open({ relay: { silentEvents: true } })
    await relay.authAccepted()
    relay.notice('rate limited, slow down')

    const event = signedEvent(6)
    const failure = await socket.publish(event).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toContain(`no NIP-20 OK for event ${event.id.slice(0, 12)}`)
    expect(failure.message).toContain('relay NOTICE: rate limited, slow down')
    expect(failure.retryable).toBe(false)
  })

  it('rejects a malformed event before it reaches the wire', async () => {
    const { relay, socket } = open()
    await expect(socket.publish(signedEvent(7, { id: 'not-hex' }))).rejects.toThrow(
      /event\.id must be 64-char lowercase hex/u,
    )
    expect(sentEvents(relay, 'EVENT')).toHaveLength(0)
  })

  it('ignores OK frames carrying a foreign or truncated event id', async () => {
    const { relay, socket } = open({
      relay: {
        spuriousOk: true,
        verdict: () => ({ accepted: false, message: 'blocked: not an allowed publisher' }),
      },
    })
    await relay.authAccepted()

    // The spurious frames claim acceptance; the real verdict is the blocked one, and nothing threw.
    expect(await socket.publish(signedEvent(20))).toEqual({
      accepted: false,
      message: 'blocked: not an allowed publisher',
    })
  })
})

describe('fetchById', () => {
  it('reads a stored event back over REQ ids and closes the subscription', async () => {
    const stored = signedEvent(8)
    const { relay, socket } = open({ relay: { events: [stored] } })

    expect(await socket.fetchById(stored.id)).toEqual(stored)
    expect(relay.inbound.filter((frame) => frame[0] === 'REQ')).toEqual([
      ['REQ', 'mcp-read-1', { ids: [stored.id] }],
    ])
    expect(relay.inbound.filter((frame) => frame[0] === 'CLOSE')).toEqual([['CLOSE', 'mcp-read-1']])
  })

  it('returns null when the relay EOSEs without the event', async () => {
    const { socket } = open({ relay: { events: [] } })
    expect(await socket.fetchById(signedEvent(9).id)).toBeNull()
  })

  it('ignores a foreign event on an ids-REQ and waits for EOSE', async () => {
    const { relay, socket } = open({ relay: { events: [], mismatchedRead: true } })

    expect(await socket.fetchById(signedEvent(18).id)).toBeNull()
    expect(relay.inbound.filter((frame) => frame[0] === 'CLOSE')).toEqual([['CLOSE', 'mcp-read-1']])
  })

  it('times out rather than accept a foreign event, and closes the subscription', async () => {
    const { relay, socket } = open({
      relay: { events: [], mismatchedRead: true, stallEose: true },
    })

    await expect(socket.fetchById(signedEvent(19).id)).rejects.toThrow(/no EOSE/u)
    expect(relay.inbound.filter((frame) => frame[0] === 'CLOSE')).toEqual([['CLOSE', 'mcp-read-1']])
  })

  it('surfaces a CLOSED with no message as "closed by relay"', async () => {
    const { socket } = open({ relay: { closedReads: '' } })
    await expect(socket.fetchById(signedEvent(21).id)).rejects.toThrow(
      /relay CLOSED the REQ: closed by relay/u,
    )
  })

  it('reads a stored event while the handshake is still pending (reads are never gated)', async () => {
    const stored = signedEvent(10)
    const relay = createFakeRelay({ expectedRelay: RELAY, events: [stored] })
    const { signer, release } = gatedSigner()
    const socket = authedSocket({
      relayUrl: RELAY,
      signer,
      wsFactory: relay.factory,
      timeouts: TINY,
    })
    sockets.push(socket)

    await socket.ready()
    // The eager challenge has been issued and the signer is held: no AUTH event can exist yet.
    await waitUntil(
      () => relay.sockets.some((candidate) => candidate.currentChallenge !== null),
      'the eager challenge',
    )
    expect(sentEvents(relay, 'AUTH')).toHaveLength(0)

    expect(await socket.fetchById(stored.id)).toEqual(stored)
    expect(socket.authed).toBe(false)
    release()
  })

  it('throws on timeout rather than pretending the event is absent', async () => {
    const { relay, socket } = open({ relay: { silentReads: true } })
    await socket.ready()

    const failure = await socket.fetchById(signedEvent(11).id).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toContain('no EOSE for REQ {"ids":["ee0000')
    expect(failure.retryable).toBe(false)
    expect(relay.inbound.filter((frame) => frame[0] === 'REQ')).toHaveLength(1)
    // A timeout abandons the read, so its subscription must be closed too — otherwise every slow
    // read leaks a live REQ on the session-long socket.
    expect(relay.inbound.filter((frame) => frame[0] === 'CLOSE')).toEqual([['CLOSE', 'mcp-read-1']])
  })

  it('surfaces a CLOSED answer verbatim', async () => {
    const { socket } = open({ relay: { closedReads: 'invalid: filter not accepted' } })
    await expect(socket.fetchById(signedEvent(12).id)).rejects.toThrow(
      /relay CLOSED the REQ: invalid: filter not accepted/u,
    )
  })

  it('rejects an id that is not NIP-01-shaped', async () => {
    const { socket } = open()
    await expect(socket.fetchById('nope')).rejects.toThrow(/64-char lowercase hex event id/u)
  })
})

describe('connection lifecycle', () => {
  it('reports a failed connect as a retryable RelayError', async () => {
    const { socket } = open({ relay: { failConnect: true } })
    const failure = await socket.ready().catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.retryable).toBe(true)
    expect(failure.message).toMatch(/websocket error connecting/u)
  })

  it('fails an in-flight write with a retryable error when the socket closes', async () => {
    const { relay, socket } = open({ relay: { silentEvents: true } })
    await relay.authAccepted()

    const pending = socket.publish(signedEvent(13))
    await waitUntil(() => relay.inbound.some((frame) => frame[0] === 'EVENT'), 'the EVENT to land')
    socket.close()

    const failure = await pending.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toBe('socket closed by client')
    expect(failure.retryable).toBe(false)
  })

  it('fails pending work retryably when the facade resets the socket', async () => {
    const { relay, socket } = open({ relay: { silentEvents: true } })
    await relay.authAccepted()

    const pending = socket.publish(signedEvent(26))
    await waitUntil(() => relay.inbound.some((frame) => frame[0] === 'EVENT'), 'the EVENT to land')
    // What the facade does after a retryable failure: peers sharing the socket must retry, so the
    // flush is retryable — unlike `close()`, which is the user ending the session.
    socket.reset('socket reset after a retryable failure')

    const failure = await pending.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toBe('socket reset after a retryable failure')
    expect(failure.retryable).toBe(true)
  })
})
