/**
 * Paced batch publish — stage 3 of the pipeline (README: WS + NIP-42, per-event NIP-20 into the
 * ledger, retry with backoff on rate limits).
 *
 * Sequential per event (relays are the bottleneck and we are a well-behaved mirror):
 *
 * 1. resume-skip: an event already acked ok by this relay is not sent again (design §6.6);
 * 2. publish via {@link authedSocket} (NIP-42 handled inside);
 * 3. capture the NIP-20 verdict into `publish_log` (last write wins);
 * 4. rate-limit-ish rejections get exponential backoff, up to `maxRetries` extra attempts;
 *    atomically-permanent rejections (relay-side `stale` / `too old` protections that a simple
 *    re-drive can never fix) are recorded as rejected but retried NEVER — they poison the
 *    queue otherwise;
 * 5. a poisoned event (`socket.publish` that never resolves — dead tunnel, hung relay probe)
 *    is given up on after `watchdogMs` (default 600s) WITH its event FULLY dumped to a retry
 *    queue file alongside the batch input, and the loop continues at the next event (the
 *    publisher's job is throughput WITH the ledger, not one head-of-line block).
 *
 * The retry queue (default `<input>.retry-queue.ndjson`, newline-appended dry bytes of the events
 * in order of abandonment) is what the supervisor re-feeds after fixing the transport; it is
 * appended even when markPublish races the dump.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { DEFAULT_LEDGER_PATH, openLedger } from '../ledger/index'
import type { Ledger } from '../ledger/index'
import { ABANDONED_MSG } from '../ledger/seccertsLedger'
import type { SignedEvent } from '../types'
import { authedSocket } from './auth'
import type { AuthedSocket, PublishAck } from './auth'

/** Timer handle (kept as a named type per ts-no-return-type: consumers never re-derive). */
export type TimerHandle = ReturnType<typeof setTimeout>

/**
 * Marker the watchdog race resolves with. Never a runtime value callers need — typed constant.
 */
export const WATCHDOG = Symbol.for('@scrutiny-fabric/mirror.publish.watchdog')

/** A message the relay may reject with that is worth waiting out (before trying again). */
const RATE_LIMIT_RE = /rate[-\s]?limit|too much|too many|blocked: rate|throttle|slow down|spam/i

/**
 * Relay-side permanence rejections that a re-drive NEVER fixes for other relays' filters:
 * the event is semantically *too old* (relay's freshness policy), `stale`-classed, or in a
 * temporal window the relay declines to carry. Mark-and-move semantics: they are terminal
 * for THIS relay, never config'd as rate-limit; the proper recovery is re-signing with a
 * current `created_at` + a fresh batch, not a slower straight retry over the same bytes.
 */
export const PERMANENT_STALE_RE =
  /(event too old|stale|older than|pre-dates?|expired|out of window|outside .* window|content is too large|too many indexable tags|id is computed incorrectly)/i

/** True when a NIP-20 rejection is relay-permanent for these bytes (never rate-limit-retry).
 * Terminal verdicts (id-corruption, size caps, tag-count caps) can NEVER flip for identical
 * bytes — a relaunch of the same bytes is a regression, not a retrial.
 */
export function isRelayPermanentRejection(msg: string): boolean {
  return PERMANENT_STALE_RE.test(msg)
}

/** True when a NIP-20 rejection message looks like a rate limit rather than a permanent error. */
export function isRateLimitMessage(msg: string): boolean {
  return RATE_LIMIT_RE.test(msg)
}

