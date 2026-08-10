#!/usr/bin/env node
/**
 * Headless-Chrome retained-heap measurement for the browser-memory investigation (issue #30).
 *
 * Serves the PUBLISHED ESM build of @scrutiny-fabric/core (packages/core/dist) plus the
 * `diff` runtime dependency over a loopback HTTP server (an import map resolves `diff` to its
 * own ESM entry — the tab runs the exact files a downstream bundler would ship; nothing is
 * rebundled), launches headless Chrome on a throwaway profile, and drives it over raw CDP via
 * Node ≥22's built-in WebSocket. Zero new dependencies.
 *
 * Chrome flags: `--js-flags=--expose-gc --enable-precise-memory-info`. Each tab load fetches
 * and parses the generated corpus, ingests it through `createStore` (public API), and POSTs
 * the measured sample back; the orchestrator cross-checks the sample against CDP
 * `Performance.getMetrics().JSHeapUsedSize` after a CDP-forced garbage collection.
 *
 * Requirements: Chrome ≥136 needs a non-default --user-data-dir for remote debugging
 * (https://developer.chrome.com/blog/remote-debugging-port) — this harness always launches
 * with a fresh temporary profile dir, which satisfies that and isolates the measurement.
 *
 * Usage:
 *   node tools/browser-memory/measure-chrome.mjs [events.json] <count> [...more counts]
 *
 * Each count is measured across two fresh page loads (criterion: heap round-trip across at
 * least two loads). Writes results-chrome-<ISO>.json beside the corpus and prints a table.
 */

import { spawn } from 'node:child_process'
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '../..')
const repoRoot = resolve(here, '../../../..')

const args = process.argv.slice(2)
const numericArgs = args.filter((a) => /^\d+$/.test(a))
const counts = numericArgs.map(Number)
if (counts.length === 0) {
  console.error('usage: node measure-chrome.mjs [events.json] <count> [...more counts]')
  process.exit(1)
}
const eventsPath = resolve(
  args.length > counts.length
    ? args.find((a) => !/^\d+$/.test(a))
    : join(repoRoot, 'investigations/browser-memory/events-full.json'),
)
const eventsStat = statSync(eventsPath) // throws early when the corpus has not been generated

const diffPkg = JSON.parse(readFileSync(join(pkgRoot, 'node_modules/diff/package.json'), 'utf8'))
const diffDir = join(pkgRoot, 'node_modules/diff')
const diffEsmPath = diffPkg.exports['.'].import.default.replace(/^\.\//, '/')

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const chrome = chromeCandidates.find((p) => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
})
if (!chrome) throw new Error('No Chrome binary found; set CHROME_PATH')

