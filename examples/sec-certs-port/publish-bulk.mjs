/**
 * Bulk NDJSON → Nostr relays publisher. Crash-safe, rate-limit-aware.
 *
 *   node publish-bulk.mjs <events.ndjson> <relay1,relay2,...> [--pace 250] [--cursor-dir .]
 *
 * - One WS per relay, all relays in parallel; events sent strictly sequentially per relay.
 * - Await per-event OK ack (15s) before the next event; ~pace ms (+jitter) between sends.
 * - Cursor per relay (<cursor-dir>/cursor-<host>.json) → restart resumes exactly; duplicates
 *   also satisfy the cursor (idempotent corpus by design).
 * - On throttle hints (OK error messages mentioning rate/too many/NOTICE) or mid-run socket
 *   drops: exponential backoff (5s → 5min cap) then reconnect and resume. 'auth-required' /
 *   'payment-required' / whitelist refs are permanent → relay marked dead, skipped.
 * - Summary per relay + results JSON at <cursor-dir>/results-<host>.json.
 *
 * Uses `ws` (dep of this example package) — Node's built-in undici WebSocket is rejected by
 * some public relays' client fingerprinting (damus/nos.lol observed, 2026-09-17).
 *
 * NIP-42: pass --auth-sec <64-hex-secret> (e.g. from --key-file format) and any relay
 * sending an AUTH challenge gets a signed kind-22242 reply (nonce challenge + relay tag,
 * timestamped) — needed for paid relays like nostr.wine after admission.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

const argv = process.argv.slice(2)
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }
const file = argv[0] ?? die('usage: publish-bulk.mjs <events.ndjson> <relay1,...> [--pace 250] [--cursor-dir .] [--auth-sec hexkey|--auth-key-file path]')
const relays = (argv[1] ?? die('give a comma-separated relay list')).split(',').filter(Boolean)
// --pace supports single value ("250") or per-relay map
// ("default:3000,relay.primal.net:400"). --inflight N lets up to N events be
// un-acked in flight per relay (ack-order-safe resume: cursor = within-order prefix).
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined }
const paceSpec = String(opt('--pace') ?? '250')
const paceFor = (url) => {
  const h = host(url)
  for (const part of paceSpec.split(',')) {
    const [k, v] = part.split(':')
    if (k && v && h === `relay_${k}`) return Number(v) // host() mangles to relay_nos_lol etc.
    if (k && v && (h.includes(k.replace(/[^a-z0-9]/gi, '_')) || h === k)) return Number(v)
  }
  const def = paceSpec.match(/default:(\d+)/)
  return def ? Number(def[1]) : (/^\d+$/.test(paceSpec) ? Number(paceSpec) : 250)
}
const inflightN = Number(opt('--inflight') ?? '1')
const cursorDir = opt('--cursor-dir') ?? '.'
mkdirSync(cursorDir, { recursive: true })

// NIP-42 secure-random challenge response (relay sends ['AUTH', challenge]; we reply
// with a signed kind-22242; the relay then honors the connection for our pubkey).
const authSecHex = opt('--auth-sec') ?? (() => {
  const p = opt('--auth-key-file')
  if (!p) return null
  const m = readFileSync(p, 'utf8').match(/Secret key \(hex\):\s*([0-9a-fA-F]{64})/i)
  return m ? m[1] : die(`could not parse 'Secret key (hex)' from ${p}`)
})()
const authSigned = authSecHex ? (url, challenge) => {
  const t = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', url], ['challenge', challenge]],
    content: '',
  }
  const sk = hexToBytes(authSecHex)
  const pubkey = bytesToHex(schnorr.getPublicKey(sk))
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, t.created_at, t.kind, t.tags, t.content]))))
  return { ...t, id, pubkey, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) }
} : null

const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
console.log(`${events.length} events → ${relays.length} relays (pace ${paceSpec}, inflight ${inflightN}, cursors in ${cursorDir})`)

const host = (r) => r.replace(/^wss?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_')
const THROTTLE = /rate|too many|throttle|slow down|spam/i
const PERMANENT = /auth-required|payment-required|whitel|banned/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const raceDrain = (pred, ms) => new Promise((res) => {
  const t0 = Date.now()
  const iv = setInterval(() => { if (pred() || Date.now() - t0 > ms) { clearInterval(iv); res() } }, 50)
  if (iv.unref) iv.unref()
})

function openWs(url) {
  return new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(url, { handshakeTimeout: 15_000 }) } catch (err) { return reject(err) }
    ws.once('open', () => resolve(ws))
    ws.once('error', (err) => { try { ws.close() } catch {} ; reject(err) })
  })
}

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
  let stalledCycles = 0 // consecutive connect↔throttle cycles that made zero cursor progress
  const heartbeat = setInterval(() => {
    console.log(`[${host(url)}] hb cursor=${cursor}/${events.length} ok=${stats.ok} dup=${stats.duplicates} rej=${stats.rejected}`)
    try { writeFileSync(curPath, JSON.stringify({ cursor })) } catch {}
  }, 60_000)
  heartbeat.unref()
  while (cursor < events.length) {
    let ws
    try { ws = await openWs(url); backoff = 5000 } catch (err) {
      console.log(`[${host(url)}] connect failed (${err.message}); retry in ${backoff / 1000}s`)
      await sleep(backoff); backoff = Math.min(backoff * 2, 300_000); continue
    }
    const pending = new Map()
    let dropped = false
    const dropAll = () => { dropped = true; for (const s of pending.values()) s({ ackTimeout: true }); pending.clear() }
    ws.on('close', dropAll)
    ws.on('error', () => dropAll())
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (Array.isArray(msg) && msg[0] === 'OK') {
        const [, id, accepted, message] = msg
        const settle = pending.get(id)
        if (settle) { pending.delete(id); settle({ id, accepted: accepted === true, message: String(message ?? '') }) }
      } else if (Array.isArray(msg) && msg[0] === 'AUTH') {
        if (authSigned) {
          try { ws.send(JSON.stringify(['AUTH', authSigned(url, String(msg[1]))])); console.log(`[${host(url)}] AUTH challenge answered`) }
          catch (e) { console.log(`[${host(url)}] AUTH send failed: ${e.message}`) }
        } else {
          console.log(`[${host(url)}] AUTH demanded but no --auth-sec given — relay may restrict writes`)
        }
      } else if (Array.isArray(msg) && msg[0] === 'NOTICE') {
        console.log(`[${host(url)}] NOTICE: ${String(msg[1]).slice(0, 160)}`)
      }
    })
    const sendOne = (e) => new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(e.id); resolve({ ackTimeout: true }) }, 15_000)
      pending.set(e.id, (r) => { clearTimeout(t); resolve(r) })
      ws.send(JSON.stringify(['EVENT', e]), (err) => { if (err) { pending.delete(e.id); clearTimeout(t); resolve({ ackTimeout: true }) } })
    })
    // Serial ack-wait loop — one event in flight per relay. The earlier pipelined
    // window kept stalling against newlay/relay.tools (results never drained);
    // this form is the one proven across nos.lol/nostr.mom/damus/primal runs.
    const pace = paceFor(url)
    for (let i = cursor; i < events.length; i++) {
      if (dropped) break
      const r = await sendOne(events[i])
      const msg = r.message ?? ''
      if (r.ackTimeout) { dropped = true; break }
      if (r.accepted || msg.startsWith('duplicate')) {
        if (msg.startsWith('duplicate')) stats.duplicates++; else stats.ok++
        cursor = i + 1
        backoff = 5000
        stalledCycles = 0
      } else if (PERMANENT.test(msg)) {
        stats.dead = msg
        try { ws.close() } catch {}
        return summary(`PERMANENT reject '${msg.slice(0, 80)}' — relay marked dead`)
      } else if (THROTTLE.test(msg)) {
        stalledCycles++
        const park = stalledCycles >= 3 ? Math.min(300_000 * 2 ** (stalledCycles - 3), 3 * 3_600_000) : 0
        console.log(`[${host(url)}] throttle (${msg.slice(0, 80)}); backoff ${backoff / 1000}s${park ? `, then park ${Math.round(park / 60000)}min (stall cycle ${stalledCycles})` : ''}`)
        try { writeFileSync(curPath, JSON.stringify({ cursor })) } catch {}
        try { ws.close() } catch {}
        await sleep(backoff); backoff = Math.min(backoff * 2, 300_000)
        if (park) await sleep(park)
        break
      } else {
        stats.rejected++
        console.log(`[${host(url)}] rejected ${events[i].id.slice(0, 8)}: ${msg.slice(0, 100)}`)
        cursor = i + 1
      }
      if (cursor % 50 === 0) { try { writeFileSync(curPath, JSON.stringify({ cursor })) } catch {} }
      await sleep(pace + Math.floor(Math.random() * Math.max(1, Math.floor(pace / 2))))
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
