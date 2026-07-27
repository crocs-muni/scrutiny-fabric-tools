#!/usr/bin/env node
/**
 * Generate `packages/core/src/rules.ts` from `tools/rules.json`.
 *
 * `rules.json` is itself extracted from Appendix F of the protocol spec by `extract-rules.mjs`.
 * The chain is therefore: protocol-spec.md -> rules.json -> rules.ts, and no link in it is
 * hand-written (D35, D36). 134 hand-typed rule IDs would drift, which is how the two previous
 * implementations died.
 *
 * Usage:
 *   node tools/gen-rules.mjs           regenerate rules.ts
 *   node tools/gen-rules.mjs --check   exit 1 if the committed rules.ts has drifted
 *
 * Scope note: this checks rules.ts against rules.json only. Verifying rules.json against the spec
 * needs the spec repo, which CI does not have; that is the vendored-checksum gate in Phase 7.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, 'rules.json')
const TARGET = join(here, '..', 'packages', 'core', 'src', 'rules.ts')

/** Single-quoted TS string literal, matching the Biome style used across the package. */
const lit = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

const nullable = (s) => (s === null || s === '' ? 'null' : lit(s))

function generate(rules) {
  const ids = rules.map((r) => r.id)

  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (duplicates.length > 0) {
    throw new Error(`duplicate rule ids in rules.json: ${duplicates.join(', ')}`)
  }

  const byLayer = { V: 0, A: 0, D: 0, reserved: 0 }
  for (const r of rules) {
    if (r.layer === null) byLayer.reserved += 1
    else byLayer[r.layer] += 1
  }

  const entries = rules
    .map((r) =>
      [
        `  '${r.id}': {`,
        `    id: '${r.id}',`,
        `    section: ${lit(r.section)},`,
        `    layer: ${nullable(r.layer)},`,
        `    inheritsFrom: ${nullable(r.inheritsFrom)},`,
        `    summary: ${lit(r.summary)},`,
        `    reserved: ${r.reserved},`,
        '  },',
      ].join('\n'),
    )
    .join('\n')

  return `// GENERATED FILE — do not edit by hand.
//
// Source:      tools/rules.json (extracted from Appendix F of the SCRUTINY Fabric protocol spec)
// Regenerate:  pnpm rules:gen
// Verify:      pnpm rules:check
//
// ${rules.length} rules: V=${byLayer.V}, A=${byLayer.A}, D=${byLayer.D}, ${byLayer.reserved} reserved.

/**
 * The layer a rule belongs to (§6.0). The partition is by *subject*, not by normative strength —
 * a MUST may appear in any layer.
 *
 * - \`V\` — Validity. Is the event well-formed and admissible at all?
 * - \`A\` — Application. Given an admitted event, does applying it to chain state succeed?
 * - \`D\` — Discovery. How do consumers find, gate visibility, and resolve events?
 *
 * The distinction is enforced, not decorative: TR-1 forbids rejecting a V-valid event because it
 * violates an A or D rule.
 */
export type RuleLayer = 'V' | 'A' | 'D'

/** Every rule ID in Appendix F. */
export type RuleId =
${ids.map((id) => `  | '${id}'`).join('\n')}

/** Appendix F metadata for a single rule. */
export interface Rule {
  readonly id: RuleId
  /** Spec section the rule is defined in, e.g. \`'4.3'\`. */
  readonly section: string
  /** \`null\` only for reserved IDs, which have no layer. */
  readonly layer: RuleLayer | null
  /** Base-layer source this rule inherits from (\`'NIP-01'\`, \`'CommonMark §4.5'\`, …), if any. */
  readonly inheritsFrom: string | null
  /** One-line summary. The spec prose remains the authoritative definition. */
  readonly summary: string
  /**
   * A retained-but-superseded ID. Reserved rules are never emitted as issues; the ID exists so
   * that older citations still dereference.
   */
  readonly reserved: boolean
}

/** Every rule in Appendix F, keyed by ID. */
export const RULES: Readonly<Record<RuleId, Rule>> = Object.freeze({
${entries}
})

/** Every rule ID, in Appendix F order. */
export const RULE_IDS: readonly RuleId[] = Object.freeze(Object.keys(RULES) as RuleId[])

/** Whether an arbitrary string is a registered rule ID. */
export function isRuleId(value: string): value is RuleId {
  return Object.hasOwn(RULES, value)
}
`
}

const rules = JSON.parse(readFileSync(SOURCE, 'utf8'))
const generated = generate(rules)

if (process.argv.includes('--check')) {
  let current
  try {
    current = readFileSync(TARGET, 'utf8')
  } catch {
    console.error('rules.ts is missing. Run: pnpm rules:gen')
    process.exit(1)
  }
  if (current !== generated) {
    console.error('rules.ts has drifted from rules.json. Run: pnpm rules:gen')
    process.exit(1)
  }
  console.log(`rules.ts is in sync with rules.json (${rules.length} rules).`)
} else {
  writeFileSync(TARGET, generated)
  console.log(`Wrote ${TARGET} (${rules.length} rules).`)
}
