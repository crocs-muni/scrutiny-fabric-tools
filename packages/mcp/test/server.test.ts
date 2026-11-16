/**
 * The MCP adapter over an in-memory MCP transport, with an SDK `Client` as the host. Covers spec
 * §14.1 items 3 (approval: decline, cancel, no response, chat fallback with wrong and right code,
 * expired window; zero signatures and zero relay writes in each refusal), 6 (progress), 8 (every
 * result validates against its outputSchema: the SDK client checks it) and 9 (key hygiene).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { NostrEvent } from '@scrutiny-fabric/core'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalCode } from '../src/approval/summary.js'
import type { DraftNetwork } from '../src/plan/draft.js'
import { Journal } from '../src/publish/journal.js'
import { GUIDE_URI } from '../src/server/guidance.js'
import { type ServerDeps, createServer } from '../src/server/server.js'
import { npubEncode } from '../src/signer/keys.js'
import { FILES, METADATA, PRIMARY, PRODUCT, PROFILE, PUBKEY, makeRoot, plan } from './_fixtures.js'
import { testSigner } from './_signer.js'

const SECRET = '01'.repeat(32)
const NETWORK: DraftNetwork = {
  probeRelay: async () => ({
    reachable: true,
    blossom: true,
    clock_skew_s: 0,
    limits: {},
    created_at_window: { past_s: 7200, future_s: 900 },
  }),
  verifyUrl: async () => ({ kind: 'match' }),
  profilePublished: async () => false,
}

/** The structured-content fields these tests read; the SDK client has validated the rest. */
interface Out {
  readonly plan_hash?: string
  readonly ready?: boolean
  readonly findings?: readonly { readonly code: string; readonly field: string | null }[]
  readonly refusal?: { readonly code: string } | null
  readonly approval_code?: string | null
  readonly approval_summary?: string | null
  readonly results?: readonly Record<string, unknown>[]
}

type Elicit = (params: ElicitRequest['params']) => Promise<ElicitResult>

const outputs: string[] = []
let closers: (() => Promise<void>)[] = []
afterEach(async () => {
  // Key hygiene (spec §14.1 item 9): no tool output, in any test, carries the secret.
  for (const out of outputs) expect(out).not.toContain(SECRET)
  outputs.length = 0
  for (const close of closers) await close()
  closers = []
})

async function harness(opts: { elicit?: Elicit; budgetMs?: number } = {}) {
  const stored = new Map<string, NostrEvent>()
  let writes = 0
  const signer = testSigner(SECRET)
  let seconds = 1_800_000_000
  const deps: ServerDeps = {
    signer,
    signerStatus: async () => ({ state: 'ready', npub: npubEncode(PUBKEY), fix: null }),
    network: NETWORK,
    primary: () => ({
      publish: async (event) => {
        writes += 1
        stored.set(event.id, event)
        return { ok: true, message: '' }
      },
      fetchByIds: async (ids) =>
        new Map(
          ids.flatMap((id) =>
            stored.has(id) ? [[id, stored.get(id) as NostrEvent] as const] : [],
          ),
        ),
      close: () => {},
    }),
    mirror: () => ({ publish: async () => ({ ok: true, message: '' }), close: () => {} }),
    uploadBlob: async (_primary, _root, u) => ({
      state: 'uploaded',
      url: `https://relay.example/${u.x}${u.ext}`,
    }),
    now: () => seconds++,
    clock: Date.now,
    callBudgetMs: opts.budgetMs ?? 5000,
  }
  const server = createServer(deps)
  const client = new Client(
    { name: 'test-host', version: '0' },
    { capabilities: opts.elicit === undefined ? {} : { elicitation: {} } },
  )
  const elicitations: ElicitRequest['params'][] = []
  if (opts.elicit !== undefined) {
    const elicit = opts.elicit
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitations.push(request.params)
      return elicit(request.params)
    })
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  closers.push(async () => {
    await client.close()
    await server.close()
  })

  const call = async (
    name: string,
    args: Record<string, unknown>,
    onprogress?: (p: { progress: number }) => void,
  ) => {
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      onprogress === undefined ? {} : { onprogress },
    )
    outputs.push(JSON.stringify(result))
    return result as { isError?: boolean; structuredContent?: Out }
  }
  return { client, call, signer, stored, writes: () => writes, elicitations }
}

const approve: Elicit = async () => ({ action: 'accept', content: { decision: 'approve' } })

async function drafted(h: Awaited<ReturnType<typeof harness>>, root = makeRoot(FILES)) {
  const draft = await h.call('draft_plan', { root, plan: plan([PROFILE, PRODUCT, METADATA]) })
  const hash = draft.structuredContent?.plan_hash ?? ''
  return { root, hash, draft }
}

const refusalCode = (r: { structuredContent?: Out }) => r.structuredContent?.refusal?.code