export interface PublishBatchOptions {
  relay: string
  /** Signing key: 64-char hex or `nsec1…`. */
  keyHex: string
  /**
   * URL written into AUTH events' `relay` tag when the client reaches the relay
   * through a tunnel (the relay validates the tag against its own public URL).
   * Defaults to `relay`.
   */
  authRelayUrl?: string
  /** Delay between network publishes (not after skips). Default 500 ms. */
  paceMs?: number
  /** Extra attempts allowed after a rate-limit rejection. Default 5. */
  maxRetries?: number
  /** First backoff step; doubles per retry. Default 2000 ms. */
  backoffBaseMs?: number
  /** Backoff ceiling. Default 60 000 ms. */
  backoffCapMs?: number
  /** Publish at most this many events (after resume-skip filtering does not apply — it caps input). Default Infinity. */
  limit?: number
  /**
   * Skip events already acked ok by this relay in the ledger. Default true.
   * Complementary mode `--resend-rejected` in the CLI: when `skipTerminalRejected` is set to
   * false and `skipPublished` stays true, the lane skips only ok=1 rows — precisely the knob
   * needed to re-push the events whose relay caps were widened after a terminal reject.
   */
  skipTerminalRejected?: boolean
  /** Skip events already acked ok by this relay in the ledger. Default true. */
  skipPublished?: boolean
  /** Reuse an open ledger (tests/CLI); otherwise one is opened at `ledgerPath`. */
  ledger?: Ledger
  /** Ledger path when `ledger` is not given. Default `artifacts/mirror.sqlite`. */
  ledgerPath?: string
  /**
   * Parallel worker lanes, each with its own authed socket, draining the (file-ordered) queue
   * by shared index. Measured relay capacity on this relay (2026-10-11): single socket
   * 14.7 ev/s, 4 lanes 32.7 ev/s, 8 lanes 69 ev/s, 0 rejects — default keeps the legacy
   * sequential paced path (1); a parallel call should also drop pacing to ~0. The batch's
   * emission order already guarantees endpoint-before-binding inside every lane's start order.
   */
  workers?: number
  /**
   * Abandon an event whose `socket.publish` produced NO verdict after this long and append
   * it to the retry queue. Default 600 000 ms (10 minutes per the amended batching plan).
   */
  watchdogMs?: number
  /**
   * Where events the watchdog abandons are appended, one compact JSON line each, oldest
   * first. Default: `<infile>.retry-queue.ndjson` (caller-supplied absolute path urged).
   * Pass `null` to disable; default with no infile known is a path the caller owns.
   */
  retryQueuePath?: string | null
  /** Socket construction seam for tests. */
  socketFactory?: (relay: string, keyHex: string) => AuthedSocket
  log?: (line: string) => void
  /** Delay seam for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface PublishEventResult {
  id: string
  ok: boolean
  msg: string
  skipped: boolean
  /** Network attempts made (0 when skipped). */
  attempts: number
  /** Wall-clock spent on this event's publish attempts (0 when skipped). */
  ms: number
}

export interface PublishSummary {
  relay: string
  /** Events considered (input after `limit`, before skip filtering). */
  total: number
  skipped: number
  accepted: number
  rejected: number
  /** Events the per-attempt watchdog gave up on and dumped to the retry queue. */
  abandoned: number
  results: PublishEventResult[]
}

/**
 * Publish `events` to one relay, sequentially, with resume-skip + paced sends + rate-limit backoff.
 * Returns the stage-3 summary; per-event NIP-20 verdicts are in the ledger's `publish_log`.
 */
