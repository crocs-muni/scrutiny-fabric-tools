/**
 * Ledger — bun:sqlite-backed idempotency store (design §6.6).
 *
 * Stage 1 records what each source row produced; stage 3 records each relay's NIP-20 verdict per
 * event id ("resume-skip"). Re-running a build/publish with the same inputs is a no-op.
 *
 * API surface (frozen): openLedger, upsertRecords, markPublish, wasPublished, setRelayCapability,
 * readAll. `close()` is exposed for scripts that open non-default paths.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DEFAULT_LEDGER_PATH,
  LEDGER_SCHEMA_SQL,
  rowToPublishLog,
  rowToRecord,
  rowToRelay,
} from './schema'
import type {
  LedgerRecordRow,
  LedgerSnapshot,
  PublishLogDbRow,
  RecordDbRow,
  RelayDbRow,
} from './schema'

export { DEFAULT_LEDGER_PATH, LEDGER_SCHEMA_SQL } from './schema'
export type { LedgerRecordRow, LedgerSnapshot, PublishLogRow, RelayRow } from './schema'

/** Handle over one ledger database file (or `:memory:`). */
export class Ledger {
  readonly db: Database
  readonly path: string

  constructor(db: Database, path: string) {
    this.db = db
    this.path = path
  }

  /** Insert-or-update source rows (keyed by `(corpus, source_id)`); returns rows written. */
  upsertRecords(rows: LedgerRecordRow[]): number {
    const stmt = this.db.query(
      `INSERT INTO records (corpus, source_id, source_hash, gen_version, event_ids, i_set, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(corpus, source_id) DO UPDATE SET
         source_hash = excluded.source_hash,
         gen_version = excluded.gen_version,
         event_ids   = excluded.event_ids,
         i_set       = excluded.i_set,
         updated_at  = excluded.updated_at`,
    )
    const now = Date.now()
    this.db.transaction((items: LedgerRecordRow[]) => {
      for (const row of items) {
        stmt.run(
          row.corpus,
          row.sourceId,
          row.sourceHash,
          row.genVersion,
          JSON.stringify(row.eventIds),
          JSON.stringify(row.iSet),
          now,
        )
      }
    })(rows)
    return rows.length
  }

  /** Record the NIP-20 verdict for one `(event, relay)` pair; last write wins. */
  markPublish(eventId: string, relay: string, ok: boolean, msg: string | null): void {
    this.db
      .query(
        `INSERT INTO publish_log (event_id, relay, ok, msg, ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id, relay) DO UPDATE SET
           ok  = excluded.ok,
           msg = excluded.msg,
           ts  = excluded.ts`,
      )
      .run(eventId, relay, ok ? 1 : 0, msg, Date.now())
  }

  /** True when a relay has previously acked this event id (ok=1). Rejections do not skip. */
  wasPublished(eventId: string, relay: string): boolean {
    const row = this.db
      .query<PublishLogDbRow, [string, string]>(
        'SELECT event_id, relay, ok, msg, ts FROM publish_log WHERE event_id = ? AND relay = ?',
      )
      .get(eventId, relay)
    return row !== null && row.ok === 1
  }

  /** Upsert a relay capability snapshot (e.g. probe verdict or supported NIPs summary). */
  setRelayCapability(relay: string, capability: string | null): void {
    this.db
      .query(
        `INSERT INTO relays (relay, capability, ts) VALUES (?, ?, ?)
         ON CONFLICT(relay) DO UPDATE SET capability = excluded.capability, ts = excluded.ts`,
      )
      .run(relay, capability, Date.now())
  }

  /** Full dump for diagnostics/selftests/summaries. */
  readAll(): LedgerSnapshot {
    const records = this.db
      .query<RecordDbRow, []>('SELECT * FROM records ORDER BY corpus, source_id')
      .all()
      .map(rowToRecord)
    const publishLog = this.db
      .query<PublishLogDbRow, []>('SELECT * FROM publish_log ORDER BY event_id, relay')
      .all()
      .map(rowToPublishLog)
    const relays = this.db
      .query<RelayDbRow, []>('SELECT * FROM relays ORDER BY relay')
      .all()
      .map(rowToRelay)
    return { records, publishLog, relays }
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Open (creating if needed) the ledger at `path` — default `artifacts/mirror.sqlite`.
 * `:memory:` is supported for tests; parent directories are created for file paths.
 */
export function openLedger(path: string = DEFAULT_LEDGER_PATH): Ledger {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path, { create: true })
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(LEDGER_SCHEMA_SQL)
  return new Ledger(db, path)
}
