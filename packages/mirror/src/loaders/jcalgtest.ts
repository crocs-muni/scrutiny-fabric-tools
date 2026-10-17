import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../hashing'
/**
 * JCAlgTest loader — walks a local clone of `crocs-muni/jcalgtest_results` and
 * produces the `SourceBundle` defined in `../types.ts`.
 *
 * Contracts honored here (design.md §2.5/§3/§4.3/§9 Q10, mirror README):
 *   - one RunRecord per CSV under `javacard/Profiles/**` (275 files today),
 *   - card identity = `jcard:cNNN` from the frozen table (matched by the table's
 *     reconciled file path, then ATR + name compatibility, then unique name) else the
 *     run's (name, ATR) pair,
 *   - `jcver` only from an exact declared `JavaCard support version;` value,
 *   - DATAFIXED/DATADEPEND `selected` scalars from the frozen metric registry
 *     (`ground-truth/metric-canonicalization.json`), `avg op` taken verbatim —
 *     the client already baseline-subtracts (data trap "baseline-already-subtracted"),
 *   - leaderboard for `sign_ecdsa_p256_sha1_ms` over cards with a declared jcver ≤ 3.0.5,
 *   - cross-links: the rank-1 HIGH-confidence candidate per card profile.
 *
 * Assumptions recorded in `loaders/SELFTEST.md` (malformed-file handling, ALGSUPPORT
 * `selected` key table, DATADEPEND length preference, exclusion counting).
 */
import type {
  CardIdentity,
  CrosslinkRecord,
  LeaderboardRecord,
  RunKind,
  RunRecord,
  SnapshotRecord,
  SourceBundle,
} from '../types'
import {
  type CrosslinkCandidate,
  type CrosslinkCardProfile,
  type GroundTruth,
  type JcardRow,
  type MetricCanonicalKey,
  loadGroundTruth,
} from './groundTruth'

const UPSTREAM_SOURCE = 'https://github.com/crocs-muni/jcalgtest_results'
const RAW_ROOT = 'https://raw.githubusercontent.com/crocs-muni/jcalgtest_results'
const CPL_CPLC_DIR = 'javacard/Profiles'

/** Card-side vendorRaw is derived from the CPLC fabricator only (ticket closed list). */
const FAB_VENDOR: Record<string, string> = {
  '4790': 'NXP Semiconductors',
  '4090': 'Infineon Technologies AG',
}

const LEADERBOARD_METRIC = 'sign_ecdsa_p256_sha1_ms'
const LEADERBOARD_COHORT = 'jcver-lte:3.0.5'
const COHORT_MAX: readonly [number, number, number] = [3, 0, 5]
const LEADERBOARD_MAX_MEMBERS = 62

/**
 * ALGSUPPORT `selected` scalars (design §4.3.6; values are seconds as printed by the
 * client). This is a mirror convention, not a ground-truth registry — the DATAFIXED/
 * DATADEPEND keys come from `metric-canonicalization.json` instead.
 */
const ALGSUPPORT_SELECTED: ReadonlyArray<{ key: string; section: string; name: string }> = [
  { key: 'ecdsa_sha256_sign_s', section: 'javacard.crypto.Signature', name: 'ALG_ECDSA_SHA_256' },
  { key: 'ecdsa_sha_sign_s', section: 'javacard.crypto.Signature', name: 'ALG_ECDSA_SHA' },
  {
    key: 'rsa2048_crt_keygen_s',
    section: 'javacard.security.KeyPair ALG_RSA_CRT on-card generation',
    name: 'ALG_RSA_CRT LENGTH_RSA_2048',
  },
  {
    key: 'ecfp256_keygen_s',
    section: 'javacard.security.KeyPair ALG_EC_FP on-card generation',
    name: 'ALG_EC_FP LENGTH_EC_FP_256',
  },
  { key: 'sha256_digest_s', section: 'javacard.security.MessageDigest', name: 'ALG_SHA_256' },
  { key: 'sha1_digest_s', section: 'javacard.security.MessageDigest', name: 'ALG_SHA' },
  { key: 'prng_generate_s', section: 'javacard.security.RandomData', name: 'ALG_PSEUDO_RANDOM' },
]

/** `alg` family slugs evidence in a JCAlgTest operation name (design §3.4, ticket mapping). */
function familyForOperation(name: string): string | null {
  const n = name.toUpperCase()
  if (n.includes('SHA3')) return 'sha-3'
  if (n.includes('HMAC')) return 'hmac'
  if (n.includes('AES')) return 'aes'
  if (n.includes('3DES') || n.includes('TDEA') || n.includes('DES')) return '3des'
  if (n.includes('RSA')) return 'rsa'
  if (n.includes('ECDSA')) return 'ecdsa'
  if (n.includes('SVDP') || n.includes('PACE') || n.includes('DH_PLAIN') || n.includes('ECDH'))
    return 'ecdh'
  if (n.includes('SHA')) return 'sha-2'
  return null
}

interface AlgRow {
  name: string
  answer: 'yes' | 'no' | 'error'
  /** Printed time (seconds) when present; the comma dialect puts it at index 4. */
  time: number | null
  section: string | null
}

interface PerfBlock {
  rawName: string
  /** Name with the DATADEPEND `;<len>;` suffix stripped and separators collapsed. */
  normalizedName: string
  avgOp: number | null
  errorToken: string | null
  dataLength: number | null
}