describe('tool surface (spec §6)', () => {
  it('lists four tools, each with strict input, an outputSchema and the §6 annotations', async () => {
    const h = await harness()
    const { tools } = await h.client.listTools()
    expect(tools.map((t) => t.name).sort()).toStrictEqual([
      'draft_plan',
      'publish_plan',
      'status',
      'verify',
    ])
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined()
      expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(
        false,
      )
    }
    const annotations = new Map(tools.map((t) => [t.name, t.annotations]))
    expect(annotations.get('publish_plan')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(annotations.get('draft_plan')).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    })
    expect(annotations.get('status')).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  })

  it('refuses an unknown argument on the wire before the handler runs', async () => {
    const h = await harness()
    const result = await h.call('draft_plan', { root: makeRoot(), plan: {}, content: 'free text' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
  })

  it('reports status without signing, with the approval channel the host supports', async () => {
    const chat = await harness()
    const s = await chat.call('status', {})
    expect(s.structuredContent).toMatchObject({
      signer: { state: 'ready', npub: npubEncode(PUBKEY) },
      protocol: { mcp: '2025-11-25', approval_channel: 'chat' },
    })
    const dialog = await harness({ elicit: approve })
    expect((await dialog.call('status', {})).structuredContent).toMatchObject({
      protocol: { approval_channel: 'elicitation' },
    })
    expect([...chat.signer.calls, ...dialog.signer.calls]).toStrictEqual([])
  })
})

describe('draft_plan', () => {
  it('returns the plan hash as plan_id and stores the plan under .scrutiny/plans', async () => {
    const h = await harness()
    const { root, hash, draft } = await drafted(h)
    expect(draft.structuredContent).toMatchObject({ plan_id: hash, ready: true, findings: [] })
    const stored = JSON.parse(
      readFileSync(join(root, '.scrutiny', 'plans', `${hash}.json`), 'utf8'),
    )
    expect(stored.ready).toBe(true)
    expect(h.signer.calls).toStrictEqual([])
  })

  it('reads a plan file by path, and refuses one outside the root', async () => {
    const h = await harness()
    const root = makeRoot({
      ...FILES,
      '.scrutiny/plans/draft.json': JSON.stringify(plan([PROFILE, PRODUCT, METADATA])),
    })
    const byPath = await h.call('draft_plan', { root, path: '.scrutiny/plans/draft.json' })
    expect(byPath.structuredContent?.ready).toBe(true)
    const outside = await h.call('draft_plan', { root, path: '../elsewhere.json' })
    expect(outside.structuredContent?.findings?.[0]).toMatchObject({
      code: 'schema.path_outside_root',
      field: 'path',
    })
  })

  it('needs exactly one of plan or path', async () => {
    const h = await harness()
    const both = await h.call('draft_plan', { root: makeRoot(), plan: {}, path: 'x.json' })
    expect(both.structuredContent?.findings?.[0]?.code).toBe('schema.invalid')
  })
})

describe('approval by elicitation (spec §7.1)', () => {
  it('shows the server-rendered summary, publishes on approve, and reports progress', async () => {
    const h = await harness({ elicit: approve })
    const { root, hash } = await drafted(h)
    const progress: number[] = []
    const out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash }, (p) =>
      progress.push(p.progress),
    )
    expect(out.isError).toBeFalsy()
    expect(out.structuredContent).toMatchObject({
      outcome: 'complete',
      progress: { done: 4, total: 4 },
      approval: { channel: 'elicitation' },
    })
    expect(h.elicitations).toHaveLength(1)
    const message = h.elicitations[0]?.message ?? ''
    expect(message).toContain(npubEncode(PUBKEY))
    expect(message).toContain(hash)
    expect(h.stored.size).toBe(4)
    expect(progress.at(-1)).toBe(4)
  })

  for (const [name, elicit] of [
    ['decline', async () => ({ action: 'decline' })],
    ['cancel', async () => ({ action: 'cancel' })],
    [
      'accept without approve',
      async () => ({ action: 'accept', content: { decision: 'decline' } }),
    ],
    ['no response', () => new Promise<ElicitResult>(() => {})],
  ] as const) {
    it(`signs and sends nothing on ${name}`, async () => {
      const h = await harness({ elicit: elicit as Elicit, budgetMs: 400 })
      const { root, hash } = await drafted(h)
      const out = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
      expect(out.isError).toBe(true)
      expect(refusalCode(out)).toBe('approval.declined')
      expect(h.signer.calls).toStrictEqual([])
      expect(h.writes()).toBe(0)
    })
  }

  it('does not ask again inside the approval window, and asks again after it, saying what is done', async () => {
    const h = await harness({ elicit: approve })
    const { root, hash } = await drafted(h)
    await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(h.elicitations).toHaveLength(1)

    // An expired approval: replace the journal's only approval with one from 31 minutes ago.
    const journalFile = join(root, '.scrutiny', 'runs', `${hash}.journal`)
    const lines = readFileSync(journalFile, 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.includes('"approval"'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(journalFile, `${lines.join('\n')}\n`)
    await (await Journal.open(root, hash)).recordApproval(
      hash,
      'elicitation',
      Date.now() - 31 * 60 * 1000,
    )
    await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(h.elicitations).toHaveLength(2)
    expect(h.elicitations[1]?.message).toContain('4 of 4 already published')
  })
})

