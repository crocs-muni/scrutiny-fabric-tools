#!/usr/bin/env node
/**
 * Survivor hand-check harness for StrykerJS mutation testing.
 *
 * Applies each surviving mutant to the real source, runs the full vitest suite, and reports
 * whether the suite kills it. Used to distinguish genuine equivalent mutants from runner
 * attribution misses (stryker-js #6073-class) before retiring a mutant with a disable comment.
 *
 * Usage:
 *   pnpm mutant-check <module>          # check all survivors in src/<module>.ts
 *   pnpm mutant-check <module> --quick  # check only the first 5 survivors
 *
 * Prerequisites: `pnpm build` must be current (the harness imports from dist/ for the
 * unmutated baseline, and mutates src/ for the patched run).
 *
 * Evidence convention: every "equivalent mutant" justification in this repo must cite a
 * `pnpm mutant-check` run as its evidence (docs/QUALITY-AUDIT-2026-08-08.md §3 Step-5, T5-a).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const module = process.argv[2]
if (!module) {
  console.error('Usage: pnpm mutant-check <module> [--quick]')
  console.error('Example: pnpm mutant-check patch')
  process.exit(1)
}

const quick = process.argv.includes('--quick')
const reportPath = 'reports/mutation/mutation.json'
const srcPath = `src/${module}.ts`
const orig = readFileSync(srcPath, 'utf8')
const lines = orig.split('\n')

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const fileKey = Object.keys(report.files).find((k) => k.endsWith(`${module}.ts`))
if (!fileKey) {
  console.error(`No mutation report found for ${module}.ts at ${reportPath}`)
  console.error(`Run \`pnpm test:mutate --mutate src/${module}.ts\` first.`)
  process.exit(1)
}

const survivors = report.files[fileKey].mutants.filter(
  (m) => m.status === 'Survived' || m.status === 'NoCoverage',
)

if (survivors.length === 0) {
  console.log(`${module}.ts: no survivors to check.`)
  process.exit(0)
}

console.log(`${module}.ts: ${survivors.length} survivor(s) to hand-check`)

const offsetOf = (line, col) => {
  let off = 0
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1
  return off + col - 1
}

const toCheck = quick ? survivors.slice(0, 5) : survivors
const results = []

for (const m of toCheck) {
  const start = offsetOf(m.location.start.line, m.location.start.column)
  const end = offsetOf(m.location.end.line, m.location.end.column)
  const segment = orig.slice(start, end)
  const replacement = m.replacement ?? ''
  const label = `#${m.id} ${m.mutatorName}@${m.location.start.line}:${m.location.start.column}`

  writeFileSync(srcPath, orig.slice(0, start) + replacement + orig.slice(end))

  let verdict
  try {
    execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=basic'], {
      stdio: 'pipe',
    })
    verdict = 'SURVIVES-SUITE (genuine equivalent candidate)'
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const failed = out.match(/Tests +(\d+ failed)/)
    verdict = failed ? `KILLED-BY-SUITE (${failed[1]})` : 'KILLED-BY-SUITE (nonzero exit)'
  }

  writeFileSync(srcPath, orig)
  results.push({
    label,
    verdict,
    segment: segment.slice(0, 60),
    replacement: replacement.slice(0, 60),
  })
  console.log(`${verdict.padEnd(24)} ${label}`)
  console.log(`  segment: ${JSON.stringify(segment.slice(0, 60))}`)
  console.log(`  with:    ${JSON.stringify(replacement.slice(0, 60))}`)
}

const tally = {}
for (const { verdict } of results) {
  const key = verdict.split(' ')[0]
  tally[key] = (tally[key] ?? 0) + 1
}
console.log(`\nTALLY: ${JSON.stringify(tally)}`)