interface ParsedRun {
  record: RunRecord
  /** Identity key parts, resolved later against the frozen table. */
  atr: string | null
  name: string
  jcver: string | null
  /** CPLC block (lowercase, no separators) when the run carries one. */
  cplc: { fab: string; ictype: string; osid: string | null } | null
  date: string | null
  familyEvidence: string[]
  /** DATAFIXED metric values for the leaderboard (key `sign_ecdsa_p256_sha1_ms`). */
  leaderboardValue: number | null | undefined
}

// ---------------------------------------------------------------------------
// small parsing utilities
// ---------------------------------------------------------------------------

function readBytes(path: string): Buffer {
  return readFileSync(path)
}

function tryReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** `{repo}/.git` resolution without shelling out to git; null when unavailable. */
function gitRevision(repoDir: string): string | null {
  const gitDir = join(repoDir, '.git')
  const head = tryReadText(join(gitDir, 'HEAD'))?.trim()
  if (head === undefined || head === null || head === '') return null
  if (/^[0-9a-f]{40}$/u.test(head)) return head
  const ref = /^ref:\s*(.+)$/u.exec(head)?.[1]?.trim()
  if (ref === undefined) return null
  const direct = tryReadText(join(gitDir, ref))?.trim()
  if (direct !== undefined && direct !== null && /^[0-9a-f]{40}$/u.test(direct)) return direct
  const packed = tryReadText(join(gitDir, 'packed-refs'))
  if (packed !== null) {
    for (const line of packed.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const [sha, name] = trimmed.split(/\s+/u)
      if (name === ref && sha !== undefined && /^[0-9a-f]{40}$/u.test(sha)) return sha
    }
  }
  return null
}

/** Parse a printed number, tolerating comma decimals (`0,105000`) and blanks. */
function parsePrintedNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const v = raw.trim().replace(',', '.')
  if (v === '' || !/^-?\d+(?:\.\d+)?$/u.test(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** First value of a header key (`key; value`, `key: value`, `key, value`, `key=value`). */
function headerValue(lines: readonly string[], ...keys: string[]): string | null {
  for (const line of lines) {
    const s = line.trim()
    if (s === '') continue
    for (const key of keys) {
      const pattern = new RegExp(
        `^${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*[;:,=]\\s*(.*)$`,
        'u',
      )
      const m = pattern.exec(s)
      if (m === null) continue
      const value = (m[1] ?? '')
        .trim()
        .replace(/[;,]+$/u, '')
        .trim()
      if (value !== '') return value
    }
  }
  return null
}

/** Header ATR line value → lowercase hex; null for placeholders (`3b xx …`) and junk. */
function normalizeAtr(raw: string | null): string | null {
  if (raw === null) return null
  let hex = raw.toLowerCase().replace(/[^0-9a-fx]/gu, '')
  if (hex === '' || hex.includes('x')) return null
  // Defensive: a duplicated header value (`...90 00 3b 68 ...`) is halved once.
  if (hex.length % 4 === 0 && hex.slice(0, hex.length / 2) === hex.slice(hex.length / 2)) {
    hex = hex.slice(0, hex.length / 2)
  }
  if (hex.length < 6 || hex.length % 2 !== 0) return null
  return hex
}

/**
 * Filename-embedded ATR: the LAST `3b`/`3f`-anchored byte run (separators optional,
 * case-insensitive — the corpus mixes `3b_fa_18_…`, `3B D5 18 …`, `3BFC18…`).
 */
function atrFromFilename(repoRelPath: string): string | null {
  const base = (repoRelPath.split('/').pop() ?? repoRelPath).replace(/\.csv/giu, '_')
  const stripped = base.replace(/[ _]*\((?:provided|provide)[ _]by[^)]*\)/giu, '')
  const matches = stripped.match(/(?:3b|3f)(?:[ _]?[0-9a-fA-F]{2})+/giu)
  if (matches === null || matches.length === 0) return null
  const hex = (matches[matches.length - 1] ?? '').toLowerCase().replace(/[^0-9a-f]/gu, '')
  if (hex.length < 6 || hex.length % 2 !== 0) return null
  return hex
}

/** Filename-derived card label, used when the run has no `Card name;` line. */
function cardNameFromFilename(repoRelPath: string): string {
  const base = (repoRelPath.split('/').pop() ?? repoRelPath)
    .replace(/\.csv$/iu, '')
    .replace(/[ _]*\((?:provided|provide)[ _]by[^)]*\)/giu, '')
  const head = base.split(/__?/u)[0] ?? base
  return head.trim().replace(/_/gu, ' ') || base.trim()
}

/** `(provided_by_X)` / `(provided by X)` / `(provide_by_X)` filename contributor. */
function contributorFromFilename(repoRelPath: string): string | null {
  const m = /\((?:provided|provide)[ _]by[ _]([^)]+)\)/iu.exec(repoRelPath)
  if (m === null) return null
  const value = (m[1] ?? '').trim().replace(/_/gu, ' ').replace(/\s+/gu, ' ').trim()
  return value === '' ? null : value
}

/** Lowercase alphanumeric token list, used for name compatibility scoring. */
function tokens(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return []
  return value.toLowerCase().match(/[a-z0-9]+/gu) ?? []
}

