/**
 * emit/seccerts/roots.ts — sec-certs root projection (leg 2): SecCertsBundle → DesiredRoot[].
 *
 * Pure projection — no signing, no ledger, no clock. Emission order (update-semantics §5,
 * run-0 manifest): corpus Products (cc, eucc, pp, fips) → PP Products → cc records
 * (TOE Product + cert Metadata) → eucc records → fips records (module Product + validation
 * Metadata) → advisories sorted by CVE → snapshot Metadatas.
 *
 * Content follows design §4.1/§4.3.x: headline (first two lines carry the payload per rule
 * 8a), `- ` bullets, a Links block, and exactly one single-line `Record card (JSON): …` line
 * last (rule 8c — never fenced blocks). Rule 2a is oversupplied rather than relied on:
 * every card scalar and every `i` value is spelled out in prose (the gate re-checks with
 * lostFacts; the probe asserts lostFacts-empty for every produced root).
 */
import { sha256 } from '@noble/hashes/sha2.js'

import type {
  CveRelation,
  DesiredRoot,
  SecCertsBundle,
  SecCertsCertRecord,
  SecCertsCorpusDoc,
  SecCertsFipsRecord,
  SecCertsPpRecord,
} from '../../loaders/seccerts-types.js'
import { composeContent, familyList, vendorSlug } from '../content.js'

/** The one CVE with curated advisory text (design §4.3.10). */
export const ROCA_CVE = 'CVE-2017-15361'

/**
 * Import stamp of the initial corpus build (run 0). Later sync runs pass their own
 * stamp into `planRoots`/`planBundle`; the default keeps run 0 byte-deterministic.
 */
export const MIRROR_IMPORT_STAMP = '2026-10-11'

function sha256Hex(input: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(input))).toString('hex')
}

/** Non-empty strings in place; null/undefined/'' dropped (i-set and prose parts). */
function present(values: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) out.push(value)
  }
  return out
}

/** Corpus products and snapshots in the frozen corpus order (update-semantics §5). */
const CORPUS_ORDER: readonly string[] = [
  'seccerts/cc',
  'seccerts/eucc',
  'seccerts/pp',
  'seccerts/fips',
]

function orderedCorp(docs: readonly SecCertsCorpusDoc[]): SecCertsCorpusDoc[] {
  const out: SecCertsCorpusDoc[] = []
  for (const corpus of CORPUS_ORDER) {
    for (const doc of docs) if (doc.corpus === corpus) out.push(doc)
  }
  for (const doc of docs) if (!CORPUS_ORDER.includes(doc.corpus)) out.push(doc)
  return out
}

function countsLine(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts).map(([key, value]) => `${key} ${value}`)
  return parts.length === 0 ? 'no counts recorded in the dataset' : parts.join(', ')
}

function byteSize(sizeBytes: number | null): string {
  return sizeBytes === null ? 'size not published' : `${sizeBytes} bytes`
}

/**
 * Card `eal[]` values: the closed-list EAL FIRST, then the full security_level set as written
 * (design §4.2: eal[] = e.g. ['EAL5+','ALC_DVS.2','AVA_VAN.5']). Some records (SAR-only
 * security_level) carry no EAL element inside the set — the closed-list value from
 * `heuristics.eal` must still lead, or it lands in i-set/card but not in prose (rule 2a).
 */
function effectiveLevels(r: SecCertsCertRecord): string[] {
  const tail = r.securityLevel.filter((level) => level !== r.eal)
  return r.eal === null ? [...r.securityLevel] : [r.eal, ...tail]
}

/** "EAL5+ with ALC_DVS.2, AVA_VAN.5" — prose spelling for the eal tag and card array. */
/**
 * Emit-side `i + k + e + t` total (relay measures ALL single-char tags): i-tags, distinct
 * k-prefix tags derived from those values, the three `t` baseTags, e-couplings, imeta rows.
 * The mirror's imeta is an import-coupled attachment channel, not a discardable indexer —
 * it's inside the same budget though (imeta counts if the relay counts it).
 */
function evTagEstimate(iValues: readonly string[], e = 0, imeta = 0): number {
  const prefixes = new Set(iValues.map((v) => v.split(':')[0] ?? v))
  return iValues.length + prefixes.size + 3 + e + imeta
}

function levelsSentence(levels: readonly string[]): string {
  const [first, ...rest] = levels
  if (first === undefined) return 'no EAL recorded'
  return rest.length === 0 ? first : `${first} with ${rest.join(', ')}`
}

/**
 * Content-size discipline (relay wall = 65,535 bytes/event, ecosystem-wide 64 KiB): the design's
 * answer is summary + pointer (sec-certs cert.json/source page — full data stays upstream).
 * Heavy lists (CVEs, validation histories, version matrices, CAVP refs, maintenance entries)
 * are clip-rendered with an explicit, machine-checkable trait note. Advisory bindings carry the
 * COMPLETE per-CVE index — list clips lose no graph edges, only prose volume. The 55 KiB
 * soft cap under the relay's 65,535 keeps room for tag rows + the wrapping layer.
 */
const RELAY_CONTENT_SOFT_CAP = 55_000

/**
 * Total-tag budget (generic-relay safe): relays count ALL single-char tags (i, k derived, e,
 * t) against one hidden limit — measured reject class shows events at 65–72 total failing
 * while deliberate probes at ~75 i-tags pass; the enshrined IX-2 gate counts i-tags only.
 * Stock relay policies (khatru default and its relatives — nostr.wine et al.) live in the
 * 60–100 band, so the mirror budget for the sum is **60** with the baseTags overhead (3 t)
 * + e tags + imeta + derived k prefix tags (≈≤10) also accounted inside. IX-2's i≤64 cap
 * stays as the stricter single-family rule at the gate (unchanged).
 */
const TOTAL_TAG_BUDGET = 60

/** `1234, 5678`, …` — deterministic first-N clip with the note phrase provided by callers. */
function clipList<T>(items: readonly T[], cap: number): { kept: readonly T[]; rest: number } {
  return items.length <= cap
    ? { kept: items, rest: 0 }
    : { kept: items.slice(0, cap), rest: items.length - cap }
}

/** "CVE-2017-15361 (direct); CVE-… (transitive via …)" — §9 Q6 class words in prose. */
function cvePhrase(cves: readonly CveRelation[], cap = Number.POSITIVE_INFINITY): string {
  if (cves.length === 0) return 'none recorded'
  const { kept, rest } = clipList(cves, cap)
  const body = kept
    .map((c) => {
      if (c.cls === 'direct') return `${c.cve} (direct)`
      if (c.cls === 'transitive') {
        return c.via === null ? `${c.cve} (transitive)` : `${c.cve} (transitive via ${c.via})`
      }
      return `${c.cve} (maintenance)`
    })
    .join('; ')
  return rest === 0
    ? body
    : `${body}; … +${rest} more (clipped for the relay size wall — the complete set lives as advisory bindings rooted at this record)`
}

const TRIM_NOTE =
  '(clipped for the relay size wall — the complete set remains at the upstream cert.json / source page in Links)'

