#!/usr/bin/env bun
/**
 * Mirror CLI — pipeline entry points (README §Pipeline).
 *
 *   bun src/cli.ts build:jcalgtest [--repo C:/tmp/jcres] [--ground-truth docs/mirroring/ground-truth]
 *                                   [--artifacts artifacts] [--nsec env]
 *   bun src/cli.ts repin:jcalgtest [--in artifacts/jcalgtest.ndjson] [--out artifacts/jcalgtest-repin.ndjson]
 *                                  [--summary artifacts/jcalgtest-repin.summary.json] [--nsec env]
 *   bun src/cli.ts verify:imeta --in FILE.ndjson [--sample N] [--out FILE.json]
 *   bun src/cli.ts gate  --in artifacts/jcalgtest.ndjson
 *   bun src/cli.ts probe --relay wss://relay.example.com [--key env]
 *   bun src/cli.ts publish --relay ws://… [--in artifacts/jcalgtest.ndjson] [--limit N] [--pace 500]
 *
 * Sibling units (loaders/emit/gate) are loaded lazily by dynamic import so this file type-checks and
 * runs while the other units are still landing; missing modules produce a pointed error, not a crash.
 *
 * Key material resolution (`--nsec`/`--key`): `env` (default) → `NSEC` then `NSEC_FILE`;
 * a flag value that is not key material is treated as an environment variable name.
 * `NSEC_AGE_FILE` is intentionally unsupported in the pilot (README: env nsec for pilot).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { EventTemplate } from 'nostr-tools/pure'

import { openLedger } from './ledger/index'
import { toSecretKey } from './publish/auth'
import { publishBatch } from './publish/index'
import { relayProbe, writeProbeResult } from './publish/probe'
import type { GateReport, Manifest, SignedEvent, SourceBundle } from './types'

interface Signer {
  pubkey: string
  sign(template: EventTemplate): SignedEvent
}

interface LoaderModule {
  loadJcalgtest(opts: { repoDir: string; groundTruthDir: string }): SourceBundle
}

interface SeccertsLoaderModule {
  loadSeccerts(opts: { dataDir: string; groundTruthDir: string }): unknown
}

interface SeccertsEmitModule {
  emitSeccerts(
    bundle: unknown,
    opts: { signer: Signer; ledgerPath: string; createdAtBase?: number; producedAt?: string },
  ): {
    events: SignedEvent[]
    manifest: Manifest
    counts: Record<string, number>
    warnings: string[]
  }
}

interface EmitModule {
  emitSourceBundle(
    bundle: SourceBundle,
    opts: { signer: Signer },
  ): { events: SignedEvent[]; manifest: Manifest }
  writeArtifacts(
    result: { events: SignedEvent[]; manifest: Manifest },
    opts?: { corpus?: string; outDir?: string; filename?: string },
  ): { ndjsonPath: string; manifestPath: string }
}

interface GateModule {
  gateBatch(
    ndjsonPath: string,
    opts?: { outPath?: string; artifactsDir?: string },
  ): Promise<{ ok: boolean; exitCode: 0 | 1; report: GateReport; outPath: string }>
}

interface RepinSummaryLike {
  scanned: number
  candidates: number
  unchanged: number
  repinnedMetadata: number
  repinnedBindings: number
  kind5s: number
  fetchFailures: Array<{ event: string; url: string; error: string }>
  mismatchSamples: unknown[]
}

interface ImetaVerifyReportLike {
  ok: boolean
  imetaEvents: number
  verifiedEvents: number
  counts: { match: number; mismatch: number; 'fetch-error': number }
  rows: Array<{
    event: string
    url: string | null
    status: 'match' | 'mismatch' | 'fetch-error'
    error: string | null
    expectedSha256: string | null
    actualSha256: string | null
  }>
}

interface RepinModule {
  runRepinLeg(opts: {
    inputPath: string
    outputPath: string
    summaryPath: string
    signer: Signer
  }): Promise<{ ndjsonPath: string; summaryPath: string; summary: RepinSummaryLike }>
  verifyImetaNdjson(opts: {
    ndjsonPath: string
    sample?: number
  }): Promise<ImetaVerifyReportLike>
}

const USAGE = `Usage:
  cli.ts build:jcalgtest [--repo DIR] [--ground-truth DIR] [--artifacts DIR] [--nsec env|ENV_VAR|hex|nsec1…]
  cli.ts build:seccerts [--data C:/tmp] [--ground-truth DIR] [--artifacts DIR] [--ledger PATH] [--nsec env|ENV_VAR|hex|nsec1…]
  cli.ts repin:jcalgtest [--in FILE.ndjson] [--out FILE.ndjson] [--summary FILE.json] [--nsec env|ENV_VAR|hex|nsec1…]
  cli.ts verify:imeta [--in FILE.ndjson] [--sample N] [--out FILE.json] [--relay-host none]
  cli.ts gate --in FILE.ndjson
  cli.ts probe --relay ws://… [--key env|ENV_VAR|hex|nsec1…]
  cli.ts publish --relay ws://… [--in FILE.ndjson] [--limit N] [--pace MS] [--ledger PATH]
`

interface ParsedArgs {
  positional: string[]
  flags: Map<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 2) {
      flags.set(token.slice(2, eq), token.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(token.slice(2), next)
      i++
    } else {
      flags.set(token.slice(2), 'true')
    }
  }
  return { positional, flags }
}

function intFlag(flags: Map<string, string>, name: string): number | undefined {
  const raw = flags.get(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`--${name}: expected a non-negative number, got '${raw}'`)
  return value
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined || value === '') throw new Error(`missing --${name}\n${USAGE}`)
  return value
}

/** Resolve the signing key to hex/nsec material; `env` (or no flag) reads NSEC / NSEC_FILE. */
function resolveKeyMaterial(flagValue: string | undefined): string {
  if (flagValue !== undefined && flagValue !== 'env') {
    if (/^[0-9a-fA-F]{64}$/.test(flagValue) || flagValue.startsWith('nsec1')) return flagValue
    const fromEnv = process.env[flagValue]
    if (fromEnv === undefined || fromEnv.trim() === '') {
      throw new Error(`key: environment variable ${flagValue} is unset or empty`)
    }
    return fromEnv.trim()
  }
  const direct = process.env['NSEC']?.trim()
  if (direct !== undefined && direct !== '') return direct
  const file = process.env['NSEC_FILE']
  if (file !== undefined && file !== '') {
    const content = readFileSync(file, 'utf8').trim()
    if (content === '') throw new Error(`key: NSEC_FILE ${file} is empty`)
    return content
  }
  if (process.env['NSEC_AGE_FILE'] !== undefined) {
    throw new Error('key: NSEC_AGE_FILE is not supported by the pilot CLI — use NSEC or NSEC_FILE')
  }
  throw new Error('key: set NSEC / NSEC_FILE, or pass --nsec <ENV_VAR|hex|nsec1…>')
}