/** 3 exact / 2 contiguous sublist / 1 token-subset / 0 incompatible. */
function nameScore(runName: string | null, tableName: string | null): number {
  const a = tokens(runName)
  const b = tokens(tableName)
  if (a.length === 0 || b.length === 0) return 0
  if (a.join(' ') === b.join(' ')) return 3
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  for (let i = 0; i + short.length <= long.length; i += 1) {
    if (long.slice(i, i + short.length).join(' ') === short.join(' ')) return 2
  }
  const longSet = new Set(long)
  if (short.every((t) => longSet.has(t))) return 1
  return 0
}

/** Path normalization for the table's reconciled-file leg (case/separator agnostic). */
function normalizedBasename(path: string): string {
  return (path.split('/').pop() ?? path)
    .replace(/[ _]*\((?:provided|provide)[ _]by[^)]*\)/giu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '')
}

/** `2019/09/18 12:42:44` (or date-only) → ISO `2019-09-18`; null when malformed. */
function isoDate(raw: string | null): string | null {
  if (raw === null) return null
  const m = /^(\d{4})\/(\d{2})\/(\d{2})/u.exec(raw.trim())
  if (m === null) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** `…_1615380872493__…` (13-digit epoch ms) → number; null when absent. */
function epochFromFilename(repoRelPath: string): number | null {
  const m = /_(\d{13})(?:_|\.|$)/u.exec(repoRelPath.split('/').pop() ?? '')
  if (m === null) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

function jcverTuple(version: string | null): [number, number, number] | null {
  if (version === null) return null
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(version)
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')]
}

function compareTuple(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function runKindOf(repoRelPath: string): RunKind {
  if (repoRelPath.startsWith('javacard/Profiles/performance/fixed/')) return 'DATAFIXED'
  if (repoRelPath.startsWith('javacard/Profiles/performance/variable/')) return 'DATADEPEND'
  if (repoRelPath.startsWith('javacard/Profiles/aid/')) return 'AIDSUPPORT'
  return 'ALGSUPPORT'
}

/** All run CSVs under `javacard/Profiles/**`, repo-relative POSIX paths, sorted. */
function listRunFiles(repoDir: string): string[] {
  const root = join(repoDir, CPL_CPLC_DIR)
  const out: string[] = []
  const walk = (rel: string): void => {
    const abs = join(root, rel)
    const entries = readdirSync(abs, { withFileTypes: true })
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
        out.push(`${CPL_CPLC_DIR}/${child}`)
    }
  }
  walk('')
  return out.sort()
}

// ---------------------------------------------------------------------------
// ALGSUPPORT parsing
// ---------------------------------------------------------------------------

function splitSemi(line: string): string[] {
  return line.split(';').map((f) => f.trim())
}

function splitComma(line: string): string[] {
  return line.split(',').map((f) => f.trim())
}

function answerOf(fields: readonly string[]): 'yes' | 'no' | 'error' | null {
  const v = (fields[1] ?? '').toLowerCase()
  return v === 'yes' || v === 'no' || v === 'error' ? v : null
}

/** Time column: `;`-dialect index 2, comma-dialect index 4 (indices 2/3 are blank). */
function rowTime(fields: readonly string[]): number | null {
  for (const idx of [2, 4, 3]) {
    const n = parsePrintedNumber(fields[idx])
    if (n !== null) return n
  }
  return null
}

/**
 * Parse the ALGSUPPORT body: section headers are bare `javacard…`/`javacardx…` class
 * lines (optionally `;supported`, and regex-escaped dots); rows are
 * `<name>;yes|no|error[;time…]` (semicolon dialect) or
 * `<name>,yes,,,<time>,<mem>,<mem>,<mem>` (comma dialect, 2025 runs).
 * Header-region lines (`High-power …; no`, `JCSystem…`) never count as rows.
 */
function parseAlgSupport(lines: readonly string[]): { rows: AlgRow[]; sections: string[] } {
  const rows: AlgRow[] = []
  const sections: string[] = []
  let section: string | null = null
  let inBody = false
  for (const line of lines) {
    const s = line.trim()
    if (s === '') continue
    if (/^javacardx?[.\\]/iu.test(s)) {
      const cleaned = (splitSemi(s)[0] ?? s).replace(/\\\./gu, '.').trim()
      if (cleaned !== '') {
        section = cleaned
        sections.push(cleaned)
        inBody = true
      }
      continue
    }
    if (!inBody) continue
    let fields = splitSemi(s)
    let answer = answerOf(fields)
    if (answer === null) {
      fields = splitComma(s)
      answer = answerOf(fields)
    }
    if (answer === null) continue
    const name = (fields[0] ?? '').trim()
    if (name === '') continue
    rows.push({ name, answer, time: rowTime(fields), section })
  }
  return { rows, sections }
}

// ---------------------------------------------------------------------------
// DATAFIXED / DATADEPEND parsing
// ---------------------------------------------------------------------------

function normalizeMethodName(raw: string): string {
  const noSuffix = raw.replace(/;.*$/u, '').trim()
  return noSuffix.replace(/[_\s]+/gu, ' ')
}

/**
 * Block grammar (metric-canonicalization §block_structure): `method name:; <name>`
 * followed by config/baseline/raw/stats/info lines, or by a single error token line.
 */
function parsePerfBlocks(lines: readonly string[]): PerfBlock[] {
  const blocks: PerfBlock[] = []
  let current: PerfBlock | null = null
  let stage: 'name' | 'config' | 'body' | 'error' = 'name'
  const flush = (): void => {
    if (current !== null) blocks.push(current)
    current = null
  }
  for (const line of lines) {
    const s = line.trim()
    if (s === '') continue
    if (s.startsWith('method name')) {
      flush()
      const raw = s.replace(/^method name\s*[:;,]+\s*/u, '').trim()
      current = {
        rawName: raw,
        normalizedName: normalizeMethodName(raw),
        avgOp: null,
        errorToken: null,
        dataLength: null,
      }
      stage = 'name'
      continue
    }
    if (current === null) continue
    if (s.startsWith('operation stats')) {
      const m = /avg op:;\s*([^;]+)/u.exec(s)
      const value = parsePrintedNumber(m?.[1])
      if (value !== null) current.avgOp = value
      stage = 'body'
      continue
    }
    if (s.startsWith('operation info')) {
      const m = /data length;\s*(\d+)/u.exec(s)
      if (m !== null) current.dataLength = Number(m[1])
      stage = 'body'
      continue
    }
    if (
      s.startsWith('measurement config') ||
      s.startsWith('baseline ') ||
      s.startsWith('operation raw')
    ) {
      if (stage === 'name' || stage === 'config') stage = 'config'
      continue
    }
    // Non-field line: an error token right after the name/config, else a section header.
    if (
      (stage === 'name' || stage === 'config') &&
      current.errorToken === null &&
      current.avgOp === null
    ) {
      current.errorToken = s
      stage = 'error'
      continue
    }
    flush()
    stage = 'name'
  }
  flush()
  return blocks
}

// ---------------------------------------------------------------------------
// AIDSUPPORT parsing
// ---------------------------------------------------------------------------

function parseAidSupport(lines: readonly string[]): { packageCount: number; highlights: string[] } {
  const highlights: string[] = []
  const scanTool = headerValue(lines, 'jcAIDScan version')
  if (scanTool !== null) highlights.push(`scan tool jcAIDScan ${scanTool}`)
  const aids = new Set<string>()
  const packageVersions = new Map<string, string>()
  let rows = 0
  let inTable = false
  for (const line of lines) {
    const s = line.trim()
    if (s === '') continue
    if (/^PACKAGE AID\s*[;:,]/iu.test(s)) {
      inTable = true
      continue
    }
    if (!inTable) continue
    const fields = splitSemi(s)
    const aid = (fields[0] ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{4,}$/u.test(aid)) continue
    aids.add(aid)
    rows += 1
    const name = (fields[3] ?? '').trim()
    const api = (fields[4] ?? '').trim()
    if (name !== '' && api !== '') {
      const prev = packageVersions.get(name)
      if (prev === undefined || api.localeCompare(prev, undefined, { numeric: true }) > 0) {
        packageVersions.set(name, api)
      }
    }
  }
  highlights.push(`${aids.size} package AIDs, ${rows} AID/version rows`)
  const framework = packageVersions.get('javacard.framework')
  if (framework !== undefined && framework !== '')
    highlights.push(`javacard.framework supported up to ${framework}`)
  if (packageVersions.has('org.globalplatform'))
    highlights.push('GlobalPlatform package registry present')
  return { packageCount: aids.size, highlights }
}

// ---------------------------------------------------------------------------
// per-file run parse
// ---------------------------------------------------------------------------

interface MetricLookup {
  /** DATAFIXED: registry key → normalized printed method name. */
  fixed: Map<string, string>
  /** DATADEPEND: normalized registry name → registry key. */
  depend: Map<string, string>
}

function buildMetricLookup(keys: readonly MetricCanonicalKey[]): MetricLookup {
  const fixed = new Map<string, string>()
  const depend = new Map<string, string>()
  for (const key of keys) {
    const fixedName = key.source.DATAFIXED?.distinct_name
    if (typeof fixedName === 'string' && fixedName !== '')
      fixed.set(key.key, normalizeMethodName(fixedName))
    const dependName = key.source.DATADEPEND?.normalized_name
    if (typeof dependName === 'string' && dependName !== '')
      depend.set(normalizeMethodName(dependName), key.key)
    for (const raw of key.source.DATADEPEND?.raw_forms ?? []) {
      const normalized = normalizeMethodName(raw)
      if (normalized !== '') depend.set(normalized, key.key)
    }
  }
  return { fixed, depend }
}

/** `selected` scalars for a perf run from the frozen metric registry. */
function selectPerfMetrics(
  blocks: readonly PerfBlock[],
  lookup: MetricLookup,
  kind: RunKind,
): Record<string, number | null> {
  const selected: Record<string, number | null> = {}
  if (kind === 'DATAFIXED') {
    const byName = new Map<string, PerfBlock>()
    for (const block of blocks)
      if (!byName.has(block.normalizedName)) byName.set(block.normalizedName, block)
    for (const [key, normalizedName] of lookup.fixed) {
      const block = byName.get(normalizedName)
      if (block !== undefined) selected[key] = block.avgOp
    }
  } else if (kind === 'DATADEPEND') {
    const byName = new Map<string, PerfBlock[]>()
    for (const block of blocks) {
      const list = byName.get(block.normalizedName)
      if (list === undefined) byName.set(block.normalizedName, [block])
      else list.push(block)
    }
    for (const [normalized, key] of lookup.depend) {
      const list = byName.get(normalized)
      if (list === undefined || list.length === 0) continue
      // Keys are defined on 256-byte input; the variable corpus repeats per data length.
      const preferred =
        list.find((b) => b.dataLength === 256) ?? list.find((b) => b.dataLength !== null) ?? list[0]
      if (preferred !== undefined) selected[key] = preferred.avgOp
    }
  }
  return selected
}

function perfHighlights(blocks: readonly PerfBlock[], kind: RunKind): string[] {
  const measured = blocks.filter((b) => b.avgOp !== null).length
  const errors = blocks.length - measured
  const highlights: string[] = []
  if (blocks.length > 0)
    highlights.push(
      `${measured} of ${blocks.length} operation blocks measured; ${errors} error blocks`,
    )
  const ecBlocks = blocks.filter((b) => /Signature_ALG_ECDSA/iu.test(b.rawName))
  if (ecBlocks.length > 0 && ecBlocks.every((b) => b.avgOp === null)) {
    const token = ecBlocks.find((b) => b.errorToken !== null)?.errorToken ?? 'error'
    highlights.push(`ECDSA unsupported in this run (all EC signature blocks returned ${token})`)
  }
  if (kind === 'DATADEPEND') {
    const lengths = [
      ...new Set(blocks.map((b) => b.dataLength).filter((n): n is number => n !== null)),
    ].sort((a, b) => a - b)
    if (lengths.length > 0)
      highlights.push(`data lengths ${lengths[0]}..${lengths[lengths.length - 1]} bytes`)
  }
  return highlights
}

function algSupportHighlights(
  rows: readonly AlgRow[],
  declared: string | null,
  jcsys: string | null,
): string[] {
  const highlights: string[] = []
  const errors = rows.filter((r) => r.answer === 'error').length
  if (errors > 0) highlights.push(`${errors} rows returned error tokens`)
  // Documented quirk (design §4.3.6): keybuilder type supported while cipher rows are not.
  const yes = new Set(rows.filter((r) => r.answer === 'yes').map((r) => r.name))
  const no = new Set(rows.filter((r) => r.answer === 'no').map((r) => r.name))
  const quirkLengths: string[] = []
  for (const length of ['192', '256']) {
    const keybuilder = `TYPE_AES LENGTH_AES_${length}`
    const cipherRows = [...no].filter((n) => n.startsWith(`ALG_AES_BLOCK_${length}_`))
    if (yes.has(keybuilder) && cipherRows.length > 0) quirkLengths.push(length)
  }
  if (quirkLengths.length > 0) {
    highlights.push(
      `AES-${quirkLengths.join('/')} cipher rows flagged not supported while AES-${quirkLengths.join('/')} keybuilder types are supported`,
    )
  }
  if (declared !== null && jcsys !== null) {
    const declaredMM = declared.split('.').slice(0, 2).join('.')
    if (declaredMM !== jcsys.trim()) {
      highlights.push(
        `declared JavaCard support version ${declared} but JCSystem.getVersion major.minor ${jcsys.trim()}`,
      )
    }
  }
  return highlights
}

// ---------------------------------------------------------------------------
// main loader
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// card identity resolution (against the frozen jcard table)
// ---------------------------------------------------------------------------

interface CardIndex {
  rows: JcardRow[]
  byAtr: Map<string, JcardRow[]>
  byPath: Map<string, JcardRow[]>
}

function buildCardIndex(gt: GroundTruth): CardIndex {
  const byAtr = new Map<string, JcardRow[]>()
  const byPath = new Map<string, JcardRow[]>()
  const add = (map: Map<string, JcardRow[]>, key: string, row: JcardRow): void => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [row])
    else if (!list.includes(row)) list.push(row)
  }
  for (const row of gt.jcardTable.cards) {
    const atr = row.atr_hex_lowercase_concat
    if (typeof atr === 'string' && atr !== '' && !atr.includes('x')) add(byAtr, atr, row)
    for (const rf of row.run_files ?? []) add(byPath, normalizedBasename(rf.path), row)
    if (typeof row.linked_file === 'string') add(byPath, normalizedBasename(row.linked_file), row)
  }
  return { rows: gt.jcardTable.cards, byAtr, byPath }
}

