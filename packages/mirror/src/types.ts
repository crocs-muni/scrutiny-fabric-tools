/** @scrutiny-fabric/mirror shared contracts — frozen for v0. See README.md. */

export interface CardIdentity {
  /** cNNN zero-padded table index when matched in ground-truth/jcard-table.json, else null. */
  jcard: string | null
  /** Canonical card name (site/jcard-table or filename-derived for unmatched). */
  name: string
  /** Lowercase continuous hex, no separators; null when genuinely missing. */
  atr: string | null
  cplc: { fab: string; ictype: string; osid?: string } | null
  /** Verbatim corpus vendor string BEFORE slugify; slug applied in emit. */
  vendorRaw: string | null
  /** Exact declared version e.g. "3.0.5" ONLY when a run declares it; else null. */
  jcver: string | null
  /** Best current support summary (union over runs), filled by emit for product content. */
  familiesSupported: string[]
  sourceRunFiles: string[]
}

export type RunKind = 'ALGSUPPORT' | 'DATAFIXED' | 'DATADEPEND' | 'AIDSUPPORT'

export interface RunRecord {
  kind: RunKind
  /** Repo-relative path of the run CSV. */
  file: string
  /** SHA-256 of the raw CSV bytes (imeta x). */
  sha256: string
  /** Raw.githubusercontent.com URL of the file (imeta url + content link). */
  upstreamUrl: string
  sizeBytes: number
  atr: string | null
  cardName: string
  jcver: string | null
  /** Executed-at info; may be null (52 runs undated). */
  run: {
    date: string | null
    epochMs: number | null
    clientVersion: string | null
    appletVersion: string | null
    contributedBy: string | null
  }
  /** alg family slugs supported by this run (from yes rows / measured ops), empty if n/a. */
  families: string[]
  measuredCount?: number
  supportedCount?: number
  unsupportedCount?: number
  /** Registry-selected scalars (metric-canonicalization keys) or null when operation failed. */
  selected: Record<string, number | null>
  /** DATADEPEND: covered data lengths. AIDSUPPORT: package count. */
  lengths?: number[]
  packageCount?: number
  /** Notable prose facts (quirks, NO_SUCH_ALGORITHM sets) — short strings for content. */
  highlights: string[]
}

export interface LeaderboardRecord {
  metric: 'sign_ecdsa_p256_sha1_ms'
  cohortBucket: string // e.g. "jcver-lte:3.0.5"
  snapshot: string // ISO date of import
  /** [rank, jcard-or-null, cardName, ms] sorted ascending; members ≤ 62. */
  top: Array<[number, string | null, string, number]>
  excluded: { reason: string; count: number }[]
}

export interface CrosslinkRecord {
  cardJcard: string | null
  cardName: string
  cardAtr: string | null
  /** sec-certs cert record dgst (16-hex) + printed cert id etc. */
  certDgst: string
  certId: string
  scheme: string
  evidence: string[] // provenance strings (method + matched fields)
}

export interface SnapshotRecord {
  corpus: string // 'jcalgtest'
  snapshot: string
  tool: string
  counts: { cards: number; runs: number; crossings: number }
  datasetSha256: string
  source: string // upstream URL
}

export interface SourceBundle {
  cards: CardIdentity[]
  runs: RunRecord[]
  leaderboard: LeaderboardRecord
  crosslinks: CrosslinkRecord[]
  snapshot: SnapshotRecord
}

/** One signed event, ready for NDJSON + publish. Mirrors NIP-01 JSON. */
export interface SignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface Manifest {
  corpus: string
  snapshot: string
  producedAt: string
  counts: { products: number; metadata: number; bindings: number; patches: number; other: number }
  ledgerPreview: number // rows to upsert
  files: { ndjson: string }
}

export interface GateReport {
  ok: boolean
  eventCount: number
  errors: { event: string | null; code: string; detail: string }[]
  /** Self-consume: facts present in tags/record-card but missing from prose. */
  lostFacts: { event: string; fact: string }[]
}
