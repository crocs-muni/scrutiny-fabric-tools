/**
 * Ground-truth loader — reads the frozen `docs/mirroring/ground-truth/*` artifacts.
 *
 * These files are AUTHORITATIVE for the jcalgtest import (jcard numbering, cross-link
 * candidates, metric registry, run timeline census, vendor census). They live in the
 * sibling `scrutiny-fabric` repo; the CLI passes the directory via `--ground-truth`.
 *
 * All five inputs are required — a missing/renamed file is a hard error (the import
 * must never silently fall back to a weaker identity/counting source).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// jcard-table.json — website c-number freeze (117 rows c000..c116)
// ---------------------------------------------------------------------------

/** One per-card run file, reconciled from the clone by the frozen table. */
export interface JcardRunFile {
  /** Repo-relative path as recorded by the table (usually a basename). */
  path: string
  atr_name?: string | null
  header_atr?: string | null
  header_card_name?: string | null
  header_prov?: string | null
  exec?: string | null
  jcver?: string | null
}

/** One frozen card table row. */
export interface JcardRow {
  cn: number
  /** `c000`..`c116` (zero-padded, design §9 Q11). */
  jcard: string
  site_label: string
  /** Canonical published name (the one CardIdentity carries for matched cards). */
  name: string
  card_name?: string
  atr_hex_lowercase_concat: string | null
  atr_tokens?: string[]
  atr_raw?: string | null
  /** True for `[undisclosedN]` rows whose ATR is an `xx`/all-zero placeholder. */
  placeholder: boolean
  provided_by?: string | null
  linked_file?: string | null
  linked_file_found?: boolean
  run_files?: JcardRunFile[]
  perf_links?: unknown[]
  rename_drift?: string | null
  conflicts?: string[]
  notes?: string[]
}

export interface JcardTable {
  schema_version: number
  snapshot: string
  scrape_date?: string
  sources: {
    table?: string
    site?: string
    clone?: { repo?: string; revision?: string; revision_date?: string; results_files?: number }
    [key: string]: unknown
  }
  /** Row-reconciliation counts (`rows_total`, `atr_collision_groups`, …). */
  counts: Record<string, number>
  cards: JcardRow[]
}

// ---------------------------------------------------------------------------
// crosslink-matrix.json — issue-#264 card x cert candidates
// ---------------------------------------------------------------------------

export type CrosslinkConfidence = 'high' | 'medium' | 'low'

/** One evidence row (name token or CPLC semantic mapping) copied from the matrix. */
export interface CrosslinkEvidenceRow {
  field: string
  kind: string
  cert_value?: string
  card_phrase?: string
  card_token?: string
  weight?: number
  label?: string
  freq?: number
  strength?: string
  via?: string[]
  mapping_source?: string
}

export interface CrosslinkCandidate {
  dgst: string
  cert_id: string
  scheme: string
  eal: string | null
  name: string
  category?: string
  confidence: CrosslinkConfidence
  score: number
  /** Rank order is the array order; the matrix lists strongest first. */
  evidence?: CrosslinkEvidenceRow[]
  matched_tokens?: string[]
  cplc_evidence?: {
    literal_hits?: string[]
    semantic_hits?: string[]
    semantic_hits_strong?: string[]
    [key: string]: unknown
  }
  url?: string
  [key: string]: unknown
}

/** One card profile in the matrix (146 profiles: mapped + unmapped). */
export interface CrosslinkCardProfile {
  jcard_hint: string
  jcard: string | null
  on_site: boolean
  site_label?: string | null
  site_name?: string | null
  card_name: string
  names?: string[]
  atr: string | null
  atr_partial?: boolean
  cplc?: string | null
  n_run_files?: number
  run_files?: string[]
  run_kinds?: Record<string, number>
  candidates?: CrosslinkCandidate[]
  candidates_total?: number
  candidates_truncated?: number
  [key: string]: unknown
}