describe('chat fallback (spec §7)', () => {
  it('returns the summary and a code, refuses a wrong code, and publishes with the right one', async () => {
    const h = await harness()
    const { root, hash } = await drafted(h)

    const first = await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    expect(first.isError).toBe(true)
    expect(refusalCode(first)).toBe('approval.required')
    expect(first.structuredContent?.approval_code).toBe(approvalCode(hash))
    expect(first.structuredContent?.approval_summary).toContain(hash)

    const wrong = await h.call('publish_plan', {
      root,
      plan_id: hash,
      plan_hash: hash,
      approval_code: 'ZZZZZZ',
    })
    expect(refusalCode(wrong)).toBe('approval.wrong_code')
    expect(h.signer.calls).toStrictEqual([])
    expect(h.writes()).toBe(0)

    const right = await h.call('publish_plan', {
      root,
      plan_id: hash,
      plan_hash: hash,
      approval_code: approvalCode(hash).toLowerCase(),
    })
    expect(right.structuredContent).toMatchObject({
      outcome: 'complete',
      approval: { channel: 'chat' },
    })
  })
})

describe('publish_plan refuses a plan that is not the one drafted', () => {
  it('when plan_hash differs from plan_id, is unknown, or the files changed', async () => {
    const h = await harness({ elicit: approve })
    const { root, hash } = await drafted(h)
    const other = 'f'.repeat(64)
    expect(
      refusalCode(await h.call('publish_plan', { root, plan_id: hash, plan_hash: other })),
    ).toBe('plan.changed')
    expect(
      refusalCode(await h.call('publish_plan', { root, plan_id: other, plan_hash: other })),
    ).toBe('plan.changed')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'reports/fi.pdf'), 'edited after drafting')
    expect(
      refusalCode(await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })),
    ).toBe('plan.changed')
    expect(h.elicitations).toHaveLength(0)
    expect(h.signer.calls).toStrictEqual([])
  })

  it('when blocking questions remain', async () => {
    const h = await harness({ elicit: approve })
    const root = makeRoot(FILES)
    const { bind_to: _drop, ...unbound } = METADATA
    const draft = await h.call('draft_plan', { root, plan: plan([PROFILE, PRODUCT, unbound]) })
    const hash = draft.structuredContent?.plan_hash ?? ''
    expect(
      refusalCode(await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })),
    ).toBe('plan.not_ready')
    expect(h.signer.calls).toStrictEqual([])
  })
})

describe('verify (spec §6.4)', () => {
  it('reports every journalled event stored, valid and byte-identical', async () => {
    const h = await harness({ elicit: approve })
    const { root, hash } = await drafted(h)
    await h.call('publish_plan', { root, plan_id: hash, plan_hash: hash })
    // A relay may return the fields in another key order (khatru does); the bytes are the same.
    for (const [id, e] of h.stored) {
      h.stored.set(id, {
        sig: e.sig,
        content: e.content,
        tags: e.tags,
        kind: e.kind,
        created_at: e.created_at,
        pubkey: e.pubkey,
        id: e.id,
      })
    }
    const out = await h.call('verify', { root, plan_hash: hash })
    const results = out.structuredContent?.results ?? []
    expect(results).toHaveLength(4)
    for (const r of results) {
      expect(r).toMatchObject({
        relay: PRIMARY,
        stored: true,
        id_valid: true,
        sig_valid: true,
        byte_identical: true,
      })
    }
  })

  it('refuses when there is nothing to verify', async () => {
    const h = await harness()
    expect(refusalCode(await h.call('verify', {}))).toBe('schema.invalid')
  })
})

describe('guidance surfaces (spec §12)', () => {
  it('serves instructions naming every tool and the guide, the guide resource, and the prompt', async () => {
    const h = await harness()
    const instructions = h.client.getInstructions() ?? ''
    for (const name of ['status', 'draft_plan', 'publish_plan', 'verify', GUIDE_URI])
      expect(instructions).toContain(name)
    const guide = await h.client.readResource({ uri: GUIDE_URI })
    expect(guide.contents[0]?.mimeType).toBe('text/markdown')
    const prompt = await h.client.getPrompt({
      name: 'publish',
      arguments: { folder: '/data/ex', relay: PRIMARY },
    })
    const message = prompt.messages[0]?.content
    expect(message?.type === 'text' ? message.text : '').toContain('/data/ex')
  })
})
