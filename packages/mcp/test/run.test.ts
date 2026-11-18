/**
 * The run engine (spec §8, §6.3) against in-memory transports. Covers the acceptance criteria of
 * §14.1 items 4–6: invariant A (property-tested), resume without duplicates or stale resends, and
 * progress/cancel; plus the deadline, rejection, mirror and fetch-back paths.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NostrEvent } from '@crocs-muni/scrutiny-fabric'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { BlobUpload, TemplateGraph } from '../src/plan/draft.js'
import { Journal } from '../src/publish/journal.js'
import {
  type MirrorTransport,
  type PrimaryTransport,
  type RunInput,
  runPlan,
} from '../src/publish/run.js'
import type { PublishReply } from '../src/relay/socket.js'
import { RelayError } from '../src/relay/socket.js'
import { testSigner } from './_signer.js'

const ROOT = () => mkdtempSync(join(tmpdir(), 'scrutiny-run-'))
const PLAN_HASH = 'a'.repeat(64)

/** Profile, two products, one metadata bound to both: the shape of a real plan. */
function graph(products = ['product:a', 'product:b'], bindTo = products): TemplateGraph {
  const t = (type: string) => [
    ['t', 'scrutiny-fabric'],
    ['t', 'scrutiny-v0.8.1'],
    ['t', type],
  ]
  return {
    planVersion: 1,
    pubkey: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
    relays: ['wss://primary.example'],
    events: [
      { ref: 'profile:me', kind: 0, content: '{"name":"me"}', tags: [] },
      ...products.map((ref) => ({ ref, kind: 1, content: ref, tags: t('scrutiny-product') })),
      { ref: 'metadata:m', kind: 1, content: 'm', tags: t('scrutiny-metadata') },
      ...bindTo.map((p) => ({
        ref: `binding:metadata:m>${p}`,
        kind: 1,
        content: `l\n\nRefs: root @ref:${p} link @ref:metadata:m`,
        tags: [
          ...t('scrutiny-binding'),
          ['e', `@ref:${p}`, '', 'root', ''],
          ['e', '@ref:metadata:m', '', 'link', ''],
        ],
      })),
    ],
    blobs: [],
  }
}

type Reply = 'ok' | 'reject' | 'lost' | 'stored-no-ack' | 'hang'

/**
 * A primary relay double. Each publish consumes the next scripted reply (default `ok`):
 * - `lost`: never stored, the client gives up (RelayError);
 * - `stored-no-ack`: stored, but the ack never arrives (RelayError);
 * - `hang`: never answers.
 * `confirmed` holds ids the engine has been told are stored (OK true, or found by REQ).
 * `signals` records the abort signal each publish was given, in call order.
 */
function primary(script: Reply[] = []) {
  const stored = new Map<string, NostrEvent>()
  const confirmed = new Set<string>()
  const sent: NostrEvent[] = []
  const signals: (AbortSignal | undefined)[] = []
  const transport: PrimaryTransport = {
    async publish(event, signal) {
      sent.push(event)
      signals.push(signal)
      const reply = script.shift() ?? 'ok'
      if (reply === 'hang') return new Promise<PublishReply>(() => {})
      if (reply === 'lost') throw new RelayError('timeout', 'no OK')
      if (reply === 'reject') return { ok: false, message: 'blocked: not an allowed publisher' }
      const duplicate = stored.has(event.id)
      stored.set(event.id, event)
      if (reply === 'stored-no-ack') throw new RelayError('timeout', 'no OK')
      confirmed.add(event.id)
      return { ok: true, message: duplicate ? 'duplicate: already have it' : '' }
    },
    async fetchByIds(ids) {
      const out = new Map<string, NostrEvent>()
      for (const id of ids) {
        const event = stored.get(id)
        if (event !== undefined) {
          out.set(id, event)
          confirmed.add(id)
        }
      }
      return out
    },
  }
  return { transport, stored, confirmed, sent, signals }
}

/** A signer that asserts invariant A at the moment of every signature. */
function guardedSigner(confirmed: ReadonlySet<string>) {
  const inner = testSigner()
  const violations: string[] = []
  return {
    violations,
    calls: inner.calls,
    publicKey: inner.publicKey,
    sign: async (template: Parameters<typeof inner.sign>[0]) => {
      for (const tag of template.tags) {
        if (tag[0] === 'e' && !confirmed.has(tag[1] ?? '')) violations.push(String(tag[1]))
      }
      return inner.sign(template)
    },
  }
}

