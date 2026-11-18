/**
 * Real-relay e2e (spec §14.1 items 1–3 and 9). Builds `relay/cmd/relay`, starts it on a loopback
 * port with a throwaway data directory, and drives the MCP server through an SDK client over the
 * in-memory transport, with the production network path (`relayDeps`) and an injected signer.
 *
 * Without Go this suite FAILS; it never skips (spec §17: the prototype's `SKIPPED` exit 0 hid a
 * broken harness). Uploads are not covered until the relay serves Blossom (spec §18 step 7).
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RelayConnection } from '../../src/relay/socket.js'
import { relayDeps } from '../../src/server/live.js'
import { createServer } from '../../src/server/server.js'
import { signEvent } from '../../src/signer/event.js'
import { npubEncode, publicKeyHex } from '../../src/signer/keys.js'
import { FILES, METADATA, PRODUCT, PROFILE, makeRoot, plan } from '../_fixtures.js'
import { testSigner } from '../_signer.js'

const RELAY_DIR = fileURLToPath(new URL('../../../../relay/', import.meta.url))

/** `MAIN` publishes, `AUTH` is a second allowlisted key, `STRANGER` is not on the allowlist. */
const KEY_MAIN = '01'.repeat(32)
const KEY_AUTH = '02'.repeat(32)
const KEY_STRANGER = '04'.repeat(32)
const SECRETS = [KEY_MAIN, KEY_AUTH, KEY_STRANGER]
const pub = (secret: string) => publicKeyHex(hexToBytes(secret))

let relay: ChildProcess
let tmp: string
let relayUrl: string
let httpUrl: string
const relayLog: string[] = []

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })
}

