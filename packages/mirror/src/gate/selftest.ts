/**
 * gate/selftest.ts — reproducible run of the gate over the frozen example set.
 *
 *   bun run packages/mirror/src/gate/selftest.ts [examplesDir]
 *
 * Default dir: the sibling design repo's example set. Prints per-event findings and
 * the aggregate counts recorded in SELFTEST.md. Exit code 0 iff every event passes
 * the signature/id/shape checks (the hard requirement); the remaining findings are
 * reported but are known legacy deviations (see SELFTEST.md), so they do not fail
 * the script.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gateEvents } from './index.js'

const DEFAULT_EXAMPLES = join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  'scrutiny-fabric/docs/mirroring/examples',
)
const dir = process.argv[2] ?? DEFAULT_EXAMPLES

const files = readdirSync(dir)
  .filter((f) => /^\d.*\.json$/.test(f))
  .sort()
const events: unknown[] = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))

function idOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    return typeof value.id === 'string' ? value.id : null
  }
  return null
}

const result = gateEvents(events)
const codesById = new Map<string, Set<string>>()
for (const err of result.errors) {
  if (err.event === null) continue
  const set = codesById.get(err.event) ?? new Set<string>()
  set.add(err.code)
  codesById.set(err.event, set)
}

console.log(`examples dir: ${dir}`)
console.log(
  `eventCount=${result.eventCount} errors=${result.errors.length} lostFacts=${result.lostFacts.length}`,
)

let cryptoPass = 0
files.forEach((file, i) => {
  const id = idOf(events[i])
  const codes = id === null ? new Set<string>(['NO-ID']) : (codesById.get(id) ?? new Set<string>())
  const cryptoOk = !codes.has('SHAPE') && !codes.has('ID-MISMATCH') && !codes.has('SIG-INVALID')
  if (cryptoOk) cryptoPass++
  const findings = [...codes].join(',') || 'clean'
  console.log(`  ${file.padEnd(38)} ${cryptoOk ? 'sig/id OK ' : 'SIG/ID FAIL'} ${findings}`)
})
console.log(`sig/id pass = ${cryptoPass}/${files.length}`)

for (const lost of result.lostFacts) console.log(`  LOST ${lost.event.slice(0, 16)} ${lost.fact}`)

const codeCounts: Record<string, number> = {}
for (const err of result.errors) codeCounts[err.code] = (codeCounts[err.code] ?? 0) + 1
console.log('error codes:', JSON.stringify(codeCounts))

process.exit(cryptoPass === files.length ? 0 : 1)
