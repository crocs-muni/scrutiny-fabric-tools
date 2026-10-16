/**
 * seccerts-common.ts — shared sec-certs loading + normalization for leg 2 (next-leg-cc.md,
 * design §3.4/§10, ground-truth/{eucc-pp-census, vendor-census, maintenance-deepdive}).
 *
 * Every extraction here was verified against the 2026-10-11 fresh datasets:
 *  - dataset top-level: {_type, state:{sec_certs_version,…}, timestamp: 'YYYY-MM-DD hh:mm:ss.µs',
 *    name, description, n_certs, certs:[…]} (record list key is `certs`).
 *  - sec-certs set-valued fields are wrappers {'_type':'Set','elements':[…]} — unwrap via
 *    {@link unwrapSet} (also accepts plain lists / count-dict shapes / scalars).
 *  - pdf_data.*_keywords.<category> values are nested count dicts ({family: {leaf: n, …}} and
 *    {family: {mid: {leaf: n}}}) — leaf AND intermediate keys carry vocabulary.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { sha256 } from '@noble/hashes/sha2.js'

import type { CveRelation, SourceHashKind } from './seccerts-types.js'

/**
 * SHA-256 hex. Hashes via `@noble/hashes` — the package's hash convention (`node:crypto` is
 * biome-restricted across `packages/*\/src/**`, same as `loaders/jcalgtest.ts` and
 * `emit/seccerts/engine.ts`; no new dependency: `@noble/hashes` ships with nostr-tools).
 */
export function sha256Hex(input: string | Buffer): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return Buffer.from(sha256(bytes)).toString('hex')
}

/** Dataset file leg + upstream identity for a sec-certs corpus name. */
const DATASET_FILES: Record<string, { file: string; url: string }> = {
  cc: { file: 'cc_dataset.json', url: 'https://sec-certs.org/cc/dataset.json' },
  fips: { file: 'fips_dataset.json', url: 'https://sec-certs.org/fips/dataset.json' },
  eucc: { file: 'eucc_dataset.json', url: 'https://sec-certs.org/eucc/dataset.json' },
  pp: { file: 'pp_dataset.json', url: 'https://sec-certs.org/pp/dataset.json' },
  maintenance: {
    file: 'maintenance_updates.json',
    url: 'https://sec-certs.org/cc/maintenance_updates.json',
  },
}

