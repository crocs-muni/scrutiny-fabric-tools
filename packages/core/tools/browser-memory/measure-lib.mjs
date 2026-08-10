/**
 * Shared measurement protocol for the browser-memory investigation (issue #30).
 *
 * Runs identically in Node (`measure-node.mjs`) and in a headless-Chrome tab
 * (`page-entry.mjs`, served by `measure-chrome.mjs`), so an identical event stream and
 * sequence of GC/sample points drives both engines. Host-specific IO (event loading,
 * GC trigger, heap sampler, clock) is injected.
 *
 * Phases: baseline → corpus parsed and retained → full `store.add()` ingest (public API,
 * `createStore` with default in-memory storage, `verify` stubbed — D12 keeps cryptography
 * out of core, so no signature work happens in either engine anyway; the retained sig/id
 * strings are present regardless).
 *
 * The corpus-array wrapper is released after ingest, so the `stored` sample reflects what
 * the STORE retains (its own references into the same event objects), not the loading
 * array. Samples follow triple-GC with a macrotask settle between rounds.
 */

export async function measure({ count, loadEvents, createStore, gc, heap, chunkSize = 10000 }) {
  const settle = () => new Promise((r) => setTimeout(r, 25))
  const sample = async () => {
    for (let i = 0; i < 3; i++) {
      gc()
      await settle()
    }
    return heap()
  }
  const t0 = performance.now()

  const baseline = await sample()

  const tLoad = performance.now()
  let events = await loadEvents(count)
  const msLoad = performance.now() - tLoad
  if (events.length !== count) throw new Error(`corpus short: wanted ${count}, got ${events.length}`)
  const corpus = await sample()

  const tIngest = performance.now()
  const store = createStore({ verify: () => true })
  const add = { accepted: 0, pending: 0, rejected: 0 }
  for (let i = 0; i < events.length; i += chunkSize) {
    const r = await store.add(events.slice(i, i + chunkSize))
    add.accepted += r.accepted.length
    add.pending += r.pending.length
    add.rejected += r.rejected.length
  }
  const msIngest = performance.now() - tIngest

  events = null
  // Liveness: pin BEFORE the GC+sample. Without a live reference here, engines may lawfully
  // collect `store` during the sample's forced GCs (observed: Chrome 151's V8 freed it, so
  // its `stored` phase measured corpus-only crumbs; Node 25's frame retained it). Pinned to
  // globalThis, alive-through-sample is structural in BOTH engines; cleared by
  // page reload / process exit.
  globalThis.__bmPinnedStore = store
  const stored = await sample()

  return {
    events: count,
    accepted: add.accepted,
    pending: add.pending,
    rejected: add.rejected,
    baseline,
    corpus,
    stored,
    retainedCorpus: corpus - baseline,
    retainedStore: stored - baseline,
    bytesPerEventCorpus: Math.round((corpus - baseline) / count),
    msLoad: Math.round(msLoad),
    msIngest: Math.round(msIngest),
    msTotal: Math.round(performance.now() - t0),
  }
}
