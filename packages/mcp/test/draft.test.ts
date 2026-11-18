/**
 * The engine's draft step: schema → refs → files → composition → preflight → open questions → hash.
 * Byte-exact template goldens adapt the prototype's wire-event golden
 * (`test/tools/handlers.test.ts:172`, `:265`, `:279`, `:303`) to a plan.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Draft, draftPlan } from '../src/plan/draft.js'
import { FILES, METADATA, PRIMARY, PRODUCT, PROFILE, PUBKEY, makeRoot, plan } from './_fixtures.js'

/** Independent of the code under test: node's own SHA-256, not @noble/hashes. */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const VERSION = 'scrutiny-v0.8.1'

async function draft(
  records: readonly unknown[],
  opts: { relays?: string[]; files?: object } = {},
) {
  const root = makeRoot({ ...FILES, ...(opts.files ?? {}) })
  return draftPlan({ root, plan: plan(records, opts.relays ?? [PRIMARY]), pubkey: PUBKEY })
}

function drafted(d: Draft) {
  if (d.status !== 'drafted') throw new Error(`expected drafted, got ${JSON.stringify(d.findings)}`)
  return d
}

const questions = (d: Draft) =>
  drafted(d).open_questions.map((q) => ({ code: q.code, field: q.field, blocking: q.blocking }))

describe('template graph goldens', () => {
  it('composes profile, product, metadata and binding byte-for-byte, in fixed order', async () => {
    const d = drafted(await draft([METADATA, PRODUCT, PROFILE]))
    const x = sha256('report bytes')

    expect(d.graph).toStrictEqual({
      planVersion: 1,
      pubkey: PUBKEY,
      relays: [PRIMARY],
      events: [
        {
          ref: 'profile:me',
          kind: 0,
          content:
            '{"name":"examplecorp","display_name":"Example Corp","about":"Secure-element vendor."}',
          tags: [],
        },
        {
          ref: 'product:ex-100',
          kind: 1,
          content: [
            'Example Corp EX-100 secure element',
            '',
            '- RISC-V core with hardware crypto accelerator',
            '',
            'Links:',
            '- https://example.com/ex-100',
            '',
            'Record card (JSON): {"vendor":"Example Corp","part":"EX-100"}',
          ].join('\n'),
          tags: [
            ['t', 'scrutiny-fabric'],
            ['t', VERSION],
            ['t', 'scrutiny-product'],
            ['i', 'vendor:example-corp'],
            ['i', 'part:EX-100'],
            ['k', 'vendor'],
            ['k', 'part'],
          ],
        },
        {
          ref: 'metadata:fi-test',
          kind: 1,
          content:
            'EX-100 fault-injection evaluation EX-FI-2026-01\n\n- Laser fault injection on the boot ROM',
          tags: [
            ['t', 'scrutiny-fabric'],
            ['t', VERSION],
            ['t', 'scrutiny-metadata'],
            ['i', 'part:EX-100'],
            ['i', 'test:EX-FI-2026-01'],
            ['k', 'part'],
            ['k', 'test'],
            ['meta', 'test'],
            ['identifier', 'EX-FI-2026-01'],
            [
              'imeta',
              `url https://relay.example/${x}.pdf`,
              'm application/pdf',
              `x ${x}`,
              'size 12',
              'alt FI evaluation (PDF)',
            ],
          ],
        },
        {
          ref: 'binding:metadata:fi-test>product:ex-100',
          kind: 1,
          content:
            'Fault-injection test\n\nRefs: root @ref:product:ex-100 link @ref:metadata:fi-test',
          tags: [
            ['t', 'scrutiny-fabric'],
            ['t', VERSION],
            ['t', 'scrutiny-binding'],
            ['e', '@ref:product:ex-100', '', 'root', ''],
            ['e', '@ref:metadata:fi-test', '', 'link', ''],
          ],
        },
      ],
      blobs: [{ x, size: 12, m: 'application/pdf', via: 'upload' }],
    })
    expect(d.ready).toBe(true)
    expect(d.open_questions).toStrictEqual([])
  })

  it('cites a publisher URL verbatim and marks the blob as verified-by-url', async () => {
    const meta = {
      ...METADATA,
      artifacts: [{ path: 'reports/fi.pdf', url: 'https://example.com/fi.pdf', alt: 'FI' }],
    }
    const d = drafted(await draft([PRODUCT, meta]))
    const event = d.graph.events.find((e) => e.ref === 'metadata:fi-test')
    expect(event?.tags.at(-1)?.[1]).toBe('url https://example.com/fi.pdf')
    expect(d.graph.blobs[0]?.via).toBe('url')
  })

  it('uploads a profile picture and puts its URL in the kind-0 JSON', async () => {
    const d = drafted(
      await draft([{ ...PROFILE, picture: { path: 'brand/logo.png' } }], {
        files: { 'brand/logo.png': 'png' },
      }),
    )
    const x = sha256('png')
    expect(JSON.parse(d.graph.events[0]?.content ?? '')).toStrictEqual({
      name: 'examplecorp',
      display_name: 'Example Corp',
      about: 'Secure-element vendor.',
      picture: `https://relay.example/${x}.png`,
    })
    expect(d.graph.blobs).toStrictEqual([{ x, size: 3, m: 'image/png', via: 'upload' }])
  })

  it('emits one binding per bind_to entry (a shared record)', async () => {
    const other = { ...PRODUCT, ref: 'product:ex-200', headline: 'Example Corp EX-100 EX-200' }
    const meta = {
      ...METADATA,
      bind_to: [
        { ref: 'product:ex-200', label: 'b' },
        { ref: 'product:ex-100', label: 'a' },
      ],
    }
    const d = drafted(await draft([PRODUCT, other, meta]))
    expect(d.graph.events.map((e) => e.ref)).toStrictEqual([
      'product:ex-100',
      'product:ex-200',
      'metadata:fi-test',
      'binding:metadata:fi-test>product:ex-100',
      'binding:metadata:fi-test>product:ex-200',
    ])
    expect(d.preview.counts).toStrictEqual({ profile: 0, product: 2, metadata: 1, binding: 2 })
  })
})

