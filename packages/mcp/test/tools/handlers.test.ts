/**
 * The #108 A4 handlers over the fake relay, a real dev-key signer and the cooperative fake bunker:
 * the wire event is byte-exact, every refusal happens before a signature is spent, and the report
 * never claims a verification it did not perform.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import {
  type NostrEvent,
  type UnsignedEvent,
  VERSION_TAG,
  buildProduct,
} from '@scrutiny-fabric/core'
import { afterEach, describe, expect, it } from 'vitest'
import { type ServerConfig, loadConfig } from '../../src/config.ts'
import { createDevKeySigner, verifySignedEvent } from '../../src/identity/sign.ts'
import { RelayClient } from '../../src/relay/client.ts'
import type { AuthSigner } from '../../src/relay/types.ts'
import type { HandlerContext } from '../../src/tools/handlers/context.ts'
import { createContext } from '../../src/tools/handlers/context.ts'
import { TOOLS, type ToolDeps } from '../../src/tools/register.ts'
import { FakeBunker } from '../identity/fakeBunker.ts'
import {
  type FakeRelay,
  type FakeRelayOptions,
  createFakeRelay,
  sentEvents,
} from '../relay/fakeRelay.ts'

const RELAY = 'wss://relay.scrutiny.cloud'
/** 32 × 0x01 — a valid secp256k1 scalar; deterministic signatures make the wire event predictable. */
const HEX_KEY = '01'.repeat(32)
/**
 * The session clock. `nextCreatedAt` and the signer both guard the relay's freshness window
 * against the real wall clock, so a frozen past timestamp would be refused before signing; within
 * one run this value is fixed, which is all the byte-exact assertions need.
 */
const NOW = Math.floor(Date.now() / 1000)
const TINY = { connectMs: 500, authMs: 500, ackMs: 1_000, readMs: 1_000 }

const clients: RelayClient[] = []
const bunkers: FakeBunker[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const bunker of bunkers.splice(0)) {
    for (const socket of bunker.sockets) socket.close()
  }
})

interface Harness {
  readonly relay: FakeRelay
  readonly ctx: HandlerContext
  readonly devKey: ReturnType<typeof createDevKeySigner>
  readonly signerCalls: UnsignedEvent[]
  readonly config: ServerConfig
  call(name: string, args: unknown): Promise<CallToolResult>
}

function harness(
  relayOptions: Partial<FakeRelayOptions> = {},
  deps: Partial<ToolDeps> = {},
): Harness {
  const relay = createFakeRelay({
    expectedRelay: RELAY,
    eagerChallenge: false,
    gateWrites: false,
    ...relayOptions,
  })
  const config = loadConfig({ SCRUTINY_RELAY_URL: RELAY, NSEC: HEX_KEY })
  const devKey = createDevKeySigner(hexToBytes(HEX_KEY))
  const signerCalls: UnsignedEvent[] = []
  const auth: AuthSigner = {
    async sign(template) {
      signerCalls.push(template)
      return devKey.sign(template)
    },
  }
  const client = new RelayClient({
    relayUrl: RELAY,
    signer: auth,
    wsFactory: relay.factory,
    timeouts: TINY,
    reconnectAttempts: 0,
  })
  clients.push(client)
  const ctx = createContext({
    config,
    signer: {
      mode: 'dev-key',
      publicKey: devKey.publicKey,
      sign: async (template) => {
        signerCalls.push(template)
        return devKey.sign(template)
      },
    },
    client,
    now: () => NOW,
    ...deps,
  })
  return {
    relay,
    ctx,
    devKey,
    signerCalls,
    config,
    async call(name, args) {
      const tool = TOOLS.find((candidate) => candidate.name === name)
      if (tool === undefined) throw new Error(`no tool ${name}`)
      return await tool.call(args, ctx)
    },
  }
}

function textOf(result: CallToolResult): string {
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') {
    throw new Error(`expected a text block, got ${JSON.stringify(result.content)}`)
  }
  return block.text
}

/** The publish report shape (`src/tools/handlers/publish.ts`); fields the tests read. */
interface PublishReport {
  readonly id: string
  readonly accepted: boolean
  readonly relay_message: string
  readonly verified: boolean
  readonly warnings?: readonly string[]
  readonly note?: string
}

/** The verify_event report shape (`src/tools/handlers/verify.ts`). */
interface VerifyReport {
  readonly found: boolean
  readonly event_id: string
  readonly id_matches?: boolean
  readonly signature_valid?: boolean
  readonly event: NostrEvent | null
  readonly note?: string
}

function jsonOf<T>(result: CallToolResult): T {
  return JSON.parse(textOf(result)) as T
}

function lastEvent(relay: FakeRelay): NostrEvent {
  const event = sentEvents(relay, 'EVENT').at(-1)
  if (event === undefined) throw new Error('no EVENT reached the relay')
  return event
}

