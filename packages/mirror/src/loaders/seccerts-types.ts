/**
 * seccerts-types.ts — leg-2 intermediate representation (IR) between `loaders/seccerts-*` and
 * `emit/seccerts/*`. Contract file: extend `src/types.ts` is FORBIDDEN (NOT-in-scope), so leg-2
 * types live here. Follow `docs/mirroring/design.md` + `update-semantics.md` (2026-10-11).
 *
 * LIFECYCLE INVARIANTS the engine relies on (do not weaken):
 *  - `sourceId` values are logical keys (record `dgst`; never event ids).
 *  - `sourceHash` = `state.<primary>.json_hash` when the record provides one, else SHA-256 of the
 *    loader's normalized projection bytes (stable key order, LF). The engine emits iff it changes.
 *  - Every relation (advisory binding, PP membership, record binding) is a first-class ledger row
 *    keyed by a deterministic logical `relationId` — disappearance must deterministically retract.
 */
import type { SignedEvent } from '../types.js'

// ---------------------------------------------------------------------------
// shared vocabulary (design §3.3/§3.4)
// ---------------------------------------------------------------------------

/** Closed alg family slugs (§3.4) — must stay a subset of emit/content.ts FAMILY_LABELS keys. */
export const ALG_FAMILIES = [
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
  'aes',
  '3des',
  'sha-2',
  'sha-3',
  'hmac',
  'chacha20',
  'secp256r1',
  'secp384r1',
  'secp521r1',
  'ed25519',
  'ed448',
  'x25519',
  'x448',
] as const
export type AlgFamily = (typeof ALG_FAMILIES)[number]

/** Provenance class of a cert↔CVE relation (design §9 Q6 + maintenance amendment). */
export type CveClass = 'direct' | 'transitive' | 'maintenance'

export interface CveRelation {
  cve: string // MITRE canonical, e.g. CVE-2017-15361
  cls: CveClass
  /** For 'transitive': the referencing cert id bridging to the CVE, when derivable; else null. */
  via: string | null
}

/** Ledger hash provenance — which hash the loader reused/computed (next-leg §Ledger conventions). */
export type SourceHashKind = 'json_hash' | 'normalized-sha256'

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/**
 * CC or EUCC certificate record projection. EUCC differences (ground-truth/eucc-pp-census):
 * `certId` = top-level `cert_id` verbatim (never `heuristics.cert_id`); `schemeTag` null for the
 * 5 EU-scheme records; PP refs ride the keyword alias channel only; records carry no `cc:` i tag.
 */
export interface SecCertsCertRecord {
  corpus: 'seccerts/cc' | 'seccerts/eucc'
  /** Logical key — record dgst. */
  sourceId: string
  sourceHash: string
  sourceHashKind: SourceHashKind
  name: string
  manufacturerRaw: string | null
  /** 2-letter lowercase scheme code (frozen mapping); null for EUCC EU-scheme records. */
  schemeTag: string | null
  /** Human scheme name for prose (e.g. "BSI", "EUCC"); best effort. */
  schemeName: string | null
  /** Canonical printed cert id for the `cc:`/`eucc:` i value; null = no tag (106 cc records). */
  certId: string | null
  /** Closed-list achieved level (`EAL1`…`EAL7`, optional `+`); null when unrecorded. */
  eal: string | null
  /** Full `security_level` set incl. augmentation components — content only. */
  securityLevel: string[]
  status: string | null
  notValidBefore: string | null
  notValidAfter: string | null
  category: string | null
  certLab: string | null
  reportLink: string | null
  stLink: string | null
  certLink: string | null
  manufacturerWeb: string | null
  /** Record-resolved PP references (`pp:<dgst>` values), deduped, sorted. */
  ppRefsResolved: string[]
  /** Unresolved PP references — `tidy(token)` values for tag-only `pp:<tidy>`; sorted. */
  ppRefsUnresolved: string[]
  /** Direct certificate reference-graph outgoing ids (report ∪ st directly_referencing), ≤64. */
  directRefs: string[]
  /** True when `directRefs` was truncated to 64 — content must carry a truncation note. */
  directRefsTruncated: boolean
  /** Transitive closure — CONTENT ONLY (IX-4). */
  indirectRefs: string[]
  /** related_cves → 'direct'; direct/indirect_transitive_cves → 'transitive'; maintenance rows → 'maintenance'. */
  cves: CveRelation[]
  /** §3.4 family slugs evidenced by this record, priority order (pq > asymmetric > symmetric > hash), ≤10. */
  algFamilies: AlgFamily[]
  /** Evidenced algorithm names NOT in the closed list → record-card `alg_unknown[]` only. */
  algUnknown: string[]
  /** Fuzzy CPE matches (association-quality): first ≤3 become `cpe:` i tags; ALL go to content/card. */
  cpeMatches: string[]
  /** Parent-side full maintenance array (4-tuples) — cc only; eucc: []. */
  maintenance: Array<{
    date: string | null
    title: string | null
    reportLink: string | null
    stLink: string | null
  }>
  /** imeta-pinnable upstream artifacts (only when the record publishes `state.*.source_hash`). */
  artifacts: {
    report?: { url: string; sha256: string; sizeBytes: number | null } | undefined
    st?: { url: string; sha256: string; sizeBytes: number | null } | undefined
    cert?: { url: string; sha256: string; sizeBytes: number | null } | undefined
  }
  /** sec-certs dataset snapshot stamp for `snapshot` record-card/content fields. */
  snapshot: string
}