describe('plan hash', () => {
  it('does not depend on record order, and changes with any content change', async () => {
    const root = makeRoot(FILES)
    const hashOf = async (records: readonly unknown[]) =>
      drafted(await draftPlan({ root, plan: plan(records), pubkey: PUBKEY })).plan_hash
    const base = await hashOf([PROFILE, PRODUCT, METADATA])
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([PROFILE, PRODUCT, METADATA], { minLength: 3 }),
        async (records) => {
          expect(await hashOf(records)).toBe(base)
        },
      ),
      { numRuns: 6 },
    )
    expect(await hashOf([PROFILE, { ...PRODUCT, bullets: ['changed'] }, METADATA])).not.toBe(base)
  })

  it('binds the signer identity and the file bytes', async () => {
    const root = makeRoot(FILES)
    const a = drafted(await draftPlan({ root, plan: plan([PRODUCT, METADATA]), pubkey: PUBKEY }))
    const b = drafted(await draftPlan({ root, plan: plan([PRODUCT, METADATA]), pubkey: null }))
    expect(a.plan_hash).not.toBe(b.plan_hash)
    writeFileSync(join(root, 'reports/fi.pdf'), 'report bytes, revised')
    const c = drafted(await draftPlan({ root, plan: plan([PRODUCT, METADATA]), pubkey: PUBKEY }))
    expect(c.plan_hash).not.toBe(a.plan_hash)
  })
})