function validationPhrase(r: SecCertsFipsRecord, cap = Number.POSITIVE_INFINITY): string {
  if (r.validations.length === 0) return 'none recorded'
  const { kept, rest } = clipList(r.validations, cap)
  const body = kept.map(([date, label]) => `${date} (${label})`).join(' → ')
  return rest === 0 ? body : `${body} → … +${rest} ${TRIM_NOTE}`
}

/** Per-channel keep sizes (`hw …; fw …; sw …`) once a content budget demands a clip. */
const VERSIONS_CLIP = 24

function versionsPhrase(r: SecCertsFipsRecord, clip = false): string {
  if (!clip) {
    return versionsPhraseUncapped(r)
  }
  const parts = present([
    r.hwVersions.length === 0 ? null : `hw ${clipSentence(r.hwVersions, VERSIONS_CLIP)}`,
    r.fwVersions.length === 0 ? null : `fw ${clipSentence(r.fwVersions, VERSIONS_CLIP)}`,
    r.swVersions.length === 0 ? null : `sw ${clipSentence(r.swVersions, VERSIONS_CLIP)}`,
  ])
  return parts.length === 0 ? 'none recorded' : parts.join('; ')
}

function versionsPhraseUncapped(r: SecCertsFipsRecord): string {
  const parts = present([
    r.hwVersions.length === 0 ? null : `hw ${r.hwVersions.join(', ')}`,
    r.fwVersions.length === 0 ? null : `fw ${r.fwVersions.join(', ')}`,
    r.swVersions.length === 0 ? null : `sw ${r.swVersions.join(', ')}`,
  ])
  return parts.length === 0 ? 'none recorded' : parts.join('; ')
}

function clipSentence(items: readonly string[], cap: number, sep = '; '): string {
  const { kept, rest } = clipList(items, cap)
  return rest === 0 ? kept.join(sep) : `${kept.join(sep)}${sep}… +${rest} ${TRIM_NOTE}`
}

function certIdTag(r: SecCertsCertRecord): string | null {
  if (r.certId === null) return null
  return `${r.corpus === 'seccerts/eucc' ? 'eucc' : 'cc'}:${r.certId}`
}

function certPage(r: SecCertsCertRecord): string {
  return `https://sec-certs.org/${r.corpus === 'seccerts/eucc' ? 'eucc' : 'cc'}/${r.sourceId}/`
}

/** Upstream PDF links repeated in the Links block for non-imeta consumers (§4.1 rule 3). */
function upstreamCertLinks(r: SecCertsCertRecord): string[] {
  const links: string[] = []
  if (r.reportLink !== null) links.push(`Certification report (upstream PDF): ${r.reportLink}`)
  if (r.stLink !== null) links.push(`Security target (upstream PDF): ${r.stLink}`)
  if (r.certLink !== null) links.push(`Certificate (upstream): ${r.certLink}`)
  return links
}

/* (the capped validationPhrase/versionsPhrase helpers live with cvePhrase above,
 * next to the RELAY_CONTENT_SOFT_CAP constant — the earlier drop-in bodies were merged.) */

/** §11.6 status-led banner: ARCHIVED/sunset or REVOKED-with-reason above the fold. */
function fipsBanner(r: SecCertsFipsRecord): string {
  const last = r.validations.length === 0 ? undefined : r.validations[r.validations.length - 1]
  const lastDate = last === undefined ? null : last[0]
  const status = r.status === null ? '' : r.status.toLowerCase()
  if (status === 'historical')
    return `ARCHIVED (historical; sunset ${lastDate ?? 'date not recorded'})`
  if (status === 'revoked')
    return r.statusReason === null ? 'REVOKED' : `REVOKED — ${r.statusReason}`
  if (r.status === null) return 'status not recorded'
  return r.status.toUpperCase()
}

function fipsPolicyLine(r: SecCertsFipsRecord): string {
  if (r.policy.sha256 === null) {
    return `Policy PDF: ${r.policy.url ?? 'not published'} — no source hash published, upstream link only.`
  }
  return `Policy PDF pinned by the source record: sha256 ${r.policy.sha256} (${byteSize(r.policy.sizeBytes)}); certificate PDF is linked upstream only (no source hash published).`
}

function fipsPolicyImeta(r: SecCertsFipsRecord): string[][] {
  if (r.policy.url === null || r.policy.sha256 === null || r.policy.sizeBytes === null) return []
  return [
    [
      'imeta',
      `url ${r.policy.url}`,
      'm application/pdf',
      `x ${r.policy.sha256}`,
      `size ${r.policy.sizeBytes}`,
    ],
  ]
}

// ---------------------------------------------------------------------------
// advisories (assembled in emit from record cves — one Metadata per distinct CVE)
// ---------------------------------------------------------------------------

interface AdvisoryAggregate {
  cve: string
  aliases: string[]
  cwe: string[]
  disclosed: string | null
  /** Newest snapshot stamp among records referencing this CVE (provenance). */
  snapshot: string
  /** A `seccerts/cc` record references this CVE (gates the CC-network link). */
  ccVictim: boolean
}

function advisoriesFor(bundle: SecCertsBundle): AdvisoryAggregate[] {
  const agg = new Map<string, { snapshot: string; ccVictim: boolean }>()
  const add = (cve: string, snapshot: string, ccSide: boolean): void => {
    const prev = agg.get(cve)
    if (prev === undefined) {
      agg.set(cve, { snapshot, ccVictim: ccSide })
      return
    }
    if (snapshot > prev.snapshot) prev.snapshot = snapshot
    if (ccSide) prev.ccVictim = true
  }
  for (const r of bundle.cc) for (const c of r.cves) add(c.cve, r.snapshot, true)
  for (const r of bundle.eucc) for (const c of r.cves) add(c.cve, r.snapshot, false)
  for (const r of bundle.fips) for (const c of r.cves) add(c.cve, r.snapshot, false)
  for (const m of bundle.maintenance) for (const cve of m.cves) add(cve, m.snapshot, false)
  return [...agg.entries()]
    .map(([cve, v]) => {
      const curated =
        cve === ROCA_CVE
          ? { aliases: ['ROCA'], cwe: ['CWE-310'], disclosed: '2017-10' as string | null }
          : { aliases: [] as string[], cwe: [] as string[], disclosed: null as string | null }
      return {
        cve,
        aliases: curated.aliases,
        cwe: curated.cwe,
        disclosed: curated.disclosed,
        snapshot: v.snapshot,
        ccVictim: v.ccVictim,
      }
    })
    .sort((a, b) => (a.cve < b.cve ? -1 : a.cve > b.cve ? 1 : 0))
}

