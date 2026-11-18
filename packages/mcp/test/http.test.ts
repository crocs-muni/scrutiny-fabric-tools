/**
 * The HTTP side of step 3: NIP-11 probe, publisher-URL verification (§9.2) and the Blossom client
 * (§9.3), each driven through an injected `fetch` so no network is touched.
 */

import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { BlossomError, ensureBlob } from '../src/artifacts/blossom.js'
import { verifyUrl } from '../src/artifacts/url.js'
import { probeRelay } from '../src/relay/nip11.js'
import { testSigner } from './_signer.js'

const NOW = 1_800_000_000
const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: Uint8Array | null
}

/** A fake `fetch` answering from a route function, recording each call. */
function fakeFetch(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: body instanceof Uint8Array ? body : null,
    }
    calls.push(call)
    return route(call)
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

describe('probeRelay (NIP-11 + Blossom presence + clock skew)', () => {
  const info = {
    name: 'test',
    limitation: { max_limit: 500, max_event_tags: 64, max_message_length: 512000 },
  }

  it('reads limits, measures skew from the Date header, and sees Blossom answer HEAD /upload', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.method === 'GET') {
        return new Response(JSON.stringify(info), {
          headers: {
            'content-type': 'application/nostr+json',
            date: new Date((NOW - 61) * 1000).toUTCString(),
          },
        })
      }
      return new Response(null, { status: 401 })
    })
    expect(await probeRelay('wss://relay.example', { fetch, now: () => NOW })).toStrictEqual({
      reachable: true,
      blossom: true,
      clock_skew_s: 61,
      limits: { max_limit: 500, max_event_tags: 64, max_message_length: 512000 },
      created_at_window: { past_s: 7200, future_s: 900 },
    })
    expect(calls[0]).toMatchObject({ url: 'https://relay.example/', method: 'GET' })
    expect(calls[0]?.headers.get('accept')).toBe('application/nostr+json')
    expect(calls[1]).toMatchObject({ url: 'https://relay.example/upload', method: 'HEAD' })
  })

  it('takes the created_at window from NIP-11 when the relay advertises one', async () => {
    const { fetch } = fakeFetch((call) =>
      call.method === 'GET'
        ? Response.json({ limitation: { created_at_lower_limit: 60, created_at_upper_limit: 30 } })
        : new Response(null, { status: 404 }),
    )
    const probe = await probeRelay('ws://127.0.0.1:7777', { fetch, now: () => NOW })
    expect(probe).toMatchObject({
      reachable: true,
      blossom: false,
      created_at_window: { past_s: 60, future_s: 30 },
    })
  })

  it('reports a document that is not an object as unreachable', async () => {
    for (const doc of [null, [], 'relay', 7]) {
      const { fetch } = fakeFetch(() => Response.json(doc))
      expect(await probeRelay('wss://r.example', { fetch, now: () => NOW })).toMatchObject({
        reachable: false,
      })
    }
  })

  it('degrades a malformed limitation to the defaults instead of throwing', async () => {
    for (const limitation of [null, [1], 'wide', 42]) {
      const { fetch } = fakeFetch((call) =>
        call.method === 'GET'
          ? Response.json({ name: 'test', limitation })
          : new Response(null, { status: 404 }),
      )
      expect(await probeRelay('wss://r.example', { fetch, now: () => NOW })).toStrictEqual({
        reachable: true,
        blossom: false,
        clock_skew_s: null,
        limits: {},
        created_at_window: { past_s: 7200, future_s: 900 },
      })
    }
  })

  it('reports Blossom absent on 404 or 405, and when HEAD fails', async () => {
    for (const status of [404, 405]) {
      const { fetch } = fakeFetch((call) =>
        call.method === 'GET' ? Response.json(info) : new Response(null, { status }),
      )
      expect(await probeRelay('wss://r.example', { fetch, now: () => NOW })).toMatchObject({
        blossom: false,
      })
    }
    const { fetch } = fakeFetch((call) => {
      if (call.method === 'GET') return Response.json(info)
      throw new TypeError('network')
    })
    expect(await probeRelay('wss://r.example', { fetch, now: () => NOW })).toMatchObject({
      blossom: false,
    })
  })

  it('is unreachable when NIP-11 fails or is not JSON', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    expect(
      (await probeRelay('wss://r.example', { fetch: down.fetch, now: () => NOW })).reachable,
    ).toBe(false)
    const html = fakeFetch(() => new Response('<html>', { status: 200 }))
    expect(
      (await probeRelay('wss://r.example', { fetch: html.fetch, now: () => NOW })).reachable,
    ).toBe(false)
  })
})

