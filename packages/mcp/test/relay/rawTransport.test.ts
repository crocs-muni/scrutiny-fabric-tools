/**
 * Transport shape A4 adapts to the NIP-46 signer channel (#108 A3): write, hear, close — including
 * the buffering that keeps a first handshake frame from being lost before `open`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { type RawTransport, rawTransport } from '../../src/relay/rawTransport.ts'
import { RelayError } from '../../src/relay/types.ts'
import { createFakeRelay, signedEvent, waitUntil } from './fakeRelay.ts'

const RELAY = 'wss://relay.scrutiny.cloud'

const transports: RawTransport[] = []

afterEach(() => {
  for (const transport of transports.splice(0)) transport.close()
})

describe('rawTransport', () => {
  it('queues frames until the socket opens, then flushes them in order', async () => {
    const relay = createFakeRelay({ expectedRelay: RELAY, eagerChallenge: false })
    const transport = rawTransport(RELAY, { wsFactory: relay.factory })
    transports.push(transport)

    transport.send(['REQ', 'signer', {}])
    transport.send(['EVENT', signedEvent(1)])
    // `open` is one microtask behind the factory, so nothing is on the wire yet.
    expect(relay.lastSocket().inbound).toHaveLength(0)

    await waitUntil(() => relay.lastSocket().inbound.length === 2, 'the queued frames to flush')
    expect(relay.lastSocket().inbound.map((frame) => frame[0])).toEqual(['REQ', 'EVENT'])
  })

  it('fans inbound frames out to every handler and stops after unsubscribe', async () => {
    const relay = createFakeRelay({ expectedRelay: RELAY, eagerChallenge: false })
    const transport = rawTransport(RELAY, { wsFactory: relay.factory })
    transports.push(transport)

    const first: string[] = []
    const second: string[] = []
    const unsubscribe = transport.onMessage((raw) => first.push(raw))
    transport.onMessage((raw) => second.push(raw))
    await waitUntil(() => relay.lastSocket().readyState === 1, 'the fake socket to open')

    const frame = JSON.stringify(['EOSE', 'signer'])
    relay.lastSocket().deliver(['EOSE', 'signer'])
    await waitUntil(
      () => first.length === 1 && second.length === 1,
      'the frame to reach both handlers',
    )
    expect(first[0]).toBe(frame)

    unsubscribe()
    relay.lastSocket().deliver(['NOTICE', 'again'])
    await waitUntil(() => second.length === 2, 'the second frame to reach the remaining handler')
    expect(first).toHaveLength(1)
  })

  it('refuses to send after close and closes the socket', () => {
    const relay = createFakeRelay({ expectedRelay: RELAY, eagerChallenge: false })
    const transport = rawTransport(RELAY, { wsFactory: relay.factory })
    transports.push(transport)

    transport.close()
    expect(relay.lastSocket().readyState).toBe(3)
    expect(() => transport.send(['REQ', 'signer', {}])).toThrow(RelayError)
    expect(() => transport.send(['REQ', 'signer', {}])).toThrow(/raw transport closed/u)
    // Idempotent: a second close is not an error.
    expect(() => transport.close()).not.toThrow()
  })

  it('drops the queue when the relay closes before it opens, and reports it', async () => {
    const relay = createFakeRelay({ expectedRelay: RELAY, eagerChallenge: false })
    const logs: string[] = []
    const transport = rawTransport(RELAY, {
      wsFactory: relay.factory,
      log: (line) => logs.push(line),
    })
    transports.push(transport)

    transport.send(['REQ', 'signer', {}])
    relay.lastSocket().serverClose(1006, 'proxy gone')
    await waitUntil(
      () => logs.some((line) => line.startsWith('[ws] closed')),
      'the close to be reported',
    )

    expect(logs.some((line) => line.includes('proxy gone'))).toBe(true)
    expect(() => transport.send(['REQ', 'signer', {}])).toThrow(/raw transport closed/u)
  })
})