function advisoryRoot(a: AdvisoryAggregate): DesiredRoot {
  const iSet = present([`cve:${a.cve}`, ...a.cwe.slice(0, 4).map((c) => `cwe:${c}`)])
  const facets = a.cve === ROCA_CVE ? ['sec-certs', 'roca', 'jcalgtest'] : ['sec-certs']
  const sourceHash = sha256Hex(`cve-advisory@1|${a.cve}|${a.aliases.join(',')}|${a.cwe.join(',')}`)
  const network = 'sec-certs CC reference graph: https://sec-certs.org/cc/network/'

  let content: string
  if (a.cve === ROCA_CVE) {
    content = composeContent({
      headline: `ROCA — CVE-2017-15361: predictable RSA key generation in Infineon RSALib (disclosed 2017-10).\nAdvisory record cve:${a.cve} — aliases ${a.aliases.join(', ')}; cwe ${a.cwe.join(', ')}; source: sec-certs heuristics + NVD; mirrored snapshot ${a.snapshot}.`,
      bullets: [
        "Impact: RSA keys generated by affected Infineon cryptographic hardware (smart cards, TPMs, tokens) are factorable from the public key alone (Coppersmith's attack on a structured-prime weakness); devices dating back to at least 2012.",
        'Scope: independent of RNG quality; affects cryptographic hardware across vendors and firmware versions; an EAL4+/EAL5+ certificate does not imply immunity.',
        'CWE: CWE-310 (cryptographic issues); reference to the ACM CCS 2017 paper ("The Return of Coppersmith\'s Attack").',
        "Mirror provenance: this advisory is bound to each affected Product mirrored by this key, using sec-certs' derived cert↔CVE relation (sec-certs reports ~89% precision for its CVE/CPE mapping, arXiv:2311.17603) — treat bindings as source-derived, not authoritative.",
        'Binding semantics: absence of a binding means "no relation recorded in the mirrored source", not "verified clean"; new affected products appear as new bindings, never by patching this record.',
        "Mitigations (informational): vendor detection tools, key replacement, migration to ECC — outside this record's scope.",
      ],
      links: [
        `NVD: https://nvd.nist.gov/vuln/detail/${a.cve}`,
        'CRoCS ROCA page: https://crocs.fi.muni.cz/doku.php?id=public:papers:rsa_ccs17',
        network,
        'Mirrored by scrutiny-mirror from sec-certs derived data + NVD snapshot; not authored by MITRE or Infineon.',
      ],
      card: {
        type: 'cve-advisory@1',
        cve: a.cve,
        aliases: a.aliases,
        cwe: a.cwe,
        disclosed: a.disclosed,
        source: 'sec-certs heuristics + NVD',
        snapshot: a.snapshot,
      },
    })
  } else {
    const links = [`NVD: https://nvd.nist.gov/vuln/detail/${a.cve}`]
    if (a.ccVictim) links.push(network)
    links.push(
      'Mirrored by scrutiny-mirror from sec-certs derived data + NVD; not authored by MITRE.',
    )
    content = composeContent({
      headline:
        `${a.cve} — vulnerability referenced by mirrored certification records (sec-certs derived data).\n` +
        `Advisory record cve:${a.cve}; source: sec-certs heuristics + NVD; mirrored snapshot ${a.snapshot}.`,
      bullets: [
        'No curated description is published for this CVE in this mirror snapshot (design §11.8 rule 1: negative results are first-class content).',
        'Bindings to this advisory are source-derived: sec-certs heuristics link certification records to CVEs with ~89% precision (arXiv:2311.17603) — an association signal, not a patch list or a vendor confirmation.',
        'Binding semantics: absence of a binding means "no relation recorded in the mirrored source", not "verified clean"; new affected products appear as new bindings, never by patching this record.',
        `Mirrored by scrutiny-mirror from sec-certs derived data + NVD; snapshot ${a.snapshot}; not authored by MITRE.`,
      ],
      links,
      card: {
        type: 'cve-advisory@1',
        cve: a.cve,
        aliases: a.aliases,
        cwe: a.cwe,
        source: 'sec-certs heuristics + NVD',
        snapshot: a.snapshot,
      },
    })
  }

  return {
    corpus: 'seccerts/global',
    sourceId: `cve:${a.cve}`,
    role: 'advisory',
    sourceHash,
    iSet,
    facets,
    content,
    imeta: [],
  }
}

// ---------------------------------------------------------------------------
// cert records (cc / eucc): TOE Product + cert Metadata
// ---------------------------------------------------------------------------

function toeRoot(r: SecCertsCertRecord): DesiredRoot {
  const slug = vendorSlug(r.manufacturerRaw)
  const iSet = present([
    certIdTag(r),
    r.schemeTag === null ? null : `scheme:${r.schemeTag}`,
    slug === null ? null : `vendor:${slug}`,
  ])
  const levels = effectiveLevels(r)
  const levelSentence = levelsSentence(levels)
  const schemeWord =
    r.schemeName === null
      ? r.schemeTag === null
        ? 'scheme not recorded'
        : r.schemeTag
      : r.schemeTag === null
        ? r.schemeName
        : `${r.schemeName} (scheme:${r.schemeTag})`
  const page = certPage(r)
  const roca = r.cves.some((c) => c.cve === ROCA_CVE)
  const truncNote = r.directRefsTruncated
    ? ' (list truncated at the 64-reference cap; further references exist upstream)'
    : ''
  const lineageBullet =
    r.directRefs.length === 0
      ? `Lineage (sec-certs reference graph): no direct certificate references recorded${
          r.indirectRefs.length === 0
            ? ''
            : `; transitively references ${r.indirectRefs.join(', ')}`
        }.`
      : `Lineage (sec-certs reference graph): directly references ${r.directRefs.join(', ')}${truncNote}${
          r.indirectRefs.length === 0
            ? ''
            : `; transitively references ${r.indirectRefs.join(', ')}`
        }.`
  const maintenanceBullet =
    r.maintenance.length === 0
      ? 'Maintenance updates recorded: none in this snapshot.'
      : `Maintenance updates recorded: ${r.maintenance.length} (details on the certification-record event bound to this Product).`
  const cpeBullet =
    r.cpeMatches.length === 0
      ? 'Fuzzy CPE matches: none recorded (sec-certs association-quality field; verified_cpe_matches is empty corpus-wide).'
      : `Fuzzy CPE matches (sec-certs association-quality — ~89% precision, arXiv:2311.17603; content only, never an indexer): ${r.cpeMatches.join('; ')}.`

  const assemble = (cveCap: number, cpeCap: number): string =>
    composeContent({
      headline:
        `${r.name} — ${r.certId ?? r.sourceId} — ${schemeWord}, ${levelSentence} (certified TOE Product).\n` +
        `Record dgst ${r.sourceId}; status ${r.status ?? 'unrecorded'}; valid ${r.notValidBefore ?? '(not recorded)'} → ${r.notValidAfter ?? '(not recorded)'}; snapshot ${r.snapshot}.`,
      bullets: [
        `Vendor: ${r.manufacturerRaw ?? 'not recorded'}${slug === null ? '' : ` (vendor:${slug})`}; category: ${r.category ?? 'not recorded'}; evaluation facility: ${r.certLab ?? 'not recorded'}.`,
        `Certification: ${r.certId ?? 'no printed cert id'} — ${levelSentence}; status ${r.status ?? 'unrecorded'}; valid ${r.notValidBefore ?? '(not recorded)'} → ${r.notValidAfter ?? '(not recorded)'}.`,
        maintenanceBullet,
        lineageBullet,
        `Related CVE (sec-certs heuristics): ${cvePhrase(r.cves, cveCap)}; class words follow §9 Q6 (direct / transitive via …); absence means no recorded relation, not verified clean.`,
        r.cpeMatches.length === 0
          ? 'Fuzzy CPE matches: none recorded (sec-certs association-quality field; verified_cpe_matches is empty corpus-wide).'
          : `Fuzzy CPE matches (sec-certs association-quality — ~89% precision, arXiv:2311.17603; content only, never an indexer): ${clipSentence(r.cpeMatches, cpeCap)}.`,
      ],
      links: [
        `Source page: ${page}`,
        `Full record JSON: ${page}cert.json`,
        ...upstreamCertLinks(r),
        `Mirrored by scrutiny-mirror from sec-certs.org snapshot ${r.snapshot}; not authored or endorsed by ${r.manufacturerRaw ?? 'the manufacturer'}.`,
      ],
      card: {
        type: 'sec-certs-cc-toe@1',
        dgst: r.sourceId,
        cert_id: r.certId,
        scheme: r.schemeTag,
        eal: levels,
        status: r.status,
        valid_from: r.notValidBefore,
        valid_until: r.notValidAfter,
        vendor: slug,
        cpe_fuzzy: r.cpeMatches.slice(0, cpeCap),
        snapshot: r.snapshot,
      },
    })

  let content = ''
  for (const [cveCap, cpeCap] of TOE_LADDER) {
    content = assemble(cveCap, cpeCap)
    if (Buffer.byteLength(content, 'utf8') <= RELAY_CONTENT_SOFT_CAP) break
  }

  return {
    corpus: r.corpus,
    sourceId: r.sourceId,
    role: 'product',
    sourceHash: r.sourceHash,
    iSet,
    facets: roca ? ['sec-certs', 'roca'] : ['sec-certs'],
    content,
    imeta: [],
  }
}