describe('open questions', () => {
  it('relay.missing and signer.missing block', async () => {
    const root = makeRoot(FILES)
    const d = await draftPlan({ root, plan: plan([PRODUCT], []), pubkey: null })
    expect(questions(d)).toStrictEqual([
      { code: 'relay.missing', field: 'relays', blocking: true },
      { code: 'signer.missing', field: null, blocking: true },
      { code: 'profile.missing', field: null, blocking: false },
    ])
    expect(drafted(d).ready).toBe(false)
  })

  it('profile.missing and record.no_source warn without blocking', async () => {
    const d = drafted(await draft([{ ...PRODUCT, sources: [] }]))
    expect(questions(d)).toStrictEqual([
      { code: 'profile.missing', field: null, blocking: false },
      { code: 'record.no_source', field: 'records[product:ex-100].sources', blocking: false },
    ])
    expect(d.ready).toBe(true)
  })

  it('record.no_product blocks a metadata record without bind_to', async () => {
    const { bind_to: _drop, ...unbound } = METADATA
    expect(questions(await draft([PROFILE, PRODUCT, unbound]))).toStrictEqual([
      { code: 'record.no_product', field: 'records[metadata:fi-test].bind_to', blocking: true },
    ])
  })

  it('record.dangling_ref blocks a bind_to naming a missing ref or a non-product', async () => {
    const meta = (ref: string) => ({ ...METADATA, bind_to: [{ ref, label: 'l' }] })
    for (const ref of ['product:nope', 'metadata:fi-test', 'profile:me']) {
      expect(questions(await draft([PROFILE, PRODUCT, meta(ref)]))).toStrictEqual([
        {
          code: 'record.dangling_ref',
          field: 'records[metadata:fi-test].bind_to[0].ref',
          blocking: true,
        },
      ])
    }
  })

  it('record.duplicate_ref blocks a repeated record ref and a repeated bind_to target', async () => {
    expect(questions(await draft([PROFILE, PRODUCT, PRODUCT, METADATA]))).toStrictEqual([
      { code: 'record.duplicate_ref', field: 'records[2].ref', blocking: true },
    ])
    const twice = { ...METADATA, bind_to: [...METADATA.bind_to, ...METADATA.bind_to] }
    expect(questions(await draft([PROFILE, PRODUCT, twice]))).toStrictEqual([
      {
        code: 'record.duplicate_ref',
        field: 'records[metadata:fi-test].bind_to[1].ref',
        blocking: true,
      },
    ])
  })

  it('record.rule_2a names each card key and indexer missing from the prose', async () => {
    const product = {
      ...PRODUCT,
      card: { ...PRODUCT.card, eal: 'EAL6+' },
      indexers: [...PRODUCT.indexers, 'cc:BSI-DSZ-CC-9999'],
    }
    expect(questions(await draft([PROFILE, product]))).toStrictEqual([
      { code: 'record.rule_2a', field: 'records[product:ex-100].card.eal', blocking: true },
      { code: 'record.rule_2a', field: 'records[product:ex-100].indexers[2]', blocking: true },
    ])
  })

  it('record.indexer_prefix_unknown warns and suggests the nearest known prefix', async () => {
    const product = {
      ...PRODUCT,
      headline: `${PRODUCT.headline} EX-FI-1`,
      indexers: [...PRODUCT.indexers, 'tst:EX-FI-1'],
    }
    const d = drafted(await draft([PROFILE, product]))
    expect(questions(d)).toStrictEqual([
      {
        code: 'record.indexer_prefix_unknown',
        field: 'records[product:ex-100].indexers[2]',
        blocking: false,
      },
    ])
    expect(d.open_questions[0]?.options).toStrictEqual(['test:EX-FI-1', 'keep tst:EX-FI-1'])
    expect(d.ready).toBe(true)
  })

  it('artifact.missing_file blocks a missing artifact or source', async () => {
    const meta = {
      ...METADATA,
      artifacts: [{ path: 'reports/gone.pdf', alt: 'gone' }],
      sources: ['reports/fi.pdf', 'notes/gone.md'],
    }
    expect(questions(await draft([PROFILE, PRODUCT, meta]))).toStrictEqual([
      {
        code: 'artifact.missing_file',
        field: 'records[metadata:fi-test].artifacts[0].path',
        blocking: true,
      },
      {
        code: 'artifact.missing_file',
        field: 'records[metadata:fi-test].sources[1]',
        blocking: true,
      },
    ])
  })

  it('artifact.type blocks an unmapped extension and an image outside picture', async () => {
    const meta = {
      ...METADATA,
      artifacts: [
        { path: 'reports/tool.exe', alt: 'exe' },
        { path: 'reports/photo.png', alt: 'png' },
        { path: 'reports/fi.pdf', alt: 'pdf' },
      ],
    }
    const d = await draft([PROFILE, PRODUCT, meta], {
      files: { 'reports/tool.exe': 'x', 'reports/photo.png': 'x' },
    })
    expect(questions(d)).toStrictEqual([
      {
        code: 'artifact.type',
        field: 'records[metadata:fi-test].artifacts[0].path',
        blocking: true,
      },
      {
        code: 'artifact.type',
        field: 'records[metadata:fi-test].artifacts[1].path',
        blocking: true,
      },
    ])
  })

  it('accepts an .html artifact as text/html and keeps it out of profile pictures', async () => {
    const meta = {
      ...METADATA,
      artifacts: [{ path: 'reports/dashboard.html', alt: 'Dashboard (HTML)' }],
    }
    const d = drafted(
      await draft([PROFILE, PRODUCT, meta], {
        files: { 'reports/dashboard.html': '<!doctype html>' },
      }),
    )
    const x = sha256('<!doctype html>')
    expect(d.graph.events.find((e) => e.ref === 'metadata:fi-test')?.tags).toContainEqual([
      'imeta',
      `url https://relay.example/${x}.html`,
      'm text/html',
      `x ${x}`,
      'size 15',
      'alt Dashboard (HTML)',
    ])
    expect(d.graph.blobs).toStrictEqual([{ x, size: 15, m: 'text/html', via: 'upload' }])

    const picture = { ...PROFILE, picture: { path: 'reports/dashboard.html' } }
    const refused = await draft([picture, PRODUCT, METADATA], {
      files: { 'reports/dashboard.html': '<!doctype html>' },
    })
    expect(questions(refused)).toStrictEqual([
      {
        code: 'artifact.type',
        field: 'records[profile:me].picture.path',
        blocking: true,
      },
    ])
  })

  it('artifact.too_large blocks a file over 50 MB and passes one at exactly 50 MB', async () => {
    const root = makeRoot(FILES)
    for (const [name, size] of [
      ['big.zip', 50 * 1024 * 1024 + 1],
      ['edge.zip', 50 * 1024 * 1024],
    ] as const) {
      writeFileSync(join(root, name), '')
      truncateSync(join(root, name), size)
    }
    const meta = {
      ...METADATA,
      artifacts: [
        { path: 'big.zip', alt: 'big' },
        { path: 'edge.zip', alt: 'edge' },
      ],
    }
    const d = await draftPlan({ root, plan: plan([PROFILE, PRODUCT, meta]), pubkey: PUBKEY })
    expect(questions(d)).toStrictEqual([
      {
        code: 'artifact.too_large',
        field: 'records[metadata:fi-test].artifacts[0].path',
        blocking: true,
      },
    ])
  }, 30_000)
})