function makeSigner(material: string): Signer {
  const secretKey = toSecretKey(material)
  const pubkey = getPublicKey(secretKey)
  return { pubkey, sign: (template: EventTemplate) => finalizeEvent(template, secretKey) }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Import a sibling unit lazily. The specifier is a runtime variable on purpose: this file must
 * type-check before the other units land. Both the `.js` convention and extensionless fallback are
 * tried.
 */
async function importModule(preferred: string, fallback: string, label: string): Promise<unknown> {
  try {
    return await import(preferred)
  } catch (first) {
    try {
      return await import(fallback)
    } catch {
      throw new Error(
        `cannot load ${label} (${preferred}): ${errorMessage(first)} — is the unit built yet?`,
      )
    }
  }
}

function readNdjson(path: string): SignedEvent[] {
  const events: SignedEvent[] = []
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed) as SignedEvent)
    } catch (err) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${errorMessage(err)}`)
    }
  }
  return events
}

/** Corpus name from an NDJSON filename: `artifacts/jcalgtest.ndjson` → `jcalgtest`. */
function corpusOf(ndjsonPath: string): string {
  const base = ndjsonPath.replace(/\\/g, '/').split('/').pop() ?? ndjsonPath
  return base.replace(/\.ndjson$/i, '')
}

async function runBuildJcalgtest(flags: Map<string, string>): Promise<number> {
  const repoDir = flags.get('repo') ?? 'C:/tmp/jcres'
  const groundTruthDir = flags.get('ground-truth') ?? 'docs/mirroring/ground-truth'
  const artifactsDir = flags.get('artifacts') ?? 'artifacts'
  const signer = makeSigner(resolveKeyMaterial(flags.get('nsec')))

  const loader = (await importModule(
    './loaders/jcalgtest.js',
    './loaders/jcalgtest',
    'loaders/jcalgtest',
  )) as LoaderModule
  const emitter = (await importModule('./emit/index.js', './emit/index', 'emit')) as EmitModule
  if (typeof loader.loadJcalgtest !== 'function')
    throw new Error('loaders/jcalgtest: missing loadJcalgtest()')
  if (
    typeof emitter.emitSourceBundle !== 'function' ||
    typeof emitter.writeArtifacts !== 'function'
  ) {
    throw new Error('emit: missing emitSourceBundle()/writeArtifacts()')
  }

  const bundle = loader.loadJcalgtest({ repoDir, groundTruthDir })
  const result = emitter.emitSourceBundle(bundle, { signer })
  const { ndjsonPath, manifestPath } = emitter.writeArtifacts(result, {
    corpus: 'jcalgtest',
    outDir: artifactsDir,
  })
  console.log(
    `build:jcalgtest: ${result.events.length} events (products=${result.manifest.counts.products} ` +
      `metadata=${result.manifest.counts.metadata} bindings=${result.manifest.counts.bindings}) ` +
      `signer=${signer.pubkey.slice(0, 8)}…`,
  )
  console.log(`  ndjson:   ${ndjsonPath}`)
  console.log(`  manifest: ${manifestPath}`)
  return 0
}

async function runBuildSeccerts(flags: Map<string, string>): Promise<number> {
  const dataDir = flags.get('data') ?? 'C:/tmp'
  const groundTruthDir = flags.get('ground-truth') ?? 'docs/mirroring/ground-truth'
  const artifactsDir = flags.get('artifacts') ?? 'artifacts'
  const ledgerPath = flags.get('ledger') ?? 'artifacts/mirror.sqlite'
  const signer = makeSigner(resolveKeyMaterial(flags.get('nsec')))

  const loader = (await importModule(
    './loaders/seccerts.js',
    './loaders/seccerts',
    'loaders/seccerts',
  )) as {
    loadSeccerts(opts: { dataDir: string; groundTruthDir: string }): unknown
  }
  const emitter = (await importModule('./emit/seccerts.js', './emit/seccerts', 'emit/seccerts')) as {
    emitSeccertsBundle(
      bundle: unknown,
      opts: { signer: Signer; ledgerPath: string; leg1NdjsonPath?: string },
    ): Promise<{ events: SignedEvent[]; manifest: Manifest }>
    writeArtifacts: EmitModule['writeArtifacts']
  }
  if (typeof loader.loadSeccerts !== 'function')
    throw new Error('loaders/seccerts: missing loadSeccerts()')
  if (typeof emitter.emitSeccertsBundle !== 'function')
    throw new Error('emit/seccerts: missing emitSeccertsBundle()')

  // writeArtifacts uses the shared `manifest.json` basename — preserve whatever stood there
  // (leg 1's jcalgtest manifest) and emit the seccerts one under its own name.
  const sharedManifestPath = join(artifactsDir, 'manifest.json')
  let priorManifest: string | null = null
  try {
    priorManifest = readFileSync(sharedManifestPath, 'utf8')
  } catch {
    priorManifest = null
  }

  const bundle = loader.loadSeccerts({ dataDir, groundTruthDir })
  const result = (await emitter.emitSeccertsBundle(bundle, {
    signer,
    ledgerPath,
    leg1NdjsonPath: flags.get('leg1') ?? 'artifacts/jcalgtest.ndjson',
  })) as {
    events: SignedEvent[]
    manifest: Manifest
    warnings: string[]
  }
  const { ndjsonPath } = emitter.writeArtifacts(result, {
    corpus: 'seccerts',
    outDir: artifactsDir,
  })
  if (priorManifest !== null) writeFileSync(sharedManifestPath, priorManifest, 'utf8')
  const seccertsManifest = join(artifactsDir, 'seccerts.manifest.json')
  writeFileSync(seccertsManifest, `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8')
  console.log(
    `build:seccerts: ${result.events.length} delta events (products=${result.manifest.counts.products} ` +
      `metadata=${result.manifest.counts.metadata} bindings=${result.manifest.counts.bindings} ` +
      `other=${result.manifest.counts.other}) signer=${signer.pubkey.slice(0, 8)}…`,
  )
  console.log(`  ndjson:   ${ndjsonPath}`)
  console.log(`  manifest: ${seccertsManifest}`)
  return 0
}