const TOE_LADDER: Array<[number, number]> = [
  [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  [96, 96],
  [48, 48],
  [16, 24],
]

const MODULE_LADDER: Array<[number, boolean]> = [
  [Number.POSITIVE_INFINITY, false],
  [96, true],
  [48, true],
  [16, true],
]

function certMetadataRoot(
  r: SecCertsCertRecord,
  ppByDgst: ReadonlyMap<string, SecCertsPpRecord>,
): DesiredRoot {
  const slug = vendorSlug(r.manufacturerRaw)
  const core = present([certIdTag(r), ...r.ppRefsResolved.map((pp) => `pp:${pp}`)])
  const tail = present([
    r.eal === null ? null : `eal:${r.eal}`,
    r.schemeTag === null ? null : `scheme:${r.schemeTag}`,
    slug === null ? null : `vendor:${slug}`,
    ...r.algFamilies.slice(0, 10).map((f) => `alg:${f}`),
    // §3.2: the CPE 2.3 formatted string is the value verbatim (its own `cpe:` scheme is
    // part of the canonical form — never doubled; parsers split on the first `:` only, IR-3).
    ...r.cpeMatches.slice(0, 3).map((c) => (c.startsWith('cpe:') ? c : `cpe:${c}`)),
    ...r.directRefs.slice(0, 64).map((ref) => (ref.startsWith('cc:') ? ref : `cc:${ref}`)),
  ])
  const unresolvedAll = r.ppRefsUnresolved.map((pp) => `pp:${pp}`)
  // The imeta row count derives from the same artifact predicates the builder's imeta block
  // uses (sha256 present AND sizeBytes non-null — never fabricate size-only rows).
  const extras =
    (r.artifacts.report !== undefined && r.artifacts.report.sizeBytes !== null ? 1 : 0) +
    (r.artifacts.st !== undefined && r.artifacts.st.sizeBytes !== null ? 1 : 0) +
    (r.artifacts.cert !== undefined && r.artifacts.cert.sizeBytes !== null ? 1 : 0)
  const budgetNotes: string[] = []
  // Generic-relay TOTAL-tag budget (TOTAL_TAG_BUDGET ⇒ measured reject class was 65+): drop
  // from lowest-priority tag families until i+k+e+t+imeta fits, in a deterministic order:
  //  1. unresolved pp (tag-only tokens that anchor nothing),
  //  2. trailing cc:<ref> references (content keeps the full list),
  //  3. cpe: extras (association-quality, already content-complete),
  //  4. trailing alg: family tokens (family-level indexers; PQC stays first by priority),
  // the essential `cc:`/`eucc:`/eal/scheme/vendor and resolved pp:<dgst> membership tags are
  // never trimmed here (their discovery semantics run the corpus).
  const unresolvedKept = [...unresolvedAll]
  let iSet = [...core, ...unresolvedKept, ...tail]
  const recompute = (): void => {
    iSet = [...core, ...unresolvedKept, ...tail]
  }
  if (evTagEstimate(iSet, 0, extras) > TOTAL_TAG_BUDGET) {
    while (unresolvedKept.length > 0 && evTagEstimate(iSet, 0, extras) > TOTAL_TAG_BUDGET) {
      unresolvedKept.pop()
      recompute()
    }
    budgetNotes.push(
      `${unresolvedAll.length - unresolvedKept.length} unresolved pp: tags dropped first (generic-relay tag budget ${TOTAL_TAG_BUDGET}; tokens remain in the card and prose)`,
    )
  }
  const refStart = tail.length - r.directRefs.slice(0, 64).length
  while (tail.length > refStart && evTagEstimate(iSet, 0, extras) > TOTAL_TAG_BUDGET) {
    tail.pop()
    budgetNotes.push('trailing cc: reference tag dropped to fit the generic-relay tag budget')
    recompute()
  }
  const algTagCount = Math.min(10, r.algFamilies.length)
  const cpeStart = 3 + algTagCount
  while (tail.length > cpeStart && evTagEstimate(iSet, 0, extras) > TOTAL_TAG_BUDGET) {
    tail.splice(tail.length - 1, 1)
    budgetNotes.push('trailing cpe: tag dropped to fit the generic-relay tag budget')
    recompute()
  }
  while (tail.length > 3 + 2 && evTagEstimate(iSet, 0, extras) > TOTAL_TAG_BUDGET) {
    // from the lowest-priority alg families (hash/curve slugs trail after pq/asym), still
    // leaving the lead two tags (cert-critical families at the head of the block).
    tail.splice(tail.length - 1, 1)
    budgetNotes.push('trailing alg: tag dropped to fit the generic-relay tag budget')
    recompute()
  }
  // Hard floor: the essential triple (cert-id/eal+scheme/vendor + resolved pp:<dgst>) is
  // never trimmed — a record that physically cannot fit still emits; a budget overflow
  // beats a silently missing certificate record.

  const levels = effectiveLevels(r)
  const levelSentence = levelsSentence(levels)
  const page = certPage(r)
  const ppParts = r.ppRefsResolved.map((dgst) => {
    const pp = ppByDgst.get(dgst)
    const alias = pp === undefined ? undefined : pp.printedAliases[0]
    const namePart =
      pp === undefined ? '' : `, ${pp.name}${pp.version === null ? '' : ` v${pp.version}`}`
    return `${alias === undefined ? '' : `${alias} `}(pp:${dgst}${namePart})`
  })
  const ppBullet =
    r.ppRefsResolved.length === 0
      ? 'Protection Profiles: none resolved — absence is source-side, not a statement of no conformity.'
      : `Protection Profiles (record-resolved; membership bindings published): ${ppParts.join('; ')}.`
  const ppUnresolvedBullet =
    r.ppRefsUnresolved.length === 0
      ? null
      : `Unresolved PP references (tag-only, no PP record or binding): ${unresolvedAll.join('; ')}.`
  const maintenanceBullet =
    r.maintenance.length === 0
      ? 'Maintenance updates: none recorded in the parent record.'
      : `Maintenance updates (parent record; links verbatim): ${r.maintenance
          .map(
            (m) =>
              `${m.date ?? '(undated)'} ${m.title ?? '(untitled)'}${
                m.reportLink === null ? '' : ` (report ${m.reportLink})`
              }${m.stLink === null ? '' : ` (ST ${m.stLink})`}`,
          )
          .join('; ')}.`
  const truncNote = r.directRefsTruncated
    ? ' (truncated at the 64-reference cap; further references exist upstream)'
    : ''
  const lineageBullet =
    r.directRefs.length === 0
      ? `Lineage (sec-certs reference graph): directly references no certificates${
          r.indirectRefs.length === 0
            ? ''
            : `; transitively references ${r.indirectRefs.join(', ')}`
        }.`
      : `Lineage (sec-certs reference graph): directly references ${r.directRefs.join(', ')}${truncNote}${
          r.indirectRefs.length === 0
            ? ''
            : `; transitively references ${r.indirectRefs.join(', ')}`
        }.`
  const artifactParts: string[] = []
  if (r.artifacts.report !== undefined) {
    artifactParts.push(
      `report sha256 ${r.artifacts.report.sha256} (${byteSize(r.artifacts.report.sizeBytes)})`,
    )
  }
  if (r.artifacts.st !== undefined) {
    artifactParts.push(`ST sha256 ${r.artifacts.st.sha256} (${byteSize(r.artifacts.st.sizeBytes)})`)
  }
  if (r.artifacts.cert !== undefined) {
    artifactParts.push(
      `certificate sha256 ${r.artifacts.cert.sha256} (${byteSize(r.artifacts.cert.sizeBytes)})`,
    )
  }
  const artifactBullet =
    artifactParts.length === 0
      ? 'Artifact hashes: none published by the source record — upstream PDFs are linked only.'
      : `Artifact hashes (reused from the sec-certs state for mirrored PDFs): ${artifactParts.join('; ')}.`
  const algUnknownPart =
    r.algUnknown.length === 0
      ? ''
      : `; unmapped algorithm names (content/card only): ${r.algUnknown.join(', ')}`
  const algBullet = `Algorithm families evidenced (family-level indexers): ${
    r.algFamilies.length === 0 ? 'none recorded' : familyList(r.algFamilies)
  }${algUnknownPart}.`
  const cpeBullet =
    r.cpeMatches.length === 0
      ? 'Fuzzy CPE matches: none recorded.'
      : `Fuzzy CPE matches (sec-certs association-quality — ~89% precision, arXiv:2311.17603; cpe: indexers carry the first ${Math.min(3, r.cpeMatches.length)}): ${r.cpeMatches.join('; ')}.`

  const CERT_LADDER: Array<[number, number, number]> = [
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    [96, 48, 96],
    [48, 24, 48],
    [16, 12, 24],
  ]

  const imeta: string[][] = []
  if (r.artifacts.report !== undefined && r.artifacts.report.sizeBytes !== null) {
    imeta.push([
      'imeta',
      `url ${r.artifacts.report.url}`,
      'm application/pdf',
      `x ${r.artifacts.report.sha256}`,
      `size ${r.artifacts.report.sizeBytes}`,
    ])
  }
  if (r.artifacts.st !== undefined && r.artifacts.st.sizeBytes !== null) {
    imeta.push([
      'imeta',
      `url ${r.artifacts.st.url}`,
      'm application/pdf',
      `x ${r.artifacts.st.sha256}`,
      `size ${r.artifacts.st.sizeBytes}`,
    ])
  }
  if (r.artifacts.cert !== undefined && r.artifacts.cert.sizeBytes !== null) {
    imeta.push([
      'imeta',
      `url ${r.artifacts.cert.url}`,
      'm application/pdf',
      `x ${r.artifacts.cert.sha256}`,
      `size ${r.artifacts.cert.sizeBytes}`,
    ])
  }

  const assemble = (cveCap: number, maintCap: number, cpeCap: number): string => {
    const cappedMaintenance =
      r.maintenance.length === 0
        ? 'Maintenance updates: none recorded in the parent record.'
        : `Maintenance updates (parent record; links verbatim): ${r.maintenance
            .slice(0, maintCap)
            .map(
              (m) =>
                `${m.date ?? '(undated)'} ${m.title ?? '(untitled)'}${
                  m.reportLink === null ? '' : ` (report ${m.reportLink})`
                }${m.stLink === null ? '' : ` (ST ${m.stLink})`}`,
            )
            .join('; ')}${
            r.maintenance.length <= maintCap
              ? ''
              : `; … +${r.maintenance.length - maintCap} ${TRIM_NOTE}`
          }.`
    const cappedCpe =
      r.cpeMatches.length === 0
        ? 'Fuzzy CPE matches: none recorded.'
        : `Fuzzy CPE matches (sec-certs association-quality — ~89% precision, arXiv:2311.17603; cpe: indexers carry the first ${Math.min(3, r.cpeMatches.length)}): ${clipSentence(r.cpeMatches, cpeCap)}.`
    return composeContent({
      headline:
        `${r.certId ?? r.sourceId} — ${r.name}, ${levelSentence} (${r.schemeName ?? 'scheme not recorded'}, ${r.status ?? 'status unrecorded'}).\n` +
        `Certification record: dgst ${r.sourceId}; scheme ${r.schemeTag ?? 'unrecorded'}${
          r.certLab === null ? '' : `; evaluation facility ${r.certLab}`
        }; status ${r.status ?? 'unrecorded'}; valid ${r.notValidBefore ?? '(not recorded)'} → ${
          r.notValidAfter ?? '(not recorded)'
        }; snapshot ${r.snapshot}.`,
      bullets: [
        `TOE: ${r.name}${r.manufacturerRaw === null ? '' : ` (${r.manufacturerRaw})`}; category: ${r.category ?? 'not recorded'}.`,
        `Scheme: ${r.schemeName ?? 'not recorded'} (scheme:${r.schemeTag ?? 'unrecorded'}); evaluation facility: ${r.certLab ?? 'not recorded'}; vendor: ${r.manufacturerRaw ?? 'not recorded'}${slug === null ? '' : ` (vendor:${slug})`}.`,
        `Assurance: ${levelSentence}; status ${r.status ?? 'unrecorded'}; certification valid ${r.notValidBefore ?? '(not recorded)'} → ${r.notValidAfter ?? '(not recorded)'}.`,
        ppBullet,
        ...(ppUnresolvedBullet === null ? [] : [ppUnresolvedBullet]),
        cappedMaintenance,
        lineageBullet,
        `Related CVE (sec-certs heuristics): ${cvePhrase(r.cves, cveCap)} — bound as advisories on the TOE Product, never as indexers here.`,
        cappedCpe,
        algBullet,
        artifactBullet,
        ...(budgetNotes.length === 0 ? [] : [`Indexer budget (§3.6): ${budgetNotes.join('; ')}.`]),
      ],
      links: [
        `Source page: ${page}`,
        `Full record JSON: ${page}cert.json`,
        ...upstreamCertLinks(r),
        `Mirrored by scrutiny-mirror from sec-certs.org snapshot ${r.snapshot}; derived fields (CPE/CVE/reference heuristics) are sec-certs' output, not the mirror's; not authored or endorsed by ${r.manufacturerRaw ?? 'the manufacturer'}.`,
      ],
      card: {
        type: 'sec-certs-cc-record@1',
        dgst: r.sourceId,
        cert_id: r.certId,
        scheme: r.schemeTag,
        status: r.status,
        eal: levels,
        pp: [...r.ppRefsResolved, ...r.ppRefsUnresolved],
        vendor: slug,
        maintenance: r.maintenance.slice(0, maintCap).map((m) => [m.date, m.title]),
        related_cves: [...new Set(r.cves.map((c) => c.cve))].slice(0, cveCap),
        direct_refs: r.directRefs,
        alg_unknown: r.algUnknown,
        snapshot: r.snapshot,
      },
    })
  }

  let content = ''
  for (const [cveCap, maintCap, cpeCap] of CERT_LADDER) {
    content = assemble(cveCap, maintCap, cpeCap)
    if (Buffer.byteLength(content, 'utf8') <= RELAY_CONTENT_SOFT_CAP) break
  }

  return {
    corpus: r.corpus,
    sourceId: r.sourceId,
    role: 'metadata',
    sourceHash: r.sourceHash,
    iSet,
    facets: r.cves.some((c) => c.cve === ROCA_CVE) ? ['sec-certs', 'roca'] : ['sec-certs'],
    content,
    imeta,
  }
}

// ---------------------------------------------------------------------------
// PP Products
// ---------------------------------------------------------------------------

function ppRoot(pp: SecCertsPpRecord, membership: number): DesiredRoot {
  const alias = pp.printedAliases[0]
  const iSet = present([
    `pp:${pp.sourceId}`,
    alias === undefined ? null : `pp:${alias}`,
    pp.schemeTag === null ? null : `scheme:${pp.schemeTag}`,
  ])
  const aliases = pp.printedAliases
  const links: string[] = [`PP record page: https://sec-certs.org/pp/${pp.sourceId}/`]
  if (pp.link !== null) links.push(`Upstream PP document: ${pp.link}`)

  const content = composeContent({
    headline:
      `${alias ?? pp.sourceId} — ${pp.name}${pp.version === null ? '' : `, v${pp.version}`} (${
        pp.schemeName ?? 'scheme not recorded'
      }, ${pp.status ?? 'status unrecorded'}).\n` +
      `PP record pp:${pp.sourceId}; scheme ${pp.schemeTag ?? 'unrecorded'}; snapshot ${pp.snapshot}; membership feed #i pp:${pp.sourceId}.`,
    bullets: [
      `Version: ${pp.version ?? 'not recorded'}; status: ${pp.status ?? 'not recorded'}; scheme: ${pp.schemeName ?? 'not recorded'}${
        pp.schemeTag === null ? '' : ` (scheme:${pp.schemeTag})`
      }; source: ${pp.source}.`,
      `Membership: ${membership} mirrored certification record${membership === 1 ? '' : 's'} claim conformity via pp:${pp.sourceId} (cc record-resolved + eucc keyword-alias channels) — per-cert membership bindings are published; membership feed query: #i pp:${pp.sourceId}.`,
      aliases.length === 0
        ? 'Printed scheme id: none derivable for this PP record (112/607 records carry no printable id — eucc-pp-census §2.2).'
        : `Printed scheme id${aliases.length === 1 ? '' : 's'} (alias table): ${aliases.join(', ')}.`,
      `Mirrored by scrutiny-mirror from the sec-certs PP dataset, snapshot ${pp.snapshot}; key pp:${pp.sourceId}; not authored or endorsed by ${pp.vendorRaw ?? 'the PP authors'}; upstream cadence weekly.`,
    ],
    links,
    card: {
      type: 'sec-certs-pp@1',
      pp: pp.sourceId,
      pp_alias: alias ?? null,
      name: pp.name,
      version: pp.version,
      scheme: pp.schemeTag,
      source: pp.source,
      snapshot: pp.snapshot,
    },
  })

  return {
    corpus: 'seccerts/pp',
    sourceId: pp.sourceId,
    role: 'product',
    sourceHash: pp.sourceHash,
    iSet,
    facets: ['sec-certs'],
    content,
    imeta: [],
  }
}

// ---------------------------------------------------------------------------
// FIPS: module Product + validation Metadata
// ---------------------------------------------------------------------------

function fipsLinks(r: SecCertsFipsRecord): string[] {
  const page = `https://sec-certs.org/fips/${r.sourceId}/`
  return present([
    `Source page: ${page}`,
    `Full record: ${page}cert.json`,
    r.certificatePdfUrl === null ? null : `Certificate PDF (upstream): ${r.certificatePdfUrl}`,
    r.policy.url === null ? null : `Policy PDF (upstream): ${r.policy.url}`,
    `Mirrored by scrutiny-mirror from sec-certs.org snapshot ${r.snapshot}; not authored or endorsed by ${r.vendorRaw ?? 'the vendor'}.`,
  ])
}

function fipsReadableLines(r: SecCertsFipsRecord): {
  moduleLine: string
  vendorLine: string
  statusLine: string
  versionsLine: string
} {
  const moduleLine = `Module: ${r.module} — ${r.moduleType ?? 'module type not recorded'}${
    r.embodiment === null ? '' : `, ${r.embodiment}`
  }${r.level === null ? '' : `; FIPS ${r.standard} Level ${r.level}`}.`
  const vendorLine = `Vendor: ${r.vendorRaw ?? 'not recorded'}; lab: ${r.certLab ?? 'not recorded'}; validation history (chronological): ${validationPhrase(r)}.`
  const statusLine = `Status: ${r.status ?? 'not recorded'}${
    r.statusReason === null ? '' : ` — reason: ${r.statusReason}`
  }.`
  const versionsLine = `Versions: ${versionsPhrase(r)}.`
  return { moduleLine, vendorLine, statusLine, versionsLine }
}

function fipsModuleRoot(r: SecCertsFipsRecord): DesiredRoot {
  const slug = vendorSlug(r.vendorRaw)
  const fipsId = `${r.standard}-${r.certId}`
  const iSet = present([`fips:${fipsId}`, slug === null ? null : `vendor:${slug}`])
  const banner = fipsBanner(r)
  const readable = fipsReadableLines(r)

  const assembleModule = (cveCap: number, clipVers: boolean): string =>
    composeContent({
      headline:
        `${banner} — FIPS ${r.standard} #${r.certId} ${r.module} (module Product).\n` +
        `Module: ${r.module}${r.moduleType === null ? '' : ` — ${r.moduleType}`}; vendor ${r.vendorRaw ?? 'not recorded'}${
          slug === null ? '' : ` (vendor:${slug})`
        }; snapshot ${r.snapshot}.`,
      bullets: [
        readable.moduleLine,
        readable.vendorLine,
        readable.statusLine,
        clipVers ? `Versions: ${versionsPhrase(r, true)}.` : readable.versionsLine,
        `Related CVE (sec-certs heuristics): ${cvePhrase(r.cves, cveCap)}; advisory bindings root at this module Product.`,
        fipsPolicyLine(r),
      ],
      links: fipsLinks(r),
      card: {
        type: 'sec-certs-fips-module@1',
        cert_id: r.certId,
        fips: fipsId,
        module: r.module,
        module_type: r.moduleType,
        vendor: slug,
        snapshot: r.snapshot,
      },
    })

  let content = ''
  for (const [cveCap, clipVers] of MODULE_LADDER) {
    content = assembleModule(cveCap, clipVers)
    if (Buffer.byteLength(content, 'utf8') <= RELAY_CONTENT_SOFT_CAP) break
  }

  return {
    corpus: 'seccerts/fips',
    sourceId: r.sourceId,
    role: 'product',
    sourceHash: r.sourceHash,
    iSet,
    facets: r.cves.some((c) => c.cve === ROCA_CVE) ? ['sec-certs', 'roca'] : ['sec-certs'],
    content,
    imeta: [],
  }
}

const FIPS_CLIPS = [Number.POSITIVE_INFINITY, 96, 48, 32] as const

function fipsMetadataRoot(r: SecCertsFipsRecord): DesiredRoot {
  const slug = vendorSlug(r.vendorRaw)
  const fipsId = `${r.standard}-${r.certId}`
  const fixed = present([`fips:${fipsId}`, slug === null ? null : `vendor:${slug}`])
  let algTags = r.algFamilies.slice(0, 10).map((f) => `alg:${f}`)
  const cavpTags = r.cavpRefs.map((c) => `cavp:${c}`)
  const directTags = r.directRefs.map((ref) => (ref.startsWith('fips:') ? ref : `fips:${ref}`))
  const budgetNotes: string[] = []
  // Same generic-relay TOTAL-tag budget as the cert builder (TOTAL_TAG_BUDGET; relay counts
  // i+k+e+t, extras = the fips policy imeta row): drop order matches the historical 64-cap
  // behavior — alg families first (content still lists them), then CAVP refs, then cross
  // refs; the essential fips:/vendor tags never trim.
  const extrasFips = r.policy.sha256 !== null ? 1 : 0
  const fipsEstimate = (): number =>
    evTagEstimate([...fixed, ...algTags, ...cavpTags, ...directTags], 0, extrasFips)
  if (fipsEstimate() > TOTAL_TAG_BUDGET) {
    budgetNotes.push(
      `algorithm family tags omitted to fit the generic-relay tag budget ${TOTAL_TAG_BUDGET} (CAVP reference completeness takes priority)`,
    )
    algTags = []
  }
  while (fipsEstimate() > TOTAL_TAG_BUDGET && cavpTags.length > 0) {
    cavpTags.pop()
  }
  if (cavpTags.length < r.cavpRefs.length) {
    budgetNotes.push(
      `CAVP reference tags truncated to ${cavpTags.length} of ${r.cavpRefs.length} (generic-relay tag budget ${TOTAL_TAG_BUDGET})`,
    )
  }
  while (fipsEstimate() > TOTAL_TAG_BUDGET && directTags.length > 0) {
    directTags.pop()
  }
  if (directTags.length < r.directRefs.length) {
    budgetNotes.push(
      `cross-reference tags truncated to ${directTags.length} of ${r.directRefs.length} (generic-relay tag budget ${TOTAL_TAG_BUDGET})`,
    )
  }
  const iSet = [...fixed, ...algTags, ...cavpTags, ...directTags]

  const banner = fipsBanner(r)
  const readable = fipsReadableLines(r)
  const algUnknownPart =
    r.algUnknown.length === 0
      ? ''
      : `; unmapped algorithm names (content/card only): ${r.algUnknown.join(', ')}`

  const assemble = (cveCap: number, validCap: number, cavpCap: number, clipVers: boolean): string =>
    composeContent({
      headline:
        `${banner} — FIPS ${r.standard} #${r.certId} ${r.module} (validation record).\n` +
        `Validation record fips:${fipsId}; status ${r.status ?? 'unrecorded'}; level ${
          r.level ?? 'not recorded'
        }; vendor ${r.vendorRaw ?? 'not recorded'}${
          slug === null ? '' : ` (vendor:${slug})`
        }; snapshot ${r.snapshot}.`,
      bullets: [
        readable.moduleLine,
        `Vendor: ${r.vendorRaw ?? 'not recorded'}; lab: ${r.certLab ?? 'not recorded'}; validation history (chronological): ${validationPhrase(r, validCap)}.`,
        readable.statusLine,
        clipVers ? `Versions: ${versionsPhrase(r, true)}.` : readable.versionsLine,
        `Algorithm families evidenced (family-level indexers): ${
          r.algFamilies.length === 0 ? 'none recorded' : familyList(r.algFamilies)
        }${algUnknownPart}.`,
        `CAVP algorithm references (raw list): ${
          r.cavpRefs.length === 0 ? 'none recorded' : clipSentence(r.cavpRefs, cavpCap)
        }.`,
        `Related CVE (sec-certs heuristics): ${cvePhrase(r.cves, cveCap)}; see the advisory bindings rooted at this module Product.`,
        `Cross-referenced validations (module_processed_references): ${
          r.directRefs.length === 0 ? 'none recorded' : r.directRefs.join(', ')
        }.`,
        fipsPolicyLine(r),
        ...(budgetNotes.length === 0
          ? []
          : [
              `Indexer budget (§3.6): ${budgetNotes.join('; ')}; the full lists remain in this prose and the record card.`,
            ]),
      ],
      links: fipsLinks(r),
      card: {
        type: 'sec-certs-fips-record@1',
        cert_id: r.certId,
        fips: fipsId,
        status: r.status,
        level: r.level,
        module_type: r.moduleType,
        vendor: slug,
        validations: r.validations.slice(0, validCap),
        cavp: r.cavpRefs.slice(0, cavpCap),
        related_cves: [...new Set(r.cves.map((c) => c.cve))].slice(0, cveCap),
        alg_unknown: r.algUnknown,
        snapshot: r.snapshot,
      },
    })

  // Content-budget ladder: full → clipped cuts; worst measured offender was 134 KB, so a
  // second level at 48 and a floor at 16 keeps every documented heavy record under the wall.
  const LADDER: Array<[number, number, number, boolean]> = [
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false],
    [96, 96, 96, true],
    [48, 64, 64, true],
    [16, 32, 32, true],
  ]
  let content = ''
  for (const [cveCap, validCap, cavpCap, clipVers] of LADDER) {
    content = assemble(cveCap, validCap, cavpCap, clipVers)
    if (Buffer.byteLength(content, 'utf8') <= RELAY_CONTENT_SOFT_CAP) break
  }

  return {
    corpus: 'seccerts/fips',
    sourceId: r.sourceId,
    role: 'metadata',
    sourceHash: r.sourceHash,
    iSet,
    facets: r.cves.some((c) => c.cve === ROCA_CVE) ? ['sec-certs', 'roca'] : ['sec-certs'],
    content,
    imeta: fipsPolicyImeta(r),
  }
}

