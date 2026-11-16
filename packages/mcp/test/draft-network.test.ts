/**
 * The relay and URL questions of spec §6.5, raised when `draftPlan` runs with a network port.
 * The port is faked here; the live one is exercised against an in-process relay at the end.
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { UrlCheck } from '../src/artifacts/url.js'
import { type Draft, type DraftNetwork, draftPlan } from '../src/plan/draft.js'
import { liveDraftNetwork } from '../src/relay/network.js'
import type { RelayProbe } from '../src/relay/nip11.js'
import { FakeRelay } from './_fake-relay.js'
import { FILES, METADATA, PRIMARY, PRODUCT, PROFILE, PUBKEY, makeRoot, plan } from './_fixtures.js'
import { sampleEvent, testSigner } from './_signer.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const OK_PROBE: RelayProbe = {
  reachable: true,
  blossom: true,
  clock_skew_s: 0,
  limits: { max_limit: 500 },
  created_at_window: { past_s: 7200, future_s: 900 },
}

function network(
  over: {
    probe?: Partial<RelayProbe> | RelayProbe
    url?: UrlCheck
    profile?: boolean | null
  } = {},
): DraftNetwork & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    probeRelay: async () => ({ ...OK_PROBE, ...(over.probe ?? {}) }) as RelayProbe,
    verifyUrl: async (url) => {
      urls.push(url)
      return over.url ?? { kind: 'match' }
    },
    profilePublished: async () => over.profile ?? false,
  }
}

async function draft(records: readonly unknown[], net: DraftNetwork) {
  return draftPlan({ root: makeRoot(FILES), plan: plan(records), pubkey: PUBKEY, network: net })
}

const questions = (d: Draft) =>
  d.status === 'drafted'
    ? d.open_questions.map((q) => ({ code: q.code, field: q.field, blocking: q.blocking }))
    : d.findings

describe('relay probe questions', () => {
  it('raises nothing for a healthy primary, and shows the probe in the preview', async () => {
    const d = await draft([PROFILE, PRODUCT, METADATA], network())
    expect(questions(d)).toStrictEqual([])
    expect(d.status === 'drafted' && d.preview.relays).toStrictEqual([
      {
        url: PRIMARY,
        role: 'primary',
        reachable: true,
        blossom: true,
        clock_skew_s: 0,
        limits: { max_limit: 500 },
      },
    ])
  })

  it('blocks on an unreachable primary', async () => {
    const d = await draft(
      [PROFILE, PRODUCT],
      network({ probe: { reachable: false, message: 'down' } }),
    )
    expect(questions(d)).toStrictEqual([
      { code: 'relay.unreachable', field: 'relays[0]', blocking: true },
    ])
  })

  it('blocks on a primary without Blossom only when something must be uploaded', async () => {
    const noBlossom = network({ probe: { blossom: false } })
    expect(questions(await draft([PROFILE, PRODUCT, METADATA], noBlossom))).toStrictEqual([
      { code: 'relay.no_blossom', field: 'relays[0]', blocking: true },
    ])
    const viaUrl = {
      ...METADATA,
      artifacts: [{ path: 'reports/fi.pdf', url: 'https://example.com/fi.pdf', alt: 'FI' }],
    }
    expect(questions(await draft([PROFILE, PRODUCT, viaUrl], noBlossom))).toStrictEqual([])
  })

  it('warns past 60 s of clock skew and blocks outside the relay window, both ways', async () => {
    const at = async (skew: number) =>
      questions(await draft([PROFILE, PRODUCT], network({ probe: { clock_skew_s: skew } })))
    expect(await at(60)).toStrictEqual([])
    expect(await at(-61)).toStrictEqual([
      { code: 'relay.clock_skew', field: 'relays[0]', blocking: false },
    ])
    expect(await at(900)).toStrictEqual([
      { code: 'relay.clock_skew', field: 'relays[0]', blocking: false },
    ])
    expect(await at(901)).toStrictEqual([
      { code: 'relay.clock_skew', field: 'relays[0]', blocking: true },
    ])
    expect(await at(-7201)).toStrictEqual([
      { code: 'relay.clock_skew', field: 'relays[0]', blocking: true },
    ])
  })
})

describe('artifact.url_mismatch', () => {
  const viaUrl = {
    ...METADATA,
    artifacts: [{ path: 'reports/fi.pdf', url: 'https://example.com/fi.pdf', alt: 'FI' }],
  }

  it('checks the URL against the local hash and passes on a match', async () => {
    const net = network()
    expect(questions(await draft([PROFILE, PRODUCT, viaUrl], net))).toStrictEqual([])
    expect(net.urls).toStrictEqual(['https://example.com/fi.pdf'])
  })

  it('blocks on a mismatch or a failed download', async () => {
    for (const url of [
      { kind: 'mismatch', x: sha256('other') },
      { kind: 'error', message: 'HTTP 404' },
    ] as const) {
      expect(questions(await draft([PROFILE, PRODUCT, viaUrl], network({ url })))).toStrictEqual([
        {
          code: 'artifact.url_mismatch',
          field: 'records[metadata:fi-test].artifacts[0].url',
          blocking: true,
        },
      ])
    }
  })
})

describe('profile.missing with a relay to ask', () => {
  it('stays quiet when this pubkey already has a profile on the primary', async () => {
    expect(questions(await draft([PRODUCT], network({ profile: true })))).toStrictEqual([])
  })

  it('asks when none is published, or when the relay could not say', async () => {
    for (const profile of [false, null]) {
      expect(questions(await draft([PRODUCT], network({ profile })))).toStrictEqual([
        { code: 'profile.missing', field: null, blocking: false },
      ])
    }
  })
})

describe('liveDraftNetwork against an in-process relay', () => {
  let relay: FakeRelay | undefined
  afterEach(async () => {
    await relay?.stop()
  })

  it('finds a published profile by kind 0 and author, without authenticating', async () => {
    relay = await FakeRelay.start({ requireAuth: false })
    const signer = testSigner()
    const net = liveDraftNetwork({ fetch: globalThis.fetch, signer, now: () => 1_800_000_000 })
    expect(await net.profilePublished(relay.url, PUBKEY)).toBe(false)
    const profile = { ...sampleEvent('{}'), kind: 0 }
    relay.stored.set(profile.id, { ...profile, tags: [] })
    expect(await net.profilePublished(relay.url, PUBKEY)).toBe(true)
    expect(signer.calls).toStrictEqual([])
  })

  it('reports null when the relay cannot be reached', async () => {
    relay = await FakeRelay.start()
    const url = relay.url
    await relay.stop()
    relay = undefined
    const net = liveDraftNetwork({ fetch: globalThis.fetch, signer: testSigner(), now: () => 0 })
    expect(await net.profilePublished(url, PUBKEY)).toBeNull()
  })

  it('is unreachable when NIP-11 answers but the WebSocket does not', async () => {
    relay = await FakeRelay.start()
    const url = relay.url
    await relay.stop()
    relay = undefined
    const nip11 = (async () => Response.json({ limitation: {} })) as unknown as typeof fetch
    const net = liveDraftNetwork({ fetch: nip11, signer: testSigner(), now: () => 0 })
    expect(await net.probeRelay(url)).toMatchObject({ reachable: false })
  })

  it('is reachable when both answer', async () => {
    relay = await FakeRelay.start()
    const nip11 = (async () => Response.json({ limitation: {} })) as unknown as typeof fetch
    const net = liveDraftNetwork({ fetch: nip11, signer: testSigner(), now: () => 0 })
    expect(await net.probeRelay(relay.url)).toMatchObject({ reachable: true })
  })
})
