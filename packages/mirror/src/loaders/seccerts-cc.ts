import { tidyPpToken } from './ppAliases.js'
import {
  canonicalCertId,
  extractAlgFamilies,
  extractCertCves,
  normalizeDirectRefs,
  normalizeEal,
  readDatasetJson,
  schemeTag,
  sourceHashOf,
  str,
  unwrapSet,
} from './seccerts-common.js'
/**
 * seccerts-cc.ts — CC certificate dataset → `SecCertsCertRecord` projection (design §2.1/§10.1).
 *
 * This file also owns the small parsing helpers shared by the other seccerts loaders
 * (`asRecord`, `algFamiliesOf`, `ppKeywordTokens`, `stringSet`, `artifactsOf`,
 * `upstreamArtifact`) so the four loaders stay one convention, not four; generic container
 * unwrapping (`unwrapSet`) and string extraction (`str`) come from `seccerts-common.ts`.
 *
 * Live-verified shapes of the fresh 2026-10-11 `cc_dataset.json` (6,829 records), which the
 * code below relies on:
 *  - set-valued fields are Python-`set` serializations `{"_type":"Set","elements":[…]}`
 *    (elements sorted by the serializer) — unwrap via `unwrapSet`;
 *  - `pdf_data.{report,st,cert}_keywords.<category>` values are nested count dicts:
 *    `cc_protection_profile_id` = `{"BSI":{"BSI-CC-PP-0035-2007":2}}` (scheme family → token →
 *    count); the outer scheme keys are labels, never references;
 *  - `heuristics.cert_id` is null on 106 records — 9 of them have an id-ish own `cc_cert_id`
 *    keyword token; the rest stay null (never fabricate an identity);
 *  - `state.{report,st,cert}` is a `DocumentState` with no size field — artifact `sizeBytes`
 *    is therefore always null in this dataset version;
 *  - `report_references.directly_referencing` holds canonical printed cert ids (not dgsts).
 *
 * `source_hash` provenance: `state.report|st|cert.json_hash` when present, else sha256 of the
 * projection below (field order here is the hash order — keep it stable).
 */
import type { AlgFamily, SecCertsCertRecord, SecCertsCorpusDoc } from './seccerts-types.js'
import { ALG_FAMILIES } from './seccerts-types.js'

/** One record as parsed from the dataset JSON: nested values are `unknown`. */
export type RawRecord = Record<string, unknown>

/** Diagnostics the bundle aggregates; loaders only increment counters, never read them. */
interface CertLoadDiag {
  /** (record, token) pairs skipped as prose aliases (not id-ish, so no `pp:` tag). */
  prosePpTokens: number
}

/** Options shared by the CC and EUCC loaders (identical projection pipeline). */
export interface CertLoadOpts {
  dataDir: string
  ppResolve: (token: string) => string | null
  isProse: (token: string) => boolean
  /**
   * Optional diagnostics sink (update-semantics stats). The ticket signature is the three
   * fields above; this fourth one is additive and optional — a caller that omits it still gets
   * the full record projection.
   */
  diag?: CertLoadDiag
}

export interface CertLoadResult {
  records: SecCertsCertRecord[]
  corpus: SecCertsCorpusDoc
}

/** Keyword containers scanned for PP-reference tokens, in fixed order. */
const PP_KEYWORD_SIDES = ['report_keywords', 'st_keywords', 'cert_keywords'] as const
const CC_PP_KEYWORD = 'cc_protection_profile_id'

// ---------------------------------------------------------------------------
// raw-JSON helpers (exported to the sibling seccerts loaders)
// ---------------------------------------------------------------------------

/** Narrow an unknown JSON value to a plain object. */
export function asRecord(value: unknown): RawRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null
}

/** Keep only values that are members of the frozen `alg:` family list (§3.4). */
export function algFamiliesOf(list: readonly string[]): AlgFamily[] {
  const known = new Set<string>(ALG_FAMILIES)
  return list.filter((slug): slug is AlgFamily => known.has(slug))
}

/** PP-reference tokens per keyword category shape `{scheme: {token: count}}`; inner keys only. */
function ppTokensFromCategory(value: unknown): string[] {
  const out: string[] = []
  const collect = (node: unknown): void => {
    const obj = asRecord(node)
    if (obj === null) return
    for (const [key, child] of Object.entries(obj)) {
      if (typeof child === 'number') out.push(key)
      else collect(child)
    }
  }
  for (const inner of Object.values(asRecord(value) ?? {})) collect(inner)
  return out
}