/** A transport whose clock advances by `step` on every publish. */
function ticking(t: PrimaryTransport, step: () => void): PrimaryTransport {
  return {
    ...t,
    publish: async (e, signal) => {
      step()
      return t.publish(e, signal)
    },
  }
}

let seconds = 1_800_000_000
async function run(
  overrides: Partial<RunInput> & Pick<RunInput, 'journal' | 'primary'>,
): Promise<Awaited<ReturnType<typeof runPlan>>> {
  return runPlan({
    planHash: PLAN_HASH,
    graph: graph(),
    uploads: [],
    signer: testSigner(),
    mirrors: new Map(),
    uploadBlob: async (u) => ({ state: 'uploaded', url: `https://primary.example/${u.x}${u.ext}` }),
    now: () => seconds++,
    clock: () => 0,
    deadline: Number.POSITIVE_INFINITY,
    ...overrides,
  })
}

describe('a complete run', () => {
  it('publishes in fixed order, resolves refs to acked ids, and verifies every event', async () => {
    const relay = primary()
    const journal = await Journal.open(ROOT(), PLAN_HASH)
    const progress: number[] = []
    const out = await run({
      journal,
      primary: relay.transport,
      onProgress: (done) => progress.push(done),
    })

    expect(out.outcome).toBe('complete')
    expect(out.progress).toStrictEqual({ done: 6, total: 6 })
    expect(out.records.map((r) => [r.ref, r.state])).toStrictEqual([
      ['profile:me', 'verified'],
      ['product:a', 'verified'],
      ['product:b', 'verified'],
      ['metadata:m', 'verified'],
      ['binding:metadata:m>product:a', 'verified'],
      ['binding:metadata:m>product:b', 'verified'],
    ])
    expect(relay.sent.map((e) => e.kind)).toStrictEqual([0, 1, 1, 1, 1, 1])
    const id = (ref: string) => out.records.find((r) => r.ref === ref)?.event_id
    const binding = relay.sent[4]
    expect(binding?.tags.filter((t) => t[0] === 'e')).toStrictEqual([
      ['e', id('product:a'), '', 'root', ''],
      ['e', id('metadata:m'), '', 'link', ''],
    ])
    expect(binding?.content).toBe(`l\n\nRefs: root ${id('product:a')} link ${id('metadata:m')}`)
    expect(progress).toStrictEqual([1, 2, 3, 4, 5, 6])
  })

  it('resolves only an event’s own parents, leaving a lookalike token literal', async () => {
    const relay = primary()
    const base = graph()
    const lookalike = '@ref:product:unrelated'
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
      graph: {
        ...base,
        events: base.events.map((e) =>
          e.ref === 'metadata:m' ? { ...e, content: `m ${lookalike}` } : e,
        ),
      },
    })
    expect(out.outcome).toBe('complete')
    const metadata = relay.sent.find((e) => e.content.startsWith('m '))
    expect(metadata?.content).toBe(`m ${lookalike}`)
    const binding = relay.sent.find((e) => e.content.startsWith('l'))
    const rootId = binding?.tags.find((t) => t[3] === 'root')?.[1] ?? ''
    const linkId = binding?.tags.find((t) => t[3] === 'link')?.[1] ?? ''
    expect(binding?.content).toBe(`l\n\nRefs: root ${rootId} link ${linkId}`)
    expect(binding?.content).not.toContain('@ref:')
  })

  it('reports an event the relay serves altered as acked, not verified', async () => {
    const relay = primary()
    relay.transport.fetchByIds = async (ids) =>
      new Map(
        ids.flatMap((id) => {
          const e = relay.stored.get(id)
          return e === undefined
            ? []
            : [[id, { ...e, content: `${e.content} (tampered)` }] as const]
        }),
      )
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
    })
    expect(out.outcome).toBe('complete')
    expect(out.records.every((r) => r.state === 'acked')).toBe(true)
  })

  it('uploads a blob before signing the event citing it, and stops before signing if it fails', async () => {
    const upload: BlobUpload = {
      ref: 'metadata:m',
      x: 'b'.repeat(64),
      size: 1,
      m: 'application/pdf',
      ext: '.pdf',
      path: 'r.pdf',
    }
    const order: string[] = []
    const signer = testSigner()
    const relay = primary()
    const journal = await Journal.open(ROOT(), PLAN_HASH)
    const ok = await run({
      journal,
      primary: relay.transport,
      uploads: [upload],
      signer: {
        ...signer,
        sign: async (t) => {
          order.push(`sign ${t.content.slice(0, 12)}`)
          return signer.sign(t)
        },
      },
      uploadBlob: async (u) => {
        order.push(`upload ${u.path}`)
        return { state: 'uploaded', url: 'https://primary.example/b.pdf' }
      },
    })
    expect(order.indexOf('upload r.pdf')).toBe(order.indexOf('sign m') - 1)
    expect(ok.records.find((r) => r.ref === 'metadata:m')?.blobs).toStrictEqual([
      { x: upload.x, url: 'https://primary.example/b.pdf', state: 'uploaded' },
    ])

    const failing = testSigner()
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: primary().transport,
      uploads: [upload],
      signer: failing,
      uploadBlob: async () => {
        throw new Error('network')
      },
    })
    expect(out.outcome).toBe('stopped')
    expect(out.refusal?.code).toBe('artifact.upload_failed')
    expect(failing.calls.map((t) => t.content)).toStrictEqual([
      '{"name":"me"}',
      'product:a',
      'product:b',
    ])
  })
})