const PRODUCT_ARGS = {
  headline: 'Acme Secure SE-1',
  bullets: ['Part number AS-SE1-C2P-T301; package 4 mm × 4 mm QFN32.'],
  links: [{ url: 'https://www.acme-secure.example/datasheets/AS-SE1.pdf' }],
  indexers: ['vendor:acme-secure', 'part:AS-SE1-C2P-T301'],
  card: { type: 'acme-datasheet@1', part: 'AS-SE1-C2P-T301' },
  imeta: [
    {
      url: 'https://www.acme-secure.example/datasheets/AS-SE1.pdf',
      m: 'application/pdf',
      x: 'a'.repeat(64),
      size: 412033,
      alt: 'SE-1 datasheet v1.2',
    },
  ],
}

describe('publish_product — composed, preflighted, signed, published, verified', () => {
  it('sends the byte-exact event the builders and composer specify', async () => {
    const test = harness()
    const result = await test.call('publish_product', PRODUCT_ARGS)

    const content = [
      'Acme Secure SE-1',
      '',
      '- Part number AS-SE1-C2P-T301; package 4 mm × 4 mm QFN32.',
      '',
      'Links:',
      '- https://www.acme-secure.example/datasheets/AS-SE1.pdf',
      '',
      'Record card (JSON): {"type":"acme-datasheet@1","part":"AS-SE1-C2P-T301"}',
    ].join('\n')
    const expectedTags = [
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-product'],
      ['i', 'vendor:acme-secure'],
      ['i', 'part:AS-SE1-C2P-T301'],
      ['k', 'vendor'],
      ['k', 'part'],
      [
        'imeta',
        'url https://www.acme-secure.example/datasheets/AS-SE1.pdf',
        'm application/pdf',
        `x ${'a'.repeat(64)}`,
        'size 412033',
        'alt SE-1 datasheet v1.2',
      ],
    ]
    const expected = test.devKey.sign({
      kind: 1,
      created_at: NOW,
      tags: expectedTags,
      content,
    })

    // BIP-340 signatures use a random auxiliary value when none is supplied (identity/sign.ts:137),
    // so two signings of the same id differ only in `sig`. Every other field — including the id,
    // which commits to the exact content bytes — must match.
    const sent = lastEvent(test.relay)
    expect({ ...sent, sig: '' }).toStrictEqual({ ...expected, sig: '' })
    expect(sent.id).toBe(expected.id)
    expect(sent.sig).toMatch(/^[0-9a-f]{128}$/u)
    expect(verifySignedEvent(sent)).toBe(true)
    expect(jsonOf<PublishReport>(result)).toStrictEqual({
      id: expected.id,
      accepted: true,
      relay_message: '',
      verified: true,
    })
  })

  it('refuses an oversized payload before the signer is touched and before any dial', async () => {
    const test = harness()
    const result = await test.call('publish_product', {
      ...PRODUCT_ARGS,
      headline: 'x'.repeat(70_000),
    })

    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('publish_product refused — nothing was signed.')
    expect(text).toContain('content:')
    expect(text).toContain('65536')
    expect(test.signerCalls).toStrictEqual([])
    expect(test.relay.sockets).toHaveLength(0)
  })

  it('reports accepted-but-unverified honestly and says to call verify_event again', async () => {
    const test = harness({ storeAccepted: false })
    const result = await test.call('publish_product', PRODUCT_ARGS)
    const report = jsonOf<PublishReport>(result)
    expect(report.accepted).toBe(true)
    expect(report.verified).toBe(false)
    expect(report.note).toContain('call verify_event')
  })

  it('surfaces preflight warnings on a successful publish', async () => {
    const test = harness()
    const result = await test.call('publish_product', {
      ...PRODUCT_ARGS,
      indexers: ['acme-internal:OBJECT-1'],
    })
    const report = jsonOf<PublishReport>(result)
    expect(report.accepted).toBe(true)
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings?.[0]).toContain('IR-4')
  })
})

describe('publish_metadata', () => {
  it('emits the Lens compatibility tag last and the metadata type tag', async () => {
    const test = harness()
    await test.call('publish_metadata', {
      headline: 'Acme SE-1 evaluation report',
      indexers: ['part:AS-SE1-C2P-T301'],
      meta_subtype: 'report',
    })
    const event = lastEvent(test.relay)
    expect(event.tags[2]).toStrictEqual(['t', 'scrutiny-metadata'])
    expect(event.tags.at(-1)).toStrictEqual(['meta', 'report'])
  })
})

