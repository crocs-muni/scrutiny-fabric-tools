/**
 * seccertsLedger.ts — ledger v1 for the sec-certs corpora (update-semantics.md §1).
 *
 * Two additive tables over the same sqlite file opened by `openLedger`; leg-1's
 * `records`/`publish_log`/`relays` tables and ALL leg-1 files stay untouched:
 * this module owns its own DDL (CREATE IF NOT EXISTS) and row accessors.
 *
 * INVARIANTS (engine-enforced):
 *  - `roots`   : one row per emitted root; `tip_event_id` + full `tip_content` — patches are
 *                diffs against it; `i_set` + `imeta` are the re-root diff keys (imeta rows are
 *                immutable after publication, IX-3, so a moved pin re-roots, never patches).
 *  - `relations`: every binding is a row keyed by logical `relation_id`; disappearance ⇒
 *                `state='retracted'` + a kind-5 naming the stored `event_id` (CLASS-4).
 */
import type { Database } from 'bun:sqlite'

export const SECCERTS_GEN_VERSION = 'seccerts-v1'

const SECCERTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roots (
  corpus       TEXT    NOT NULL,
  source_id    TEXT    NOT NULL,
  role         TEXT    NOT NULL,
  root_event_id TEXT   NOT NULL,
  tip_event_id TEXT    NOT NULL,
  tip_content  TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  i_set        TEXT    NOT NULL,
  imeta        TEXT    NOT NULL DEFAULT '[]',
  source_hash  TEXT    NOT NULL,
  gen_version  TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'live',
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (corpus, source_id, role)
);

