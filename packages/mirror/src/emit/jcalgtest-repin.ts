/**
 * emit/jcalgtest-repin.ts — leg-1 imeta re-pin leg (B3 fix) + the corpus-agnostic imeta verifier.
 *
 * The defect: the leg-1 import pinned each run CSV with the sha256/size of the LOCAL Windows
 * working tree (CRLF) while the pinned raw.githubusercontent.com URLs serve LF blob bytes —
 * 274/275 run-Metadata `imeta` pins failed re-verification. The fix is a C4-style re-root
 * (mirroring emit/seccerts/engine.ts): re-emit the run-Metadata with the pin corrected to the
 * bytes the pinned URL serves today, re-point every Binding whose `e link` targets it, and
 * kind-5 supersede both old events. The URL itself is never rewritten — a commit-pinned raw
 * URL is immutable, so its bytes are the durable truth the pin must match.
 *
 * The re-emitted content also fixes the prose pin (`(sha256 …, … bytes)`, runMetadata.ts:146
 * and the binding bullet) and carries a supersedes notice. Nothing is guessed: a fetch failure
 * SKIPS its event and lands in `fetchFailures` (the CLI exits 1 — all-or-nothing leg).
 *
 * `planRepinLeg` is the pure planner — fetcher and signer are injected, so tests need no
 * network and a throwaway key; `runRepinLeg` wires global fetch and writes NDJSON + summary.
 * Signing happens at plan time because the kind-5 and prose notices cite the new event ids.
 *
 * `verifyImetaNdjson` (CLI `verify:imeta`) is the public integrity check this leg satisfies:
 * for every kind-1 event with imeta rows (any corpus), re-fetch each pinned URL and recompute
 * sha256 + size. Node-only and dependency-free (global fetch + the package's @noble/hashes).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { sha256 } from '@noble/hashes/sha2.js'

import { errorMessage, readNdjson } from '../ndjson.js'
import type { SignedEvent } from '../types.js'
import { RECORD_CARD_LABEL } from './content.js'
import { buildDeletion } from './deletion.js'
import type { Signer } from './keys.js'
import { serializeNdjson } from './ndjson.js'

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

/** One fetched pin: sha256 (lowercase hex) + byte length of the bytes the URL serves. */
export interface ImetaPin {
  sha256: string
  sizeBytes: number
}

/** Fetcher contract: URL → the pin of the bytes that URL serves today. */
export type ImetaFetcher = (url: string) => Promise<ImetaPin>

/** One candidate whose pinned URL could not be fetched — its event is skipped, never guessed. */
export interface RepinFetchFailure {
  event: string
  url: string
  error: string
}

/** Why one Metadata (and by extension its Bindings) is being superseded. */
export interface RepinMismatchSample {
  event: string
  file: string
  url: string
  oldSha256: string
  oldSizeBytes: number
  newSha256: string
  newSizeBytes: number
  /** True when the content carried the pinned sha/size verbatim in its prose pin. */
  proseMatched: boolean
}

export interface RepinSummary {
  /** Events read from the input NDJSON (the whole corpus, not just candidates). */
  scanned: number
  /** Run-Metadata events: kind 1, `t scrutiny-metadata`, exactly one imeta row with url/x/size. */
  candidates: number
  /** Candidates whose bytes AND prose pin already match — not re-emitted. */
  unchanged: number
  /** Corrected run-Metadata events emitted. */
  repinnedMetadata: number
  /** Bindings re-pointed to a superseding Metadata. */
  repinnedBindings: number
  /** NIP-09 deletions emitted (one per superseded Metadata and Binding). */
  kind5s: number
  fetchFailures: RepinFetchFailure[]
  /** First {@link MAX_MISMATCH_SAMPLES} supersede reasons; the counts above are authoritative. */
  mismatchSamples: RepinMismatchSample[]
}

export interface RepinPlan {
  /** The delta batch: superseding kind-1s first, kind-5 deletions last (engine §5 order). */
  events: SignedEvent[]
  summary: RepinSummary
}

export interface RunRepinOptions {
  /** Input NDJSON (read-only; never rewritten). */
  inputPath: string
  /** Output NDJSON for the signed delta batch. */
  outputPath: string
  /** Where the run summary JSON lands. */
  summaryPath: string
  /** Publisher key; every re-emission and deletion is signed with it. */
  signer: Signer
  /** `created_at` for the whole leg (unix seconds); defaults to the current time. */
  now?: number
  /** Pin fetcher override (tests); defaults to {@link fetchImetaPin}. */
  fetcher?: ImetaFetcher
}