describe('set_profile', () => {
  it('publishes the NIP-01 profile JSON with no tags', async () => {
    const test = harness()
    const result = await test.call('set_profile', {
      name: 'acme',
      display_name: 'Acme Secure',
      about: 'Secure elements',
      picture_url: 'https://www.acme-secure.example/logo.png',
    })
    const event = lastEvent(test.relay)
    expect(event.kind).toBe(0)
    expect(event.tags).toStrictEqual([])
    expect(event.content).toBe(
      JSON.stringify({
        name: 'acme',
        display_name: 'Acme Secure',
        about: 'Secure elements',
        picture: 'https://www.acme-secure.example/logo.png',
      }),
    )
    expect(jsonOf<PublishReport>(result).verified).toBe(true)
  })
})

describe('publish_binding', () => {
  it('emits BD-8 marked e tags and the rule-8d Refs line', async () => {
    const test = harness()
    const root = 'a'.repeat(64)
    const link = 'b'.repeat(64)
    const author = 'c'.repeat(64)
    const result = await test.call('publish_binding', {
      root_ref: { id: root, relay: 'wss://hint.example', author },
      link_ref: { id: link },
      label: 'certifies',
      bullets: ['Evidence: CC evaluation report.'],
    })
    const event = lastEvent(test.relay)
    expect(event.tags).toStrictEqual([
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-binding'],
      ['e', root, 'wss://hint.example', 'root', author],
      ['e', link, '', 'link', ''],
    ])
    expect(event.content).toBe(
      `certifies\n\n- Evidence: CC evaluation report.\n\nRefs: root ${root} link ${link}`,
    )
    expect(jsonOf<PublishReport>(result).verified).toBe(true)
  })
})