CREATE TABLE IF NOT EXISTS relations (
  corpus       TEXT    NOT NULL,
  relation_id  TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  subject_id   TEXT    NOT NULL,
  object_key   TEXT    NOT NULL,
  fingerprint  TEXT    NOT NULL,
  event_id     TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'live',
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (corpus, relation_id)
);
`

export interface RootRow {
  corpus: string
  sourceId: string
  role: string
  rootEventId: string
  tipEventId: string
  tipContent: string
  contentHash: string
  iSet: string[]
  /** Emitted NIP-92 imeta rows (JSON round-trip) — part of the re-root diff key (2026-10-11). */
  imeta: string[][]
  sourceHash: string
  genVersion: string
  state: 'live' | 'retired'
  updatedAt: number
}

/**
 * Upsert payload for `upsertRoots`. `imeta` is optional so callers holding a legacy/engine row
 * without the column do not clobber a stored set; the engine always supplies it.
 */
export type RootUpsertRow = Omit<RootRow, 'updatedAt' | 'imeta'> & { imeta?: string[][] }

export interface RelationRow {
  corpus: string
  relationId: string
  kind: string
  subjectId: string
  objectKey: string
  fingerprint: string
  eventId: string
  state: 'live' | 'retracted'
  updatedAt: number
}

interface RootDbRow {
  corpus: string
  source_id: string
  role: string
  root_event_id: string
  tip_event_id: string
  tip_content: string
  content_hash: string
  i_set: string
  imeta: string
  source_hash: string
  gen_version: string
  state: string
  updated_at: number
}

interface RelationDbRow {
  corpus: string
  relation_id: string
  kind: string
  subject_id: string
  object_key: string
  fingerprint: string
  event_id: string
  state: string
  updated_at: number
}

function parseStrArray(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Parse the JSON `imeta` column into rows of tag-value strings (junk-tolerant). */
function parseImeta(raw: string | null): string[][] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(v)) return []
    return v
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => row.filter((cell): cell is string => typeof cell === 'string'))
  } catch {
    return []
  }
}

function rowToRoot(r: RootDbRow): RootRow {
  return {
    corpus: r.corpus,
    sourceId: r.source_id,
    role: r.role,
    rootEventId: r.root_event_id,
    tipEventId: r.tip_event_id,
    tipContent: r.tip_content,
    contentHash: r.content_hash,
    iSet: parseStrArray(r.i_set),
    imeta: parseImeta(r.imeta),
    sourceHash: r.source_hash,
    genVersion: r.gen_version,
    state: r.state === 'retired' ? 'retired' : 'live',
    updatedAt: r.updated_at,
  }
}

function rowToRelation(r: RelationDbRow): RelationRow {
  return {
    corpus: r.corpus,
    relationId: r.relation_id,
    kind: r.kind,
    subjectId: r.subject_id,
    objectKey: r.object_key,
    fingerprint: r.fingerprint,
    eventId: r.event_id,
    state: r.state === 'retracted' ? 'retracted' : 'live',
    updatedAt: r.updated_at,
  }
}

/** Sec-certs ledger accessor over an already-opened bun:sqlite Database (additive DDL). */
export class SecCertsLedger {
  readonly db: Database

  constructor(db: Database) {
    this.db = db
    this.db.exec(SECCERTS_SCHEMA_SQL)
    // Additive migration (2026-10-11 amendment): `imeta` joined the roots table after the v1
    // drafts; CREATE TABLE IF NOT EXISTS never alters an existing DB, so patch it in guarded.
    const rootCols = this.db.query<{ name: string }, []>('PRAGMA table_info(roots)').all()
    if (!rootCols.some((c) => c.name === 'imeta')) {
      this.db.exec("ALTER TABLE roots ADD COLUMN imeta TEXT NOT NULL DEFAULT '[]'")
    }
  }

  /** All `live` roots for one corpus (keys of the diff). */
  rootsByCorpus(corpus: string): RootRow[] {
    return this.db
      .query<RootDbRow, [string]>(
        "SELECT * FROM roots WHERE corpus = ? AND state = 'live' ORDER BY source_id, role",
      )
      .all(corpus)
      .map(rowToRoot)
  }

  /** Previously seen (live|retired) source ids for one corpus+role — C5 disappearance detection. */
  knownSourceIds(corpus: string, role: string): string[] {
    return this.db
      .query<{ source_id: string }, [string, string]>(
        'SELECT DISTINCT source_id FROM roots WHERE corpus = ? AND role = ?',
      )
      .all(corpus, role)
      .map((r) => r.source_id)
  }

  /** All relations for one corpus (any state). */
  relationsByCorpus(corpus: string): RelationRow[] {
    return this.db
      .query<RelationDbRow, [string]>(
        'SELECT * FROM relations WHERE corpus = ? ORDER BY relation_id',
      )
      .all(corpus)
      .map(rowToRelation)
  }

  /**
   * Unpublished chain points: ids the ledger's chain state references that the
   * given relay has no `publish_log` row for. Covers every live root's tip and
   * origin event id plus every live relation's event id — the three places a
   * later build's diffs anchor on. A nonempty result means the previous batch
   * was signed and recorded here but never reached the relay: building again
   * would emit patches whose parents do not exist there.
   *
   * An EXISTING row for (event_id, relay) — ack ok=1, rejected ok=0, or an
   * operator abandonment — always resolves the chain point: the relay already
   * returned a verdict, or the operator explicitly decided the id is not going
   * there. Only silence blocks the build.
   */
  unpublishedChainPointIds(relay: string): string[] {
    const rows = this.db
      .query<{ id: string }, [string]>(
        `SELECT DISTINCT id FROM (
           SELECT tip_event_id AS id FROM roots WHERE state = 'live'
           UNION
           SELECT root_event_id AS id FROM roots WHERE state = 'live'
           UNION
           SELECT event_id AS id FROM relations WHERE state = 'live'
         )
         WHERE id NOT IN (
           SELECT event_id FROM publish_log WHERE relay = ?1
         )`,
      )
      .all(relay)
    return rows.map((r) => r.id)
  }

  /**
   * Explicit operator escape for the unpublished-chain-point gate: marks the
   * dangling ids as intentionally abandoned for `relay` (ok=0, msg records the
   * reset) so the next build is no longer blocked. A re-published abandoned id
   * simply overwrites the row (last write wins).
   */
  abandonChainPoints(relay: string, ids: readonly string[]): number {
    const stmt = this.db.query(
      `INSERT INTO publish_log (event_id, relay, ok, msg, ts)
       VALUES (?, ?, 0, 'abandoned by operator (force-reset)', ?)
       ON CONFLICT(event_id, relay) DO UPDATE SET
         ok  = excluded.ok,
         msg = excluded.msg,
         ts  = excluded.ts`,
    )
    const now = Date.now()
    this.db.transaction((items: readonly string[]) => {
      for (const id of items) stmt.run(id, relay, now)
    })(ids)
    return ids.length
  }

  upsertRoots(rows: RootUpsertRow[]): number {
    const stmt = this.db.query(
      `INSERT INTO roots (corpus, source_id, role, root_event_id, tip_event_id, tip_content,
                          content_hash, i_set, imeta, source_hash, gen_version, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?, ?, ?)
       ON CONFLICT(corpus, source_id, role) DO UPDATE SET
         root_event_id = excluded.root_event_id,
         tip_event_id  = excluded.tip_event_id,
         tip_content   = excluded.tip_content,
         content_hash  = excluded.content_hash,
         i_set         = excluded.i_set,
         imeta         = COALESCE(?, roots.imeta),
         source_hash   = excluded.source_hash,
         gen_version   = excluded.gen_version,
         state         = excluded.state,
         updated_at    = excluded.updated_at`,
    )
    const now = Date.now()
    this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        const imetaJson = r.imeta === undefined ? null : JSON.stringify(r.imeta)
        stmt.run(
          r.corpus,
          r.sourceId,
          r.role,
          r.rootEventId,
          r.tipEventId,
          r.tipContent,
          r.contentHash,
          JSON.stringify(r.iSet),
          imetaJson,
          r.sourceHash,
          r.genVersion,
          r.state,
          now,
          imetaJson,
        )
      }
    })(rows)
    return rows.length
  }

  upsertRelations(rows: Omit<RelationRow, 'updatedAt'>[]): number {
    const stmt = this.db.query(
      `INSERT INTO relations (corpus, relation_id, kind, subject_id, object_key, fingerprint,
                              event_id, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(corpus, relation_id) DO UPDATE SET
         kind        = excluded.kind,
         subject_id  = excluded.subject_id,
         object_key  = excluded.object_key,
         fingerprint = excluded.fingerprint,
         event_id    = excluded.event_id,
         state       = excluded.state,
         updated_at  = excluded.updated_at`,
    )
    const now = Date.now()
    this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        stmt.run(
          r.corpus,
          r.relationId,
          r.kind,
          r.subjectId,
          r.objectKey,
          r.fingerprint,
          r.eventId,
          r.state,
          now,
        )
      }
    })(rows)
    return rows.length
  }
}