describe('record.budget (on the final tag set)', () => {
  /** n distinct `part:` indexers whose values are long hex, which rule 2a exempts. */
  const product = (n: number) => ({
    ...PRODUCT,
    card: {},
    indexers: Array.from({ length: n }, (_, i) => `part:${i.toString(16).padStart(64, '0')}`),
  })

  it('counts t + i + k + e only: 60 indexers make 64 tags and pass, 61 make 65 and block', async () => {
    expect(questions(await draft([PROFILE, product(60)]))).toStrictEqual([])
    const d = drafted(await draft([PROFILE, product(61)]))
    expect(questions(d)).toStrictEqual([
      { code: 'record.budget', field: 'records[product:ex-100].indexers', blocking: true },
    ])
    expect(d.open_questions[0]?.options).toStrictEqual([
      `part:${(60).toString(16).padStart(64, '0')}`,
    ])
  })

  it('does not count imeta, meta or identifier against the single-letter ceiling', async () => {
    const meta = {
      ...METADATA,
      indexers: Array.from({ length: 59 }, (_, i) => `part:${i.toString(16).padStart(64, '0')}`),
      artifacts: Array.from({ length: 5 }, (_, i) => ({ path: 'reports/fi.pdf', alt: `a${i}` })),
    }
    // t 3 + i 59 + k 1 = 63; five imeta rows, meta and identifier are not single-letter tags.
    expect(questions(await draft([PROFILE, PRODUCT, meta]))).toStrictEqual([])
  })

  it('blocks a tag value over 1024 bytes and passes one at exactly 1024', async () => {
    // Long hex is rule-2a exempt; `part:` + 1019 hex = 1024 bytes, + 1020 hex = 1025 bytes.
    const p = (n: number) => ({ ...PRODUCT, card: {}, indexers: [`part:${'a'.repeat(n)}`] })
    expect(questions(await draft([PROFILE, p(1019)]))).toStrictEqual([])
    expect(questions(await draft([PROFILE, p(1020)]))).toStrictEqual([
      { code: 'record.budget', field: 'records[product:ex-100].indexers[0]', blocking: true },
    ])
  })

  it('blocks an event over 65 536 signed bytes', async () => {
    // Long-hex card values are rule-2a exempt, so only the size gate can fire.
    const card = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`k${i}`, i.toString(16).padStart(900, 'a')]),
    )
    expect(questions(await draft([PROFILE, { ...PRODUCT, card }]))).toStrictEqual([
      { code: 'record.budget', field: 'records[product:ex-100]', blocking: true },
    ])
  })
})