// ── loopback HTTP server: page, published ESM, diff ESM, corpus, result sink ─
let resultWaiter = null
const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' }
const distRoot = join(pkgRoot, 'dist')
function serveFile(res, file, ctype) {
  res.writeHead(200, { 'Content-Type': ctype })
  createReadStream(file)
    .once('error', () => res.destroy())
    .pipe(res)
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      resultWaiter?.(JSON.parse(body))
      resultWaiter = null
      res.writeHead(200).end('ok')
    })
    return
  }
  if (url.pathname === '/') {
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"diff":"/vendor${diffEsmPath}"}}</script><script type="module" src="/page-entry.mjs"></script>`,
      )
    return
  }
  if (url.pathname === '/page-entry.mjs' || url.pathname === '/measure-lib.mjs') {
    serveFile(res, join(here, url.pathname.slice(1)), 'text/javascript')
    return
  }
  if (url.pathname.startsWith('/vendor/')) {
    const file = resolve(diffDir, url.pathname.slice(8))
    if (!file.startsWith(diffDir + sep)) {
      res.writeHead(403).end()
      return
    }
    serveFile(res, file, MIME[file.slice(file.lastIndexOf('.'))] ?? 'text/plain')
    return
  }
  if (url.pathname.startsWith('/dist/')) {
    const file = resolve(distRoot, url.pathname.slice(6))
    if (!file.startsWith(distRoot + sep)) {
      res.writeHead(403).end()
      return
    }
    serveFile(res, file, MIME[file.slice(file.lastIndexOf('.'))] ?? 'text/plain')
    return
  }
  if (url.pathname === '/events.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': eventsStat.size })
    createReadStream(eventsPath).pipe(res)
    return
  }
  res.writeHead(404).end('not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// ── headless Chrome on a throwaway profile ───────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'bm-chrome-'))
// Sweep orphaned profile dirs from crashed prior runs of this tool (only bm-chrome-* we made).
for (const d of readdirSync(tmpdir())) {
  if (d.startsWith('bm-chrome-') && join(tmpdir(), d) !== profile) {
    rmSync(join(tmpdir(), d), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  }
}
const proc = spawn(chrome, [
  '--headless',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--mute-audio',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
  'about:blank',
])
proc.once('error', (err) => {
  console.error(`failed to launch chrome: ${err.message}`)
  process.exit(1)
})
const cdpWsUrl = await new Promise((resolveWs, rejectWs) => {
  let buf = ''
  const timer = setTimeout(() => rejectWs(new Error('no DevTools banner within 30s')), 30000)
  proc.stderr.on('data', (c) => {
    buf += c
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m) {
      clearTimeout(timer)
      resolveWs(m[1])
    }
  })
})
const cdpPort = Number(new URL(cdpWsUrl).port)

const json = async (p) => (await fetch(`http://127.0.0.1:${cdpPort}${p}`)).json()
let version = null
for (let i = 0; i < 50 && !version; i++) {
  try {
    version = await json('/json/version')
  } catch {
    await new Promise((r) => setTimeout(r, 200))
  }
}
console.log(`Browser: ${version.Browser} · V8 ${version['V8-Version']} · ${version['User-Agent']}`)

// ── minimal CDP client over the built-in WebSocket, connected to the BROWSER
// endpoint: every measurement run gets its own fresh target (tab), so heaps can
// never leak across loads the way a reused tab allowed (observed: navigation
// preserved the previous run's heap).
const ws = new WebSocket(cdpWsUrl)
await new Promise((resOpen, rejOpen) => {
  ws.addEventListener('open', resOpen, { once: true })
  ws.addEventListener('error', () => rejOpen(new Error('CDP websocket failed')), { once: true })
})
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rej(new Error(`${msg.error.message} (${msg.error.code})`)) : res(msg.result)
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    console.log(`  [tab:${msg.params.type}] ${text}`)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.log(
      `  [tab:exception] ${d.text} ${d.exception?.description ?? ''} @${d.url ?? ''}:${d.lineNumber ?? ''}`,
    )
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    console.log(`  [tab:${e.level}] ${e.text} @${e.url ?? ''}`)
  }
})
const send = (method, params = {}, sessionId = undefined) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej })
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
  })