describe('rejection (spec §8.3)', () => {
  it('stops at the first rejection, maps the allowlist message, and signs nothing after it', async () => {
    const relay = primary(['ok', 'reject'])
    const signer = testSigner()
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
      signer,
    })
    expect(out.outcome).toBe('stopped')
    expect(out.refusal).toMatchObject({
      code: 'relay.not_allowed',
      relay_message: 'blocked: not an allowed publisher',
    })
    expect(signer.calls).toHaveLength(2)
    expect(out.records.map((r) => r.state)).toStrictEqual([
      'acked',
      'rejected',
      'pending',
      'pending',
      'skipped',
      'pending',
    ])
  })
})

describe('the time box (spec §6.3)', () => {
  it('signs nothing once the deadline has passed and returns partial with a resume hint', async () => {
    let ms = 0
    const signer = testSigner()
    const relay = primary()
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: ticking(relay.transport, () => {
        ms += 10
      }),
      signer,
      clock: () => ms,
      deadline: 25,
    })
    expect(out.outcome).toBe('partial')
    expect(out.resume).not.toBeNull()
    expect(signer.calls).toHaveLength(3)
    expect(out.progress).toStrictEqual({ done: 3, total: 6 })
  })

  it('stops waiting for an ack at the deadline and leaves the event signed for the next call', async () => {
    const relay = primary(['ok', 'hang'])
    const journal = await Journal.open(ROOT(), PLAN_HASH)
    const start = Date.now()
    // A frozen clock: the deadline is reached only by the 100 ms wait on the hanging ack, never by
    // slow journal fsyncs before it (a real clock made this flaky on Windows CI).
    const out = await run({
      journal,
      primary: relay.transport,
      clock: () => 0,
      deadline: 100,
    })
    expect(Date.now() - start).toBeLessThan(2000)
    expect(out.outcome).toBe('partial')
    expect(journal.latest().get('product:a')?.state).toBe('signed')
  })

  it('aborts the publish still in flight, so a partial run stops writing to the relay', async () => {
    const relay = primary(['hang'])
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
      clock: () => 0,
      deadline: 50,
    })
    expect(out.outcome).toBe('partial')
    expect(relay.signals).toHaveLength(1)
    expect(relay.signals[0]?.aborted).toBe(true)
  })
})

