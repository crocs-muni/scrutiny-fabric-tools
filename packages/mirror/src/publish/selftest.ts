/**
 * Self-test for ledger + publish + probe — the acceptance evidence for SELFTEST.md.
 *
 *   bun src/publish/selftest.ts
 *
 * Three parts, all local (no external relay is ever written to):
 * 1. ledger round-trip against a real sqlite file (write/read/re-upsert/persist numbers);
 * 2. publishBatch against an in-code mock relay: NIP-42 AUTH (late challenge), NIP-20 verdict
 *    capture, rate-limit backoff, pacing, resume-skip, limit;
 * 3. relayProbe against the same mock (read-only filters + AUTH handshake) and against a dead port
 *    (unreachable shape). Asserts the probe server received zero EVENT messages.
 *
 * Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { nsecEncode } from 'nostr-tools/nip19'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

import { openLedger } from '../ledger/index'
import type { SignedEvent } from '../types'
import { toSecretKey } from './auth'
import { isRateLimitMessage, publishBatch } from './index'
import { relayProbe } from './probe'

const LEDGER_PATH = 'artifacts/selftest/mirror-selftest.sqlite'
const BATCH_LEDGER_PATH = 'artifacts/selftest/publish-batch.sqlite'

interface ConnState {
  authed: boolean
  challengeSent: boolean
  rateLimitHits: number
}

interface MockRelay {
  url: string
  stats: {
    eventArrivals: Array<{ id: string; at: number }>
    authEvents: number
    challengeSends: number
  }
  stop(): void
}

interface MockRelayOptions {
  challengeOnConnect: boolean
  rateLimitTargetId?: string
  invalidTargetId?: string
}

function startMockRelay(opts: MockRelayOptions): MockRelay {
  const stats: MockRelay['stats'] = { eventArrivals: [], authEvents: 0, challengeSends: 0 }
  const conns = new Map<object, ConnState>()
  let boundUrl = ''
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response('scrutiny-fabric mirror selftest mock relay (no real relay behaviour)')
    },
    websocket: {
      open(ws) {
        conns.set(ws, { authed: false, challengeSent: false, rateLimitHits: 0 })
        if (opts.challengeOnConnect) {
          stats.challengeSends++
          ws.send(JSON.stringify(['AUTH', 'mock-challenge-on-connect']))
        }
      },
      close(ws) {
        conns.delete(ws)
      },
      message(ws, raw) {
        const text = typeof raw === 'string' ? raw : raw.toString()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return
        }
        if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
        const [type, ...rest] = parsed as [string, ...unknown[]]
        const state = conns.get(ws)
        if (state === undefined) return

        if (type === 'AUTH') {
          const ev = rest[0] as { id?: unknown; kind?: unknown; tags?: unknown } | undefined
          const tags = Array.isArray(ev?.tags) ? (ev.tags as unknown[][]) : []
          const hasChallenge = tags.some((t) => t[0] === 'challenge' && typeof t[1] === 'string')
          const hasRelay = tags.some((t) => t[0] === 'relay' && t[1] === boundUrl)
          if (ev?.kind === 22242 && hasChallenge && hasRelay) {
            state.authed = true
            stats.authEvents++
            ws.send(JSON.stringify(['OK', ev.id, true, '']))
          } else {
            ws.send(JSON.stringify(['OK', ev?.id ?? '', false, 'invalid: bad AUTH event']))
          }
          return
        }

        if (type === 'EVENT') {
          const ev = rest[0] as { id: string }
          stats.eventArrivals.push({ id: ev.id, at: Date.now() })
          if (!state.authed) {
            if (!state.challengeSent) {
              state.challengeSent = true
              stats.challengeSends++
              ws.send(JSON.stringify(['AUTH', 'mock-challenge-late']))
            }
            ws.send(JSON.stringify(['OK', ev.id, false, 'auth-required: authenticate first']))
            return
          }
          if (opts.rateLimitTargetId !== undefined && ev.id === opts.rateLimitTargetId) {
            state.rateLimitHits++
            if (state.rateLimitHits === 1) {
              ws.send(
                JSON.stringify(['OK', ev.id, false, 'rate-limited: too much for this connection']),
              )
            } else {
              ws.send(JSON.stringify(['OK', ev.id, true, '']))
            }
            return
          }
          if (opts.invalidTargetId !== undefined && ev.id === opts.invalidTargetId) {
            ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']))
            return
          }
          ws.send(JSON.stringify(['OK', ev.id, true, 'duplicate: already have this event']))
          return
        }

        if (type === 'REQ') {
          const subId = rest[0] as string
          const filter = (rest[1] ?? {}) as Record<string, unknown>
          if (typeof filter['search'] === 'string') {
            ws.send(JSON.stringify(['NOTICE', 'unrecognised filter item: search']))
            ws.send(JSON.stringify(['CLOSED', subId, 'unsupported: search']))
            return
          }
          const tFacet = filter['#t']
          if (Array.isArray(tFacet) && tFacet.includes('jcalgtest')) {
            ws.send(
              JSON.stringify([
                'EVENT',
                subId,
                {
                  id: 'f'.repeat(64),
                  pubkey: 'a'.repeat(64),
                  created_at: 1,
                  kind: 1,
                  tags: [['t', 'jcalgtest']],
                  content: 'mock jcalgtest note',
                  sig: 'b'.repeat(128),
                },
              ]),
            )
          }
          ws.send(JSON.stringify(['EOSE', subId]))
          return
        }
      },
    },
  })
  const url = `ws://127.0.0.1:${server.port}`
  boundUrl = url
  return {
    url,
    stats,
    stop() {
      void server.stop(true)
    },
  }
}

function makeEvents(count: number, secretKey: Uint8Array): SignedEvent[] {
  const events: SignedEvent[] = []
  for (let i = 1; i <= count; i++) {
    events.push(
      finalizeEvent(
        {
          kind: 1,
          created_at: 1_700_000_000 + i,
          tags: [['t', 'jcalgtest']],
          content: `selftest event ${i}`,
        },
        secretKey,
      ),
    )
  }
  return events
}

function receiveGapsMs(
  arrivals: Array<{ id: string; at: number }>,
): Array<{ from: string; to: string; ms: number }> {
  const gaps: Array<{ from: string; to: string; ms: number }> = []
  for (let i = 1; i < arrivals.length; i++) {
    const prev = arrivals[i - 1]
    const cur = arrivals[i]
    if (prev !== undefined && cur !== undefined)
      gaps.push({ from: prev.id, to: cur.id, ms: cur.at - prev.at })
  }
  return gaps
}

async function part1LedgerRoundTrip(): Promise<void> {
  console.log('== part 1: ledger sqlite round-trip ==')
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${LEDGER_PATH}${suffix}`, { force: true })
  }

  const ledger = openLedger(LEDGER_PATH)
  const rows = Array.from({ length: 6 }, (_, i) => ({
    corpus: 'jcalgtest',
    sourceId: `javacard/Profiles/results/Card${i}_ALGSUPPORT_3.0.5_atr.csv`,
    sourceHash: `hash-${i}`,
    genVersion: 'selftest-1',
    eventIds: [`event-${i}-a`, `event-${i}-b`],
    iSet: [`jcard:c00${i}`, 'vendor:nxp'],
  }))
  const written = ledger.upsertRecords(rows)
  const first = rows[0]
  if (first === undefined) throw new Error('rows unexpectedly empty')
  const updated = { ...first, sourceHash: 'hash-0-v2', genVersion: 'selftest-2' }
  rows[0] = updated
  const rewritten = ledger.upsertRecords([updated])
  ledger.markPublish('event-0-a', 'ws://mock', true, '')
  ledger.markPublish('event-0-b', 'ws://mock', false, 'invalid: bad signature')
  ledger.markPublish('event-0-b', 'ws://mock', false, 'invalid: bad signature (retry)')
  ledger.setRelayCapability('ws://mock', 'reachable; nip11 present (NIPs 1,11,42)')

  console.log(`  file: ${LEDGER_PATH}`)
  console.log(
    `  write: ${written} rows upserted, then ${rewritten} re-upserted (2 modified columns)`,
  )
  const afterWrite = ledger.readAll()
  console.log(
    `  read:  records=${afterWrite.records.length} publishLog=${afterWrite.publishLog.length} relays=${afterWrite.relays.length}`,
  )
  assert.equal(afterWrite.records.length, 6, 'upsert must not duplicate rows (PK corpus+source_id)')
  assert.equal(
    afterWrite.records[0]?.sourceHash,
    'hash-0-v2',
    'upsert must update the modified row',
  )
  assert.equal(afterWrite.publishLog.length, 2, 'publish_log keyed by (event_id, relay)')
  assert.equal(
    afterWrite.publishLog.find((r) => r.eventId === 'event-0-b')?.msg,
    'invalid: bad signature (retry)',
    'last write wins',
  )
  assert.equal(ledger.wasPublished('event-0-a', 'ws://mock'), true)
  assert.equal(
    ledger.wasPublished('event-0-b', 'ws://mock'),
    false,
    'rejections do not count as published',
  )
  assert.equal(ledger.wasPublished('event-0-a', 'ws://other'), false, 'relay-scoped')
  ledger.close()

  const reopened = openLedger(LEDGER_PATH)
  const afterReopen = reopened.readAll()
  reopened.close()
  console.log(
    `  reopen: records=${afterReopen.records.length} publishLog=${afterReopen.publishLog.length} relays=${afterReopen.relays.length}`,
  )
  assert.deepEqual(
    afterReopen.records.map((r) => r.sourceId),
    afterWrite.records.map((r) => r.sourceId),
    'order-stable read after reopen',
  )
  assert.equal(afterReopen.relays[0]?.capability, 'reachable; nip11 present (NIPs 1,11,42)')
  console.log('  PASS\n')
}

async function part2PublishBatch(): Promise<void> {
  console.log('== part 2: publishBatch vs in-code mock relay ==')
  const secretKey = generateSecretKey()
  const events = makeEvents(6, secretKey)
  const [e1, e2, e3, e4, e5, e6] = events as [
    SignedEvent,
    SignedEvent,
    SignedEvent,
    SignedEvent,
    SignedEvent,
    SignedEvent,
  ]
  const nsec = nsecEncode(secretKey)
  assert.deepEqual([...toSecretKey(nsec)], [...secretKey], 'nsec1… decodes to the same 32 bytes')
  assert.equal(isRateLimitMessage('rate-limited: too much for this connection'), true)
  assert.equal(isRateLimitMessage('invalid: bad signature'), false)

  const mock = startMockRelay({
    challengeOnConnect: false,
    rateLimitTargetId: e2.id,
    invalidTargetId: e5.id,
  })
  console.log(
    `  mock relay: ${mock.url} (NIP-42 late challenge, NIP-20: rate-limit/invalid/duplicate)`,
  )
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${BATCH_LEDGER_PATH}${suffix}`, { force: true })
  }
  const ledger = openLedger(BATCH_LEDGER_PATH)
  const paceMs = 120
  const backoffBaseMs = 150

  try {
    const run1 = await publishBatch(events, {
      relay: mock.url,
      keyHex: nsec,
      paceMs,
      backoffBaseMs,
      maxRetries: 3,
      ledger,
      log: () => {},
    })
    const arrivals1 = mock.stats.eventArrivals.slice()
    console.log(
      `  run1: total=${run1.total} accepted=${run1.accepted} rejected=${run1.rejected} skipped=${run1.skipped} ` +
        `networkEvents=${arrivals1.length}`,
    )
    assert.deepEqual(
      {
        total: run1.total,
        accepted: run1.accepted,
        rejected: run1.rejected,
        skipped: run1.skipped,
      },
      { total: 6, accepted: 5, rejected: 1, skipped: 0 },
    )
    const e2Result = run1.results.find((r) => r.id === e2.id)
    assert.equal(e2Result?.attempts, 2, 'rate limit must be retried exactly once here')
    assert.equal(e2Result?.ok, true)
    assert.equal(arrivals1.length, 8, '6 events + e1 auth-required retry + e2 rate-limit retry')
    assert.equal(mock.stats.challengeSends, 1, 'one challenge per connection')

    const gaps = receiveGapsMs(arrivals1)
    const backoffGap = gaps.find((g) => g.from === e2.id && g.to === e2.id)
    const pacingGaps = gaps.filter((g) => g.from !== g.to)
    console.log(`  run1 gaps between network events (ms): ${gaps.map((g) => g.ms).join(', ')}`)
    console.log(`  backoff gap for rate-limit retry: ${backoffGap?.ms} (base ${backoffBaseMs})`)
    console.log(`  pacing gaps (min): ${Math.min(...pacingGaps.map((g) => g.ms))} (pace ${paceMs})`)
    assert.ok(
      backoffGap !== undefined && backoffGap.ms >= backoffBaseMs - 30,
      `backoff gap ${backoffGap?.ms}`,
    )
    assert.ok(
      pacingGaps.every((g) => g.ms >= paceMs - 30),
      `pacing gaps must respect pace (${pacingGaps.map((g) => g.ms).join(', ')})`,
    )

    const log = ledger.readAll().publishLog
    assert.equal(log.length, 6, 'one publish_log row per event for this relay')
    assert.equal(log.find((r) => r.eventId === e2.id)?.ok, true)
    assert.equal(log.find((r) => r.eventId === e5.id)?.ok, false)
    assert.equal(log.find((r) => r.eventId === e5.id)?.msg, 'invalid: bad signature')
    assert.equal(log.find((r) => r.eventId === e6.id)?.msg, 'duplicate: already have this event')
    assert.equal(ledger.wasPublished(e1.id, mock.url), true)
    assert.equal(ledger.wasPublished(e5.id, mock.url), false)
    console.log(
      `  NIP-20 captured: e6 msg='duplicate: already have this event', e5 msg='invalid: bad signature'`,
    )

    const arrivalsBeforeRun2 = mock.stats.eventArrivals.length
    const run2 = await publishBatch(events, {
      relay: mock.url,
      keyHex: nsec,
      paceMs,
      backoffBaseMs,
      maxRetries: 3,
      ledger,
      log: () => {},
    })
    const arrivals2 = mock.stats.eventArrivals.slice(arrivalsBeforeRun2)
    const skippedIds = run2.results
      .filter((r) => r.skipped)
      .map((r) => r.id)
      .sort()
    console.log(
      `  run2 (resume): total=${run2.total} accepted=${run2.accepted} rejected=${run2.rejected} skipped=${run2.skipped} ` +
        `networkEvents=${arrivals2.length}`,
    )
    assert.deepEqual(
      {
        total: run2.total,
        accepted: run2.accepted,
        rejected: run2.rejected,
        skipped: run2.skipped,
      },
      { total: 6, accepted: 0, rejected: 1, skipped: 5 },
    )
    assert.deepEqual(
      skippedIds,
      [e1.id, e2.id, e3.id, e4.id, e6.id].sort(),
      'only ok-acked events are skipped',
    )
    assert.deepEqual(
      arrivals2.map((a) => a.id),
      [e5.id, e5.id],
      'run2 touches the relay only for the previously rejected event (auth dance + invalid)',
    )

    const run3 = await publishBatch([e1], {
      relay: mock.url,
      keyHex: nsec,
      paceMs,
      backoffBaseMs,
      maxRetries: 0,
      limit: 1,
      skipPublished: false,
      ledger,
      log: () => {},
    })
    console.log(
      `  run3 (limit=1, skipPublished=false): total=${run3.total} accepted=${run3.accepted}`,
    )
    assert.deepEqual(
      { total: run3.total, accepted: run3.accepted, skipped: run3.skipped },
      { total: 1, accepted: 1, skipped: 0 },
    )
    assert.equal(mock.stats.eventArrivals.at(-1)?.id, e1.id)
    console.log('  PASS\n')
  } finally {
    mock.stop()
    ledger.close()
  }
}

async function part3Probe(): Promise<void> {
  console.log('== part 3: relayProbe (read-only) ==')
  const secretKey = generateSecretKey()
  const key = nsecEncode(secretKey)
  const mock = startMockRelay({ challengeOnConnect: true })
  try {
    const withKey = await relayProbe({ relay: mock.url, keyHex: key, perProbeMs: 400 })
    console.log(`  probe(mock, key): ${withKey.verdict}`)
    console.log(
      `  probe(mock, key): ${JSON.stringify(withKey.per_probe.map((p) => [p.name, p.accepted, p.events_returned]))}`,
    )
    assert.equal(withKey.connected, true)
    assert.equal(withKey.auth.challenge_received, true)
    assert.equal(withKey.auth.ok, true, 'AUTH handshake accepted when a key is provided')
    assert.equal(withKey.per_probe.find((p) => p.name === 'facet-t')?.events_returned, 1)
    const search = withKey.per_probe.find((p) => p.name === 'search')
    assert.equal(search?.accepted, false)
    assert.match(search?.notice ?? '', /unrecognised filter item/)
    assert.equal(mock.stats.eventArrivals.length, 0, 'probe must never publish an EVENT')

    const withoutKey = await relayProbe({ relay: mock.url, perProbeMs: 400 })
    console.log(`  probe(mock, no key): ${withoutKey.verdict}`)
    assert.equal(withoutKey.auth.attempted, false)
    assert.equal(withoutKey.auth.challenge_received, true)
    assert.equal(withoutKey.auth.ok, null)
    assert.equal(mock.stats.eventArrivals.length, 0, 'still no EVENT messages')

    const dead = await relayProbe({ relay: 'ws://127.0.0.1:1', timeoutMs: 800, perProbeMs: 200 })
    console.log(`  probe(dead port): ${dead.verdict}`)
    assert.equal(dead.connected, false)
    assert.equal(dead.per_probe.length, 0)
    assert.match(dead.verdict, /^unreachable: /)
    console.log('  PASS\n')
  } finally {
    mock.stop()
  }
}

await part1LedgerRoundTrip()
await part2PublishBatch()
await part3Probe()
console.log('selftest: ALL PASS')
