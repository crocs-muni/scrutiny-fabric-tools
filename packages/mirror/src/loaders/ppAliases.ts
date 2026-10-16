/**
 * ppAliases.ts — PP alias table per ground-truth/eucc-pp-census §2.5 (EXACT rule).
 *
 * Cert-side PP references arrive as noisy keyword tokens (`BSI-PP-0035`, `BSI-CC-PP0035-2007`,
 * `BSI-PP- 0035-2007`, maintenance suffixes `…-MA-02`, …). A reference resolves to a PP-dataset
 * `dgst` — never to a raw token (§2.3 verdict). Keys claimed by 2+ records are dataset-level
 * collisions and stay unresolved (§2.5 conservative policy).
 *
 * The derivation is a straight port of the census script (`C:/tmp/eucc_pp_census_v2.py`,
 * reproduce line of eucc-pp-census.md) and reproduces its measured table on the 2026-09-23
 * pp dataset byte-for-byte: 618 keys, 601 unambiguous, 17 collision keys / 29 records.
 *
 * `printedAliases` also feeds the PP Product's printed-id alias (§2.5/§2.6) and is ordered
 * most-specific-first (a version/year-bearing id precedes its bare form) so `[0]` — the alias
 * the emit layer tags and prints (design §4.3.3) — is the full printed id.
 */
import { str, tidyPpToken } from './seccerts-common.js'

type Dict = Record<string, unknown>

/** Narrow an unknown JSON value to a plain object. */
function dict(value: unknown): Dict | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null
}

/** akey(t): tidy + strip ALL non-alphanumerics + fold a trailing MA0*N → MAN (§2.5). */
function akey(token: string): string {
  return tidyPpToken(token)
    .replace(/[^A-Z0-9]/gu, '')
    .replace(/MA0*(\d+)$/u, 'MA$1')
}

/** Lookup keys for a token: akey, then akey with trailing MA\d+ / M\d+ stripped (§2.5 kvar). */
function kvar(token: string): string[] {
  const key = akey(token)
  const out = [key]
  for (const rx of [/MA\d+$/u, /M\d+$/u]) {
    const base = key.replace(rx, '')
    if (base !== '' && base !== key && !out.includes(base)) out.push(base)
  }
  return out
}

/**
 * Printed ids derived from the record's own portal links (§2.5 candidate rules), a port of the
 * census `link_ids`: DE `ppNNNN[Vn]` + `not_valid_before` year; FR `ANSSI-CC*_PP-YYYY-NN`,
 * `pp[cr]YYYYNN` / `pp[cr]YYNN`; KR `KECS-PP-nnnn-yyyy`; JP `JISEC-CC-PP-Cnnnn-yyyy`;
 * plus `scheme_metadata.pp_short_name` (NIAP/US) on any scheme.
 */
function linkIds(doc: Dict): string[] {
  const web = dict(doc['web_data']) ?? {}
  const scheme = (str(web['scheme']) ?? '').toUpperCase()
  const year = (str(web['not_valid_before']) ?? '').slice(0, 4)
  const ids = new Set<string>()
  for (const rawLink of [web['report_link'], web['pp_link']]) {
    const link = str(rawLink)
    if (link === null) continue
    const file = link.split('/').pop() ?? ''
    const de = /\bpp\s*0*(\d{3,4})(?:[-_ ]*v\s*(\d+))?/iu.exec(file)
    if (scheme === 'DE' && de !== null && de[1] !== undefined) {
      const num = de[1].padStart(4, '0')
      const base = `BSI-CC-PP-${num}${de[2] === undefined ? '' : `-V${de[2]}`}`
      ids.add(base)
      if (year !== '') ids.add(`${base}-${year}`)
    }
    if (scheme === 'FR') {
      const anssi = /ANSSI-CC[^_]*_PP-(\d{4})-(\d{2})/iu.exec(file)
      if (anssi !== null) ids.add(`ANSSI-CC-PP-${anssi[1]}/${anssi[2]}`)
      const yyyy = /^pp(?:cr)?(\d{4})(\d{2})en?\.pdf/iu.exec(file)
      if (yyyy !== null) ids.add(`ANSSI-CC-PP-${yyyy[1]}/${yyyy[2]}`)
      const yy = /^pp(?:cr)?(\d{2})(\d{2})[a-z]*\.pdf$/iu.exec(file)
      if (
        yy !== null &&
        yy[1] !== undefined &&
        yy[2] !== undefined &&
        /^pp(?:cr)?(\d{4})(\d{2})/iu.exec(file) === null
      ) {
        const century = Number(yy[1]) < 50 ? '20' : '19'
        ids.add(`ANSSI-CC-PP-${century}${yy[1]}/${yy[2]}`)
      }
    }
    const kecs = /(KECS-PP-\d{4}-\d{4})/iu.exec(file)
    if (scheme === 'KR' && kecs !== null && kecs[1] !== undefined) ids.add(kecs[1].toUpperCase())
    const jisec = /(JISEC-CC-PP-C\d{4}-\d{4})/iu.exec(file)
    if (scheme === 'JP' && jisec !== null && jisec[1] !== undefined) ids.add(jisec[1].toUpperCase())
  }
  const short = str(dict(doc['scheme_metadata'])?.['pp_short_name'])
  if (short !== null) ids.add(short)
  return [...ids]
}