/**
 * `cc_protection_profile_id` keyword tokens across report/st/cert sides, deduped in encounter
 * order (live-verified: `{schemeFamily: {token: count}}`; the scheme family is never a token).
 */
export function ppKeywordTokens(pdfData: unknown): string[] {
  const pdf = asRecord(pdfData)
  if (pdf === null) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const side of PP_KEYWORD_SIDES) {
    const keywords = asRecord(pdf[side])
    if (keywords === null) continue
    for (const token of ppTokensFromCategory(keywords[CC_PP_KEYWORD])) {
      if (seen.has(token)) continue
      seen.add(token)
      out.push(token)
    }
  }
  return out
}

/**
 * Upstream artifact pinned via imeta: only when the record publishes BOTH a
 * `state.<sub>.source_hash` and a link. `sizeBytes` is null — `DocumentState` has no size
 * field in this dataset version (verified live 2026-10-11; the field is read defensively).
 */
function upstreamArtifact(
  state: unknown,
  record: RawRecord,
  sub: 'report' | 'st' | 'cert',
  linkField: string,
): { url: string; sha256: string; sizeBytes: number | null } | null {
  const subState = asRecord(asRecord(state)?.[sub])
  if (subState === null) return null
  const sha256 = str(subState['source_hash'])
  const url = str(record[linkField])
  if (sha256 === null || url === null) return null
  const size = subState['size']
  return { url, sha256, sizeBytes: typeof size === 'number' ? size : null }
}

/**
 * Dominant own `cc_cert_id` keyword token for records without `heuristics.cert_id`.
 * Tokens that cannot be a printed id (whitespace, no digit) are not eligible — the category
 * carries report titles too (e.g. "Rapport de certification 2005/12") and an identity must
 * never be fabricated from prose. Ties break lexicographically for determinism.
 */
