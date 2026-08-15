/**
 * Browser-side measurement page for the browser-memory investigation (issue #30).
 *
 * Loaded by `measure-chrome.mjs` over loopback HTTP with an import map resolving `diff` to
 * its own ESM build. Runs the shared protocol from `measure-lib.mjs` against the published
 * bundle and POSTs the measured sample to `/result` for the orchestrator.
 */

import { createStore } from '/dist/index.js'
import { measure } from './measure-lib.mjs'

const params = new URLSearchParams(location.search)
const count = Number(params.get('count'))
const run = Number(params.get('run'))

try {
  const result = await measure({
    count,
    loadEvents: async (n) => {
      const res = await fetch('/events.json')
      let events = JSON.parse(await res.text())
      if (events.length > n) events = events.slice(0, n)
      return events
    },
    createStore,
    gc: () => window.gc(),
    heap: () => performance.memory.usedJSHeapSize,
  })
  await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: true, run, ...result }) })
} catch (err) {
  const message = err?.stack ? String(err.stack) : String(err)
  await fetch('/result', {
    method: 'POST',
    body: JSON.stringify({ ok: false, run, error: message }),
  })
}