describe('resume (spec §8.4, §14.1 item 5)', () => {
  it('marks an un-acked event the relay stored as acked, without resending it', async () => {
    const relay = primary(['ok', 'stored-no-ack'])
    const root = ROOT()
    const first = await run({
      journal: await Journal.open(root, PLAN_HASH),
      primary: relay.transport,
    })
    expect(first.outcome).toBe('stopped')
    expect(first.refusal?.code).toBe('relay.no_ack')

    const sentBefore = relay.sent.length
    const second = await run({
      journal: await Journal.open(root, PLAN_HASH),
      primary: relay.transport,
    })
    expect(second.outcome).toBe('complete')
    const productA = relay.sent.filter((e) => e.content === 'product:a')
    expect(productA).toHaveLength(1)
    expect(relay.sent.length - sentBefore).toBe(4)
  })

  it('re-signs an un-acked event the relay lacks, with a fresh created_at', async () => {
    const relay = primary(['ok', 'lost'])
    const root = ROOT()
    await run({ journal: await Journal.open(root, PLAN_HASH), primary: relay.transport })
    await run({ journal: await Journal.open(root, PLAN_HASH), primary: relay.transport })
    const productA = relay.sent.filter((e) => e.content === 'product:a')
    expect(productA).toHaveLength(2)
    expect(productA[0]?.id).not.toBe(productA[1]?.id)
    expect(productA[1]?.created_at).toBeGreaterThan(productA[0]?.created_at ?? 0)
    const journal = await Journal.open(root, PLAN_HASH)
    expect(
      journal.lines.filter((l) => l.type === 'record' && l.state === 'superseded'),
    ).toHaveLength(1)
  })

  it('marks a stored event acked even when the relay serves it altered, and never re-signs it', async () => {
    const relay = primary(['ok', 'stored-no-ack'])
    const root = ROOT()
    await run({ journal: await Journal.open(root, PLAN_HASH), primary: relay.transport })

    const stored = relay.transport.fetchByIds
    relay.transport.fetchByIds = async (ids) =>
      new Map(
        [...(await stored(ids))].map(([id, e]) => [
          id,
          { ...e, content: `${e.content} (altered)` },
        ]),
      )
    const sentBefore = relay.sent.length
    const second = await run({
      journal: await Journal.open(root, PLAN_HASH),
      primary: relay.transport,
    })

    expect(second.outcome).toBe('complete')
    const journal = await Journal.open(root, PLAN_HASH)
    expect(
      journal.lines.filter((l) => l.type === 'record' && l.state === 'superseded'),
    ).toHaveLength(0)
    // §8.4 step 2: stored ⇒ acked. The altered bytes are §8.7's finding, not a reason to re-sign.
    expect(relay.sent.filter((e) => e.content === 'product:a')).toHaveLength(1)
    expect(relay.sent.length - sentBefore).toBe(4)
  })

  it('reuses acked ids across calls and never stores two events for one ref', async () => {
    const relay = primary()
    const root = ROOT()
    let ms = 0
    for (let call = 0; call < 6; call++) {
      const out = await run({
        journal: await Journal.open(root, PLAN_HASH),
        primary: ticking(relay.transport, () => {
          ms += 10
        }),
        clock: () => ms,
        deadline: ms + 15,
      })
      if (out.outcome === 'complete') break
    }
    // A duplicate would repeat kind and content (binding content carries the resolved ids).
    const contents = [...relay.stored.values()].map((e) => `${e.kind}:${e.content}`)
    expect(new Set(contents).size).toBe(contents.length)
    expect(relay.stored.size).toBe(6)
  })

  it('stops, without signing, when the relay cannot be asked about un-acked events', async () => {
    const relay = primary(['ok', 'stored-no-ack'])
    const root = ROOT()
    await run({ journal: await Journal.open(root, PLAN_HASH), primary: relay.transport })
    const signer = testSigner()
    const out = await run({
      journal: await Journal.open(root, PLAN_HASH),
      primary: {
        ...relay.transport,
        fetchByIds: async () => Promise.reject(new RelayError('timeout', 'x')),
      },
      signer,
    })
    expect(out.refusal?.code).toBe('relay.read_failed')
    expect(signer.calls).toStrictEqual([])
  })
})

describe('invariant A (spec §8.2, §14.1 item 4)', () => {
  it('never signs an event referencing one without an OK from the primary, across resumes', async () => {
    const reply = fc.constantFrom<Reply>('ok', 'ok', 'ok', 'reject', 'lost', 'stored-no-ack')
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.array(reply, { maxLength: 30 }),
        async (nProducts, script) => {
          const products = Array.from({ length: nProducts }, (_, i) => `product:p${i}`)
          const relay = primary([...script])
          const signer = guardedSigner(relay.confirmed)
          const root = ROOT()
          for (let call = 0; call < 12; call++) {
            const out = await run({
              journal: await Journal.open(root, PLAN_HASH),
              graph: graph(products),
              primary: relay.transport,
              signer,
            })
            if (out.outcome === 'complete') break
          }
          expect(signer.violations).toStrictEqual([])
          // At most one stored event per ref: a duplicate would repeat kind and content.
          const keys = [...relay.stored.values()].map((e) => `${e.kind}:${e.content}`)
          expect(new Set(keys).size).toBe(keys.length)
        },
      ),
      { numRuns: 60 },
    )
    // Each run fsyncs every journal line; on Windows that is the bulk of the time.
  }, 120_000)
})

