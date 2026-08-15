#!/usr/bin/env node
/**
 * Phase 23 (mandate §8, #46 §3/C6) — regenerate the module-ownership table in
 * `#53` from the per-module coverage tables, never by hand.
 *
 * Sources of truth (in order): the rule registry (`tools/rules.json`, itself generated from the
 * spec), and the coverage partition the gates actually execute — `packages/core/test/_v-coverage.ts`,
 * `packages/core/test/_a-*-coverage.ts`, and `packages/core/test/_unowned.ts`. The table's `Owns`
 * column is collapsed ranges (`TAG-1…5, BD-1…7/10/12`) over a module's emitted + not-covered rules;
 * its `Notes` column is hand-written prose carried forward per module name, with orphans warned
 * rather than silently dropped.
 *
 * `node tools/gen-ownership.mjs` rewrites the marked block; `--check` fails on drift instead of
 * writing. Hard errors (exit 2, not drift): a rule id in a table or `_unowned` that is not in the
 * registry, and a rule id claimed by NO table AND not unowned — the two silence classes the audit
 * caught when this table was hand-maintained.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1')
  .replace(/\/$/, '')
const PLAN = `${ROOT}/docs/COVERAGE.md`
const RULES_JSON = `${ROOT}/tools/rules.json`
const START = '<!-- ownership:table:start -->'
const END = '<!-- ownership:table:end -->'

const MODULE_OF_FILE = (file) =>
  file === '_v-coverage' ? 'validate' : file.replace(/^_a-/, '').replace(/-coverage(\.ts)?$/, '')

/** `'ID': …(` or `ID: …(` entries of one table file (emitted or notCovered), in order. */
function parseTable(path) {
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/^ {2}'?([A-Z]{1,4}-?\d+)'?\s*:\s*(?:emitted|notCovered)\(/gm)].map(
    (m) => m[1],
  )
}

/** Rules with no owning module, per `_unowned.ts`. */
function parseUnowned(path) {
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(/^ {2}'([A-Z]{1,4}-?\d+)':(?=\s|$)/gm)].map((m) => m[1])
}

/** `TAG-1/TAG-2/TAG-3` → `TAG-1…3`; `BD-1,BD-10,BD-12` → `BD-1/10/12`; runs continue with `/`. */
function compactRanges(ids, order) {
  const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const groups = new Map()
  for (const id of sorted) {
    const m = /^([A-Z]+)-?(\d+)$/.exec(id)
    if (!m) continue
    if (!groups.has(m[1])) groups.set(m[1], [])
    groups.get(m[1]).push(Number(m[2]))
  }
  const renderGroup = (prefix, nums) => {
    const sep = prefix.length === 1 ? '' : '-'
    const parts = []
    let run = [nums[0]]
    const flush = () => {
      parts.push(
        run.length >= 3
          ? `${prefix}${sep}${run[0]}…${prefix}${sep}${run[run.length - 1]}`
          : run.map((n) => `${prefix}${sep}${n}`).join('/'),
      )
      run = []
    }
    for (const n of nums.slice(1)) {
      if (n === run[run.length - 1] + 1) run.push(n)
      else {
        flush()
        run = [n]
      }
    }
    flush()
    return parts.join('/')
  }
  return [...groups.entries()].map(([p, ns]) => renderGroup(p, ns)).join(', ')
}

