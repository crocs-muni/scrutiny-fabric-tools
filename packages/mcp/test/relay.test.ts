/**
 * Relay connection and client against an in-process relay. Ports the audit's KEEP rows for
 * `test/relay/authedSocket.test.ts` and `test/relay/client.test.ts`, including the hostile-relay
 * guards (forged OK, foreign event on an ids-REQ) and the same-bytes resend the audit found
 * unasserted (gap 13).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayClient } from '../src/relay/client.js'
import { RelayConnection, RelayError } from '../src/relay/socket.js'
import { type FakeRelay, type FakeRelayOptions, FakeRelay as Relay } from './_fake-relay.js'
import { sampleEvent, testSigner } from './_signer.js'

const NOW = 1_800_000_000
const FAST = { okMs: 300, eoseMs: 300, connectMs: 1000 }

let relays: FakeRelay[] = []
let connections: { close(): void }[] = []
afterEach(async () => {
  for (const c of connections) c.close()
  for (const r of relays) await r.stop()
  relays = []
  connections = []
})

async function relay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const r = await Relay.start(options)
  relays.push(r)
  return r
}

async function connect(r: FakeRelay, signer = testSigner()) {
  const conn = await RelayConnection.open({ url: r.url, signer, now: () => NOW, timeouts: FAST })
  connections.push(conn)
  return conn
}

async function errorKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof RelayError) return `${cause.kind}${cause.retryable ? ' (retryable)' : ''}`
    throw cause
  }
  return 'no error'
}

describe('RelayConnection: NIP-42 and EVENT/OK', () => {
  it('answers the eager challenge with the relay URL before the first write', async () => {
    const r = await relay()
    const signer = testSigner()
    const conn = await connect(r, signer)
    const event = sampleEvent()
    expect(await conn.publish(event)).toStrictEqual({ ok: true, message: '' })
    expect(r.frames.map((f) => f[0])).toStrictEqual(['AUTH', 'EVENT'])
    const auth = signer.calls[0]
    expect(auth?.kind).toBe(22242)
    expect(auth?.created_at).toBe(NOW)
    expect(auth?.tags).toStrictEqual([
      ['relay', r.url],
      ['challenge', 'challenge-1'],
    ])
  })

  it('re-authenticates once on auth-required and resends the same bytes', async () => {
    const r = await relay({ challengeOnConnect: false })
    const conn = await connect(r)
    const event = sampleEvent()
    expect(await conn.publish(event)).toStrictEqual({ ok: true, message: '' })
    expect(r.frames.map((f) => f[0])).toStrictEqual(['EVENT', 'AUTH', 'EVENT'])
    const [first, , second] = r.frames
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('does not loop when the relay still says auth-required after re-authenticating', async () => {
    const r = await relay({
      challengeOnConnect: false,
      onEvent: (_e, { socket }) => {
        socket.send(JSON.stringify(['AUTH', 'again']))
        return { ok: false, message: 'auth-required: still no' }
      },
    })
    const conn = await connect(r)
    expect(await conn.publish(sampleEvent())).toStrictEqual({
      ok: false,
      message: 'auth-required: still no',
    })
    expect(r.sent('EVENT')).toHaveLength(2)
  })

  it('passes a rejection message through verbatim, and a duplicate as ok', async () => {
    const reply = { ok: false, message: 'blocked: not an allowed publisher' }
    const r = await relay({ onEvent: () => reply })
    expect(await (await connect(r)).publish(sampleEvent())).toStrictEqual(reply)

    const d = await relay()
    const conn = await connect(d)
    const event = sampleEvent()
    await conn.publish(event)
    expect(await conn.publish(event)).toStrictEqual({
      ok: true,
      message: 'duplicate: already have it',
    })
  })

  it('ignores OK frames carrying a foreign or truncated event id', async () => {
    const r = await relay({
      onEvent: (event, { socket }) => {
        socket.send(JSON.stringify(['OK', 'f'.repeat(64), true, 'forged']))
        socket.send(JSON.stringify(['OK', event.id.slice(0, 63), true, 'truncated']))
        socket.send(JSON.stringify(['OK', event.id, false, 'blocked: the real verdict']))
        return 'drop'
      },
    })
    expect(await (await connect(r)).publish(sampleEvent())).toStrictEqual({
      ok: false,
      message: 'blocked: the real verdict',
    })
  })

  it('times out without an OK, retryably', async () => {
    const r = await relay({ onEvent: () => 'drop' })
    expect(await errorKind((await connect(r)).publish(sampleEvent()))).toBe('timeout (retryable)')
  })

  it('fails an in-flight write retryably when the socket closes', async () => {
    const r = await relay({ onEvent: () => 'close' })
    expect(await errorKind((await connect(r)).publish(sampleEvent()))).toBe('closed (retryable)')
  })

  it('reports a failed connect as retryable', async () => {
    const r = await relay()
    const url = r.url
    await r.stop()
    relays = []
    await expect(
      errorKind(
        RelayConnection.open({ url, signer: testSigner(), now: () => NOW, timeouts: FAST }),
      ),
    ).resolves.toBe('connect (retryable)')
  })
})

describe('RelayConnection: REQ', () => {
  it('reads stored events by id, then closes the subscription', async () => {
    const r = await relay()
    const conn = await connect(r)
    const a = sampleEvent('a')
    const b = sampleEvent('b')
    await conn.publish(a)
    await conn.publish(b)
    const found = await conn.fetchByIds([a.id, b.id, 'c'.repeat(64)])
    expect([...found.keys()].sort()).toStrictEqual([a.id, b.id].sort())
    expect(found.get(a.id)).toStrictEqual(a)
    const req = r.sent('REQ')
    expect(req).toHaveLength(1)
    await vi.waitFor(() => expect(r.sent('CLOSE')).toStrictEqual([['CLOSE', req[0]?.[1]]]))
  })

  it('ignores a foreign event on an ids-REQ and waits for EOSE', async () => {
    const wanted = sampleEvent('wanted')
    const foreign = sampleEvent('foreign')
    const r = await relay({
      onReq: (subId, _filters, socket) => {
        socket.send(JSON.stringify(['EVENT', subId, foreign]))
        socket.send(JSON.stringify(['EVENT', 'other-sub', wanted]))
        socket.send(JSON.stringify(['EOSE', subId]))
      },
    })
    expect((await (await connect(r)).fetchByIds([wanted.id])).size).toBe(0)
  })

  it('throws on a CLOSED reply with the message verbatim', async () => {
    const r = await relay({
      onReq: (subId, _f, socket) => socket.send(JSON.stringify(['CLOSED', subId, 'error: nope'])),
    })
    const conn = await connect(r)
    await expect(conn.fetchByIds([sampleEvent().id])).rejects.toMatchObject({
      kind: 'closed',
      relayMessage: 'error: nope',
    })
  })

  it('throws on timeout rather than reporting the event absent', async () => {
    const r = await relay({ onReq: () => {} })
    expect(await errorKind((await connect(r)).fetchByIds([sampleEvent().id]))).toBe(
      'timeout (retryable)',
    )
  })

  it('reads without authenticating', async () => {
    const r = await relay()
    const signer = testSigner()
    await (await connect(r, signer)).fetchByIds([sampleEvent().id])
    expect(signer.calls).toStrictEqual([])
  })

  it('queries by filter for a profile', async () => {
    const r = await relay()
    const conn = await connect(r)
    const profile = sampleEvent('{}')
    await conn.publish(profile)
    expect(await conn.query({ kinds: [1], authors: [profile.pubkey], limit: 1 })).toStrictEqual([
      profile,
    ])
  })
})

describe('RelayClient: reconnect and resend (spec §8.3)', () => {
  const noSleep = async () => {}

  it('dials lazily and reuses one socket', async () => {
    const r = await relay()
    const client = new RelayClient({
      url: r.url,
      signer: testSigner(),
      now: () => NOW,
      timeouts: FAST,
      sleep: noSleep,
    })
    connections.push(client)
    expect(r.sockets).toBe(0)
    await client.publish(sampleEvent('a'))
    await client.publish(sampleEvent('b'))
    await client.fetchByIds([sampleEvent('a').id])
    expect(r.sockets).toBe(1)
  })

  it('reconnects when the connection dies before the ack and resends the same bytes', async () => {
    let drops = 1
    const r = await relay({ onEvent: () => (drops-- > 0 ? 'close' : 'default') })
    const delays: number[] = []
    const client = new RelayClient({
      url: r.url,
      signer: testSigner(),
      now: () => NOW,
      timeouts: FAST,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    connections.push(client)
    const event = sampleEvent()
    expect(await client.publish(event)).toStrictEqual({ ok: true, message: '' })
    const sent = r.sent('EVENT')
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]))
    expect(r.sockets).toBe(2)
    expect(delays).toStrictEqual([1000])
  })

  it('never reconnects for a relay verdict', async () => {
    const r = await relay({ onEvent: () => ({ ok: false, message: 'blocked: no' }) })
    const client = new RelayClient({
      url: r.url,
      signer: testSigner(),
      now: () => NOW,
      timeouts: FAST,
      sleep: noSleep,
    })
    connections.push(client)
    expect(await client.publish(sampleEvent())).toStrictEqual({ ok: false, message: 'blocked: no' })
    expect(r.sockets).toBe(1)
  })

  it('gives up after three resends with 1 s / 4 s / 10 s delays', async () => {
    const r = await relay({ onEvent: () => 'drop' })
    const delays: number[] = []
    const client = new RelayClient({
      url: r.url,
      signer: testSigner(),
      now: () => NOW,
      timeouts: FAST,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    connections.push(client)
    expect(await errorKind(client.publish(sampleEvent()))).toBe('timeout (retryable)')
    expect(r.sent('EVENT')).toHaveLength(4)
    expect(delays).toStrictEqual([1000, 4000, 10000])
  })
})