describe('mirrors (spec §8.6)', () => {
  it('sends the same signed bytes once per mirror and reports rejections without retrying', async () => {
    const relay = primary()
    const got: NostrEvent[] = []
    let calls = 0
    const good: MirrorTransport = {
      publish: async (e) => {
        got.push(e)
        return { ok: true, message: '' }
      },
    }
    const strict: MirrorTransport = {
      publish: async () => {
        calls += 1
        return { ok: false, message: 'invalid: too old' }
      },
    }
    const down: MirrorTransport = {
      publish: async () => Promise.reject(new Error('connect failed')),
    }
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
      mirrors: new Map([
        ['wss://m1.example', good],
        ['wss://m2.example', strict],
        ['wss://m3.example', down],
      ]),
    })
    expect(out.outcome).toBe('complete')
    expect(got.map((e) => JSON.stringify(e))).toStrictEqual(
      relay.sent.map((e) => JSON.stringify(e)),
    )
    expect(calls).toBe(6)
    expect(out.records[0]?.mirrors).toStrictEqual({
      'wss://m1.example': { ok: true, message: '' },
      'wss://m2.example': { ok: false, message: 'invalid: too old' },
      'wss://m3.example': { ok: false, message: 'connect failed' },
    })
  })
})

describe('cancel (spec §6.3)', () => {
  it('stops before the next event and leaves a journal the next call completes', async () => {
    const controller = new AbortController()
    const relay = primary()
    const root = ROOT()
    const out = await run({
      journal: await Journal.open(root, PLAN_HASH),
      primary: relay.transport,
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 2) controller.abort()
      },
    })
    expect(out.outcome).toBe('stopped')
    expect(out.progress.done).toBe(2)
    const next = await run({
      journal: await Journal.open(root, PLAN_HASH),
      primary: relay.transport,
    })
    expect(next.outcome).toBe('complete')
    expect(relay.stored.size).toBe(6)
  })

  it('stops before signing when a cancel arrives during a blob upload', async () => {
    const controller = new AbortController()
    const relay = primary()
    const signer = testSigner()
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
      signer,
      signal: controller.signal,
      uploads: [
        {
          ref: 'profile:me',
          x: 'c'.repeat(64),
          size: 3,
          m: 'text/plain',
          ext: '.txt',
          path: 'avatar.txt',
        },
      ],
      uploadBlob: async (u) => {
        controller.abort()
        return { state: 'uploaded', url: `https://blossom.example/${u.x}${u.ext}` }
      },
    })
    expect(out.outcome).toBe('stopped')
    expect(out.refusal?.code).toBe('run.cancelled')
    expect(signer.calls).toHaveLength(0)
    expect(relay.sent).toHaveLength(0)
  })

  it('stops before the next mirror write when a cancel arrives during one', async () => {
    const controller = new AbortController()
    const relay = primary()
    const written: string[] = []
    const mirror: MirrorTransport = {
      publish: async (e) => {
        written.push(e.id)
        controller.abort()
        return { ok: true, message: '' }
      },
    }
    const out = await run({
      journal: await Journal.open(ROOT(), PLAN_HASH),
      primary: relay.transport,
      signal: controller.signal,
      mirrors: new Map([['wss://m1.example', mirror]]),
    })
    expect(out.outcome).toBe('stopped')
    expect(out.refusal?.code).toBe('run.cancelled')
    expect(written).toHaveLength(1)
    expect(
      out.records.filter((r) => Object.keys(r.mirrors).length > 0).map((r) => r.ref),
    ).toStrictEqual(['profile:me'])
  })
})

describe('journal', () => {
  it('ignores a torn last line and keeps approvals within their 30-minute window', async () => {
    const root = ROOT()
    const journal = await Journal.open(root, PLAN_HASH)
    await journal.recordApproval(PLAN_HASH, 'elicitation', 1_000_000)
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(root, '.scrutiny', 'runs', `${PLAN_HASH}.journal`), '{"type":"rec')
    const reopened = await Journal.open(root, PLAN_HASH)
    expect(reopened.lines).toHaveLength(1)
    expect(reopened.validApproval(PLAN_HASH, 1_000_000 + 30 * 60 * 1000 - 1)?.channel).toBe(
      'elicitation',
    )
    expect(reopened.validApproval(PLAN_HASH, 1_000_000 + 30 * 60 * 1000)).toBeUndefined()
    expect(reopened.validApproval('b'.repeat(64), 1_000_000)).toBeUndefined()
  })
})