beforeAll(async () => {
  try {
    execFileSync('go', ['version'], { stdio: 'pipe', windowsHide: true })
  } catch {
    throw new Error('Go is required for the real-relay e2e (spec §14.1); install it, do not skip.')
  }
  tmp = mkdtempSync(join(tmpdir(), 'scrutiny-e2e-'))
  const binary = join(tmp, process.platform === 'win32' ? 'relay.exe' : 'relay')
  execFileSync('go', ['build', '-o', binary, './cmd/relay'], {
    cwd: RELAY_DIR,
    stdio: 'pipe',
    windowsHide: true,
  })
  const port = await freePort()
  relayUrl = `ws://127.0.0.1:${port}`
  httpUrl = `http://127.0.0.1:${port}`
  relay = spawn(binary, [], {
    env: {
      ...process.env,
      SCRUTINY_LISTEN_ADDR: `127.0.0.1:${port}`,
      SCRUTINY_SERVICE_URL: relayUrl,
      SCRUTINY_DATA_DIR: join(tmp, 'data'),
      SCRUTINY_ALLOWED_PUBKEYS: [pub(KEY_MAIN), pub(KEY_AUTH)].join(','),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  relay.stdout?.on('data', (chunk: Buffer) => relayLog.push(chunk.toString('utf8')))
  relay.stderr?.on('data', (chunk: Buffer) => relayLog.push(chunk.toString('utf8')))
  const deadline = Date.now() + 30_000
  for (;;) {
    if (relay.exitCode !== null) throw new Error(`relay exited: ${relayLog.join('')}`)
    try {
      if ((await fetch(`${httpUrl}/healthz`)).ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`relay did not start: ${relayLog.join('')}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}, 300_000)

afterAll(async () => {
  if (relay !== undefined && relay.exitCode === null) {
    const exited = new Promise((r) => relay.once('exit', r))
    relay.kill()
    await exited
  }
  // Key hygiene (spec §14.1 item 9): the relay never saw a secret either.
  for (const secret of SECRETS) expect(relayLog.join('')).not.toContain(secret)
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
})

interface Metrics {
  readonly events_stored: number
  readonly events_rejected: number
  readonly events_replaced: number
}

async function metrics(): Promise<Metrics> {
  return (await (await fetch(`${httpUrl}/metrics`)).json()) as Metrics
}

/** Counter changes since `before`. */
async function delta(before: Metrics): Promise<Metrics> {
  const after = await metrics()
  return {
    events_stored: after.events_stored - before.events_stored,
    events_rejected: after.events_rejected - before.events_rejected,
    events_replaced: after.events_replaced - before.events_replaced,
  }
}

const NOTHING: Metrics = { events_stored: 0, events_rejected: 0, events_replaced: 0 }

/** The structured-content fields these tests read; the SDK client has validated the rest. */
interface Out {
  readonly signer?: { readonly state: string }
  readonly plan_id?: string | null
  readonly plan_hash?: string | null
  readonly ready?: boolean
  readonly open_questions?: readonly { readonly code: string; readonly field: string | null }[]
  readonly outcome?: string | null
  readonly records?: readonly { readonly event_id: string | null; readonly state: string }[]
  readonly refusal?: { readonly code: string; readonly field: string | null } | null
  readonly results?: readonly Record<string, unknown>[]
}

const outputs: string[] = []
let closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const out of outputs) for (const secret of SECRETS) expect(out).not.toContain(secret)
  outputs.length = 0
  for (const close of closers) await close()
  closers = []
})

type Decision = () => Promise<ElicitResult>
const approve: Decision = async () => ({ action: 'accept', content: { decision: 'approve' } })

async function host(opts: { secret?: string; skewS?: number; decide?: Decision } = {}) {
  const signer = testSigner(opts.secret ?? KEY_MAIN)
  const skew = opts.skewS ?? 0
  const now = () => Math.floor(Date.now() / 1000) + skew
  const server = createServer({
    signer,
    signerStatus: async () => ({
      state: 'ready',
      npub: npubEncode(await signer.publicKey()),
      fix: null,
    }),
    ...relayDeps(signer, now),
    now,
    clock: Date.now,
  })
  const client = new Client(
    { name: 'e2e-host', version: '0' },
    { capabilities: { elicitation: {} } },
  )
  const decide = opts.decide ?? approve
  client.setRequestHandler(ElicitRequestSchema, () => decide())
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  const call = async (name: string, args: Record<string, unknown>): Promise<Out> => {
    const result = await client.callTool({ name, arguments: args })
    outputs.push(JSON.stringify(result))
    return (result.structuredContent ?? {}) as Out
  }
  /** Event signatures only; kind 22242 is the NIP-42 handshake. */
  const signed = () => signer.calls.filter((t) => t.kind !== 22242).length
  return { call, signed }
}

/** METADATA without its artifact: the relay has no Blossom yet (spec §18 step 7). */
const RECORDS = [PROFILE, PRODUCT, { ...METADATA, artifacts: [] }]

async function draftReady(h: Awaited<ReturnType<typeof host>>, records: readonly unknown[]) {
  const root = makeRoot(FILES)
  const draft = await h.call('draft_plan', { root, plan: plan(records, [relayUrl]) })
  expect(draft.open_questions?.filter((q) => q.code.startsWith('relay.'))).toStrictEqual([])
  return { root, hash: draft.plan_hash ?? '', draft }
}

describe('real relay: the full loop', () => {
  it('status → draft (open question) → revise → draft (ready) → publish → verify', async () => {
    const h = await host()
    expect((await h.call('status', {})).signer?.state).toBe('ready')

    const root = makeRoot(FILES)
    const first = await h.call('draft_plan', { root, plan: plan(RECORDS, []) })
    expect(first.ready).toBe(false)
    expect(first.open_questions?.map((q) => q.code)).toContain('relay.missing')

    const second = await h.call('draft_plan', { root, plan: plan(RECORDS, [relayUrl]) })
    expect(second.open_questions).toStrictEqual([])
    expect(second.ready).toBe(true)
    const hash = second.plan_hash ?? ''

    const before = await metrics()
    let out: Out = {}
    for (let attempt = 0; attempt < 5 && out.outcome !== 'complete'; attempt++) {
      out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
      expect(out.refusal).toBeNull()
    }
    expect(out.outcome).toBe('complete')
    // Profile, product, metadata and one binding, all read back from the relay.
    expect(out.records?.map((r) => r.state)).toStrictEqual(Array(4).fill('verified'))
    // events_stored counts kind 1 accepts; events_replaced counts kind 0 accepts.
    expect(await delta(before)).toStrictEqual({
      events_stored: 3,
      events_rejected: 0,
      events_replaced: 1,
    })

    // With the plan, verify compares the stored bytes against the journal's signed events.
    const verify = await h.call('verify', { root, plan_hash: hash })
    expect(verify.refusal).toBeNull()
    expect(verify.results).toHaveLength(4)
    for (const result of verify.results ?? []) {
      expect(result).toMatchObject({
        stored: true,
        id_valid: true,
        sig_valid: true,
        byte_identical: true,
      })
    }

    // Publishing the same plan again sends nothing: the journal says it is complete.
    const again = await metrics()
    await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(await delta(again)).toStrictEqual(NOTHING)
  }, 120_000)
})

describe('real relay: gates', () => {
  it('not allowlisted: relay.not_allowed, and nothing after the first rejected event', async () => {
    const h = await host({ secret: KEY_STRANGER })
    const { root, hash } = await draftReady(h, [PRODUCT, { ...METADATA, artifacts: [] }])
    const before = await metrics()
    const out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(out.refusal?.code).toBe('relay.not_allowed')
    expect(await delta(before)).toStrictEqual({ ...NOTHING, events_rejected: 1 })
    expect(h.signed()).toBe(1)
  }, 60_000)

  it('oversized: record.budget at draft time, nothing signed or sent', async () => {
    const h = await host()
    const indexers = Array.from({ length: 70 }, (_, i) => `part:EX-${i}`)
    const root = makeRoot(FILES)
    const draft = await h.call('draft_plan', {
      root,
      plan: plan([{ ...PRODUCT, indexers }], [relayUrl]),
    })
    expect(draft.ready).toBe(false)
    expect(draft.open_questions).toContainEqual(
      expect.objectContaining({ code: 'record.budget', field: 'records[product:ex-100].indexers' }),
    )
    const before = await metrics()
    const hash = draft.plan_hash ?? ''
    const out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(out.refusal?.code).toBe('plan.not_ready')
    expect(await delta(before)).toStrictEqual(NOTHING)
    expect(h.signed()).toBe(0)
  }, 60_000)

  it("clock skew: relay.clock_skew measured with the signer's clock", async () => {
    const h = await host({ skewS: -3 * 3600 })
    const root = makeRoot(FILES)
    const draft = await h.call('draft_plan', { root, plan: plan([PRODUCT], [relayUrl]) })
    expect(draft.ready).toBe(false)
    expect(draft.open_questions).toContainEqual(
      expect.objectContaining({ code: 'relay.clock_skew', field: 'relays[0]' }),
    )
    const before = await metrics()
    const hash = draft.plan_hash ?? ''
    const out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(out.refusal?.code).toBe('plan.not_ready')
    expect(await delta(before)).toStrictEqual(NOTHING)
    expect(h.signed()).toBe(0)
  }, 60_000)

  it('author mismatch: the relay refuses an event whose author is not the authenticated key', async () => {
    // The server signs AUTH and events with one key, so the mismatch is driven at the connection.
    const connection = await RelayConnection.open({
      url: relayUrl,
      signer: testSigner(KEY_AUTH),
      now: () => Math.floor(Date.now() / 1000),
    })
    try {
      const event = signEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['t', 'scrutiny-fabric']],
          content: 'author mismatch',
        },
        hexToBytes(KEY_MAIN),
      )
      const before = await metrics()
      const reply = await connection.publish(event)
      expect(reply.ok).toBe(false)
      // NIP-01 machine-readable prefix, not the wording after it.
      expect(reply.message.split(':')[0]).toBe('blocked')
      expect(await delta(before)).toStrictEqual({ ...NOTHING, events_rejected: 1 })
    } finally {
      connection.close()
    }
  }, 60_000)

  it('approval declined: approval.declined, zero signatures and zero relay writes', async () => {
    const h = await host({
      decide: async () => ({ action: 'accept', content: { decision: 'decline' } }),
    })
    const { root, hash } = await draftReady(h, [PRODUCT])
    const before = await metrics()
    const out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(out.refusal?.code).toBe('approval.declined')
    expect(await delta(before)).toStrictEqual(NOTHING)
    expect(h.signed()).toBe(0)
  }, 60_000)
})