export type CardMatchLeg = 'path' | 'atr' | 'atr+name' | 'name' | 'unmatched'

/**
 * Resolve one run to a frozen table row.
 *
 * Order of evidence: the table's own reconciled file path (highest confidence — the
 * freeze checked every row against the clone), then ATR with name-compatibility
 * (a collided ATR must never merge two differently named products, e.g. the 4-byte
 * `3b119580` shared by Feitian H19CR and NXP SECID P60), then unique name match.
 * Duplicate table rows claiming the same card/file resolve to the lowest c-number.
 */
function matchCardRow(
  index: CardIndex,
  rel: string,
  atr: string | null,
  name: string | null,
): { row: JcardRow | null; leg: CardMatchLeg } {
  const pathHits = index.byPath.get(normalizedBasename(rel)) ?? []
  const onlySameName = (rows: JcardRow[]): JcardRow | null => {
    const names = new Set(rows.map((r) => tokens(r.name).join(' ')))
    if (names.size !== 1) return null
    return rows.reduce((min, r) => (r.cn < min.cn ? r : min))
  }
  if (pathHits.length === 1) return { row: pathHits[0] ?? null, leg: 'path' }
  if (pathHits.length > 1) {
    const row = onlySameName(pathHits)
    if (row !== null) return { row, leg: 'path' }
  }
  const atrCandidates = atr !== null ? (index.byAtr.get(atr) ?? []) : []
  if (atrCandidates.length > 0) {
    const scored = atrCandidates.map((row) => ({ row, score: nameScore(name, row.name) }))
    const best = Math.max(...scored.map((s) => s.score))
    if (best > 0) {
      const winners = scored.filter((s) => s.score === best).map((s) => s.row)
      if (winners.length === 1) return { row: winners[0] ?? null, leg: 'atr' }
      const row = onlySameName(winners)
      if (row !== null) return { row, leg: 'atr' }
    } else if (atrCandidates.length === 1 && tokens(name).length === 0) {
      return { row: atrCandidates[0] ?? null, leg: 'atr' }
    }
  } else if (tokens(name).length > 0) {
    // No ATR evidence at all: unique name match over the whole table.
    const scored = index.rows
      .map((row) => ({ row, score: nameScore(name, row.name) }))
      .filter((s) => s.score >= 2)
    if (scored.length > 0) {
      const best = Math.max(...scored.map((s) => s.score))
      const winners = scored.filter((s) => s.score === best).map((s) => s.row)
      if (winners.length === 1) return { row: winners[0] ?? null, leg: 'name' }
      const row = onlySameName(winners)
      if (row !== null) return { row, leg: 'name' }
    }
  }
  // A collided ATR with an incompatible name stays unmatched: never merge two
  // differently named products (e.g. Feitian H19CR vs NXP SECID P60, both `3b119580`).
  return { row: null, leg: 'unmatched' }
}

