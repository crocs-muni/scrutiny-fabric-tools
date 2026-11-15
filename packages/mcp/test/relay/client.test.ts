/**
 * Connect/reconnect policy of `RelayClient` (#108 A3): lazy dial, single-flight, socket reuse, one
 * fresh connection per retryable failure, no reconnect for a relay verdict, permanent close.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { RelayClient } from '../../src/relay/client.ts'
import { RelayError } from '../../src/relay/types.ts'
import {
  type FakeRelay,
  type FakeRelayOptions,
  createFakeRelay,
  fakeSigner,
  sentEvents,
  signedEvent,
  waitUntil,
} from './fakeRelay.ts'

const RELAY = 'wss://relay.scrutiny.cloud'
const TINY = { connectMs: 50, authMs: 50, ackMs: 50, readMs: 50 }

const clients: RelayClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

function makeClient(
  relayOptions: Partial<FakeRelayOptions> = {},
  reconnectAttempts?: number,
): { relay: FakeRelay; client: RelayClient } {
  const relay = createFakeRelay({ expectedRelay: RELAY, ...relayOptions })
  const client = new RelayClient({
    relayUrl: RELAY,
    signer: fakeSigner(),
    wsFactory: relay.factory,
    timeouts: TINY,
    ...(reconnectAttempts === undefined ? {} : { reconnectAttempts }),
  })
  clients.push(client)
  return { relay, client }
}

describe('socket lifecycle', () => {
  it('dials lazily and reuses the socket across operations', async () => {
    const { relay, client } = makeClient()
    expect(client.connected).toBe(false)
    expect(relay.sockets).toHaveLength(0)

    expect((await client.publish(signedEvent(1))).accepted).toBe(true)
    expect(client.connected).toBe(true)
    expect((await client.publish(signedEvent(2))).accepted).toBe(true)

    expect(relay.sockets).toHaveLength(1)
    expect(sentEvents(relay, 'EVENT').length).toBeGreaterThanOrEqual(2)
  })

  it('shares one dial between concurrent operations', async () => {
    const { relay, client } = makeClient()

    const published = await Promise.all([
      client.publish(signedEvent(3)),
      client.publish(signedEvent(4)),
    ])

    expect(published.map((result) => result.accepted)).toEqual([true, true])
    expect(relay.sockets).toHaveLength(1)
  })

  it('does not report connected while the socket is still connecting', async () => {
    const { relay, client } = makeClient({ stallConnect: true })

    const pending = client.publish(signedEvent(27)).catch((cause: unknown) => cause)
    await waitUntil(() => relay.sockets.length === 1, 'the dial to start')
    // The socket object exists and is neither open nor closed: `status` must not claim a
    // connection the relay has not accepted (this window lasts up to connectMs).
    expect(client.connected).toBe(false)

    client.close()
    const failure = await pending
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toMatch(/relay client closed/u)
  })

  it('retries a peer operation when a concurrent failure resets the socket', async () => {
    // The first write the relay would have acked is lost, so the shared socket is reset while the
    // peer either waits for its own ack or is about to send; it must reconnect, not fail.
    const { relay, client } = makeClient({ dropEvents: 'first' })

    const published = await Promise.all([
      client.publish(signedEvent(28)),
      client.publish(signedEvent(29)),
    ])

    expect(published.map((result) => result.accepted)).toEqual([true, true])
    expect(relay.sockets.length).toBeGreaterThanOrEqual(2)
  })

  it('serves fetchById through the same socket', async () => {
    const stored = signedEvent(5)
    const { relay, client } = makeClient({ events: [stored] })
    await client.publish(signedEvent(6))

    expect(await client.fetchById(stored.id)).toEqual(stored)
    expect(relay.sockets).toHaveLength(1)
  })

  it('dials a fresh socket after the relay dropped the live one', async () => {
    const { relay, client } = makeClient()
    await client.publish(signedEvent(7))
    relay.lastSocket().serverClose(1006, 'idle timeout')
    await waitUntil(() => !client.connected, 'the client to notice the close')

    expect((await client.publish(signedEvent(8))).accepted).toBe(true)
    expect(relay.sockets).toHaveLength(2)
  })
})

describe('reconnect policy', () => {
  it('reconnects once when the connection dies before the ack', async () => {
    const { relay, client } = makeClient({ dropEvents: 'first' })

    const published = await client.publish(signedEvent(9))

    expect(published.accepted).toBe(true)
    expect(relay.sockets).toHaveLength(2)
    // The event landed on the second socket, after the first was retired.
    expect(sentEvents(relay, 'EVENT').length).toBeGreaterThanOrEqual(2)
  })

  it('never reconnects for a relay verdict', async () => {
    const { relay, client } = makeClient({
      verdict: () => ({ accepted: false, message: 'blocked: not an allowed publisher' }),
    })

    const published = await client.publish(signedEvent(10))

    expect(published).toEqual({ accepted: false, message: 'blocked: not an allowed publisher' })
    expect(relay.sockets).toHaveLength(1)
  })

  it('gives up after the reconnect budget and reports the last failure', async () => {
    const { relay, client } = makeClient({ dropEvents: 'all' }, 1)

    const failure = await client.publish(signedEvent(11)).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toMatch(/connection closed \(code 1006/u)
    expect(relay.sockets).toHaveLength(2)
  })

  it('retries a failed dial within the same budget', async () => {
    const { relay, client } = makeClient({ failConnect: true })

    await expect(client.publish(signedEvent(15))).rejects.toThrow(/websocket error connecting/u)
    expect(relay.sockets).toHaveLength(2)
  })

  it('reconnectAttempts: 0 means exactly one socket and a rethrown failure', async () => {
    const { relay, client } = makeClient({ dropEvents: 'first' }, 0)

    const failure = await client.publish(signedEvent(12)).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toMatch(/connection closed/u)
    expect(relay.sockets).toHaveLength(1)
  })
})

describe('close', () => {
  it('is permanent: the socket is closed and later operations refuse', async () => {
    const { relay, client } = makeClient()
    await client.publish(signedEvent(13))

    client.close()
    expect(client.connected).toBe(false)
    expect(relay.lastSocket().readyState).toBe(3)

    const failure = await client.publish(signedEvent(14)).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RelayError)
    if (!(failure instanceof RelayError)) throw new Error('expected a RelayError')
    expect(failure.message).toMatch(/relay client closed/u)
    expect(relay.sockets).toHaveLength(1)
  })
})
