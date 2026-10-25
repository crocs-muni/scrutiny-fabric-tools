/**
 * emit/jcalgtest-repin.test.ts — the re-pin leg against fixture run-Metadata + Bindings.
 *
 * Fixtures mirror the leg-1 shape (artifacts/jcalgtest.ndjson): kind-1 Metadata with one
 * imeta row + prose pin, one run Binding, exactly the numbers runMetadata.ts/binding.ts
 * render. A fake fetcher serves known LF bytes, so the tests need no network; a throwaway
 * key signs — ids are deterministic, so runs are reproducible. Every planned batch is
 * re-checked with the sibling gate (`gateEvents`).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'

import { gateEvents } from '../gate/index.js'
import type { SignedEvent } from '../types.js'
import {
  type ImetaFetcher,
  type ImetaPin,
  planRepinLeg,
  runRepinLeg,
  verifyImetaNdjson,
} from './jcalgtest-repin.js'
import { signerFromSecretKey } from './keys.js'

const SIGNER = signerFromSecretKey('01'.repeat(32))
/** 2026-10-05T00:00:00Z — the deterministic `created_at` this leg stamps on every event. */
const NOW = 1791158400
const ROOT_ID = 'ab'.repeat(32)

/** The bytes the pinned URLs serve today (LF — the blob form of the upstream CSVs). */
const LF_BYTES = new TextEncoder().encode('Algorithm,Supported\nAES,true\n')
const SERVED_PIN: ImetaPin = {
  sha256: Buffer.from(sha256(LF_BYTES)).toString('hex'),
  sizeBytes: LF_BYTES.byteLength,
}
/** The defect being corrected: the pin of the local CRLF working tree. */
const CRLF_BYTES = new TextEncoder().encode('Algorithm,Supported\r\nAES,true\r\n')
const OLD_PIN: ImetaPin = {
  sha256: Buffer.from(sha256(CRLF_BYTES)).toString('hex'),
  sizeBytes: CRLF_BYTES.byteLength,
}
const OLD_PIN_STRING = `(sha256 ${OLD_PIN.sha256}, ${OLD_PIN.sizeBytes} bytes)`

const URL_BASE =
  'https://raw.githubusercontent.com/crocs-muni/jcalgtest_results/1437997364b11deeab8c9a1ad8831fbcb3052d50/'

interface RunFixture {
  file: string
  url: string
  cardName: string
  jcard: string
  atr: string
  /** What the imeta row pins. */
  pin: ImetaPin
  /** What the prose pin renders (differs from `pin` only in the prose-drift scenario). */
  proseSha: string
  proseSize: number
}

function fixture(name: string, overrides: Partial<RunFixture>): RunFixture {
  return {
    file: `javacard/Profiles/aid/${name}_AIDSUPPORT_3B69.csv`,
    url: `${URL_BASE}javacard/Profiles/aid/${name}_AIDSUPPORT_3B69.csv`,
    cardName: 'Test Card',
    jcard: 'c001',
    atr: '3b69000241434f534a76313031',
    pin: OLD_PIN,
    proseSha: OLD_PIN.sha256,
    proseSize: OLD_PIN.sizeBytes,
    ...overrides,
  }
}

/** The changed pair: pin + prose carry the CRLF working-tree bytes; the URL serves LF. */
const CHANGED = fixture('TestChanged', {})
/** The already-correct pair: pin + prose match what the URL serves. */
const UNCHANGED = fixture('TestUnchanged', {
  pin: SERVED_PIN,
  proseSha: SERVED_PIN.sha256,
  proseSize: SERVED_PIN.sizeBytes,
})

function metadataContent(f: RunFixture): string {
  return [
    `AIDSUPPORT — ${f.cardName} (profile ${f.jcard}); run (no date).`,
    `Card identity: ATR (continuous lowercase hex) ${f.atr}; indexers: jcard and atr only; snapshot 2026-10-05.`,
    '',
    `- Card: ${f.cardName}; JCAlgTest profile ${f.jcard}; ATR (continuous lowercase hex) ${f.atr}.`,
    `- Contributor: not recorded; upstream file ${f.file} (sha256 ${f.proseSha}, ${f.proseSize} bytes) attached via imeta below.`,
    '',
    'Links:',
    `- Raw CSV: ${f.url}`,
    '',
    'Record card (JSON): {"type":"jcalgtest-aidsupport@1"}',
  ].join('\n')
}