/** Read the current table's rows and unowned-paragraph prose, for carry-forward. */
function readCurrentBlock(planText) {
  const rows = new Map()
  for (const m of planText.matchAll(
    /^\| `([^`]+)`(?: \*\*\(internal\)\*\*)? \| ([^|]*) \| ([^|]*) \|$/gm,
  )) {
    rows.set(m[1], m[3].trim())
  }
  return rows
}

const registry = JSON.parse(readFileSync(RULES_JSON, 'utf8'))
const order = registry.map((r) => r.id)
const known = new Set(order)

const tableFiles = [
  ...['_v', 'admit', 'build', 'patch', 'query', 'resolve', 'store', 'validate'].map((n) =>
    n === '_v' ? '_v-coverage' : `_a-${n}-coverage`,
  ),
]
/** module → ids (emitted and not-covered both count as owned; duplicates across modules allowed). */
const byModule = new Map()
const claims = new Map() // id → module[]
const unknownRefs = []
for (const file of tableFiles) {
  const module = MODULE_OF_FILE(file.replaceAll('\\', '/'))
  for (const id of parseTable(`${ROOT}/packages/core/test/${file}.ts`)) {
    if (!known.has(id)) unknownRefs.push(`${file}: ${id}`)
    const list = byModule.get(module) ?? []
    list.push(id)
    byModule.set(module, list)
    claims.set(id, [...(claims.get(id) ?? []), module])
  }
}
const unowned = parseUnowned(`${ROOT}/packages/core/test/_unowned.ts`)
for (const id of unowned) {
  if (!known.has(id)) unknownRefs.push(`_unowned.ts: ${id}`)
}

const seen = new Set([...claims.keys()])
const invisible = order.filter((id) => !seen.has(id) && !unowned.includes(id))
if (unknownRefs.length > 0) {
  console.error(
    `HARDFAIL — registry does not contain these referenced rules:\n  ${unknownRefs.join('\n  ')}`,
  )
  process.exit(2)
}
if (invisible.length > 0) {
  console.error(
    `HARDFAIL — rules claimed by no coverage table and not unowned (the audit's silent class):\n  ${invisible.join(', ')}`,
  )
  process.exit(2)
}

const planText = readFileSync(PLAN, 'utf8')
const currentNotes = readCurrentBlock(planText)
const modulesPresent = [...byModule.keys()]
const orphans = [...currentNotes.keys()].filter((name) => !modulesPresent.includes(name))

const rows = [...byModule.entries()].map(([module, ids]) => {
  const owns = compactRanges(ids, order)
  const notes = currentNotes.get(module) ?? ''
  return `| \`${module}\` | ${owns} | ${notes} |`
})

const duplicated = [...claims.entries()].filter(([, ms]) => ms.length > 1)
const dupNote =
  duplicated.length === 0
    ? ''
    : `\n${duplicated
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, ms]) => `${id} (shared: ${ms.join(', ')})`)
        .join(
          ', ',
        )} are claimed by more than one table — several obligations span layers legitimately (see the closure gate's note on uniqueness).`

const unownedList = compactRanges(unowned, order)
const block = [
  START,
  '',
  '| Module | Owns | Notes |',
  '|---|---|---|',
  ...rows,
  '',
  `Not owned by any module, by design: **${unowned.length} rules, now enumerated with written reasons in`,
  `\`packages/core/test/_unowned.ts\` and machine-checked** — ${unownedList}. The previous form of this`,
  'sentence was wrong twice: it listed IX-2 and RL-1, both of which turned out implementable (see',
  `\`build\` above), and it omitted seven rules entirely.${dupNote ? '' : ''}`,
  ...(dupNote ? [dupNote] : []),
  '',
  END,
].join('\n')

// Replace the marked block; on first run, from the hand table header through its closing sentence.
let nextPlan
if (planText.includes(START)) {
  const head = planText.slice(0, planText.indexOf(START))
  const tail = planText.slice(planText.indexOf(END) + END.length)
  nextPlan = `${head}${block}${tail}`
} else {
  const from = planText.indexOf('| Module | Owns | Notes |')
  const to = planText.indexOf('and it omitted seven rules entirely.')
  if (from === -1 || to === -1) {
    console.error('HARDFAIL — could not locate the hand table region in the plan to replace.')
    process.exit(2)
  }
  nextPlan = `${planText.slice(0, from)}${block}${planText.slice(to + 'and it omitted seven rules entirely.'.length)}`
}

if (orphans.length > 0 && !planText.includes(START)) {
  console.warn(
    `Notes orphaned by the regenerated shape (relocate by hand once): ${orphans.join(', ')}`,
  )
}

if (process.argv.includes('--check')) {
  if (nextPlan !== planText) {
    console.error('DRIFT — the ownership table in #53 is stale. Run `pnpm ownership:gen`.')
    process.exit(1)
  }
  console.log('ownership table is in sync with the coverage partition.')
} else {
  writeFileSync(PLAN, nextPlan)
  console.log('ownership table regenerated from the coverage partition.')
}
