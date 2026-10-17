/**
 * ledger/seccertsLedger-gate.test.ts — the build-time chain-integrity gate.
 *
 * The gate refuses a build while the ledger's chain state references events the
 * target relay never acked (`publish_log ok=1`): live root tips and origins,
 * live relation event ids. Coverage: the empty-ledger case passes; an
 * unpublished tip is reported; an ok=1 ack clears it (an ok=0 row does NOT);
 * `abandonChainPoints` marks the dangling ids so the next query is empty.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { type Ledger, openLedger } from './index.js'
import { SecCertsLedger } from './seccertsLedger.js'

const RELAY = 'ws://relay.example:7777'

function freshLedger(): { seccerts: SecCertsLedger; ledger: Ledger } {
  const ledger = openLedger(':memory:')
  return { seccerts: new SecCertsLedger(ledger.db), ledger }
}

function seedRoot(seccerts: SecCertsLedger, id: string): void {
  seccerts.upsertRoots([
    {
      corpus: 'seccerts/cc',
      sourceId: `src-${id.slice(0, 6)}`,
      role: 'snapshot',
      rootEventId: id,
      tipEventId: id,
      tipContent: `content ${id}`,
      contentHash: '00'.repeat(32),
      iSet: [],
      sourceHash: '01'.repeat(32),
      genVersion: 'seccerts-v1',
      state: 'live',
    },
  ])
}

function seedRelation(seccerts: SecCertsLedger, id: string): void {
  seccerts.upsertRelations([
    {
      corpus: 'seccerts/cc',
      relationId: `rel-${id.slice(0, 6)}`,
      kind: 'maintenance',
      subjectId: 'subj',
      objectKey: 'obj',
      fingerprint: 'fp',
      eventId: id,
      state: 'live',
    },
  ])
}

describe('unpublishedChainPointIds', () => {
  it('an empty ledger has no chain points', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([])
    } finally {
      ledger.close()
    }
  })

  it('reports an unpublished live root tip and origin', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const id = 'aa'.repeat(32)
      seedRoot(seccerts, id)
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([id])
    } finally {
      ledger.close()
    }
  })

  it('reports an unpublished live relation event id', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const id = 'bb'.repeat(32)
      seedRelation(seccerts, id)
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([id])
    } finally {
      ledger.close()
    }
  })

  it('any existing publish_log row resolves the chain point; only silence blocks', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const acked = 'cc'.repeat(32)
      const rejected = 'dd'.repeat(32)
      seedRoot(seccerts, acked)
      seedRoot(seccerts, rejected)
      ledger.markPublish(acked, RELAY, true, '')
      ledger.markPublish(rejected, RELAY, false, 'blocked: test')
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([])
    } finally {
      ledger.close()
    }
  })

  it('acks from another relay do not clear the chain point', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const id = 'ee'.repeat(32)
      seedRoot(seccerts, id)
      ledger.markPublish(id, 'ws://other-relay:7777', true, '')
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([id])
    } finally {
      ledger.close()
    }
  })

  it('retired roots and retracted relations stop being chain points', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const gone = 'ff'.repeat(32)
      seedRoot(seccerts, gone)
      seedRelation(seccerts, gone)
      seccerts.db.exec(
        `UPDATE roots SET state = 'retired'; UPDATE relations SET state = 'retracted';`,
      )
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([])
    } finally {
      ledger.close()
    }
  })
})

describe('abandonChainPoints', () => {
  it('marks dangling ids abandoned so the gate passes; the note row is ok=0', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const id = 'ab'.repeat(32)
      seedRoot(seccerts, id)
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([id])

      expect(seccerts.abandonChainPoints(RELAY, [id])).toBe(1)
      expect(seccerts.unpublishedChainPointIds(RELAY)).toEqual([])

      // The audit trail must show the abandonment, not a fake ack.
      const row = ledger.db
        .query<{ ok: number; msg: string }, [string, string]>(
          'SELECT ok, msg FROM publish_log WHERE event_id = ? AND relay = ?',
        )
        .get(id, RELAY)
      expect(row?.ok).toBe(0)
      expect(row?.msg).toContain('abandoned')
    } finally {
      ledger.close()
    }
  })

  it('a later real ack overwrites the abandonment (last write wins)', () => {
    const { seccerts, ledger } = freshLedger()
    try {
      const id = 'cd'.repeat(32)
      seedRoot(seccerts, id)
      seccerts.abandonChainPoints(RELAY, [id])
      ledger.markPublish(id, RELAY, true, '')
      const row = ledger.db
        .query<{ ok: number }, [string, string]>(
          'SELECT ok FROM publish_log WHERE event_id = ? AND relay = ?',
        )
        .get(id, RELAY)
      expect(row?.ok).toBe(1)
    } finally {
      ledger.close()
    }
  })
})