/** The summary JSON as written: the plan counts plus the run stamp. */
export interface RepinRunSummary extends RepinSummary {
  producedAt: string
}

export interface RunRepinResult {
  ndjsonPath: string
  summaryPath: string
  summary: RepinRunSummary
}

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

const MAX_MISMATCH_SAMPLES = 20
const HEX64 = /^[0-9a-f]{64}$/
const SIZE_RE = /^\d+$/
/** The prose pin both runMetadata and the binding bullets render: `(sha256 <64hex>, <n> bytes)`. */
const PIN_RE = /\(sha256 [0-9a-f]{64}, \d+ bytes\)/u
/** `upstream file <path> (sha256 …` — the Metadata's source identity for notices/deletions. */
const UPSTREAM_FILE_RE = /upstream file (.+?) \(sha256 /u
/** Rule 8d line: `Refs: root <64hex> link <64hex>` (gate re-checks the cross-reference). */
const REFS_RE = /^Refs: root ([0-9a-f]{64}) link ([0-9a-f]{64})$/mu

function shortId(id: string): string {
  return id.slice(0, 8)
}

/** `<sha, size>` rendered as the prose pin (`(sha256 …, … bytes)`) that content prose and imeta carry. */
function pinString(sha256_: string, sizeBytes: number): string {
  return `(sha256 ${sha256_}, ${sizeBytes} bytes)`
}

/** imeta fields per the gate's NIP-92 parse (`<name> <value>` words). */
function imetaFields(tag: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>()
  for (const part of tag.slice(1)) {
    const sp = part.indexOf(' ')
    if (sp > 0) fields.set(part.slice(0, sp), part.slice(sp + 1))
  }
  return fields
}

/**
 * Fetch `url` and return the pin of the bytes it serves today. Follows redirects; a non-2xx
 * status or a timeout is a fetch failure (the caller skips its event, never guesses a pin).
 */
export async function fetchImetaPin(url: string, timeoutMs = 30_000): Promise<ImetaPin> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { sha256: Buffer.from(sha256(bytes)).toString('hex'), sizeBytes: bytes.byteLength }
}

// ---------------------------------------------------------------------------
// candidate shape
// ---------------------------------------------------------------------------

interface ImetaRow {
  /** Index of the imeta tag within `event.tags` (it is replaced in place). */
  index: number
  tag: string[]
  url: string
  sha256: string
  sizeBytes: number
}

/**
 * The one imeta row of a re-pin candidate, or null when the event is not a run-Metadata:
 * must be kind 1, carry `t scrutiny-metadata`, and have exactly one imeta row whose
 * url/x/size fields are all present (x 64-hex, size an integer).
 */
function runMetadataImeta(event: SignedEvent): ImetaRow | null {
  if (event.kind !== 1) return null
  if (!event.tags.some((tag) => tag[0] === 't' && tag[1] === 'scrutiny-metadata')) return null
  const indexes: number[] = []
  for (const [index, tag] of event.tags.entries()) {
    if (tag[0] === 'imeta') indexes.push(index)
  }
  if (indexes.length !== 1) return null
  const index = indexes[0] as number
  const tag = event.tags[index] as string[]
  const fields = imetaFields(tag)
  const url = fields.get('url')
  const sha = fields.get('x')
  const size = fields.get('size')
  if (url === undefined || sha === undefined || size === undefined) return null
  if (!HEX64.test(sha) || !SIZE_RE.test(size)) return null
  return { index, tag, url, sha256: sha, sizeBytes: Number(size) }
}

/** The imeta row with x/size corrected in place (field order preserved). */
function correctedImetaRow(row: ImetaRow, pin: ImetaPin): string[] {
  return row.tag.map((part) => {
    const sp = part.indexOf(' ')
    const name = sp > 0 ? part.slice(0, sp) : part
    if (name === 'x') return `x ${pin.sha256}`
    if (name === 'size') return `size ${pin.sizeBytes}`
    return part
  })
}

/**
 * Rewrite the record's prose pin to the bytes the URL serves. The exact old `<sha, size>`
 * value is replaced verbatim first (the leg-1 shape: one occurrence); when the prose has
 * drifted, the record's own pin — the first pin-shaped occurrence, leg-1 prose carries
 * exactly one — is normalized to the fetched truth.
 */
function repinnedContent(content: string, from: string, to: string): string {
  if (content.includes(from)) return content.split(from).join(to)
  return PIN_RE.test(content) ? content.replace(PIN_RE, to) : content
}

