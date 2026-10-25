/**
 * Ledger schema + row types (bun:sqlite) — stage 1/3 idempotency bookkeeping.
 *
 * Design §§6.6: re-running an import with identical inputs emits nothing new. The ledger is keyed by
 * `(corpus, source_id)` and stores the source hash + generator version + the signed event ids it
 * produced, so `publish/` can skip events already acked by a relay (`publish_log`) and `build` can
 * detect unchanged sources.
 *
 * The DDL below is the contract; `index.ts` owns the connection and statements.
 */

/** Default DB path, relative to the invocation cwd (workspace rule: artifacts live in `artifacts/`). */
export const DEFAULT_LEDGER_PATH = 'artifacts/mirror.sqlite'

/** One upsertable row of the `records` table (stage 1 → stage 3 mapping). */
export interface LedgerRecordRow {
  /** Corpus key, e.g. `jcalgtest`. */
  corpus: string
  /** Corpus-scoped source identity, e.g. repo-relative CSV path or ground-truth record id. */
  sourceId: string
  /** SHA-256 (hex) of the raw source bytes this row was generated from. */
  sourceHash: string
  /** Generator version stamp; bump to force regeneration of identical sources. */
  genVersion: string
  /** Signed event ids produced for this source row (NDJSON order). */
  eventIds: string[]
  /** Distinct `i`-tag values present across `eventIds` (empty for corpus-level artifacts). */
  iSet: string[]
}

/** One row of `publish_log` — the NIP-20 outcome for (event, relay). */
export interface PublishLogRow {
  eventId: string
  relay: string
  ok: boolean
  msg: string | null
  ts: number
}

/** One row of `relays` — capability snapshot of a relay at probe/publish time. */
export interface RelayRow {
  relay: string
  capability: string | null
  ts: number | null
}

/** Whole-ledger read used by diagnostics, selftests and the publish summary. */
export interface LedgerSnapshot {
  records: LedgerRecordRow[]
  publishLog: PublishLogRow[]
  relays: RelayRow[]
}

/** Raw `records` row shape as stored (snake_case columns, JSON arrays as TEXT). */
export interface RecordDbRow {
  corpus: string
  source_id: string
  source_hash: string
  gen_version: string
  event_ids: string
  i_set: string
  updated_at: number
}

/** Raw `publish_log` row shape as stored. */
export interface PublishLogDbRow {
  event_id: string
  relay: string
  ok: number
  msg: string | null
  ts: number
}

/** Raw `relays` row shape as stored. */
export interface RelayDbRow {
  relay: string
  capability: string | null
  ts: number | null
}

export const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  corpus      TEXT    NOT NULL,
  source_id   TEXT    NOT NULL,
  source_hash TEXT    NOT NULL,
  gen_version TEXT    NOT NULL,
  event_ids   TEXT    NOT NULL,
  i_set       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (corpus, source_id)
);

CREATE TABLE IF NOT EXISTS publish_log (
  event_id TEXT    NOT NULL,
  relay    TEXT    NOT NULL,
  ok       INTEGER NOT NULL,
  msg      TEXT,
  ts       INTEGER NOT NULL,
  PRIMARY KEY (event_id, relay)
);

CREATE TABLE IF NOT EXISTS relays (
  relay      TEXT PRIMARY KEY,
  capability TEXT,
  ts         INTEGER
);
`

/** Parse a JSON-encoded text column tolerating legacy/garbage values as empty. */
function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** Map a raw `records` row to its typed form. */
export function rowToRecord(row: RecordDbRow): LedgerRecordRow {
  return {
    corpus: row.corpus,
    sourceId: row.source_id,
    sourceHash: row.source_hash,
    genVersion: row.gen_version,
    eventIds: parseJsonArray(row.event_ids),
    iSet: parseJsonArray(row.i_set),
  }
}

/** Map a raw `publish_log` row to its typed form. */
export function rowToPublishLog(row: PublishLogDbRow): PublishLogRow {
  return {
    eventId: row.event_id,
    relay: row.relay,
    ok: row.ok === 1,
    msg: row.msg,
    ts: row.ts,
  }
}

/** Map a raw `relays` row to its typed form. */
export function rowToRelay(row: RelayDbRow): RelayRow {
  return { relay: row.relay, capability: row.capability, ts: row.ts }
}