// ── measurement runs ─────────────────────────────────────────────────────────
// Two loads per size by default (the acceptance round-trip); BM_RUNS=1 for exploratory big
// sizes where the superlinear-admit finding (see docs/BROWSER-MEMORY-2026-08-10.md) makes a
// second load cost tens of minutes.
const runsPerSize = Number(process.env.BM_RUNS ?? 2)
const results = []
for (const count of counts) {
  for (let run = 1; run <= runsPerSize; run++) {
    const t0 = Date.now()
    const posted = new Promise((res) => {
      resultWaiter = res
    })
    const timeout = new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error(`tab did not report within 2700s (count=${count}, run ${run})`)),
        2_700_000,
      ),
    )
    // Fresh target per load — heap isolation across the two round-trip loads.
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Runtime.enable', {}, sessionId)
    await send('Performance.enable', {}, sessionId)
    await send('Log.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    await send(
      'Page.navigate',
      { url: `http://127.0.0.1:${port}/?count=${count}&run=${run}` },
      sessionId,
    )
    const watchdog = setInterval(async () => {
      try {
        const r = await send(
          'Runtime.evaluate',
          {
            expression: `location.href + ' | ready=' + document.readyState + ' | gc=' + typeof window.gc`,
          },
          sessionId,
        )
        console.log(`  [watchdog] ${r.result.value}`)
      } catch (e) {
        console.log(`  [watchdog] evaluate failed: ${e.message}`)
      }
    }, 60000)
    const payload = await Promise.race([posted, timeout])
    clearInterval(watchdog)
    if (!payload.ok) throw new Error(`tab error (count=${count}, run ${run}): ${payload.error}`)
    // Cross-check in the page's own context (store is pinned on globalThis by measure-lib,
    // so this re-read samples a live store): force GC, re-read the precise heap, and count
    // retained events through the store's own public getState() — proof of retention, not
    // just of allocation.
    const cross = await send(
      'Runtime.evaluate',
      {
        expression:
          '(() => { if (window.gc) { window.gc(); window.gc(); window.gc(); } ' +
          'var s = globalThis.__bmPinnedStore; ' +
          'var observed = s ? Object.keys(s.getState().admit.observedById).length : -1; ' +
          'return JSON.stringify({ heap: performance.memory ? performance.memory.usedJSHeapSize : null, observed: observed }); })()',
        returnByValue: true,
      },
      sessionId,
    )
    if (cross.exceptionDetails) {
      const d = cross.exceptionDetails
      console.log(
        `  [tab:cross-eval failed] ${d.text}: ${d.exception?.description?.split('\n')[0] ?? ''}`,
      )
    }
    const crossData = cross.result.value
      ? JSON.parse(cross.result.value)
      : { heap: null, observed: null }
    payload.pageCrossHeap = crossData.heap
    payload.crossObservedCount = crossData.observed
    await send('HeapProfiler.collectGarbage', {}, sessionId).catch(() => {})
    const { metrics } = await send('Performance.getMetrics', {}, sessionId)
    payload.cdpJsHeapUsed = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null
    // Renderer total footprint from the OS, best effort: V8's heap sandbox can hold
    // allocations that usedJSHeapSize-derived counters do not attribute, and the
    // tab-ceiling verdict the issue asks for is about TOTAL tab memory, not one
    // V8 accounting bucket. Windows-only lookup; null on any failure.
    try {
      const { processInfo } = await send('SystemInfo.getProcessInfo')
      const pids = processInfo
        .filter((p) => p.type === 'tab' || p.type === 'renderer')
        .map((p) => p.id)
      if (pids.length === 0) {
        console.log('  [rss] no tab/renderer processes found')
      } else {
        const { execFileSync } = await import('node:child_process')
        // The measurement tab dominates: take the largest working set among renderers.
        const out = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-Process -Id ${pids.join(',')} | Measure-Object WorkingSet64 -Maximum).Maximum`,
          ],
          { timeout: 10000 },
        )
        payload.rendererMaxWsMB = Number(String(out).trim()) / 1048576
      }
    } catch (err) {
      console.log(`  [rss] probe failed: ${err.message?.split('\n')[0]}`)
      payload.rendererMaxWsMB = null
    }
    payload.rendererPrivateMB = null
    await send('Target.closeTarget', { targetId }).catch(() => {})
    payload.wallMs = Date.now() - t0
    results.push({ browser: version.Browser, v8: version['V8-Version'], ...payload })
    const mb = (b) => (b / 1048576).toFixed(1)
    console.log(
      `  count=${payload.events} run=${run}  corpus=${mb(payload.retainedCorpus)}MB ` +
        `store=${mb(payload.retainedStore)}MB  cross=${mb(payload.pageCrossHeap)}MB ` +
        `cdp=${mb(payload.cdpJsHeapUsed)}MB  ws=${mb((payload.rendererMaxWsMB ?? 0) * 1048576)}MB  ` +
        `ingest=${payload.msIngest}ms  (accepted ${payload.accepted}, pending ${payload.pending}, ` +
        `observed ${payload.crossObservedCount})`,
    )
  }
}

const outPath = join(
  repoRoot,
  'investigations/browser-memory',
  `results-chrome-${new Date().toISOString().slice(0, 16).replaceAll(':', '')}.json`,
)
writeFileSync(outPath, JSON.stringify({ chrome: version, results }, null, 2))
console.log(`wrote ${outPath}`)

ws.close()
proc.kill()
server.close()
// Windows holds the profile dir briefly after the root process dies — wait for exit, then
// retry. Only our own mkdtemp'd bm-chrome-* dirs are ever removed.
await new Promise((r) => {
  proc.once('exit', r)
  setTimeout(r, 5000)
})
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })

process.on('exit', () => {
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
})