/** Read + hash one sec-certs dataset file; snapshot stamp = date part of the file `timestamp`. */
export function readDatasetJson(
  dataDir: string,
  name: 'cc' | 'fips' | 'eucc' | 'pp' | 'maintenance',
): {
  docs: Record<string, unknown>[]
  snapshot: string
  tool: string
  datasetUrl: string
  datasetSha256: string
  datasetSizeBytes: number
} {
  const info = DATASET_FILES[name]
  if (info === undefined) throw new Error(`readDatasetJson: unknown corpus '${name}'`)
  const path = join(dataDir, info.file)
  const bytes = readFileSync(path)
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${path}: dataset root is not an object`)
  const root = parsed as Record<string, unknown>
  const docs = root['certs']
  if (!Array.isArray(docs)) throw new Error(`${path}: missing 'certs' array`)
  const ts = typeof root['timestamp'] === 'string' ? root['timestamp'] : ''
  const state =
    typeof root['state'] === 'object' && root['state'] !== null
      ? (root['state'] as Record<string, unknown>)
      : {}
  return {
    docs: docs as Record<string, unknown>[],
    snapshot: ts.slice(0, 10),
    tool: typeof state['sec_certs_version'] === 'string' ? state['sec_certs_version'] : '',
    datasetUrl: info.url,
    datasetSha256: sha256Hex(bytes),
    datasetSizeBytes: statSync(path).size,
  }
}

/**
 * Generic sec-certs container unwrap (schema-verified 2026-10-11):
 * {_type:'Set', elements:[…]} → elements; plain list → as-is; count-dict → keys; null → [];
 * scalar → [scalar]. Used by every field extraction below.
 */
export function unwrapSet(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'object') {
    const dict = value as Record<string, unknown>
    if (Array.isArray(dict['elements'])) return dict['elements'] as unknown[]
    return Object.keys(dict)
  }
  return [value]
}

/**
 * Recursively collect every string KEY of a keyword container, any depth, any shape:
 * nested count dicts (the live grammar), arrays (recurse elements), string leaves (the value
 * itself), numbers (counts — dropped). Keywords are the vocabulary; counts are not facts.
 */
export function collectKeywordKeys(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKeywordKeys(item, out)
    return out
  }
  if (typeof value !== 'object' || value === null) return out
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(key)
    collectKeywordKeys(child, out)
  }
  return out
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

// ---------------------------------------------------------------------------
// vendor slug (design §3.4 + ground-truth/vendor-census §5)
// ---------------------------------------------------------------------------

/** Post-NFKD leftovers found by the census (§5.1: 7 slugs need these explicitly). */
const TRANSLITERATE: Record<string, string> = {
  ß: 'ss',
  ı: 'i',
  ş: 's',
  ğ: 'g',
}

const JUNK_SLUGS: Record<string, true> = { unknown: true, na: true, 'n-a': true, none: true }

/**
 * `vendor:` slug: verbatim corpus string → mechanical slug, IR-1 (`^[a-z0-9-]+$`) safe.
 * NFKD → strip combining marks → lowercase → map the survivors NFKD cannot fold (ß/ẞ→ss,
 * dotless ı→i; ş/ğ fold via NFKD but stay mapped) → non-alnum runs to '-' → trim.
 * Junk vendor values (empty, `unknown`, `n/a`, `none`, email protected redactions) → null.
 */
export function vendorSlugSec(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.includes('@') || /email\s*protected/i.test(trimmed)) return null
  const slug = trimmed
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßışğ]/gu, (c) => TRANSLITERATE[c] ?? c)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (slug === '' || JUNK_SLUGS[slug] === true) return null
  return /^[a-z0-9-]+$/u.test(slug) ? slug : null
}

// ---------------------------------------------------------------------------
// scheme + EAL (design §3.3/§3.4, §9 Q9)
// ---------------------------------------------------------------------------

const SCHEME_MAP: Record<string, string> = {
  de: 'de',
  deu: 'de',
  germany: 'de',
  nl: 'nl',
  netherlands: 'nl',
  us: 'us',
  usa: 'us',
  fr: 'fr',
  france: 'fr',
  gb: 'uk',
  uk: 'uk',
  jp: 'jp',
  ca: 'ca',
  kr: 'kr',
  it: 'it',
  es: 'es',
  se: 'se',
  tr: 'tr',
  ch: 'ch',
  cz: 'cz',
  fi: 'fi',
  no: 'no',
  il: 'il',
  au: 'au',
  sg: 'sg',
  in: 'in',
  br: 'br',
  my: 'my',
  tw: 'tw',
  pl: 'pl',
  be: 'be',
  at: 'at',
  dk: 'dk',
  hu: 'hu',
  nz: 'nz',
}

export function schemeTag(raw: unknown): string | null {
  const s = str(raw)
  if (s === null) return null
  const lower = s.toLowerCase().trim()
  const direct = SCHEME_MAP[lower]
  if (direct !== undefined) return direct
  return /^[a-z]{2}$/u.test(lower) ? lower : null
}

export function normalizeEal(raw: unknown): string | null {
  const s = str(raw)
  if (s === null) return null
  const m = /EAL\s*([1-7])\s*(\+)?/i.exec(s)
  if (m === null) return null
  const plus = m[2] !== undefined || /augment/i.test(s)
  return `EAL${m[1]}${plus ? '+' : ''}`
}

// ---------------------------------------------------------------------------
// alg family extraction (design §3.4 closed list + source maps)
// ---------------------------------------------------------------------------

/** Exact-token → closed-list family (§3.4 source row table, case-insensitive lookup). */
const FAMILY_MAP: Record<string, string> = {
  kyber: 'ml-kem',
  'crystals-kyber': 'ml-kem',
  'ml-kem': 'ml-kem',
  dilithium: 'ml-dsa',
  'crystals-dilithium': 'ml-dsa',
  'ml-dsa': 'ml-dsa',
  'sphincs+': 'slh-dsa',
  'slh-dsa': 'slh-dsa',
  lms: 'lms',
  xmss: 'xmss',
  falcon: 'falcon',
  rsa: 'rsa',
  'rsassa-pss': 'rsa',
  'rsa-pss': 'rsa',
  ecdsa: 'ecdsa',
  xeddsa: 'eddsa',
  eddsa: 'eddsa',
  ecdh: 'ecdh',
  dh: 'ecdh',
  svdp_dh: 'ecdh',
  'diffie-hellman': 'ecdh',
  aes: 'aes',
  'aes-cbc': 'aes',
  'aes-ecb': 'aes',
  'aes-gcm': 'aes',
  'aes-ctr': 'aes',
  'aes-ccm': 'aes',
  'aes-xts': 'aes',
  des: '3des',
  'triple-des': '3des',
  tdes: '3des',
  tdea: '3des',
  sha: 'sha-2',
  'sha-1': 'sha-2',
  sha1: 'sha-2',
  'sha-2': 'sha-2',
  sha2: 'sha-2',
  shs: 'sha-2',
  'secure hash': 'sha-2',
  'sha-3': 'sha-3',
  sha3: 'sha-3',
  hmac: 'hmac',
  chacha20: 'chacha20',
  'chacha20-poly1305': 'chacha20',
}

const JUNK_ALG_TOKENS: Record<string, true> = {
  pqc: true,
  'post-quantum': true,
  quantum: true,
  nist: true,
  key: true,
  'key agreement': true,
  ka: true,
  ff: true,
  if: true,
  ecc: true,
  'public key': true,
  ca: true,
  rng: true,
  'random number generator': true,
  ogad: true,
}

/** Family cap order per design §3.4/brief: pq > asymmetric > symmetric > hash, canonical within group. */
const FAMILY_PRIORITY: readonly string[] = [
  'ml-kem',
  'ml-dsa',
  'slh-dsa',
  'lms',
  'xmss',
  'falcon',
  'ecdsa',
  'ecdh',
  'eddsa',
  'rsa',
  'secp256r1',
  'secp384r1',
  'secp521r1',
  'ed25519',
  'ed448',
  'x25519',
  'x448',
  'aes',
  '3des',
  'chacha20',
  'sha-2',
  'sha-3',
  'hmac',
]

/** Variant-name table: names carrying sizes/modes/glued CAVP refs ('RSA-2048', 'SHA3-384'). */
const VARIANT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^rsa/u, 'rsa'],
  [/^dsa\b|^dsa ?(?:keygen|siggen|sigver)/u, 'rsa'],
  [/^ecdsa/u, 'ecdsa'],
  [/^eddsa|^ed25519/u, 'eddsa'],
  [/^ecdh|^svdp[_ -]?dh|^diffie/u, 'ecdh'],
  [/^aes/u, 'aes'],
  [/^(?:triple-?des|3des|tdes|tdea|des$)/u, '3des'],
  [/^sha3|^sha-3|keccak/u, 'sha-3'],
  [/^sha2|^sha-2|^sha-?1\b|^sha-?[235]\d\d|^shs|^secure hash/u, 'sha-2'],
  [/^hmac/u, 'hmac'],
  [/^chacha/u, 'chacha20'],
  [/^ml-kem|^kyber/u, 'ml-kem'],
  [/^ml-dsa|^dilithium/u, 'ml-dsa'],
  [/^slh-dsa|^sphincs/u, 'slh-dsa'],
  [/^lms\b|^hss\b/u, 'lms'],
  [/^xmss/u, 'xmss'],
  [/^falcon/u, 'falcon'],
  [/^(?:p-256|secp256r1|nist p-256|prime256v1)/u, 'secp256r1'],
  [/^(?:p-384|secp384r1)/u, 'secp384r1'],
  [/^(?:p-521|secp521r1)/u, 'secp521r1'],
  [/^x25519/u, 'x25519'],
  [/^x448/u, 'x448'],
  [/^ed448/u, 'ed448'],
]

/**
 * Map one raw algorithm-ish token to a closed-list family (design §3.4 source table).
 * Lookup cores: the token itself plus, for CAVP-glued cert refs ('AES-CBCA7673', 'SHA-1A7322'),
 * the name before the glued 'A'/'#' number. Bare class tokens ('PQC') are ignored, not unknown.
 */
function familiesOfToken(raw: string): { families: string[]; recognized: boolean } {
  const token = raw.trim()
  const lower = token.toLowerCase()
  const cores = [lower]
  const glue = /^(.*?)(?:#\s?|A)(\d{1,5})$/u.exec(token)
  if (glue !== null && glue[1] !== undefined && glue[1] !== '') cores.push(glue[1].toLowerCase())
  for (const core of cores) {
    if (lower === '' || JUNK_ALG_TOKENS[core] === true) return { families: [], recognized: true }
    const direct = FAMILY_MAP[core]
    if (direct !== undefined) return { families: [direct], recognized: true }
  }
  for (const core of cores) {
    for (const [rx, fam] of VARIANT_RULES) {
      if (rx.test(core)) return { families: [fam], recognized: true }
    }
  }
  // No family. A token with <3 letters is a class/marker ('FF', 'CA'), not a name.
  return { families: [], recognized: lower.replace(/[^a-z]/gu, '').length < 3 }
}

const CC_ALG_CATEGORIES = [
  'asymmetric_crypto',
  'ecc_curve',
  'crypto_scheme',
  'crypto_protocol',
  'randomness',
  'hash_function',
  'symmetric_crypto',
  'pq_crypto',
]

/**
 * §3.4 evidence → closed-list family slugs.
 * kind 'cc': pdf_data.{report,st,cert}_keywords.<category> nested count dicts (leaf+inner keys).
 * kind 'fips': pdf_data.module_algorithms/policy_algorithms + heuristics.algorithms (CAVP-glued
 * names; trailing cert numbers stripped before mapping).
 */
export function extractAlgFamilies(
  record: Record<string, unknown>,
  kind: 'cc' | 'fips',
): { families: string[]; unknown: string[] } {
  const tokens: string[] = []
  if (kind === 'cc') {
    const pdf = (record['pdf_data'] as Record<string, unknown> | null) ?? {}
    for (const side of ['report_keywords', 'st_keywords', 'cert_keywords']) {
      const cat = pdf[side]
      if (typeof cat !== 'object' || cat === null) continue
      for (const name of CC_ALG_CATEGORIES) {
        tokens.push(...collectKeywordKeys((cat as Record<string, unknown>)[name]))
      }
    }
  } else {
    const pdf = (record['pdf_data'] as Record<string, unknown> | null) ?? {}
    const heur = (record['heuristics'] as Record<string, unknown> | null) ?? {}
    for (const v of [
      ...unwrapSet(pdf['module_algorithms']),
      ...unwrapSet(pdf['policy_algorithms']),
      ...unwrapSet(heur['algorithms']),
    ]) {
      if (typeof v === 'string') tokens.push(v)
    }
  }
  const seen = new Set<string>()
  const unknownSeen = new Set<string>()
  const found: string[] = []
  const unknown: string[] = []
  for (const raw of tokens) {
    const { families, recognized } = familiesOfToken(raw.trim())
    if (!recognized) {
      const key = raw.trim().toLowerCase()
      if (!unknownSeen.has(key) && unknownSeen.size < 12) {
        unknownSeen.add(key)
        unknown.push(raw.trim())
      }
      continue
    }
    for (const fam of families) {
      if (seen.has(fam)) continue
      seen.add(fam)
      found.push(fam)
    }
  }
  found.sort(
    (a, b) =>
      FAMILY_PRIORITY.indexOf(a as (typeof FAMILY_PRIORITY)[number]) -
      FAMILY_PRIORITY.indexOf(b as (typeof FAMILY_PRIORITY)[number]),
  )
  return { families: found.slice(0, 10), unknown }
}

// FIPS CAVP reference split: trailing cert number (classic '#987' / '#A41' and glued
// 'A7673' / 'C482' / 'SHS 817' forms). No digit floor — FIPS 140-1-era numbers are 1-2 digits
// ('SHA-1#64', 'AES#41', 'RSA#1', 'Triple-DES#82' — live 2026-10-11).
const CAVP_SPLIT = /^(.*?)(?:#?\s?(A?\d{1,5}))$/u

/**
 * FIPS CAVP refs → 'token-number' values (§3.3): 'AES#987'→'aes-987', 'AES-CBCA7673'→'aes-a7673',
 * 'SHS#954'→'sha-2-954', 'Triple-DES#773'→'3des-773', 'SHA-1#64'→'sha-2-64'.
 * Context-free bare refs ('#A2518') carry no algorithm name → skipped (returns absent).
 */
export function normalizeCavpRefs(algStrings: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of algStrings) {
    if (raw.startsWith('#')) continue
    const m = CAVP_SPLIT.exec(raw.trim())
    if (m === null || m[1] === undefined || m[2] === undefined || m[1] === '') continue
    const num = m[2].toLowerCase()
    let name = m[1].trim()
    // strip trailing mode/key-management words that got glued before the number
    name = name.replace(/[\s#/]+$/u, '')
    const { families } = familiesOfToken(name)
    const fam = families[0]
    if (fam !== undefined) {
      out.add(`${fam}-${num}`)
      continue
    }
    const simple = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
    if (/^[a-z0-9][a-z0-9-]{1,30}$/u.test(simple)) out.add(`${simple}-${num}`)
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// CVE extraction (design §2.4/§9 Q6, maintenance-deepdive §4.1)
// ---------------------------------------------------------------------------

const CVE_RE = /^CVE-\d{4}-\d{4,7}$/u

export function extractCertCves(heur: Record<string, unknown> | null | undefined): CveRelation[] {
  if (heur === null || heur === undefined) return []
  const direct = new Set<string>()
  const transitive = new Set<string>()
  for (const v of unwrapSet(heur['related_cves'])) {
    if (typeof v === 'string' && CVE_RE.test(v)) direct.add(v)
  }
  for (const key of ['direct_transitive_cves', 'indirect_transitive_cves']) {
    for (const v of unwrapSet(heur[key])) {
      if (typeof v === 'string' && CVE_RE.test(v)) transitive.add(v)
    }
  }
  const out: CveRelation[] = []
  for (const cve of direct) out.push({ cve, cls: 'direct', via: null })
  for (const cve of transitive) {
    if (!direct.has(cve)) out.push({ cve, cls: 'transitive', via: null })
  }
  return out
}

/** Maintenance keyword harvest (deepdive §4.1): pdf_data.*_keywords.vulnerability CVE ids. */
export function cveIdsFromVulnerabilityKeywords(pdfData: unknown): string[] {
  const out = new Set<string>()
  if (typeof pdfData !== 'object' || pdfData === null) return []
  const pdf = pdfData as Record<string, unknown>
  for (const side of ['report_keywords', 'st_keywords', 'cert_keywords']) {
    const cat = pdf[side]
    if (typeof cat !== 'object' || cat === null) continue
    for (const token of collectKeywordKeys((cat as Record<string, unknown>)['vulnerability'])) {
      if (CVE_RE.test(token)) out.add(token)
    }
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// hashes + reference graph
// ---------------------------------------------------------------------------

function jsonHashAt(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const v = (value as Record<string, unknown>)['json_hash']
  return typeof v === 'string' && v !== '' ? v : null
}

/** Deterministic JSON bytes for the fallback hash: object keys sorted recursively, no whitespace. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Ledger source-hash policy (next-leg §Ledger conventions): reuse the record's own
 * `state.<artifact>.json_hash` when present — caller picks the artifact order (cc/eucc/maintenance:
 * default `report → st → cert`; fips: `policy → module`; pp: `pp → report`) — else sha256 of the
 * loader-normalized projection with stable key order.
 */
export function sourceHashOf(
  record: Record<string, unknown>,
  normalized: unknown,
  jsonHashOrder: readonly string[] = ['report', 'st', 'cert'],
): { hash: string; kind: SourceHashKind } {
  const state = (record['state'] as Record<string, unknown> | null) ?? {}
  for (const key of jsonHashOrder) {
    const h = jsonHashAt(state[key])
    if (h !== null) return { hash: h, kind: 'json_hash' }
  }
  return { hash: sha256Hex(stableJson(normalized)), kind: 'normalized-sha256' }
}

/**
 * Direct reference-graph outgoing ids (report ∪ st directly_referencing), 64-capped.
 * Values are live printed ids (sanitized via `canonicalCertId`; unprintable → dropped) or, on
 * older snapshots, dgsts mapped through the callback. Transitive/referenced-by closure → indirect.
 */
export function normalizeDirectRefs(
  heur: Record<string, unknown> | null | undefined,
  dgstToCertId: (dgst: string) => string | null,
): { refs: string[]; truncated: boolean; indirect: string[] } {
  if (heur === null || heur === undefined) return { refs: [], truncated: false, indirect: [] }
  const direct = new Set<string>()
  const indirect = new Set<string>()
  for (const side of ['report_references', 'st_references']) {
    const refs = heur[side]
    if (typeof refs !== 'object' || refs === null) continue
    const r = refs as Record<string, unknown>
    for (const v of unwrapSet(r['directly_referencing'])) {
      if (typeof v !== 'string' || v === '') continue
      if (/^[0-9a-f]{16}$/u.test(v)) {
        const mapped = dgstToCertId(v)
        if (mapped !== null) direct.add(mapped)
      } else {
        const cid = canonicalCertId(v)
        if (cid !== null) direct.add(cid)
      }
    }
    for (const key of [
      'indirectly_referencing',
      'directly_referenced_by',
      'indirectly_referenced_by',
    ]) {
      for (const v of unwrapSet(r[key])) {
        if (typeof v === 'string' && v !== '') indirect.add(v)
      }
    }
  }
  const all = [...direct].sort()
  return { refs: all.slice(0, 64), truncated: all.length > 64, indirect: [...indirect].sort() }
}

/**
 * Canonical cert id sanitation (gate ITAG-FORMAT, measured on 2026-10-11 fresh cc corpus):
 * `heuristics.cert_id` and reference-graph values sometimes carry the printed label itself
 * ('Certificate Number: 2023/144') — strip label prefixes; a value still containing whitespace
 * afterwards cannot be an i-taggable id → null (the record stays mirrored, tag-less).
 */
const CERT_LABEL_PREFIX =
  /^(?:certificate|certification|cert\.?)\s+(?:number|no\.?|id)\s*[:.]?\s*/iu

export function canonicalCertId(raw: unknown): string | null {
  const s = str(raw)
  if (s === null) return null
  const cleaned = s.replace(CERT_LABEL_PREFIX, '').trim()
  return cleaned === '' || /\s/u.test(cleaned) ? null : cleaned
}

/** eucc-pp-census §2.5 tidy: NFKC → uppercase → strip whitespace → unify BSI family → clean separators. */
export function tidyPpToken(token: string): string {
  let t = token.normalize('NFKC').toUpperCase().replace(/\s+/gu, '')
  t = t.replace(/^BSI[^A-Z0-9]*(?:CC[^A-Z0-9]*)?PP/u, 'BSI-CC-PP')
  t = t.replace(/[-_./]{2,}/gu, '-')
  t = t.replace(/^[-_./]+|[-_./]+$/gu, '')
  return t
}