/**
 * `repin:jcalgtest` — B3 fix: re-pin the leg-1 run-Metadata imeta pins to the bytes the pinned
 * URLs serve today (CRLF working-tree defect), C4-style: supersede + re-point + kind-5. Writes
 * the signed delta NDJSON + summary; the input file is never touched. Exits 1 when any pinned
 * URL could not be fetched — the leg is all-or-nothing.
 */
async function runRepinJcalgtest(flags: Map<string, string>): Promise<number> {
  const inPath = flags.get('in') ?? 'artifacts/jcalgtest.ndjson'
  const outPath = flags.get('out') ?? 'artifacts/jcalgtest-repin.ndjson'
  const summaryPath = flags.get('summary') ?? 'artifacts/jcalgtest-repin.summary.json'
  const signer = makeSigner(resolveKeyMaterial(flags.get('nsec')))

  const mod = (await importModule(
    './emit/jcalgtest-repin.js',
    './emit/jcalgtest-repin',
    'emit/jcalgtest-repin',
  )) as RepinModule
  if (typeof mod.runRepinLeg !== 'function')
    throw new Error('emit/jcalgtest-repin: missing runRepinLeg()')

  const result = await mod.runRepinLeg({
    inputPath: inPath,
    outputPath: outPath,
    summaryPath,
    signer,
  })
  const s = result.summary
  console.log(
    `repin:jcalgtest: scanned=${s.scanned} candidates=${s.candidates} unchanged=${s.unchanged} ` +
      `repinnedMetadata=${s.repinnedMetadata} repinnedBindings=${s.repinnedBindings} ` +
      `kind5s=${s.kind5s} fetchFailures=${s.fetchFailures.length} ` +
      `signer=${signer.pubkey.slice(0, 8)}…`,
  )
  console.log(`  ndjson:  ${result.ndjsonPath}`)
  console.log(`  summary: ${result.summaryPath}`)
  for (const failure of s.fetchFailures.slice(0, 20)) {
    console.log(`  fetchFailure ${failure.event.slice(0, 12)}…: ${failure.url}: ${failure.error}`)
  }
  return s.fetchFailures.length === 0 ? 0 : 1
}

