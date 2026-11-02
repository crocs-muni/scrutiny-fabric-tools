/**
 * Post-bulk-publish verification. Per relay:
 *   1) NIP-45 COUNT of #t=scrutiny-fabric-test (ground truth of real storage — OK=true
 *      during publish can be strfry shadowReject, count cannot lie).
 *   2) Recipe probes (these are the corpus' three use cases):
 *      - #i cve:CVE-2017-15361              → ROCA vuln metadata (jcalgtest corpus)
 *      - #i jcrun:perf-fixed, limit 50      → ECDSA recipe candidates (jcalgtest)
 *      - #i pq:ml-kem, limit 50             → PQC flags (sec-certs corpus)
 *      - sample bindingsReferencing-lite: #e of first found product? (skipped — count suffices)
 *
 *   node verify-live.mjs <relay1,[relay2,...]> [--expect 10790]
 */
import WebSocket from 'ws'

const argv = process.argv.slice(2)
const relays = (argv[0] ?? '').split(',').filter(Boolean)
if (relays.length === 0) { console.error('usage: verify-live.mjs <relay1,...> [--expect N]'); process.exit(1) }
const expect = Number(argv[argv.indexOf('--expect') + 1] || 10790)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(url, msg, collect = 'eose') {
  return new Promise((resolve) => {
    const out = { events: [], count: null, notice: [], error: null }
    let ws
    try { ws = new WebSocket(url, { handshakeTimeout: 15_000 }) } catch (err) { out.error = String(err); return resolve(out) }
    const t = setTimeout(() => { try { ws.close() } catch {}; out.error ??= 'timeout'; try { ws.close() } catch {}; resolve(out) }, 30_000)
    ws.on('open', () => ws.send(JSON.stringify(msg)))
    ws.on('message', (data) => {
      let m
      try { m = JSON.parse(String(data)) } catch { return }
      if (m[0] === 'EVENT') out.events.push(m[2])
      else if (m[0] === 'COUNT') { out.count = m[2]?.count ?? null; if (collect === 'eose') { try { ws.close() } catch {}; clearTimeout(t); resolve(out) } }
      else if (m[0] === 'EOSE') { try { ws.close() } catch {}; clearTimeout(t); resolve(out) }
      else if (m[0] === 'CLOSED') { out.error = `closed: ${m[2] ?? ''}` ; try { ws.close() } catch {}; clearTimeout(t); resolve(out) }
      else if (m[0] === 'NOTICE') out.notice.push(String(m[1]).slice(0, 120))
    })
    ws.on('error', (e) => { out.error ??= String(e.message); try { ws.close() } catch {}; clearTimeout(t); resolve(out) })
    ws.on('close', () => { clearTimeout(t); resolve(out) })
  })
}

for (const url of relays) {
  const tagCount = await rpc(url, ['COUNT', 'cv', { kinds: [1], '#t': ['scrutiny-fabric-test'] }])
  const roca = await rpc(url, ['REQ', 'rv', { kinds: [1], '#i': ['cve:CVE-2017-15361'], limit: 3 }])
  const perf = await rpc(url, ['REQ', 'pv', { kinds: [1], '#i': ['jcrun:perf-fixed'], limit: 60 }])
  const pq = await rpc(url, ['REQ', 'qv', { kinds: [1], '#i': ['pq:ml-kem'], limit: 3 }])
  console.log(`=== ${url}`)
  console.log(`  COUNT #t scrutiny-fabric-test: ${tagCount.count ?? `ERR ${tagCount.error ?? 'none'}`} ${typeof tagCount.count === 'number' ? (tagCount.count >= expect ? '✓' : `SHORT by ${expect - tagCount.count}`) : ''}`)
  console.log(`  ROCA vuln event: ${roca.events.length ? 'FOUND ✓' : 'missing (corpus may still be publishing)'}  perf-fixed events: ${perf.events.length}  pq:ml-kem events: ${pq.events.length}`)
  await sleep(300)
}
console.log('done.')