/**
 * Insert the supersedes sentence after the Links block — before the record card (rule 8c)
 * or, for Bindings without a card, before the mandatory `Refs:` line (rule 8d). Mirrors
 * emit/seccerts/engine.ts's `insertSupersedesLine`.
 */
function insertSupersedesNotice(content: string, sentence: string): string {
  const lines = content.split('\n')
  let index = lines.findIndex((line) => line.trimStart().startsWith(RECORD_CARD_LABEL))
  if (index === -1) index = lines.findIndex((line) => line.startsWith('Refs: '))
  if (index === -1) return [...lines, '', sentence].join('\n')
  const before = lines.slice(0, index)
  while (before.length > 0 && before[before.length - 1] === '') before.pop()
  return [...before, '', sentence, '', ...lines.slice(index)].join('\n')
}

/** Re-point the binding's mandatory `Refs: root … link …` line (rule 8d) to the new Metadata. */
function repointedRefsLine(content: string, oldLink: string, newLink: string): string {
  const match = REFS_RE.exec(content)
  if (match === null) throw new Error("binding content lacks a 'Refs: root … link …' line")
  if (match[2] !== oldLink) {
    throw new Error(
      `binding Refs link ${match[2] ?? ''} does not match its e(link) target ${oldLink}`,
    )
  }
  return content.replace(REFS_RE, `Refs: root ${match[1] ?? ''} link ${newLink}`)
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

interface RepinCandidate {
  event: SignedEvent
  row: ImetaRow
  pin: ImetaPin
  file: string
}

/**
 * Plan the re-pin leg over one corpus. Pure: every side effect is injected — `fetcher` resolves
 * each pinned URL (each distinct URL at most once), `signer` supplies the publisher key, `now`
 * is the single `created_at` for the whole batch. Returns the delta batch (superseding kind-1s
 * in input order, kind-5 deletions last) plus the summary counts.
 */
export async function planRepinLeg(
  events: readonly SignedEvent[],
  fetcher: ImetaFetcher,
  now: number,
  signer: Signer,
): Promise<RepinPlan> {
  const summary: RepinSummary = {
    scanned: events.length,
    candidates: 0,
    unchanged: 0,
    repinnedMetadata: 0,
    repinnedBindings: 0,
    kind5s: 0,
    fetchFailures: [],
    mismatchSamples: [],
  }

  // ---- pass 1: fetch each candidate's pinned URL (each distinct URL at most once) -------
  const toRepin = new Map<string, RepinCandidate>()
  const pinCache = new Map<string, Promise<ImetaPin>>()
  const fetchPin = (url: string): Promise<ImetaPin> => {
    let pin = pinCache.get(url)
    if (pin === undefined) {
      pin = fetcher(url)
      pinCache.set(url, pin)
    }
    return pin
  }

  for (const event of events) {
    const row = runMetadataImeta(event)
    if (row === null) continue
    summary.candidates += 1
    let pin: ImetaPin
    try {
      pin = await fetchPin(row.url)
    } catch (err) {
      summary.fetchFailures.push({ event: event.id, url: row.url, error: errorMessage(err) })
      continue
    }
    const proseMatched = event.content.includes(pinString(row.sha256, row.sizeBytes))
    if (pin.sha256 === row.sha256 && pin.sizeBytes === row.sizeBytes && proseMatched) {
      summary.unchanged += 1
      continue
    }
    const candidate: RepinCandidate = {
      event,
      row,
      pin,
      file: UPSTREAM_FILE_RE.exec(event.content)?.[1] ?? row.url.split('/').pop() ?? event.id,
    }
    toRepin.set(event.id, candidate)
    if (summary.mismatchSamples.length < MAX_MISMATCH_SAMPLES) {
      summary.mismatchSamples.push({
        event: event.id,
        file: candidate.file,
        url: row.url,
        oldSha256: row.sha256,
        oldSizeBytes: row.sizeBytes,
        newSha256: pin.sha256,
        newSizeBytes: pin.sizeBytes,
        proseMatched,
      })
    }
  }

  // ---- pass 2: supersede each changed Metadata (kind 1 + `e … supersedes`) --------------
  const metadataEvents: SignedEvent[] = []
  const newMetadataId = new Map<string, string>()
  for (const [oldId, entry] of toRepin) {
    const tags = entry.event.tags.map((tag, index) =>
      index === entry.row.index ? correctedImetaRow(entry.row, entry.pin) : [...tag],
    )
    tags.push(['e', oldId, '', 'supersedes'])
    const content = insertSupersedesNotice(
      repinnedContent(
        entry.event.content,
        pinString(entry.row.sha256, entry.row.sizeBytes),
        pinString(entry.pin.sha256, entry.pin.sizeBytes),
      ),
      `Supersedes ${shortId(oldId)}: imeta pin corrected to the bytes the pinned URL serves (CRLF working-tree defect in the original import).`,
    )
    const event = signer.sign({ kind: 1, created_at: now, tags, content })
    newMetadataId.set(oldId, event.id)
    metadataEvents.push(event)
    summary.repinnedMetadata += 1
  }

  // ---- pass 3: re-point every Binding whose `e link` targets a superseded Metadata ------
  const bindingEvents: SignedEvent[] = []
  const repointedByMetadata = new Map<
    string,
    Array<{ oldBindingId: string; newBindingId: string }>
  >()
  for (const event of events) {
    if (event.kind !== 1) continue
    if (!event.tags.some((tag) => tag[0] === 't' && tag[1] === 'scrutiny-binding')) continue
    const link = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'link')
    const oldMetadataId = link?.[1]
    if (oldMetadataId === undefined) continue
    const entry = toRepin.get(oldMetadataId)
    const newId = newMetadataId.get(oldMetadataId)
    if (entry === undefined || newId === undefined) continue
    const tags = event.tags.map((tag) => {
      const copy = [...tag]
      if (tag[0] === 'e' && tag[3] === 'link' && tag[1] === oldMetadataId) copy[1] = newId
      return copy
    })
    tags.push(['e', event.id, '', 'supersedes'])
    let content = repinnedContent(
      event.content,
      pinString(entry.row.sha256, entry.row.sizeBytes),
      pinString(entry.pin.sha256, entry.pin.sizeBytes),
    )
    content = repointedRefsLine(content, oldMetadataId, newId)
    content = insertSupersedesNotice(
      content,
      `Supersedes ${shortId(event.id)}: link re-pointed to the superseding Metadata ` +
        `${shortId(newId)} (imeta pin corrected to the bytes the pinned URL serves).`,
    )
    const newBinding = signer.sign({ kind: 1, created_at: now, tags, content })
    bindingEvents.push(newBinding)
    summary.repinnedBindings += 1
    const repointed = repointedByMetadata.get(oldMetadataId) ?? []
    repointed.push({ oldBindingId: event.id, newBindingId: newBinding.id })
    repointedByMetadata.set(oldMetadataId, repointed)
  }

  // ---- pass 4: kind-5 deletions last (engine §5 assembly order) -------------------------
  const deletions: SignedEvent[] = []
  for (const [oldId, entry] of toRepin) {
    const newId = newMetadataId.get(oldId)
    if (newId === undefined) continue
    deletions.push(
      buildDeletion(
        oldId,
        `Superseded by corrected imeta pin for ${entry.file}; replaced by ${shortId(newId)}.`,
        now,
        signer,
      ),
    )
    for (const binding of repointedByMetadata.get(oldId) ?? []) {
      deletions.push(
        buildDeletion(
          binding.oldBindingId,
          `Superseded by re-pointed binding for ${entry.file}; ` +
            `replaced by ${shortId(binding.newBindingId)}.`,
          now,
          signer,
        ),
      )
    }
  }
  summary.kind5s = deletions.length

  return { events: [...metadataEvents, ...bindingEvents, ...deletions], summary }
}