function dominantKeywordCertId(pdf: unknown): string | null {
  const container = asRecord(pdf)
  if (container === null) return null
  const counts = new Map<string, number>()
  for (const side of PP_KEYWORD_SIDES) {
    const keywords = asRecord(container[side])
    if (keywords === null) continue
    const category = asRecord(keywords['cc_cert_id'])
    if (category === null) continue
    for (const inner of Object.values(category)) {
      const tokens = asRecord(inner)
      if (tokens === null) continue
      for (const [token, count] of Object.entries(tokens)) {
        counts.set(token, (counts.get(token) ?? 0) + (typeof count === 'number' ? count : 1))
      }
    }
  }
  const eligible = [...counts.entries()].filter(
    ([token]) => !/\s/u.test(token) && /\d/u.test(token),
  )
  if (eligible.length === 0) return null
  eligible.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return eligible[0]?.[0] ?? null
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

/** Resolve one record's PP references through the alias table (shared with EUCC). */
function resolvePpRefs(
  heuristics: RawRecord,
  pdf: unknown,
  opts: CertLoadOpts,
  includeDgstChannel: boolean,
): { resolved: string[]; unresolved: string[] } {
  const resolved = new Set<string>()
  if (includeDgstChannel) {
    for (const element of unwrapSet(heuristics['protection_profiles'])) {
      const dgst = str(element)
      if (dgst !== null) resolved.add(dgst.toLowerCase())
    }
  }
  const unresolved = new Set<string>()
  for (const token of ppKeywordTokens(pdf)) {
    const hit = opts.ppResolve(token)
    if (hit !== null && hit.length > 0) {
      resolved.add(hit.toLowerCase())
      continue
    }
    if (opts.isProse(token)) {
      if (opts.diag !== undefined) opts.diag.prosePpTokens += 1
      continue
    }
    const tidied = tidyPpToken(token)
    if (tidied.length > 0) unresolved.add(tidied)
  }
  return {
    resolved: [...resolved].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    unresolved: [...unresolved].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  }
}

/** String elements of a set-valued field, empties dropped, source order kept. */
export function stringSet(value: unknown): string[] {
  const out: string[] = []
  for (const element of unwrapSet(value)) {
    const text = str(element)
    if (text !== null) out.push(text)
  }
  return out
}

function linksOf(record: RawRecord): {
  reportLink: string | null
  stLink: string | null
  certLink: string | null
  manufacturerWeb: string | null
} {
  return {
    reportLink: str(record['report_link']),
    stLink: str(record['st_link']),
    certLink: str(record['cert_link']),
    manufacturerWeb: str(record['manufacturer_web']),
  }
}

function maintenanceOf(record: RawRecord): SecCertsCertRecord['maintenance'] {
  const out: SecCertsCertRecord['maintenance'] = []
  for (const element of unwrapSet(record['maintenance_updates'])) {
    const entry = asRecord(element)
    if (entry === null) continue
    out.push({
      date: str(entry['maintenance_date']),
      title: str(entry['maintenance_title']),
      reportLink: str(entry['maintenance_report_link']),
      stLink: str(entry['maintenance_st_link']),
    })
  }
  return out
}

/** imeta-pinnable artifacts (report/st/cert) of one cert record; empty when no hash+link. */
export function artifactsOf(state: unknown, record: RawRecord): SecCertsCertRecord['artifacts'] {
  const artifacts: SecCertsCertRecord['artifacts'] = {}
  const report = upstreamArtifact(state, record, 'report', 'report_link')
  if (report !== null) artifacts.report = report
  const st = upstreamArtifact(state, record, 'st', 'st_link')
  if (st !== null) artifacts.st = st
  const cert = upstreamArtifact(state, record, 'cert', 'cert_link')
  if (cert !== null) artifacts.cert = cert
  return artifacts
}

/**
 * CC dataset → one `SecCertsCertRecord` per certificate record (design §2.1/§10.1).
 * Ordering follows the dataset file; malformed records without a `dgst` are skipped (the
 * datasets guarantee one, so this path is defensive only).
 */
export function loadCc(opts: CertLoadOpts): CertLoadResult {
  const dataset = readDatasetJson(opts.dataDir, 'cc')
  const { snapshot } = dataset
  const docs = dataset.docs

  // dgst → canonical cert id map for the reference graph (heuristics.cert_id only).
  const dgstToCertId = new Map<string, string | null>()
  for (const raw of docs) {
    const dgst = str(raw['dgst'])
    if (dgst === null) continue
    dgstToCertId.set(dgst, canonicalCertId(asRecord(raw['heuristics'])?.['cert_id']))
  }

  const records: SecCertsCertRecord[] = []
  for (const raw of docs) {
    const dgst = str(raw['dgst'])
    if (dgst === null) continue
    const heuristics = asRecord(raw['heuristics']) ?? {}
    const pdf = raw['pdf_data']
    const state = raw['state']
    const { reportLink, stLink, certLink, manufacturerWeb } = linksOf(raw)
    const pp = resolvePpRefs(heuristics, pdf, opts, true)
    const refs = normalizeDirectRefs(heuristics, (dgstKey) => dgstToCertId.get(dgstKey) ?? null)
    const algorithms = extractAlgFamilies(raw, 'cc')
    const projection: Omit<SecCertsCertRecord, 'sourceHash' | 'sourceHashKind'> = {
      corpus: 'seccerts/cc',
      sourceId: dgst,
      name: str(raw['name']) ?? '',
      manufacturerRaw: str(raw['manufacturer']),
      schemeTag: schemeTag(str(raw['scheme'])),
      schemeName: null, // CC records carry no human scheme name — codes only (never fabricate)
      certId: canonicalCertId(heuristics['cert_id']) ?? dominantKeywordCertId(pdf),
      eal: normalizeEal(str(heuristics['eal'])),
      securityLevel: stringSet(raw['security_level']),
      status: str(raw['status']),
      notValidBefore: str(raw['not_valid_before']),
      notValidAfter: str(raw['not_valid_after']),
      category: str(raw['category']),
      certLab: str(heuristics['cert_lab']),
      reportLink,
      stLink,
      certLink,
      manufacturerWeb,
      ppRefsResolved: pp.resolved,
      ppRefsUnresolved: pp.unresolved,
      directRefs: refs.refs,
      directRefsTruncated: refs.truncated,
      indirectRefs: refs.indirect,
      cves: extractCertCves(heuristics),
      algFamilies: algFamiliesOf(algorithms.families),
      algUnknown: algorithms.unknown,
      cpeMatches: stringSet(heuristics['cpe_matches']),
      maintenance: maintenanceOf(raw),
      artifacts: artifactsOf(state, raw),
      snapshot,
    }
    const { hash, kind } = sourceHashOf(raw, projection)
    records.push({ ...projection, sourceHash: hash, sourceHashKind: kind })
  }

  const corpus: SecCertsCorpusDoc = {
    corpus: 'seccerts/cc',
    label: 'sec-certs CC corpus',
    snapshot,
    tool: dataset.tool,
    counts: { cc: records.length },
    datasetSha256: dataset.datasetSha256,
    datasetUrl: dataset.datasetUrl,
    datasetSizeBytes: dataset.datasetSizeBytes,
  }
  return { records, corpus }
}