describe('findings (plan cannot be drafted)', () => {
  it('refuses a path that escapes the root', async () => {
    const d = await draft([PROFILE, { ...PRODUCT, sources: ['../outside.pdf'] }])
    expect(d.status).toBe('invalid')
    expect(d.findings.map((f) => [f.code, f.field])).toStrictEqual([
      ['schema.path_outside_root', 'records[product:ex-100].sources[0]'],
    ])
  })

  it('refuses an absolute path', async () => {
    const d = await draft([PROFILE, { ...PRODUCT, sources: [join(makeRoot(), 'x.pdf')] }])
    expect(d.findings.map((f) => [f.code, f.field])).toStrictEqual([
      ['schema.path_outside_root', 'records[product:ex-100].sources[0]'],
    ])
  })

  it('refuses a path that escapes the root through a directory link', async () => {
    const outside = makeRoot({ 'secret.pdf': 'outside' })
    const root = makeRoot(FILES)
    mkdirSync(join(root, 'linked'), { recursive: true })
    // A junction needs no privileges on Windows; elsewhere the type argument is ignored.
    symlinkSync(outside, join(root, 'linked', 'out'), 'junction')
    const d = await draftPlan({
      root,
      plan: plan([PROFILE, { ...PRODUCT, sources: ['linked/out/secret.pdf'] }]),
      pubkey: PUBKEY,
    })
    expect(d.findings.map((f) => [f.code, f.field])).toStrictEqual([
      ['schema.path_outside_root', 'records[product:ex-100].sources[0]'],
    ])
  })

  it('reports schema findings with source "schema" and no graph', async () => {
    const d = await draft([{ ...PRODUCT, content: 'x' }])
    expect(d.status).toBe('invalid')
    expect(d.findings[0]?.source).toBe('schema')
  })
})

describe('preview', () => {
  it('shows composed content verbatim, sources, artifact facts and the bind graph', async () => {
    const d = drafted(await draft([PROFILE, PRODUCT, METADATA]))
    const meta = d.preview.records.find((r) => r.ref === 'metadata:fi-test')
    expect(meta?.artifacts).toStrictEqual([
      { path: 'reports/fi.pdf', x: sha256('report bytes'), size: 12 },
    ])
    expect(meta?.sources).toStrictEqual(['reports/fi.pdf'])
    expect(meta?.content).toBe(d.graph.events.find((e) => e.ref === 'metadata:fi-test')?.content)
    expect(d.preview.graph).toStrictEqual([
      { from: 'metadata:fi-test', to: 'product:ex-100', label: 'Fault-injection test' },
    ])
    expect(d.preview.relays).toStrictEqual([{ url: PRIMARY, role: 'primary' }])
  })
})