/**
 * Run the re-pin leg against the filesystem: read `inputPath`, plan with the real fetcher,
 * write the signed NDJSON batch and the summary JSON. The input file is never touched.
 */
export async function runRepinLeg(options: RunRepinOptions): Promise<RunRepinResult> {
  const events = readNdjson(options.inputPath)
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const plan = await planRepinLeg(events, options.fetcher ?? fetchImetaPin, now, options.signer)

  const summary: RepinRunSummary = { ...plan.summary, producedAt: new Date().toISOString() }
  mkdirSync(dirname(options.outputPath), { recursive: true })
  mkdirSync(dirname(options.summaryPath), { recursive: true })
  writeFileSync(options.outputPath, serializeNdjson(plan.events), 'utf8')
  writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { ndjsonPath: options.outputPath, summaryPath: options.summaryPath, summary }
}

// ---------------------------------------------------------------------------
// verify:imeta — the public integrity check
// ---------------------------------------------------------------------------

export interface ImetaVerifyRow {
  event: string
  url: string | null
  expectedSha256: string | null
  expectedSizeBytes: number | null
  actualSha256: string | null
  actualSizeBytes: number | null
  status: 'match' | 'mismatch' | 'fetch-error'
  error: string | null
}

export interface ImetaVerifyCounts {
  match: number
  mismatch: number
  'fetch-error': number
}