export interface LoadJcalgtestOptions {
  /** Local clone of `crocs-muni/jcalgtest_results` (default in cli.ts: `C:/tmp/jcres`). */
  repoDir: string
  /** `docs/mirroring/ground-truth` of the scrutiny-fabric repo. */
  groundTruthDir: string
}

export function loadJcalgtest(opts: LoadJcalgtestOptions): SourceBundle {
  const gt: GroundTruth = loadGroundTruth(opts.groundTruthDir)
  const metricLookup = buildMetricLookup(gt.metricRegistry.registry.canonical_keys)
  const files = listRunFiles(opts.repoDir)
  // Pin imeta upstream URLs to the local clone's revision: master drifts while our
  // `x` hashes are computed from local clone bytes; only a pinned URL can verify.
  const revision = gitRevision(opts.repoDir)
  const RAW_BASE = revision !== null ? `${RAW_ROOT}/${revision}` : `${RAW_ROOT}/master`

  const parsed: ParsedRun[] = []
  const fileHashes = new Map<string, string>()
  for (const rel of files) {
    const abs = join(opts.repoDir, rel)
    const bytes = readBytes(abs)
    const hash = sha256Hex(bytes)
    fileHashes.set(rel, hash)
    const lines = bytes
      .toString('utf8')
      .replace(/^\uFEFF/u, '')
      .split(/\r?\n/u)
    const kind = runKindOf(rel)

    const headerName = headerValue(lines, 'Card name')
    const name = headerName ?? cardNameFromFilename(rel)
    const atr = atrFromFilename(rel) ?? normalizeAtr(headerValue(lines, 'Card ATR', 'ATR'))
    const declaredRaw = headerValue(lines, 'JavaCard support version')
    const jcver = declaredRaw !== null && /^\d+(?:\.\d+)+$/u.test(declaredRaw) ? declaredRaw : null
    const dateRaw = headerValue(lines, 'Execution date/time')
    const date = isoDate(dateRaw)
    const jcsys = headerValue(lines, 'JCSystem.getVersion()[Major.Minor]')
    const clientVersion = headerValue(lines, 'AlgTestJClient version')
    const appletVersion = headerValue(lines, 'AlgTest applet version')
    const fileContributor = contributorFromFilename(rel)
    const headerContributor = headerValue(lines, 'Tested and provided by')
    const contributedBy =
      fileContributor ??
      (headerContributor !== null && !/insert your name|please/iu.test(headerContributor)
        ? headerContributor
        : null)
    const fab =
      headerValue(lines, 'CPLC.ICFabricator', 'ICFabricator')
        ?.toLowerCase()
        .replace(/[^0-9a-f]/gu, '') ?? null
    const ictype =
      headerValue(lines, 'CPLC.ICType', 'ICType')
        ?.toLowerCase()
        .replace(/[^0-9a-f]/gu, '') ?? null
    const osid =
      headerValue(lines, 'CPLC.OperatingSystemID', 'OperatingSystemID')
        ?.toLowerCase()
        .replace(/[^0-9a-f]/gu, '') ?? null
    const cplc =
      fab !== null && fab.length === 4 && ictype !== null && ictype.length === 4
        ? { fab, ictype, osid: osid !== null && osid.length === 4 ? osid : null }
        : null

    const selected: Record<string, number | null> = {}
    const highlights: string[] = []
    let families: string[] = []
    let measuredCount: number | undefined
    let supportedCount: number | undefined
    let unsupportedCount: number | undefined
    let lengths: number[] | undefined
    let packageCount: number | undefined
    let leaderboardValue: number | null | undefined

    if (kind === 'ALGSUPPORT') {
      const { rows } = parseAlgSupport(lines)
      measuredCount = rows.length
      supportedCount = rows.filter((r) => r.answer === 'yes').length
      unsupportedCount = rows.filter((r) => r.answer === 'no').length
      const yesRows = rows.filter((r) => r.answer === 'yes')
      for (const spec of ALGSUPPORT_SELECTED) {
        const row = yesRows.find(
          (r) => r.name === spec.name && (spec.section === '' || r.section === spec.section),
        )
        if (row !== undefined && row.time !== null) selected[spec.key] = row.time
      }
      const familySet = new Set<string>()
      for (const row of yesRows) {
        const family = familyForOperation(row.name)
        if (family !== null) familySet.add(family)
      }
      families = [...familySet].sort()
      highlights.push(...algSupportHighlights(rows, declaredRaw !== null ? jcver : null, jcsys))
    } else if (kind === 'DATAFIXED' || kind === 'DATADEPEND') {
      const blocks = parsePerfBlocks(lines)
      const perfSelected = selectPerfMetrics(blocks, metricLookup, kind)
      Object.assign(selected, perfSelected)
      const familySet = new Set<string>()
      for (const block of blocks) {
        if (block.avgOp === null) continue
        const family = familyForOperation(block.normalizedName)
        if (family !== null) familySet.add(family)
      }
      families = [...familySet].sort()
      highlights.push(...perfHighlights(blocks, kind))
      if (kind === 'DATADEPEND') {
        lengths = [
          ...new Set(blocks.map((b) => b.dataLength).filter((n): n is number => n !== null)),
        ].sort((a, b) => a - b)
      }
      if (kind === 'DATAFIXED') {
        leaderboardValue =
          LEADERBOARD_METRIC in perfSelected ? perfSelected[LEADERBOARD_METRIC] : undefined
      }
      measuredCount = blocks.filter((b) => b.avgOp !== null).length
      unsupportedCount = blocks.length - measuredCount
    } else {
      const aid = parseAidSupport(lines)
      packageCount = aid.packageCount
      highlights.push(...aid.highlights)
    }

    const record: RunRecord = {
      kind,
      file: rel,
      sha256: hash,
      upstreamUrl: `${RAW_BASE}/${rel
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/')}`,
      sizeBytes: bytes.length,
      atr,
      cardName: name,
      jcver,
      run: {
        date,
        epochMs: epochFromFilename(rel),
        clientVersion,
        appletVersion,
        contributedBy,
      },
      families,
      selected,
      highlights,
    }
    if (measuredCount !== undefined) record.measuredCount = measuredCount
    if (supportedCount !== undefined) record.supportedCount = supportedCount
    if (unsupportedCount !== undefined) record.unsupportedCount = unsupportedCount
    if (lengths !== undefined) record.lengths = lengths
    if (packageCount !== undefined) record.packageCount = packageCount

    parsed.push({
      record,
      atr,
      name,
      jcver,
      cplc,
      date,
      familyEvidence: families,
      leaderboardValue,
    })
  }

  // ---- card identity -----------------------------------------------------
  const cardIndex = buildCardIndex(gt)
  const matchCard = (rel: string, atr: string | null, name: string | null): JcardRow | null =>
    matchCardRow(cardIndex, rel, atr, name).row

  interface CardBucket {
    row: JcardRow | null
    name: string
    atr: string | null
    runs: ParsedRun[]
  }
  const buckets = new Map<string, CardBucket>()
  for (const run of parsed) {
    const row = matchCard(run.record.file, run.atr, run.name)
    const key = row !== null ? `j:${row.jcard}` : `u:${tokens(run.name).join(' ')}|${run.atr ?? ''}`
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { row, name: row !== null ? row.name : run.name, atr: run.atr, runs: [] }
      buckets.set(key, bucket)
    }
    bucket.runs.push(run)
  }

  const cards: CardIdentity[] = []
  const cardKeyOfRun = new Map<string, string>()
  for (const [key, bucket] of buckets) {
    const { row, runs } = bucket
    for (const run of runs) cardKeyOfRun.set(run.record.file, key)
    // Newest run (dated first) supplies the card-level view.
    const sorted = [...runs].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    const declaring = sorted.filter((r) => r.jcver !== null)
    let jcver: string | null = null
    if (declaring.length > 0) {
      const newestDate = declaring[0]?.date ?? null
      const atNewest = declaring.filter((r) => r.date === newestDate).map((r) => r.jcver)
      const distinct = [...new Set(atNewest)]
      jcver = distinct.length === 1 ? (distinct[0] ?? null) : null
      if (
        jcver === null &&
        newestDate === null &&
        new Set(declaring.map((r) => r.jcver)).size === 1
      ) {
        jcver = declaring[0]?.jcver ?? null
      }
    }
    const cplcRun = sorted.find((r) => r.cplc !== null) ?? null
    const cplcValue = cplcRun?.cplc ?? null
    const familiesSupported = [...new Set(runs.flatMap((r) => r.familyEvidence))].sort()
    cards.push({
      jcard: row !== null ? row.jcard : null,
      name: row !== null ? row.name : bucket.name,
      atr: runs.find((r) => r.atr !== null)?.atr ?? null,
      cplc:
        cplcValue === null
          ? null
          : cplcValue.osid === null
            ? { fab: cplcValue.fab, ictype: cplcValue.ictype }
            : { fab: cplcValue.fab, ictype: cplcValue.ictype, osid: cplcValue.osid },
      vendorRaw: cplcValue !== null ? (FAB_VENDOR[cplcValue.fab] ?? null) : null,
      jcver,
      familiesSupported,
      sourceRunFiles: runs.map((r) => r.record.file).sort(),
    })
  }
  cards.sort((a, b) => {
    const ja = a.jcard ?? '\uffff'
    const jb = b.jcard ?? '\uffff'
    if (ja !== jb) return ja < jb ? -1 : 1
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return (a.atr ?? '') < (b.atr ?? '') ? -1 : (a.atr ?? '') > (b.atr ?? '') ? 1 : 0
  })

  const cardByKey = new Map<string, CardIdentity>()
  for (const card of cards) {
    const key =
      card.jcard !== null ? `j:${card.jcard}` : `u:${tokens(card.name).join(' ')}|${card.atr ?? ''}`
    cardByKey.set(key, card)
  }

  // ---- leaderboard -------------------------------------------------------
  const members = new Map<string, { card: CardIdentity; value: number; fileName: string }>()
  const excluded: { reason: string; count: number }[] = [
    { reason: 'ecdsa unsupported (NO_SUCH_ALGORITHM)', count: 0 },
    { reason: 'version undeclared', count: 0 },
  ]
  for (const run of parsed) {
    if (run.record.kind !== 'DATAFIXED' || run.leaderboardValue === undefined) continue
    const key = cardKeyOfRun.get(run.record.file)
    const card = key !== undefined ? cardByKey.get(key) : undefined
    if (card === undefined) continue
    if (run.leaderboardValue === null) {
      const entry = excluded[0]
      if (entry !== undefined) entry.count += 1
      continue
    }
    const tuple = jcverTuple(card.jcver)
    if (tuple === null) {
      const entry = excluded[1]
      if (entry !== undefined) entry.count += 1
      continue
    }
    if (compareTuple(tuple, COHORT_MAX) > 0) continue
    const prev = members.get(key ?? '')
    if (prev === undefined || run.leaderboardValue < prev.value) {
      members.set(key ?? '', { card, value: run.leaderboardValue, fileName: run.record.file })
    }
  }
  const top: Array<[number, string | null, string, number]> = [...members.values()]
    .sort((a, b) => a.value - b.value || a.card.name.localeCompare(b.card.name))
    .slice(0, LEADERBOARD_MAX_MEMBERS)
    .map(
      (m, i) =>
        [i + 1, m.card.jcard, m.card.name, m.value] as [number, string | null, string, number],
    )

  // ---- cross-links (rank-1 HIGH candidate per card profile) --------------
  const crosslinks: CrosslinkRecord[] = []
  for (const profile of gt.crosslinks.cards) {
    const high = pickHighCandidate(profile)
    if (high === null) continue
    crosslinks.push({
      cardJcard: profile.jcard ?? null,
      cardName: profile.card_name,
      cardAtr: profile.atr ?? null,
      certDgst: high.dgst,
      certId: high.cert_id,
      scheme: high.scheme,
      evidence: crosslinkEvidence(profile, high),
    })
  }

  // ---- snapshot ----------------------------------------------------------
  // revision already computed above (imeta pinning).
  const sortedHashes = [...fileHashes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, h]) => h)
  const snapshot: SnapshotRecord = {
    corpus: 'jcalgtest',
    snapshot: new Date().toISOString().slice(0, 10),
    tool: `jcalgtest_results@${revision !== null ? revision.slice(0, 7) : 'unknown'}`,
    counts: { cards: cards.length, runs: parsed.length, crossings: crosslinks.length },
    datasetSha256: sha256Hex(Buffer.from(sortedHashes.join(''), 'utf8')),
    source: UPSTREAM_SOURCE,
  }

  const leaderboard: LeaderboardRecord = {
    metric: 'sign_ecdsa_p256_sha1_ms',
    cohortBucket: LEADERBOARD_COHORT,
    snapshot: snapshot.snapshot,
    top,
    excluded,
  }

  return { cards, runs: parsed.map((p) => p.record), leaderboard, crosslinks, snapshot }
}