function metadataTags(f: RunFixture): string[][] {
  return [
    ['t', 'scrutiny-fabric'],
    ['t', 'scrutiny-metadata'],
    ['t', 'scrutiny-v0.8.1'],
    ['t', 'jcalgtest'],
    ['i', `jcard:${f.jcard}`],
    ['i', `atr:${f.atr}`],
    ['k', 'jcard'],
    ['k', 'atr'],
    ['imeta', `url ${f.url}`, 'm text/csv', `x ${f.pin.sha256}`, `size ${f.pin.sizeBytes}`],
  ]
}

function buildMetadata(f: RunFixture): SignedEvent {
  return SIGNER.sign({
    kind: 1,
    created_at: NOW - 100,
    tags: metadataTags(f),
    content: metadataContent(f),
  })
}

function buildBinding(f: RunFixture, metadataId: string): SignedEvent {
  const content = [
    `${f.cardName} ← AIDSUPPORT (no date): the measurement run bound to its card Product.`,
    '',
    `- Edge shape: root = card Product (${f.cardName}, profile ${f.jcard}), link = measurement-run Metadata (AIDSUPPORT).`,
    `- The run Metadata carries its raw CSV bytes via imeta (sha256 ${f.proseSha}, ${f.proseSize} bytes).`,
    `- Upstream file: ${f.file}; snapshot 2026-10-05; mirrored by scrutiny-mirror.`,
    '',
    'Links:',
    `- Raw CSV: ${f.url}`,
    '',
    `Refs: root ${ROOT_ID} link ${metadataId}`,
  ].join('\n')
  return SIGNER.sign({
    kind: 1,
    created_at: NOW - 99,
    tags: [
      ['t', 'scrutiny-fabric'],
      ['t', 'scrutiny-binding'],
      ['t', 'scrutiny-v0.8.1'],
      ['t', 'jcalgtest'],
      ['e', ROOT_ID, '', 'root', SIGNER.pubkey],
      ['e', metadataId, '', 'link', SIGNER.pubkey],
    ],
    content,
  })
}

const CHANGED_MD = buildMetadata(CHANGED)
const CHANGED_BIND = buildBinding(CHANGED, CHANGED_MD.id)
const UNCHANGED_MD = buildMetadata(UNCHANGED)
const UNCHANGED_BIND = buildBinding(UNCHANGED, UNCHANGED_MD.id)
const LEG = [CHANGED_MD, CHANGED_BIND, UNCHANGED_MD, UNCHANGED_BIND]

const SERVE_ALL: ImetaFetcher = (url) => {
  if (!url.startsWith(URL_BASE)) return Promise.reject(new Error(`unexpected url ${url}`))
  return Promise.resolve(SERVED_PIN)
}

const SERVE_EXCEPT_CHANGED: ImetaFetcher = (url) => {
  if (url === CHANGED.url) return Promise.reject(new Error('boom'))
  return SERVE_ALL(url)
}

function idsOf(events: readonly SignedEvent[], name: string): string[] {
  return events.flatMap((event) => event.tags.filter((t) => t[0] === name).map((t) => t[1] ?? ''))
}