export interface ImetaVerifyReport {
  /** True iff every verified row matched (any mismatch or fetch error ⇒ false, fail-closed). */
  ok: boolean
  in: string
  generatedAt: string
  /** Events read from the input NDJSON. */
  scanned: number
  /** Kind-1 events carrying at least one imeta row. */
  imetaEvents: number
  /** Events actually verified after `--sample`. */
  verifiedEvents: number
  /** The `--sample` value applied (0 = all eligible events). */
  sample: number
  counts: ImetaVerifyCounts
  /** One row per verified imeta tag, in input order. */
  rows: ImetaVerifyRow[]
}

export interface VerifyImetaOptions {
  ndjsonPath: string
  /** Verify a deterministic evenly spaced sample of N eligible events (0/undefined = all). */
  sample?: number
  /** Pin fetcher override (tests); defaults to {@link fetchImetaPin}. */
  fetcher?: ImetaFetcher
  /** Report timestamp override (tests); defaults to now in ISO form. */
  generatedAt?: string
}

/** Deterministic evenly spaced sample of `count` items (distinct, input order). */
function evenSample<T>(items: readonly T[], count: number): T[] {
  const out: T[] = []
  for (let i = 0; i < count; i++) {
    out.push(items[Math.floor((i * items.length) / count)] as T)
  }
  return out
}

/**
 * Verify every `imeta` pin of a corpus: for each kind-1 event with imeta rows (any corpus),
 * fetch each pinned URL and recompute sha256 + size. Rows report match / mismatch /
 * fetch-error per imeta tag; `ok` is fail-closed (unverifiable ≠ verified).
 */
export async function verifyImetaNdjson(options: VerifyImetaOptions): Promise<ImetaVerifyReport> {
  const events = readNdjson(options.ndjsonPath)
  const fetcher = options.fetcher ?? fetchImetaPin
  const sample = options.sample ?? 0

  const eligible: Array<{ event: SignedEvent; rows: string[][] }> = []
  for (const event of events) {
    if (event.kind !== 1) continue
    const rows = event.tags.filter((tag) => tag[0] === 'imeta')
    if (rows.length > 0) eligible.push({ event, rows })
  }
  const selected = sample > 0 && sample < eligible.length ? evenSample(eligible, sample) : eligible

  const pinCache = new Map<string, Promise<ImetaPin>>()
  const fetchPin = (url: string): Promise<ImetaPin> => {
    let pin = pinCache.get(url)
    if (pin === undefined) {
      pin = fetcher(url)
      pinCache.set(url, pin)
    }
    return pin
  }

  const rows: ImetaVerifyRow[] = []
  const counts: ImetaVerifyCounts = { match: 0, mismatch: 0, 'fetch-error': 0 }
  for (const { event, rows: imetaRows } of selected) {
    for (const tag of imetaRows) {
      const fields = imetaFields(tag)
      const url = fields.get('url') ?? null
      const expectedSha256 = fields.get('x') ?? null
      const sizeField = fields.get('size') ?? null
      const expectedSizeBytes =
        sizeField !== null && SIZE_RE.test(sizeField) ? Number(sizeField) : null
      if (url === null || expectedSha256 === null || expectedSizeBytes === null) {
        counts.mismatch += 1
        rows.push({
          event: event.id,
          url,
          expectedSha256,
          expectedSizeBytes,
          actualSha256: null,
          actualSizeBytes: null,
          status: 'mismatch',
          error: 'imeta row lacks a usable url/x/size field',
        })
        continue
      }
      try {
        const pin = await fetchPin(url)
        const matched = pin.sha256 === expectedSha256 && pin.sizeBytes === expectedSizeBytes
        counts[matched ? 'match' : 'mismatch'] += 1
        rows.push({
          event: event.id,
          url,
          expectedSha256,
          expectedSizeBytes,
          actualSha256: pin.sha256,
          actualSizeBytes: pin.sizeBytes,
          status: matched ? 'match' : 'mismatch',
          error: null,
        })
      } catch (err) {
        counts['fetch-error'] += 1
        rows.push({
          event: event.id,
          url,
          expectedSha256,
          expectedSizeBytes,
          actualSha256: null,
          actualSizeBytes: null,
          status: 'fetch-error',
          error: errorMessage(err),
        })
      }
    }
  }

  return {
    ok: counts.mismatch === 0 && counts['fetch-error'] === 0,
    in: options.ndjsonPath,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scanned: events.length,
    imetaEvents: eligible.length,
    verifiedEvents: selected.length,
    sample,
    counts,
    rows,
  }
}