export interface CrosslinkMatrix {
  artifact: string
  schema_version: number
  generated_on: string
  purpose?: string
  confidence_rules: Record<string, string>
  counts: Record<string, number>
  top_pairs?: Array<Record<string, unknown>>
  cards: CrosslinkCardProfile[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// metric-canonicalization.json — canonical key registry + block grammar
// ---------------------------------------------------------------------------

/** One canonical metric key (20 in v1) — drives `RunRecord.selected`. */
export interface MetricCanonicalKey {
  key: string
  family: string
  unit: string
  description: string
  source: {
    DATAFIXED?: {
      method_name_line?: string
      distinct_name?: string
      present_in_files?: number
      measured_files?: number
      measured_blocks?: number
      [k: string]: unknown
    }
    DATADEPEND?: {
      normalized_name?: string
      raw_forms?: string[]
      present_in_files?: number
      measured_files?: number
      measured_blocks?: number
      [k: string]: unknown
    }
  }
  [key: string]: unknown
}

export interface MetricFileEntry {
  idx: number
  run_type: 'DATAFIXED' | 'DATADEPEND'
  rel: string
  basename: string
  client_version: string | null
  applet_version: string | null
  card_name: string | null
  date: string | null
  atr: string | null
  provided_by: string | null
  sections?: string[]
  block_count?: number
  measured_blocks?: number
  error_blocks?: number
  [key: string]: unknown
}

export interface MetricCanonicalization {
  generated: string
  data_traps: Array<{ id: string; finding: string; [k: string]: unknown }>
  summary: Record<string, unknown>
  files: MetricFileEntry[]
  block_structure: {
    record_grammar?: string[]
    alternative_body?: string
    sections?: unknown
    counts?: Record<string, unknown>
    [k: string]: unknown
  }
  registry: {
    canonical_keys: MetricCanonicalKey[]
    extension_patterns: Record<string, unknown>
    /** `{value_line, value_field, name_line, per_op_math, baseline_handling}`. */
    extraction_rule: {
      value_line?: string
      value_field?: string
      name_line?: string
      per_op_math?: string
      baseline_handling?: string
      [k: string]: unknown
    }
  }
  families: Record<string, Record<string, unknown>>
  names: Record<
    string,
    Array<{
      name: string
      occurrences: number
      measured: number
      error_blocks: number
      files: number[]
    }>
  >
  algsupport: Record<string, unknown>
  version_drift?: Array<Record<string, unknown>>
  overlap?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// jcalgtest-run-timeline.json — census (275 files / 206 name+ATR groups)
// ---------------------------------------------------------------------------

export interface TimelineNewestRun {
  date: string | null
  run_type: string
  client: string | null
  applet: string | null
  jcsupport: string | null
  file: string
}

export interface TimelineCard {
  name: string
  norm_name: string
  atr: string | null
  run_count: number
  run_types: string[]
  dates: string[]
  newest: TimelineNewestRun | null
  identity_stable?: boolean
  names_seen?: string[]
  atrs_seen?: string[]
  cplcs_seen?: string[]
  names_seen_ok?: boolean
  timeline?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface RunTimeline {
  artifact: string
  source: string
  generated: string
  scope: string[]
  method: string
  counts: Record<string, number | string[]>
  cards: TimelineCard[]
  newest_run_per_card?: TimelineCard[]
  post_2023_runs?: Array<Record<string, unknown>>
  drift_flags?: Record<string, unknown>
  stale_cards?: Array<Record<string, unknown>>
  undated_cards?: Array<Record<string, unknown>>
  pqc_scan?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// vendor-census.csv — 2,168 raw vendor strings -> slugs
// ---------------------------------------------------------------------------

export interface VendorCensusRow {
  slug: string
  nRawVariants: number
  ccCount: number
  fipsCount: number
  totalCount: number
  ir1Ok: boolean
  slugIr1: string | null
  /** Raw corpus strings, pipe-separated in the CSV. */
  rawVariants: string[]
}

export interface VendorTables {
  rows: VendorCensusRow[]
  /** slug -> rows with that slug (1 by construction; kept as a map for lookup). */
  bySlug: Map<string, VendorCensusRow>
  /** Every raw variant -> slug (exact string lookup). */
  rawToSlug: Map<string, string>
}

/** The whole ground-truth bundle, as loaded from disk. */
export interface GroundTruth {
  dir: string
  jcardTable: JcardTable
  crosslinks: CrosslinkMatrix
  metricRegistry: MetricCanonicalization
  timeline: RunTimeline
  vendorTables: VendorTables
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function readJson<T>(dir: string, name: string): T {
  const path = join(dir, name)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`ground-truth: cannot read ${path}: ${(err as Error).message}`)
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`ground-truth: ${path} is not valid JSON: ${(err as Error).message}`)
  }
}

/** Split one CSV line honoring double-quoted fields (the census quotes `raw_variants`). */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

function loadVendorCensus(dir: string): VendorTables {
  const path = join(dir, 'vendor-census.csv')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`ground-truth: cannot read ${path}: ${(err as Error).message}`)
  }
  const lines = text.split(/\r?\n/u).filter((l) => l.trim() !== '')
  const header = splitCsvLine(lines[0] ?? '')
  const col = (name: string): number => header.indexOf(name)
  const iSlug = col('slug')
  const iN = col('n_raw_variants')
  const iCc = col('cc_count')
  const iFips = col('fips_count')
  const iTotal = col('total_count')
  const iIr1 = col('ir1_ok')
  const iSlugIr1 = col('slug_ir1')
  const iRaw = col('raw_variants')
  if (iSlug < 0 || iRaw < 0) {
    throw new Error(
      `ground-truth: vendor-census.csv: unexpected header (${lines[0]?.slice(0, 80) ?? ''})`,
    )
  }
  const rows: VendorCensusRow[] = []
  const bySlug = new Map<string, VendorCensusRow>()
  const rawToSlug = new Map<string, string>()
  const num = (fields: string[], idx: number): number => {
    if (idx < 0) return 0
    const v = Number(fields[idx])
    return Number.isFinite(v) ? v : 0
  }
  for (let i = 1; i < lines.length; i += 1) {
    const fields = splitCsvLine(lines[i] ?? '')
    const slug = (fields[iSlug] ?? '').trim()
    if (slug === '') continue
    const raw = iRaw >= 0 ? (fields[iRaw] ?? '') : ''
    const row: VendorCensusRow = {
      slug,
      nRawVariants: num(fields, iN),
      ccCount: num(fields, iCc),
      fipsCount: num(fields, iFips),
      totalCount: num(fields, iTotal),
      ir1Ok: (iIr1 >= 0 ? (fields[iIr1] ?? '') : '').trim() === '1',
      slugIr1:
        iSlugIr1 >= 0 && (fields[iSlugIr1] ?? '').trim() !== ''
          ? (fields[iSlugIr1] ?? '').trim()
          : null,
      rawVariants: raw
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    }
    rows.push(row)
    bySlug.set(slug, row)
    for (const variant of row.rawVariants) rawToSlug.set(variant, slug)
  }
  return { rows, bySlug, rawToSlug }
}

/**
 * Read every frozen ground-truth artifact from `dir` (defaults to the sibling
 * repo path used by the CLI: `docs/mirroring/ground-truth`).
 */
export function loadGroundTruth(dir: string): GroundTruth {
  return {
    dir,
    jcardTable: readJson<JcardTable>(dir, 'jcard-table.json'),
    crosslinks: readJson<CrosslinkMatrix>(dir, 'crosslink-matrix.json'),
    metricRegistry: readJson<MetricCanonicalization>(dir, 'metric-canonicalization.json'),
    timeline: readJson<RunTimeline>(dir, 'jcalgtest-run-timeline.json'),
    vendorTables: loadVendorCensus(dir),
  }
}