export async function publishBatch(
  events: SignedEvent[],
  opts: PublishBatchOptions,
): Promise<PublishSummary> {
  const relay = opts.relay
  const paceMs = opts.paceMs ?? 500
  const maxRetries = opts.maxRetries ?? 5
  const backoffBaseMs = opts.backoffBaseMs ?? 2000
  const backoffCapMs = opts.backoffCapMs ?? 60_000
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const skipPublished = opts.skipPublished ?? true
  const log = opts.log ?? (() => {})
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const socketFactory =
    opts.socketFactory ??
    ((url: string, key: string) =>
      authedSocket(url, key, {
        log,
        ...(opts.authRelayUrl !== undefined ? { authRelayUrl: opts.authRelayUrl } : {}),
      }))

  const ownedLedger = opts.ledger === undefined
  const ledger = opts.ledger ?? openLedger(opts.ledgerPath ?? DEFAULT_LEDGER_PATH)
  const watchdogMs = opts.watchdogMs ?? 600_000
  const retryQueue =
    opts.retryQueuePath === null
      ? null
      : resolve(opts.retryQueuePath ?? 'artifacts/retry-queue.ndjson')

  const queue = events.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : events.length)
  const summary: PublishSummary = {
    relay,
    total: queue.length,
    skipped: 0,
    accepted: 0,
    rejected: 0,
    abandoned: 0,
    results: [],
  }
  const okThisRun = new Set<string>()
  // Resume-skip = already-acked rows AND (unless disabled) terminal verdicts for identical
  // bytes (measured: id/size/tag-cap rejects never flip; re-uploading them every relaunch
  // wastes queue time and recreates the tombstone log endlessly). Operator abandonments
  // (the build gate's --force-reset, ledger.abandonChainPoints) count as terminal too:
  // the operator explicitly decided these ids are not going to this relay, so a later
  // artifacts file must not resurrect them behind their back.
  const skipTerminalRejected = opts.skipTerminalRejected ?? true
  const skipIds = new Set<string>()
  if (skipPublished) {
    for (const row of ledger.db
      .query<{ event_id: string; ok: number; msg: string | null }, [string]>(
        'SELECT event_id, ok, msg FROM publish_log WHERE relay = ?',
      )
      .all(relay)) {
      if (
        row.ok === 1 ||
        row.msg === ABANDONED_MSG ||
        (skipTerminalRejected && isRelayPermanentRejection(String(row.msg ?? '')))
      )
        skipIds.add(row.event_id)
    }
  }
  const workers = Math.max(1, opts.workers ?? 1)
  // Pacing is a SEQUENTIAL-lane knob; parallel lanes pace by their own socket round-trips.
  const effectivePaceMs = workers <= 1 ? paceMs : 0
  const sockets: AuthedSocket[] = []
  let sharedIndex = 0

  /** All queue indexing is single-threaded here; sharedIndex advances at `next()` only. */
  function nextIndex(): number {
    const cur = sharedIndex
    sharedIndex += 1
    return cur
  }

  async function lane(): Promise<void> {
    let socket: AuthedSocket | null = null
    log(`lane start (pid-aggregate; first queue index ${sharedIndex})`)
    try {
      for (;;) {
        const index = nextIndex()
        if (index >= queue.length) return
        const event = queue[index]
        if (event === undefined) continue

        if (skipPublished && (okThisRun.has(event.id) || skipIds.has(event.id))) {
          summary.skipped++
          summary.results.push({
            id: event.id,
            ok: true,
            msg: 'skipped: already published',
            skipped: true,
            attempts: 0,
            ms: 0,
          })
          continue
        }

        const started = Date.now()
        let attempts = 0
        let ack: PublishAck = { ok: false, msg: 'not attempted' }
        let abandoned = false
        for (;;) {
          if (socket === null || socket.closed) {
            socket = socketFactory(relay, opts.keyHex)
            sockets.push(socket)
          }
          attempts++
          // Bounded watchdog: armed per attempt, cleared the moment a verdict lands — nothing
          // accumulates (the orphaned-timeout leak that OOMed the 7h+ publish).
          let timer: TimerHandle | undefined
          const attemptPromise: Promise<PublishAck> = socket.publish(event).catch(
            (err: unknown): PublishAck => ({
              ok: false,
              msg: `exception: ${err instanceof Error ? err.message : String(err)}`,
            }),
          )
          const outcome = await Promise.race<PublishAck | typeof WATCHDOG>([
            attemptPromise,
            new Promise<typeof WATCHDOG>((resolveRace) => {
              timer = setTimeout(() => resolveRace(WATCHDOG), watchdogMs)
            }),
          ])
          clearTimeout(timer)
          if ((outcome as unknown) === WATCHDOG) {
            ack = { ok: false, msg: `watchdog-abandoned:${watchdogMs}ms` }
            abandoned = true
            break // poisoned attempt: dump to retry queue, continue at the next event
          }
          ack = outcome as PublishAck
          log(
            `[${event.id.slice(0, 12)}…] attempt ${attempts} verdict: ok=${String(ack.ok)} msg=${(ack.msg || '∅').slice(0, 80)}`,
          )
          if (
            ack.ok ||
            isRelayPermanentRejection(ack.msg) ||
            !isRateLimitMessage(ack.msg) ||
            attempts > maxRetries
          )
            break
          const delay = Math.min(backoffCapMs, backoffBaseMs * 2 ** (attempts - 1))
          log(
            `[${event.id.slice(0, 12)}…] rate-limited (${ack.msg}); retry ${attempts}/${maxRetries} in ${delay}ms`,
          )
          await sleep(delay)
        }
        if (abandoned) {
          // fresh socket next event (this one is presumed dead), and dump the event — oldest
          // first — so the supervisor can re-feed the exact bytes after transport recovery.
          try {
            socket?.close()
          } catch {
            // socket may already be closed; either way it must not be reused
          }
          socket = null
          summary.abandoned += 1
          if (retryQueue !== null) {
            mkdirSync(dirname(retryQueue), { recursive: true })
            appendFileSync(retryQueue, `${JSON.stringify(event)}\n`, 'utf8')
          }
        }
        const ms = Date.now() - started
        const boundedMsg = ack.msg.length > 512 ? `${ack.msg.slice(0, 512)}…` : ack.msg
        ledger.markPublish(event.id, relay, ack.ok, boundedMsg)
        if (ack.ok) {
          summary.accepted++
          okThisRun.add(event.id)
        } else {
          summary.rejected++
        }
        summary.results.push({
          id: event.id,
          ok: ack.ok,
          msg: boundedMsg,
          skipped: false,
          attempts,
          ms,
        })
        log(
          `[${event.id.slice(0, 12)}…] ${ack.ok ? 'ok' : 'rejected'}: ${ack.msg || '(no message)'} (${attempts} attempt(s), ${ms}ms)`,
        )

        if (effectivePaceMs > 0 && index < queue.length - 1) await sleep(effectivePaceMs)
      }
    } finally {
      socket?.close()
    }
  }

  try {
    const lanes: Promise<void>[] = []
    for (let w = 0; w < workers; w++) lanes.push(lane())
    await Promise.all(lanes)
  } finally {
    for (const socket of sockets) {
      try {
        socket.close()
      } catch {
        // already closed
      }
    }
    if (ownedLedger) ledger.close()
  }

  return summary
}
