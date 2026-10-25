# ledger/ self-test (acceptance evidence)

Run (same script as publish/, which drives the ledger as a real file):

```
cd packages/mirror
bun src/publish/selftest.ts        # part 1 covers the ledger; exits non-zero on first failed assertion
```

## Schema (as created by `openLedger`)

```sql
CREATE TABLE IF NOT EXISTS records (
  corpus      TEXT    NOT NULL,
  source_id   TEXT    NOT NULL,
  source_hash TEXT    NOT NULL,
  gen_version TEXT    NOT NULL,
  event_ids   TEXT    NOT NULL,   -- JSON array
  i_set       TEXT    NOT NULL,   -- JSON array
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
```

`openLedger(path = 'artifacts/mirror.sqlite')` creates parent directories, enables
`busy_timeout=5000` + WAL, and applies the DDL idempotently. It accepts `:memory:` for tests.
Prepared-statement semantics: `upsertRecords` re-writes a row on the `(corpus, source_id)` key (it
never duplicates). `markPublish` is last-write-wins on `(event_id, relay)`. `wasPublished` is true
only for `ok=1` rows.

## Captured round-trip output (2026-10-04, Bun 1.4.0)

```
== part 1: ledger sqlite round-trip ==
  file: artifacts/selftest/mirror-selftest.sqlite
  write: 6 rows upserted, then 1 re-upserted (2 modified columns)
  read:  records=6 publishLog=2 relays=1
  reopen: records=6 publishLog=2 relays=1
  PASS
```

Demonstrable numbers:

| Operation | Result |
|---|---|
| `upsertRecords` initial write | 6 rows (each with 2 `event_ids`, 2 distinct `i_set` values) |
| `upsertRecords` re-write of 1 row (new `source_hash`, `gen_version`) | 1 row updated, table still 6 rows (PK held; 7 would exist without it) |
| `readAll()` after writes | records=6, publishLog=2, relays=1 |
| `markPublish` writes | 3 calls → 2 rows (the rejected row was overwritten by its retry message, last-write-wins) |
| `wasPublished('event-0-a', 'ws://mock')` | true |
| `wasPublished('event-0-b', 'ws://mock')` | false (rejected) |
| `wasPublished('event-0-a', 'ws://other')` | false (relay-scoped) |
| close + reopen (file persistence) | records=6, publishLog=2, relays=1 in identical order |
| `setRelayCapability` | 1 relay row, capability string round-trips |

## Integration with publish/ (captured in the same run)

The batch test (publish/SELFTEST.md) writes one `publish_log` row per attempted event for the mock
relay (6 rows after run 1). The resume run demonstrates the skip semantics:
`run2: total=6 accepted=0 rejected=1 skipped=5`. Exactly the 5 ok-acked event ids were skipped.
The previously rejected id was retried.

## Known integration gap (v0)

The `records` table API (`upsertRecords`) is implemented and tested here, but the CLI's
`build:jcalgtest` does not populate it yet: emit's `EmitResult` exposes `{events, manifest}` without
a source-file → event-ids mapping. Inferring one from event content would be guesswork. Once
emit (or a build step) exposes that mapping, `cli.ts` can upsert one row per run record
(`sourceId = RunRecord.file`, `sourceHash = RunRecord.sha256`, `iSet` = distinct `i` values) to get
design §6.6 build idempotency on top of the already-working publish resume.