// ---------------------------------------------------------------------------
// corpus Products + snapshot Metadatas
// ---------------------------------------------------------------------------

function corpusRoot(doc: SecCertsCorpusDoc): DesiredRoot {
  const content = composeContent({
    headline: `${doc.label} — mirrored sec-certs corpus cover (snapshot ${doc.snapshot}).`,
    bullets: [
      `Corpus: ${doc.corpus} (${doc.label}); this cover anchors every mirrored record of the corpus plus its snapshot Metadatas via Bindings.`,
      `Counts of this import: ${countsLine(doc.counts)}.`,
      `Source: ${doc.datasetUrl} — dataset sha256 ${doc.datasetSha256} (pinned on the snapshot Metadata via imeta).`,
      `Ledger namespace: records and relations of this corpus live under ${doc.corpus} in the mirror's ledger (update-semantics §3).`,
      'Discovery: this cover carries no i anchor by design (design §9 Q2) — find it via the topic facet t sec-certs and via its Bindings to the snapshot Metadata and to the corpus records.',
      'Provenance: public sec-certs.org open data (CroCS, Masaryk University; MIT tooling), mirrored by scrutiny-mirror; upstream cadence weekly.',
    ],
    links: [`Dataset: ${doc.datasetUrl}`],
    card: {
      type: 'seccerts-corpus@1',
      corpus: doc.corpus,
      label: doc.label,
      snapshot: doc.snapshot,
      counts: doc.counts,
    },
  })

  return {
    corpus: doc.corpus,
    sourceId: doc.corpus,
    role: 'corpus',
    sourceHash: sha256Hex(`${doc.corpus}|${doc.snapshot}|${JSON.stringify(doc.counts)}`),
    iSet: [],
    facets: ['sec-certs'],
    content,
    imeta: [],
  }
}