export interface SecCertsPpRecord {
  corpus: 'seccerts/pp'
  sourceId: string // dgst
  sourceHash: string
  sourceHashKind: SourceHashKind
  name: string
  version: string | null
  schemeTag: string | null
  schemeName: string | null
  vendorRaw: string | null // PP author/sponsor when present, else null
  status: string | null
  /** Printed scheme ids derived per ground-truth/eucc-pp-census §2.5 (495/607 typical); 0..n. */
  printedAliases: string[]
  /** Upstream page link base (pp_link / report_link) for content. */
  link: string | null
  source: string // e.g. 'commoncriteriaportal.org' or marker for NIAP etc.
  snapshot: string
}

export interface SecCertsFipsRecord {
  corpus: 'seccerts/fips'
  sourceId: string // dgst
  sourceHash: string
  sourceHashKind: SourceHashKind
  certId: string // bare number, e.g. '1148'
  /** Standard-qualified id for `fips:` i value: `140-1`, `140-2`, `140-3`. */
  standard: string
  module: string
  vendorRaw: string | null
  status: string | null // active | historical | revoked
  statusReason: string | null
  level: number | null // 1..4
  moduleType: string | null // Hardware | Software | Firmware | hybrids (content only)
  embodiment: string | null // content only
  hwVersions: string[]
  fwVersions: string[]
  swVersions: string[]
  /** [date, label] validation history entries, chronological; labels verbatim. */
  validations: Array<[string, string]>
  /** Normalized CAVP refs (`aes-987`, `sha-2-954`, `3des-773`); token family-mapped (§3.3). */
  cavpRefs: string[]
  algFamilies: AlgFamily[]
  algUnknown: string[]
  cves: CveRelation[]
  /** FIPS cross-references: `fips:<std>-<num>` tags for module_processed_references. */
  directRefs: string[]
  certificatePdfUrl: string | null
  /** Policy PDF — imeta-pinnable only when `state.policy.source_hash` exists. */
  policy: { url: string | null; sha256: string | null; sizeBytes: number | null }
  certLab: string | null
  snapshot: string
}

export interface SecCertsMaintenanceRecord {
  corpus: 'seccerts/maintenance'
  /** Child dgst: `cert_<parent16hex>_update_<16hex>`. */
  sourceId: string
  sourceHash: string
  sourceHashKind: SourceHashKind
  /** Parent cert dgst (`related_cert_digest`; also embedded in `sourceId`). */
  parentDgst: string
  date: string | null
  name: string | null
  reportLink: string | null
  stLink: string | null
  /** Harvested CVE ids from `pdf_data.*_keywords.vulnerability` (deepdive §4.1), deduped, sorted. */
  cves: string[]
  snapshot: string
}

/**
 * A global advisory = one Metadata per distinct CVE corpus-wide (`seccerts/global`).
 * Victims = affected products bound via advisory bindings; assembled IN EMIT from record cves,
 * not by loaders (loaders only attach `cves` to their records).
 */
export interface SecCertsAdvisoryRecord {
  corpus: 'seccerts/global'
  /** `cve:CVE-XXXX-YYYY` — logical key. */
  sourceId: string
  /** Fingerprint of (cve, aliases, cwe) — advisory content template inputs; ledger source_hash. */
  sourceHash: string
  cve: string
  aliases: string[]
  cwe: string[]
  snapshot: string
}

/** Corpus Product + snapshot Metadata inputs, one entry per sec-certs corpus imported. */
export interface SecCertsCorpusDoc {
  /** `seccerts/cc` | `seccerts/eucc` | `seccerts/pp` | `seccerts/fips` */
  corpus: string
  label: string // human: 'sec-certs CC corpus'
  snapshot: string // dataset timestamp
  tool: string // sec-certs tool version — empty string when absent from the file
  counts: Record<string, number>
  datasetSha256: string // of the dataset.json bytes fetched (imeta pin)
  datasetUrl: string // upstream URL
  datasetSizeBytes: number
}