describe('planRepinLeg — one changed run-Metadata superseded with its Binding', () => {
  it('re-emits the pair, kind-5s both old events and skips the unchanged pair', async () => {
    const plan = await planRepinLeg(LEG, SERVE_ALL, NOW, SIGNER)

    expect(plan.summary).toMatchObject({
      scanned: 4,
      candidates: 2,
      unchanged: 1,
      repinnedMetadata: 1,
      repinnedBindings: 1,
      kind5s: 2,
      fetchFailures: [],
    })
    expect(plan.summary.mismatchSamples).toHaveLength(1)
    expect(plan.summary.mismatchSamples[0]).toMatchObject({
      event: CHANGED_MD.id,
      file: CHANGED.file,
      oldSha256: OLD_PIN.sha256,
      newSha256: SERVED_PIN.sha256,
      proseMatched: true,
    })

    expect(plan.events).toHaveLength(4)
    const newMd = plan.events[0] as SignedEvent
    const newBind = plan.events[1] as SignedEvent
    const delMd = plan.events[2] as SignedEvent
    const delBind = plan.events[3] as SignedEvent

    // ---- the superseding Metadata ----------------------------------------------------
    expect(newMd.kind).toBe(1)
    expect(newMd.created_at).toBe(NOW)
    expect(newMd.pubkey).toBe(SIGNER.pubkey)
    expect(newMd.id).not.toBe(CHANGED_MD.id)
    expect(newMd.tags).toEqual([
      ...metadataTags(CHANGED).slice(0, 8),
      [
        'imeta',
        `url ${CHANGED.url}`,
        'm text/csv',
        `x ${SERVED_PIN.sha256}`,
        `size ${SERVED_PIN.sizeBytes}`,
      ],
      ['e', CHANGED_MD.id, '', 'supersedes'],
    ])
    expect(newMd.content).toContain(`(sha256 ${SERVED_PIN.sha256}, ${SERVED_PIN.sizeBytes} bytes)`)
    expect(newMd.content).not.toContain(OLD_PIN_STRING)
    expect(newMd.content).toContain(
      `Supersedes ${CHANGED_MD.id.slice(0, 8)}: imeta pin corrected to the bytes the pinned URL serves`,
    )
    const mdLines = newMd.content.split('\n')
    expect(mdLines[mdLines.length - 3]).toContain(`Supersedes ${CHANGED_MD.id.slice(0, 8)}`)
    expect(mdLines[mdLines.length - 1]).toMatch(/^Record card \(JSON\): /)

    // ---- the re-pointed Binding ------------------------------------------------------
    expect(newBind.kind).toBe(1)
    expect(newBind.created_at).toBe(NOW)
    expect(newBind.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', 'scrutiny-binding'],
      ['t', 'scrutiny-v0.8.1'],
      ['t', 'jcalgtest'],
      ['e', ROOT_ID, '', 'root', SIGNER.pubkey],
      ['e', newMd.id, '', 'link', SIGNER.pubkey],
      ['e', CHANGED_BIND.id, '', 'supersedes'],
    ])
    expect(newBind.content).toContain(`Refs: root ${ROOT_ID} link ${newMd.id}`)
    expect(newBind.content).toContain(
      `(sha256 ${SERVED_PIN.sha256}, ${SERVED_PIN.sizeBytes} bytes)`,
    )
    expect(newBind.content).not.toContain(OLD_PIN_STRING)
    expect(newBind.content).toContain(`Supersedes ${CHANGED_BIND.id.slice(0, 8)}: link re-pointed`)
    const bindLines = newBind.content.split('\n')
    expect(bindLines[bindLines.length - 1]).toBe(`Refs: root ${ROOT_ID} link ${newMd.id}`)

    // ---- the two kind-5 deletions ----------------------------------------------------
    expect(delMd.kind).toBe(5)
    expect(delMd.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', 'scrutiny-v0.8.1'],
      ['e', CHANGED_MD.id],
    ])
    expect(delMd.content).toBe(
      `Superseded by corrected imeta pin for ${CHANGED.file}; replaced by ${newMd.id.slice(0, 8)}.`,
    )
    expect(delBind.kind).toBe(5)
    expect(delBind.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', 'scrutiny-v0.8.1'],
      ['e', CHANGED_BIND.id],
    ])
    expect(delBind.content).toBe(
      `Superseded by re-pointed binding for ${CHANGED.file}; ` +
        `replaced by ${newBind.id.slice(0, 8)}.`,
    )

    // ---- the unchanged pair is never touched -----------------------------------------
    const targets = idsOf(plan.events, 'e')
    expect(targets).not.toContain(UNCHANGED_MD.id)
    expect(targets).not.toContain(UNCHANGED_BIND.id)

    // ---- the whole batch is gate-shaped and signed -----------------------------------
    const gate = gateEvents(plan.events, 'repin')
    expect(gate.errors).toEqual([])
    expect(gate.lostFacts).toEqual([])
  })

  it('is idempotent — the superseding batch re-plans as unchanged', async () => {
    const first = await planRepinLeg(LEG, SERVE_ALL, NOW, SIGNER)
    const second = await planRepinLeg(first.events, SERVE_ALL, NOW, SIGNER)
    expect(second.summary).toMatchObject({
      scanned: 4,
      candidates: 1,
      unchanged: 1,
      repinnedMetadata: 0,
      repinnedBindings: 0,
      kind5s: 0,
    })
    expect(second.events).toEqual([])
  })

  it('skips a candidate whose pinned URL cannot be fetched and reports it', async () => {
    const plan = await planRepinLeg(LEG, SERVE_EXCEPT_CHANGED, NOW, SIGNER)
    expect(plan.summary.fetchFailures).toEqual([
      { event: CHANGED_MD.id, url: CHANGED.url, error: 'boom' },
    ])
    expect(plan.summary).toMatchObject({
      candidates: 2,
      unchanged: 1,
      repinnedMetadata: 0,
      repinnedBindings: 0,
      kind5s: 0,
    })
    expect(plan.events).toEqual([])
  })

  it('re-emits when only the prose pin drifted from the imeta row', async () => {
    const drift = fixture('TestDrift', {
      pin: SERVED_PIN,
      proseSha: 'e'.repeat(64),
      proseSize: 999,
    })
    const md = buildMetadata(drift)
    const plan = await planRepinLeg([md], SERVE_ALL, NOW, SIGNER)
    expect(plan.summary).toMatchObject({
      candidates: 1,
      unchanged: 0,
      repinnedMetadata: 1,
      kind5s: 1,
    })
    expect(plan.summary.mismatchSamples[0]?.proseMatched).toBe(false)
    const newMd = plan.events[0] as SignedEvent
    expect(newMd.content).toContain(`(sha256 ${SERVED_PIN.sha256}, ${SERVED_PIN.sizeBytes} bytes)`)
    expect(newMd.content).not.toContain('e'.repeat(64))
    expect(gateEvents(plan.events, 'repin').errors).toEqual([])
  })
})