function snapshotRoot(
  doc: SecCertsCorpusDoc,
  importStamp: string,
  recordCount: number,
): DesiredRoot {
  const toolLine = doc.tool === '' ? 'not stamped in the dataset' : doc.tool
  const content = composeContent({
    headline: `Dataset snapshot — ${doc.label}, ${doc.snapshot} (tool ${toolLine}).`,
    bullets: [
      `Corpus: ${doc.corpus} — ${doc.label}; snapshot ${doc.snapshot}.`,
      `Counts of this import: ${countsLine(doc.counts)}.`,
      `Tool: ${toolLine} (sec-certs version from the dataset state).`,
      `Import: executed ${importStamp}; changes: initial import of ${recordCount} record${
        recordCount === 1 ? '' : 's'
      } — first mirrored snapshot of this corpus.`,
      `Dataset attached: exact bytes of ${doc.datasetUrl}, sha256 ${doc.datasetSha256}, ${doc.datasetSizeBytes} bytes, pinned via imeta.`,
      'Provenance: sec-certs.org open data (CroCS, Masaryk University; MIT tooling), mirrored by scrutiny-mirror; upstream cadence weekly; every snapshot root is kept forever (update-semantics §4).',
    ],
    links: [`Dataset: ${doc.datasetUrl}`],
    card: {
      type: 'dataset-snapshot@1',
      corpus: doc.corpus,
      snapshot: doc.snapshot,
      tool: doc.tool,
      counts: doc.counts,
      dataset_sha256: doc.datasetSha256,
      source: doc.datasetUrl,
    },
  })

  return {
    corpus: doc.corpus,
    sourceId: `${doc.corpus}:${doc.snapshot}`,
    role: 'snapshot',
    sourceHash: sha256Hex(`${doc.datasetSha256}|${doc.snapshot}|${doc.corpus}`),
    iSet: [],
    facets: ['sec-certs'],
    content,
    imeta: [
      [
        'imeta',
        `url ${doc.datasetUrl}`,
        'm application/json',
        `x ${doc.datasetSha256}`,
        `size ${doc.datasetSizeBytes}`,
      ],
    ],
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Plan every root event of the leg-2 bundle, in emission order (update-semantics §5).
 * `importStamp` feeds the snapshot/run content only; it never changes root identity.
 */
export function planRoots(
  bundle: SecCertsBundle,
  importStamp: string = MIRROR_IMPORT_STAMP,
): DesiredRoot[] {
  const ppByDgst = new Map<string, SecCertsPpRecord>()
  for (const pp of bundle.pp) ppByDgst.set(pp.sourceId, pp)
  const membership = new Map<string, number>()
  for (const r of bundle.cc) {
    for (const dgst of r.ppRefsResolved) membership.set(dgst, (membership.get(dgst) ?? 0) + 1)
  }
  for (const r of bundle.eucc) {
    for (const dgst of r.ppRefsResolved) membership.set(dgst, (membership.get(dgst) ?? 0) + 1)
  }

  const corp = orderedCorp(bundle.corp)
  const recordCounts: Record<string, number> = {
    'seccerts/cc': bundle.cc.length,
    'seccerts/eucc': bundle.eucc.length,
    'seccerts/pp': bundle.pp.length,
    'seccerts/fips': bundle.fips.length,
  }
  const out: DesiredRoot[] = []
  for (const doc of corp) out.push(corpusRoot(doc))
  for (const pp of bundle.pp) out.push(ppRoot(pp, membership.get(pp.sourceId) ?? 0))
  for (const r of bundle.cc) out.push(toeRoot(r), certMetadataRoot(r, ppByDgst))
  for (const r of bundle.eucc) out.push(toeRoot(r), certMetadataRoot(r, ppByDgst))
  for (const r of bundle.fips) out.push(fipsModuleRoot(r), fipsMetadataRoot(r))
  for (const a of advisoriesFor(bundle)) out.push(advisoryRoot(a))
  for (const doc of corp) {
    out.push(snapshotRoot(doc, importStamp, recordCounts[doc.corpus] ?? 0))
  }
  return out
}