/**
 * `verify:imeta` — the public integrity check: for every kind-1 event with imeta rows (any
 * corpus), re-fetch each pinned URL and recompute sha256 + size. Fail-closed: exits 1 on any
 * mismatch or fetch error (unverifiable ≠ verified).
 */
async function runVerifyImeta(flags: Map<string, string>): Promise<number> {
  const inPath = flags.get('in') ?? 'artifacts/jcalgtest.ndjson'
  const sample = intFlag(flags, 'sample') ?? 0
  const relayHost = flags.get('relay-host') ?? 'none'
  if (relayHost !== 'none') {
    throw new Error(
      `verify:imeta: --relay-host '${relayHost}' is not supported — dump the relay's events ` +
        'to an NDJSON file and verify that via --in',
    )
  }

  const mod = (await importModule(
    './emit/jcalgtest-repin.js',
    './emit/jcalgtest-repin',
    'emit/jcalgtest-repin',
  )) as RepinModule
  if (typeof mod.verifyImetaNdjson !== 'function')
    throw new Error('emit/jcalgtest-repin: missing verifyImetaNdjson()')

  const report = await mod.verifyImetaNdjson({ ndjsonPath: inPath, sample })
  const outPath = flags.get('out') ?? join(dirname(inPath), `${corpusOf(inPath)}.imeta-report.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const { match, mismatch, 'fetch-error': fetchError } = report.counts
  console.log(
    `verify:imeta: ${report.ok ? 'OK' : 'FAIL'} — events=${report.imetaEvents} ` +
      `verified=${report.verifiedEvents} match=${match} mismatch=${mismatch} ` +
      `fetchError=${fetchError}`,
  )
  let printed = 0
  for (const row of report.rows) {
    if (row.status === 'match' || printed >= 20) continue
    printed += 1
    console.log(`  ${row.status} ${row.event.slice(0, 12)}… ${row.url ?? '(no url)'}`)
    console.log(
      row.error === null
        ? `    expected ${row.expectedSha256 ?? '(none)'} got ${row.actualSha256 ?? '(none)'}`
        : `    ${row.error}`,
    )
  }
  console.log(`  report: ${outPath}`)
  return report.ok ? 0 : 1
}

async function runGate(flags: Map<string, string>): Promise<number> {
  const inPath = flags.get('in') ?? 'artifacts/jcalgtest.ndjson'
  const gate = (await importModule('./gate/index.js', './gate/index', 'gate')) as GateModule
  if (typeof gate.gateBatch !== 'function') throw new Error('gate: missing gateBatch()')
  const result = await gate.gateBatch(inPath)
  console.log(
    `gate: ${result.ok ? 'OK' : 'FAIL'} — events=${result.report.eventCount} ` +
      `errors=${result.report.errors.length} lostFacts=${result.report.lostFacts.length}`,
  )
  for (const err of result.report.errors.slice(0, 20)) {
    console.log(`  error ${err.code} ${err.event ?? '-'}: ${err.detail}`)
  }
  for (const lost of result.report.lostFacts.slice(0, 20)) {
    console.log(`  lostFact ${lost.event}: ${lost.fact}`)
  }
  console.log(`  report: ${result.outPath}`)
  return result.exitCode
}

async function runProbe(flags: Map<string, string>): Promise<number> {
  const relay = requiredFlag(flags, 'relay')
  const keyFlag = flags.get('key')
  const keyMaterial = keyFlag === undefined ? undefined : resolveKeyMaterial(keyFlag)
  const result = await relayProbe(
    keyMaterial === undefined ? { relay } : { relay, keyHex: keyMaterial },
  )
  const outPath = writeProbeResult(result, flags.get('artifacts') ?? 'artifacts')
  console.log(`probe: ${result.verdict}`)
  console.log(`  relay: ${relay}`)
  console.log(`  report: ${outPath}`)

  const ledgerPath = flags.get('ledger') ?? 'artifacts/mirror.sqlite'
  const ledger = openLedger(ledgerPath)
  try {
    ledger.setRelayCapability(relay, result.verdict)
  } finally {
    ledger.close()
  }
  return result.connected ? 0 : 1
}

async function runPublish(flags: Map<string, string>): Promise<number> {
  const relay = requiredFlag(flags, 'relay')
  const inPath = flags.get('in') ?? 'artifacts/jcalgtest.ndjson'
  const ledgerPath = flags.get('ledger') ?? 'artifacts/mirror.sqlite'
  const events = readNdjson(inPath)
  const keyMaterial = resolveKeyMaterial(flags.get('nsec') ?? flags.get('key'))

  const options: Parameters<typeof publishBatch>[1] = {
    relay,
    keyHex: keyMaterial,
    ledgerPath,
    log: (line: string) => process.stdout.write(`${line}\n`),
  }
  const authRelayUrl = flags.get('auth-relay-url')
  if (authRelayUrl !== undefined) options.authRelayUrl = authRelayUrl
  const pace = intFlag(flags, 'pace')
  if (pace !== undefined) options.paceMs = pace
  const limit = intFlag(flags, 'limit')
  if (limit !== undefined) options.limit = limit
  const workers = intFlag(flags, 'workers')
  if (workers !== undefined) options.workers = workers
  if (flags.has('resend-rejected')) options.skipTerminalRejected = false

  const summary = await publishBatch(events, options)
  const logPath = join(dirname(inPath), `${corpusOf(inPath)}.publish-log.json`)
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(
    logPath,
    `${JSON.stringify({ ...summary, producedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  console.log(
    `publish: total=${summary.total} accepted=${summary.accepted} skipped=${summary.skipped} ` +
      `rejected=${summary.rejected} → ${logPath}`,
  )
  for (const row of summary.results) {
    if (!row.ok) console.log(`  rejected ${row.id.slice(0, 12)}…: ${row.msg || '(no message)'}`)
  }
  return summary.rejected === 0 ? 0 : 1
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const command = positional[0]
  switch (command) {
    case 'build:jcalgtest':
      return runBuildJcalgtest(flags)
    case 'build:seccerts':
      return runBuildSeccerts(flags)
    case 'repin:jcalgtest':
      return runRepinJcalgtest(flags)
    case 'verify:imeta':
      return runVerifyImeta(flags)
    case 'gate':
      return runGate(flags)
    case 'probe':
      return runProbe(flags)
    case 'publish':
      return runPublish(flags)
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE)
      return command === undefined ? 1 : 0
    default:
      console.error(`unknown command '${command}'\n${USAGE}`)
      return 1
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${errorMessage(err)}`)
      process.exit(1)
    })
}