describe('runRepinLeg — file wiring', () => {
  it('writes the signed NDJSON batch + summary and leaves the input untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcalgtest-repin-'))
    try {
      const inPath = join(dir, 'leg.ndjson')
      const input = `${LEG.map((event) => JSON.stringify(event)).join('\n')}\n`
      writeFileSync(inPath, input, 'utf8')
      const outPath = join(dir, 'leg-repin.ndjson')
      const summaryPath = join(dir, 'leg-repin.summary.json')

      const result = await runRepinLeg({
        inputPath: inPath,
        outputPath: outPath,
        summaryPath,
        signer: SIGNER,
        now: NOW,
        fetcher: SERVE_ALL,
      })

      const lines = readFileSync(outPath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(4)
      const written = lines.map((line) => JSON.parse(line) as SignedEvent)
      const plan = await planRepinLeg(LEG, SERVE_ALL, NOW, SIGNER)
      expect(written.map((event) => event.id)).toEqual(plan.events.map((event) => event.id))
      expect(gateEvents(written, 'repin').errors).toEqual([])

      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>
      expect(summary['scanned']).toBe(4)
      expect(summary['repinnedMetadata']).toBe(1)
      expect(summary['repinnedBindings']).toBe(1)
      expect(summary['kind5s']).toBe(2)
      expect(typeof summary['producedAt']).toBe('string')
      expect(result.summary.repinnedMetadata).toBe(1)
      expect(readFileSync(inPath, 'utf8')).toBe(input)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verifyImetaNdjson — the public integrity check', () => {
  it('flags the CRLF-pinned Metadata and passes the already-correct one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcalgtest-repin-verify-'))
    try {
      const inPath = join(dir, 'leg.ndjson')
      writeFileSync(inPath, `${LEG.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')

      const report = await verifyImetaNdjson({
        ndjsonPath: inPath,
        fetcher: SERVE_ALL,
        generatedAt: '2026-10-05T00:00:00.000Z',
      })
      expect(report.ok).toBe(false)
      expect(report.imetaEvents).toBe(2)
      expect(report.verifiedEvents).toBe(2)
      expect(report.counts).toEqual({ match: 1, mismatch: 1, 'fetch-error': 0 })
      expect(report.rows[0]).toMatchObject({
        event: CHANGED_MD.id,
        url: CHANGED.url,
        status: 'mismatch',
        expectedSha256: OLD_PIN.sha256,
        actualSha256: SERVED_PIN.sha256,
      })
      expect(report.rows[1]).toMatchObject({ event: UNCHANGED_MD.id, status: 'match' })

      const failed = await verifyImetaNdjson({ ndjsonPath: inPath, fetcher: SERVE_EXCEPT_CHANGED })
      expect(failed.ok).toBe(false)
      expect(failed.counts).toEqual({ match: 1, mismatch: 0, 'fetch-error': 1 })
      expect(failed.rows[0]).toMatchObject({ status: 'fetch-error', error: 'boom' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verifies a deterministic sample of the eligible events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcalgtest-repin-sample-'))
    try {
      const inPath = join(dir, 'leg.ndjson')
      writeFileSync(inPath, `${LEG.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
      const report = await verifyImetaNdjson({ ndjsonPath: inPath, sample: 1, fetcher: SERVE_ALL })
      expect(report.sample).toBe(1)
      expect(report.verifiedEvents).toBe(1)
      expect(report.rows).toHaveLength(1)
      expect(report.rows[0]?.event).toBe(CHANGED_MD.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