/**
 * Dominant own-keyword id of the record's scheme family (FR ANSSI / KR KECS / JP JISEC), used
 * only when the links carry no id (§2.5). Port of the census `kw_own`: keyword counts merge
 * `report_keywords` + `pp_keywords` (`{schemeFamily: {token: count}}`), the winning token is the
 * raw token (tidy happens later, in the key), ties break on first encounter.
 */
function kwOwn(doc: Dict): string[] {
  const web = dict(doc['web_data']) ?? {}
  const scheme = (str(web['scheme']) ?? '').toUpperCase()
  const prefix =
    scheme === 'FR' ? /^ANSSI/u : scheme === 'KR' ? /^KECS/u : scheme === 'JP' ? /^JISEC/u : null
  if (prefix === null) return []
  const pdf = dict(doc['pdf_data']) ?? {}
  const counts: Dict = {}
  for (const side of ['report_keywords', 'pp_keywords']) {
    const family = dict(dict(pdf[side])?.['cc_protection_profile_id'])
    if (family === null) continue
    for (const inner of Object.values(family)) {
      const tokens = dict(inner)
      if (tokens === null) continue
      for (const [token, count] of Object.entries(tokens)) {
        if (typeof count !== 'number') continue
        const prev = counts[token]
        counts[token] = (typeof prev === 'number' ? prev : 0) + count
      }
    }
  }
  let best: string | null = null
  let bestCount = -1
  for (const [token, count] of Object.entries(counts)) {
    if (typeof count !== 'number' || !prefix.test(token.toUpperCase())) continue
    if (count > bestCount) {
      best = token
      bestCount = count
    }
  }
  return best === null ? [] : [best]
}

/** Per-record candidate ids: link-derived first; own-keyword fallback only when links are bare. */
function candidateIds(doc: Dict): string[] {
  const fromLinks = linkIds(doc)
  return fromLinks.length > 0 ? fromLinks : kwOwn(doc)
}

export interface PpAliasTable {
  /** Keyword token → PP record dgst, or null for unresolved/collision (§2.5 exact rule). */
  resolve: (token: string) => string | null
  /** dgst → derived printed ids (for the PP Product `pp:<alias>` tag, §2.5/§2.6), most specific first. */
  printedAliases: Map<string, string[]>
  /**
   * `keys` = distinct lookup keys incl. collisions; `collisions` = subset claimed by 2+ records
   * (census §2.2: 618 keys / 17 collision keys / 601 unambiguous on the 2026-09-23 snapshot).
   */
  stats: { keys: number; collisions: number }
}

// Re-export: sibling loaders import the tidy rule from this module (kept as the PP-ids home).
export { tidyPpToken }

/**
 * Build the per-import alias table from raw PP dataset docs (record-first, collisions dropped).
 * Ordering of `printedAliases` values is most-specific-first (longest id, then lexicographic).
 */
export function buildPpAliasTable(ppDocs: Record<string, unknown>[]): PpAliasTable {
  const claimants = new Map<string, Set<string>>()
  const printedAliases = new Map<string, string[]>()

  for (const doc of ppDocs) {
    const dgst = str(doc['dgst'])
    if (dgst === null) continue
    const ids = candidateIds(doc)
    // Gate rule (ITAG-FORMAT): a tag value must not carry raw whitespace. Printed ids keep
    // their published separator forms (design §3.3 `pp:ANSSI-CC-PP-2021/02`) — resolve lookup
    // keys already normalize via akey/tidy, so only the DISPLAY/tag value needs the space run
    // collapsed out ('ANSSI-CC-PP 2008/05M01' → 'ANSSI-CC-PP 2008/05M01' is taggable only
    // without the space → 'ANSSI-CC-PP2008/05M01' misleading; drop the space cleanly).
    const tagIds = [
      ...new Set(ids.map((id) => id.replace(/\s+/gu, '')).filter((id) => id !== '')),
    ].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    printedAliases.set(dgst, tagIds)
    for (const id of ids) {
      for (const variant of kvar(id)) {
        if (variant === '') continue
        let set = claimants.get(variant)
        if (set === undefined) {
          set = new Set()
          claimants.set(variant, set)
        }
        set.add(dgst)
      }
    }
  }

  const resolved = new Map<string, string>()
  let collisions = 0
  for (const [key, set] of claimants) {
    const only = [...set][0]
    if (set.size === 1 && only !== undefined) resolved.set(key, only)
    else collisions += 1
  }

  const resolve = (token: string): string | null => {
    for (const variant of kvar(token)) {
      const hit = resolved.get(variant)
      if (hit !== undefined) return hit
    }
    return null
  }

  return { resolve, printedAliases, stats: { keys: claimants.size, collisions } }
}

/**
 * Prose-alias family (§2.6): `PP-SSCD…` descriptors are not ids — never tagged `pp:`, never
 * resolved. Exact census rule (`prose()` in the census script): `^PP[- ]?SSCD` after uppercase +
 * space removal; the measured unresolved-prose set is this family alone (835 occurrences / 42
 * distinct tokens on the CC side).
 */
export function isProseAlias(token: string): boolean {
  return /^PP-?SSCD/u.test(token.toUpperCase().replace(/ /gu, ''))
}
