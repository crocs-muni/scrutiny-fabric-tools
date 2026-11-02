/**
 * Bulk NDJSON → Nostr relays publisher. Crash-safe, rate-limit-aware.
 *
 *   node publish-bulk.mjs <events.ndjson> <relay1,relay2,...> [--pace 250] [--cursor-dir .]
 *
 * - One WS per relay, all relays in parallel; events sent strictly sequentially per relay.
 * - Await per-event OK ack (15s timeout) before the next event; ~pace ms (+jitter) between.
 * - Cursor per relay (<cursor-dir>/cursor-<host>.json, last acked line index) → restart
 *   resumes exactly; duplicates also satisfy the cursor (idempotent corpus by design).
 * - On [OK false 'rate-limited'|'too many'|'blocked'] or NOTICE throttle hints or a mid-run
 *   socket drop: exponential backoff (5s → 5min cap) then resume. 'auth-required' /
 *   'payment-required' are permanent → relay marked dead, skipped.
 * - Final per-relay summary + results JSON written to <cursor-dir>/results-<host>.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }
const file = argv[0] ?? die('usage: publish-bulk.mjs <events.ndjson> <relay1,...> [--pace 250] [--cursor-dir .]')
const relays = (argv[1] ?? die('give a comma-separated relay list')).split(',').filter(Boolean)
const paceMs = Number(argv[argv.indexOf('--pace') + 1] || 250)
const cursorDir = argv[argv.indexOf('--cursor-dir') + 1] || '.'

const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
console.log(`${events.length} events → ${relays.length} relays (pace ${paceMs}ms, cursors in ${cursorDir})`)

const host = (r) => r.replace(/^wss?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_')
const THROTTLE = /rate|too many|throttle|slow down|spam/i
const PERMANENT = /auth-required|payment-required|whitel|banned/i

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const t = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('connect timeout')) }, 15_000)
    ws.onopen = () => { clearTimeout(t); resolve(ws) }
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws connect error')) }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runRelay(url) {
  const curPath = `${cursorDir}/cursor-${host(url)}.json`
  const resPath = `${cursorDir}/results-${host(url)}.json`
  let cursor = 0
  try { cursor = JSON.parse(readFileSync(curPath, 'utf8')).cursor ?? 0 } catch {}
  const stats = { relay: url, ok: 0, duplicates: 0, rejected: 0, dead: null, started: new Date().toISOString(), finished: null, cursorStart: cursor }
  const summary = (note) => {
    Object.assign(stats, { finished: new Date().toISOString(), upto: cursor })
    try { writeFileSync(resPath, JSON.stringify(stats, null, 2)) } catch {}
    console.log(`[${host(url)}] ${note} — ok=${stats.ok} dup=${stats.duplicates} rej=${stats.rejected} cursor=${cursor}/${events.length}`)
  }
  let backoff = 5000
  while (cursor < events.length) {
    let ws
    try { ws = await openWs(url); backoff = 5000 } catch (err) {
      console.log(`[${host(url)}] connect failed (${err.message}); retry in ${backoff / 1000}s`)
      await sleep(backoff); backoff = Math.min(backoff * 2, 300_000); continue
    }
    const pending = new Map()
    let dropped = false
    ws.onclose = () => { dropped = true; for (const s of pending.values()) s({ ackTimeout: true }) }
    ws.onmessage = (frame) => {
      let msg
      try { msg = JSON.parse(String(frame.data)) } catch { return }
      if (Array.isArray(msg) && msg[0] === 'OK') {
        const [, id, accepted, message] = msg
        const settle = pending.get(id)
        if (settle) { pending.delete(id); settle({ id, accepted: accepted === true, message: String(message ?? '') }) }
      } else if (Array.isArray(msg) && msg[0] === 'NOTICE') {
        console.log(`[${host(url)}] NOTICE: ${String(msg[1]).slice(0, 160)}`)
      }
    }
    const sendOne = (e) => new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(e.id); resolve({ ackTimeout: true }) }, 15_000)
      pending.set(e.id, (r) => { clearTimeout(t); resolve(r) })
      try { ws.send(JSON.stringify(['EVENT', e])) } catch { pending.delete(e.id); clearTimeout(t); resolve({ ackTimeout: true }) }
    })
    for (let i = cursor; i < events.length; i++) {
      const r = await sendOne(events[i])
      const msg = r.message ?? ''
      if (r.ackTimeout) {
        dropped = true
        break // reconnect, retry same index
      }
      if (r.accepted || msg.startsWith('duplicate')) {
        if (msg.startsWith('duplicate')) stats.duplicates++; else stats.ok++
        cursor = i + 1
        backoff = 5000
      } else if (PERMANENT.test(msg)) {
        stats.dead = msg
        try { ws.close() } catch {}
        return summary(`PERMANENT reject '${msg.slice(0, 80)}' — relay marked dead`)
      } else if (THROTTLE.test(msg)) {
        console.log(`[${host(url)}] throttle ('${msg.slice(0, 80)}'); backoff ${backoff / 1000}s`)
        try { writeFileSync(curPath, JSON.stringify({ cursor })) } catch {}
        try { ws.close() } catch {}
        await sleep(backoff); backoff = Math.min(backoff * 2, 300_000)
        break // reconnect
      } else {
        stats.rejected++
        console.log(`[${host(url)}] rejected ${events[i].id.slice(0, 8)}: ${msg.slice(0, 100)}`)
        cursor = i + 1 // one bad event shouldn't stall the corpus
      }
      if (i % 50 === 49) { try { writeFileSync(curPath, JSON.stringify({ cursor })) } catch {} }
      await sleep(paceMs + Math.floor(Math.random() * (paceMs / 2)))
    }
    try { ws.close() } catch {}
    if (!dropped && cursor >= events.length) return summary('complete')
    if (dropped) { console.log(`[${host(url)}] stream dropped at ${cursor}; reconnecting…`); await sleep(backoff); backoff = Math.min(backoff * 2, 300_000) }
    else break
  }
  return summary(cursor >= events.length ? 'complete' : 'incomplete')
}

await Promise.all(relays.map((url) => runRelay(url).catch((err) => console.log(`[${host(url)}] fatal: ${err.message}`))))
console.log('done.')