/**
 * A card↔cert cross-link pair (decision 2026-10-11; ground-truth/crosslink-matrix.json,
 * JCAlgTest issue-#264 method). Corpora: the ledger row lives under `seccerts/cc` (CC landing
 * triggers emission); the binding's `e root` is a leg-1 `jcalgtest` card Product and its
 * `e link` is this leg's cert Metadata.
 */
export interface SecCertsCrosslink {
  corpus: 'seccerts/cc'
  /** `jcard:<cNNN>` — the leg-1 card Product's ledger source id. Unmapped cards never reach here. */
  cardKey: string
  cardName: string
  cardAtr: string | null
  certDgst: string
  certId: string | null
  scheme: string | null
  /** Evidence strings verbatim from crosslink-matrix.json (method + matched fields). */
  evidence: string[]
  score: number | null
}

export interface SecCertsBundle {
  cc: SecCertsCertRecord[]
  eucc: SecCertsCertRecord[]
  pp: SecCertsPpRecord[]
  fips: SecCertsFipsRecord[]
  maintenance: SecCertsMaintenanceRecord[]
  crosslinks: SecCertsCrosslink[]
  corp: SecCertsCorpusDoc[]
  /** Loader-side diagnostics the run summary echoes (never throwing on data, only on IO). */
  warnings: string[]
  stats: {
    ppResolved: number
    ppUnresolved: number
    ppUnresolvableProse: number
    cveDirect: number
    cveTransitive: number
    cveMaintenance: number
    distinctCves: number
  }
}

// ---------------------------------------------------------------------------
// emit-facing planning (DesiredState) — the engine's input per corpus run
// ---------------------------------------------------------------------------

/** One planned root event (unsigned) — engine diffs this against the ledger's roots rows. */
export interface DesiredRoot {
  corpus: string
  sourceId: string
  /** product|metadata|advisory|corpus|snapshot|leaderboard */
  role: string
  sourceHash: string
  /** Full `i` tag values in emission order — the re-root diff key (role-immutable). */
  iSet: string[]
  /** `k` prefixes are derived from `iSet` in emit; facets NOT in iSet (t tags only). */
  facets: string[]
  /** Complete content bytes per emit/content.ts rules (headline … record-card line). */
  content: string
  /** imeta rows (NIP-92): `[['imeta', 'url …', 'm …', 'x …', 'size …'], …]`. */
  imeta: string[][]
  /** Set only on a re-root: the old root event id to supersede (engine fills from ledger). */
  supersedes?: string
}

/** One planned binding — a first-class relation row keyed by `relationId`. */
export interface DesiredRelation {
  corpus: string // ledger namespace owning the row (update-semantics §3)
  /** Deterministic logical id, e.g. `record:<dgst>` | `pp:<certDgst>:<ppDgst>` | `adv:<productDgst>:<cve>:<cls>` | `adv-maint:<updateDgst>:<cve>`. */
  relationId: string
  kind: 'record' | 'pp-membership' | 'advisory-victim' | 'crosslink'
  /** Logical keys of the endpoints (engine resolves to current root event ids). */
  rootRef: { corpus: string; sourceId: string; role: 'product'; label: string }
  linkRef: { corpus: string; sourceId: string; role: 'metadata' | 'advisory'; label: string }
  /** Binding provenance class for advisory-victim edges. */
  cls: CveClass | null
  /** sha256 over the canonical assertion tuple (relationId|cls|content scalars) — R2/R3 diff key. */
  fingerprint: string
  facets: string[]
  headline: string
  bullets: string[]
  links: string[]
}

/** per-corpus desired state — engine input. */
export interface DesiredState {
  roots: DesiredRoot[]
  relations: DesiredRelation[]
  /** Per-corpus source_id set for C5 (disappeared-record) detection. */
  sourceIdsByCorpus: Record<string, string[]>
}

/** Engine output: signed batch + ledger patch plan + manifest-shaped counts. */
export interface EngineResult {
  events: SignedEvent[]
  /** Ledger rows the publisher applies alongside publish acks. */
  rootRows: Array<{
    corpus: string
    sourceId: string
    role: string
    rootEventId: string
    tipEventId: string
    tipContent: string
    contentHash: string
    iSet: string[]
    /** NIP-92 imeta rows as emitted — part of the re-root diff key; optional for legacy rows. */
    imeta?: string[][]
    sourceHash: string
    genVersion: string
    state: 'live' | 'retired'
  }>
  relationRows: Array<{
    corpus: string
    relationId: string
    kind: string
    subjectId: string
    objectKey: string
    fingerprint: string
    eventId: string
    state: 'live' | 'retracted'
  }>
  /** Kind-5 deletion events are part of `events` too; ids listed here for the run summary. */
  retractions: string[]
  counts: {
    newRoots: number
    patches: number
    reRoots: number
    newRelations: number
    retractedRelations: number
    replacedRelations: number
    unchanged: number
    disappeared: number
  }
  warnings: string[]
}
