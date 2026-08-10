#!/usr/bin/env node
/**
 * Node baseline for the browser-memory investigation (issue #30).
 *
 * Measures retained JS heap after loading <count> events of the generated corpus into a
 * `createStore` in-memory store, through the same shared protocol the Chrome tab runs
 * (`measure-lib.mjs`), so figures are directly comparable.
 *
 * Usage:
 *   node --expose-gc tools/browser-memory/measure-node.mjs [events.json] <count>
 *
 * One measurement per process, so each run starts from a clean heap. Prints one JSON row.
 *
 * Method matches AUDIT-2026-07-31 §4: forced GC (`--expose-gc`) before each sample,
 * `process.memoryUsage().heapUsed`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../../dist/index.js'
import { measure } from './measure-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const eventsPath = resolve(
  args.length > 1
    ? args[0]
    : join(here, '../../../../investigations/browser-memory/events-full.json'),
)
const count = Number(args.at(-1))
if (!Number.isInteger(count) || count <= 0) {
  console.error('usage: node --expose-gc measure-node.mjs [events.json] <count>')
  process.exit(1)
}

const result = await measure({
  count,
  loadEvents: async (n) => JSON.parse(readFileSync(eventsPath, 'utf8')).slice(0, n),
  createStore,
  gc: () => global.gc(),
  heap: () => process.memoryUsage().heapUsed,
})

console.log(
  JSON.stringify({ engine: `node ${process.version} (v8 ${process.versions.v8})`, ...result }),
)