/** Rank-1 HIGH candidate of a card profile (array order is the matrix's rank order). */
function pickHighCandidate(profile: CrosslinkCardProfile): CrosslinkCandidate | null {
  for (const candidate of profile.candidates ?? []) {
    if (candidate.confidence === 'high') return candidate
  }
  return null
}

/** Method + verbatim evidence strings for the cross-link Binding content (README). */
function crosslinkEvidence(profile: CrosslinkCardProfile, candidate: CrosslinkCandidate): string[] {
  const out: string[] = []
  out.push(
    `method: JCAlgTest issue #264 (card name → sec-certs full text → CPLC ICType/OperatingSystemID); crosslink-matrix ${profile.card_name} → ${candidate.cert_id} (${candidate.dgst}), confidence high, score ${candidate.score}`,
  )
  if (candidate.matched_tokens !== undefined && candidate.matched_tokens.length > 0) {
    out.push(`matched tokens: ${candidate.matched_tokens.join(', ')}`)
  }
  for (const row of (candidate.evidence ?? []).slice(0, 8)) {
    const token = row.card_token ?? row.card_phrase ?? ''
    if (row.kind === 'semantic') {
      const via = (row.via ?? []).join('; ')
      out.push(
        `CPLC semantic: "${row.cert_value ?? ''}" [${token}]${via !== '' ? ` via ${via}` : ''}`,
      )
    } else {
      out.push(`${row.field}: "${row.cert_value ?? ''}" [${token}]`)
    }
  }
  return out
}