describe('verifyUrl (spec §9.2)', () => {
  const body = new TextEncoder().encode('report bytes')
  const x = sha256(body)

  it('matches when the downloaded bytes hash to the local x', async () => {
    const { fetch } = fakeFetch(() => new Response(body))
    expect(await verifyUrl('https://example.com/r.pdf', x, { fetch })).toStrictEqual({
      kind: 'match',
    })
  })

  it('reports a mismatch with the downloaded hash', async () => {
    const { fetch } = fakeFetch(() => new Response('other bytes'))
    expect(await verifyUrl('https://example.com/r.pdf', x, { fetch })).toStrictEqual({
      kind: 'mismatch',
      x: sha256('other bytes'),
    })
  })

  it('follows up to 3 HTTPS redirects and refuses a 4th', async () => {
    const chain = (hops: number) =>
      fakeFetch((call) => {
        const n = Number(new URL(call.url).searchParams.get('n') ?? '0')
        return n < hops
          ? new Response(null, {
              status: 302,
              headers: { location: `https://example.com/r?n=${n + 1}` },
            })
          : new Response(body)
      })
    expect(await verifyUrl('https://example.com/r', x, chain(3))).toStrictEqual({ kind: 'match' })
    expect((await verifyUrl('https://example.com/r', x, chain(4))).kind).toBe('error')
  })

  it('refuses HTTP, both as the URL and as a redirect target', async () => {
    const plain = fakeFetch(() => new Response(body))
    expect((await verifyUrl('http://example.com/r', x, plain)).kind).toBe('error')
    expect(plain.calls).toHaveLength(0)
    const downgrade = fakeFetch(
      () => new Response(null, { status: 301, headers: { location: 'http://example.com/r' } }),
    )
    expect((await verifyUrl('https://example.com/r', x, downgrade)).kind).toBe('error')
  })

  it('stops reading at the size cap', async () => {
    const { fetch } = fakeFetch(() => new Response(new Uint8Array(1025)))
    expect((await verifyUrl('https://example.com/r', x, { fetch, maxBytes: 1024 })).kind).toBe(
      'error',
    )
  })

  it('reports a non-2xx status as an error', async () => {
    const { fetch } = fakeFetch(() => new Response('gone', { status: 404 }))
    expect((await verifyUrl('https://example.com/r', x, { fetch })).kind).toBe('error')
  })
})

describe('ensureBlob (BUD-02 upload, spec §9.3)', () => {
  const bytes = new TextEncoder().encode('report bytes')
  const x = sha256(bytes)
  const blob = { x, size: bytes.length, m: 'application/pdf', ext: '.pdf' }

  it('skips the upload, and signs nothing, when HEAD /<x> finds the blob', async () => {
    const signer = testSigner()
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const result = await ensureBlob({
      primary: 'wss://relay.example',
      blob,
      bytes: async () => bytes,
      signer,
      now: () => NOW,
      fetch,
    })
    expect(result).toStrictEqual({ state: 'present', url: `https://relay.example/${x}.pdf` })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual([
      `HEAD https://relay.example/${x}`,
    ])
    expect(signer.calls).toStrictEqual([])
  })

  it('uploads with a kind-24242 authorization, then checks the returned sha256', async () => {
    const signer = testSigner()
    const { fetch, calls } = fakeFetch((call) =>
      call.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : Response.json({ sha256: x, size: bytes.length, url: `https://relay.example/${x}.bin` }),
    )
    const result = await ensureBlob({
      primary: 'wss://relay.example',
      blob,
      bytes: async () => bytes,
      signer,
      now: () => NOW,
      fetch,
    })
    expect(result).toStrictEqual({ state: 'uploaded', url: `https://relay.example/${x}.pdf` })

    const put = calls[1]
    expect(put?.method).toBe('PUT')
    expect(put?.url).toBe('https://relay.example/upload')
    expect(put?.body).toStrictEqual(bytes)
    expect(put?.headers.get('content-type')).toBe('application/pdf')
    expect(put?.headers.get('x-sha-256')).toBe(x)

    const token = put?.headers.get('authorization') ?? ''
    expect(token.startsWith('Nostr ')).toBe(true)
    const auth = JSON.parse(Buffer.from(token.slice(6), 'base64url').toString('utf8'))
    expect(verifyEvent(auth)).toBe(true)
    expect(auth.kind).toBe(24242)
    expect(auth.created_at).toBe(NOW)
    expect(auth.tags).toStrictEqual([
      ['t', 'upload'],
      ['x', x],
      ['expiration', String(NOW + 300)],
      ['server', 'https://relay.example'],
    ])
  })

  it('refuses a descriptor whose sha256 differs from x', async () => {
    const { fetch } = fakeFetch((call) =>
      call.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : Response.json({ sha256: 'f'.repeat(64) }),
    )
    await expect(
      ensureBlob({
        primary: 'wss://relay.example',
        blob,
        bytes: async () => bytes,
        signer: testSigner(),
        now: () => NOW,
        fetch,
      }),
    ).rejects.toMatchObject({ refusal: { code: 'artifact.upload_mismatch', source: 'artifact' } })
  })

  it('passes a rejection reason through verbatim', async () => {
    const { fetch } = fakeFetch((call) =>
      call.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : new Response('denied', {
            status: 403,
            headers: { 'x-reason': 'blocked: not an allowed publisher' },
          }),
    )
    try {
      await ensureBlob({
        primary: 'wss://relay.example',
        blob,
        bytes: async () => bytes,
        signer: testSigner(),
        now: () => NOW,
        fetch,
      })
      expect.unreachable()
    } catch (cause) {
      expect(cause).toBeInstanceOf(BlossomError)
      expect((cause as BlossomError).refusal).toMatchObject({
        code: 'artifact.upload_failed',
        relay_message: 'blocked: not an allowed publisher',
      })
    }
  })
})