describe('publish_patch', () => {
  const ROOT_CONTENT = 'alpha\nbeta\ngamma\n'

  function seededProduct(test: Harness): NostrEvent {
    const product = test.devKey.sign({
      kind: 1,
      created_at: NOW - 100,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', VERSION_TAG],
        ['t', 'scrutiny-product'],
      ],
      content: ROOT_CONTENT,
    })
    return product
  }

  async function harnessWithProduct(): Promise<{ test: Harness; product: NostrEvent }> {
    const test = harness()
    const product = seededProduct(test)
    test.relay.seed(product)
    return { test, product }
  }

  it('resolves the root chain and emits one e root + one e reply', async () => {
    const { test, product } = await harnessWithProduct()
    const result = await test.call('publish_patch', {
      target_id: product.id,
      before: ROOT_CONTENT,
      after: 'alpha\nBETA\ngamma\n',
    })
    const event = lastEvent(test.relay)
    expect(event.tags).toStrictEqual([
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-patch'],
      ['e', product.id, '', 'root', ''],
      ['e', product.id, '', 'reply', ''],
    ])
    expect(event.content.startsWith('```diff\n')).toBe(true)
    expect(event.content.endsWith('```\n')).toBe(true)
    expect(event.content).toContain('-beta')
    expect(event.content).toContain('+BETA')
    expect(jsonOf<PublishReport>(result).verified).toBe(true)
  })

  it('refuses a stale before baseline without spending a signature', async () => {
    const { test, product } = await harnessWithProduct()
    const result = await test.call('publish_patch', {
      target_id: product.id,
      before: 'stale text\n',
      after: 'alpha\nBETA\ngamma\n',
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('before:')
    expect(textOf(result)).toContain('stale baseline')
    expect(test.signerCalls).toStrictEqual([])
    expect(sentEvents(test.relay, 'EVENT')).toStrictEqual([])
  })

  it('accepts a unified diff only when it applies to the resolved tip', async () => {
    const { test, product } = await harnessWithProduct()
    const diff = [
      '--- a/record',
      '+++ b/record',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '',
    ].join('\n')
    const result = await test.call('publish_patch', { target_id: product.id, diff })
    const event = lastEvent(test.relay)
    expect(event.content).toBe(`\`\`\`diff\n${diff}\`\`\`\n`)
    expect(jsonOf<PublishReport>(result).verified).toBe(true)
  })

  it('refuses a diff that does not apply to the resolved tip', async () => {
    const { test, product } = await harnessWithProduct()
    const diff = [
      '--- a/record',
      '+++ b/record',
      '@@ -1,2 +1,2 @@',
      ' not-here',
      '-absent',
      '+replaced',
      '',
    ].join('\n')
    const result = await test.call('publish_patch', { target_id: product.id, diff })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('diff:')
    expect(textOf(result)).toContain('does not apply cleanly')
    expect(test.signerCalls).toStrictEqual([])
  })

  it('refuses a target the relay does not have', async () => {
    const test = harness()
    const result = await test.call('publish_patch', {
      target_id: 'd'.repeat(64),
      diff: 'irrelevant\n',
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('target_id:')
    expect(test.signerCalls).toStrictEqual([])
  })
})

describe('retract', () => {
  it('publishes kind 5 with one e tag and the reason as content', async () => {
    const test = harness()
    const target = 'd'.repeat(64)
    const result = await test.call('retract', {
      target_id: target,
      reason: 'withdrawn: superseded by the 2026-11 datasheet',
    })
    const event = lastEvent(test.relay)
    expect(event.kind).toBe(5)
    expect(event.tags).toStrictEqual([['e', target]])
    expect(event.content).toBe('withdrawn: superseded by the 2026-11 datasheet')
    expect(jsonOf<PublishReport>(result).verified).toBe(true)
  })
})

describe('verify_event', () => {
  it('returns the stored event with id and signature checks', async () => {
    const test = harness()
    const signed = test.devKey.sign({
      kind: 1,
      created_at: NOW - 10,
      tags: [['t', 'scrutiny-fabric']],
      content: 'stored record',
    })
    test.relay.seed(signed)
    const result = await test.call('verify_event', { event_id: signed.id })
    const report = jsonOf<VerifyReport>(result)
    expect(report.found).toBe(true)
    expect(report.id_matches).toBe(true)
    expect(report.signature_valid).toBe(true)
    expect(report.event).toStrictEqual(signed)
  })

  it('reports a relay-served event whose id no longer matches its content', async () => {
    const test = harness()
    const signed = test.devKey.sign({
      kind: 1,
      created_at: NOW - 10,
      tags: [['t', 'scrutiny-fabric']],
      content: 'stored record',
    })
    const tampered: NostrEvent = { ...signed, content: `${signed.content} (edited by relay)` }
    test.relay.seed(tampered)
    const result = await test.call('verify_event', { event_id: signed.id })
    const report = jsonOf<VerifyReport>(result)
    expect(report.found).toBe(true)
    expect(report.id_matches).toBe(false)
    expect(report.signature_valid).toBe(false)
    expect(report.note).toContain('untrusted')
  })

  it('reports a missing event without an error', async () => {
    const test = harness()
    const result = await test.call('verify_event', { event_id: 'e'.repeat(64) })
    expect(result.isError).toBeFalsy()
    expect(jsonOf<VerifyReport>(result)).toMatchObject({ found: false, event: null })
  })
})

describe('status', () => {
  it('reports connection state without dialing, then reflects the open socket', async () => {
    const test = harness()
    const before = textOf(await test.call('status', {}))
    expect(before).toContain('connected: no')
    expect(test.relay.sockets).toHaveLength(0)

    await test.call('publish_product', PRODUCT_ARGS)
    expect(textOf(await test.call('status', {}))).toContain('connected: yes')
  })
})

describe('NIP-46 bunker path', () => {
  it('signs the composed event with the bunker user key and publishes it', async () => {
    const relay = createFakeRelay({
      expectedRelay: RELAY,
      eagerChallenge: false,
      gateWrites: false,
    })
    const bunker = new FakeBunker()
    bunkers.push(bunker)
    const uri = `bunker://${bunker.remotePubkey}?relay=${encodeURIComponent(RELAY)}`
    const config = loadConfig({ SCRUTINY_RELAY_URL: RELAY, SCRUTINY_SIGNER: uri })
    const client = new RelayClient({
      relayUrl: RELAY,
      signer: {
        async sign() {
          throw new Error('reads and writes here never need NIP-42 AUTH')
        },
      },
      wsFactory: relay.factory,
      timeouts: TINY,
      reconnectAttempts: 0,
    })
    clients.push(client)
    const ctx = createContext({ config, client, transport: bunker, now: () => NOW })

    const tool = TOOLS.find((candidate) => candidate.name === 'publish_product')
    if (tool === undefined) throw new Error('no publish_product tool')
    const result = (await tool.call(PRODUCT_ARGS, ctx)) as CallToolResult

    const event = lastEvent(relay)
    expect(event.pubkey).toBe(bunker.userPubkey)
    expect(verifySignedEvent(event)).toBe(true)
    expect(bunker.requests.some((request) => request.method === 'sign_event')).toBe(true)
    expect(bunker.badClientEvents).toStrictEqual([])
    expect(jsonOf<PublishReport>(result).verified).toBe(true)
  })
})

// Keep the builder import honest: the wire-event test above asserts literals, and this pins that
// core's builder remains the source of the tag order those literals encode.
describe('builder parity', () => {
  it('buildProduct emits the tag order the golden wire test asserts', () => {
    const built = buildProduct('x', NOW, ['vendor:acme-secure', 'part:AS-SE1-C2P-T301'])
    expect(built.template.tags).toStrictEqual([
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-product'],
      ['i', 'vendor:acme-secure'],
      ['i', 'part:AS-SE1-C2P-T301'],
      ['k', 'vendor'],
      ['k', 'part'],
    ])
  })
})
