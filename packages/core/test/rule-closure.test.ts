/**
 * The registry-closure gate — every rule in the spec is accounted for somewhere.
 *
 * D34/D35's promise is that a rule "cannot be silently dropped". Until the Phase 8 audit that held
 * for the Validity layer only: `v-coverage.test.ts` derives its expected set from the generated
 * registry, so an unclassified V rule fails the build. Every A/D gate instead asserts its table
 * against an `OWNED` array hand-transcribed from the module-ownership table in
 * `docs/IMPLEMENTATION-PLAN.md` — which closes the loop against a *document*, not against the spec.
 * A rule the document forgot was therefore invisible to every gate at once, and 21 of them were:
 * six that `validate.ts` actively emits (PR-2/3/4, MD-2/3/4), RL-1 and IX-2 (both implementable and
 * now implemented in `build.ts`), RL-4, and eleven genuinely out of scope.
 *
 * This gate closes over the registry instead. Adding a rule to the spec now fails here until it is
 * classified — as owned by a module, or as `UNOWNED` with a written reason.
 *
 * It deliberately does **not** check that a rule appears in only one table. Several legitimately
 * appear in more than one: one obligation can carry several rule IDs across layers (P2's V-layer
 * receipt half vs `build`'s producer half, `docs/QUERY-BUILD.md` §2.2), and a ceiling is observed
 * by whichever module reaches it first. Uniqueness is not the invariant; coverage is.
 */

import { describe, expect, it } from 'vitest'
import { RULES, RULE_IDS } from '../src/rules.js'
import { A_ADMIT_COVERAGE } from './_a-admit-coverage.js'
import { A_BUILD_COVERAGE } from './_a-build-coverage.js'
import { A_PATCH_COVERAGE } from './_a-patch-coverage.js'
import { A_QUERY_COVERAGE } from './_a-query-coverage.js'
import { A_RESOLVE_COVERAGE } from './_a-resolve-coverage.js'
import { A_STORE_COVERAGE } from './_a-store-coverage.js'
import { A_VALIDATE_COVERAGE } from './_a-validate-coverage.js'
import type { CoverageTable } from './_coverage.js'
import { UNOWNED } from './_unowned.js'
import { V_COVERAGE } from './_v-coverage.js'

const TABLES: readonly CoverageTable[] = [
  V_COVERAGE,
  A_VALIDATE_COVERAGE,
  A_PATCH_COVERAGE,
  A_RESOLVE_COVERAGE,
  A_ADMIT_COVERAGE,
  A_STORE_COVERAGE,
  A_QUERY_COVERAGE,
  A_BUILD_COVERAGE,
]

const classified = new Set<string>([
  ...TABLES.flatMap((t) => Object.keys(t)),
  ...Object.keys(UNOWNED),
])

describe('registry closure — no rule is invisible to every gate', () => {
  it('classifies every rule in the generated registry', () => {
    const missing = RULE_IDS.filter((id) => !classified.has(id))
    expect(
      missing,
      `unclassified rules: add each to a module's coverage table, or to _unowned.ts with a reason`,
    ).toEqual([])
  })

  it('declares nothing that is not a real rule', () => {
    const known = new Set<string>(RULE_IDS)
    expect([...classified].filter((id) => !known.has(id))).toEqual([])
  })

  it('gives every unowned rule a substantive reason', () => {
    for (const [id, reason] of Object.entries(UNOWNED)) {
      expect(
        reason.length,
        `${id}'s reason is too short to be a real justification`,
      ).toBeGreaterThan(80)
    }
  })

  it('does not park an owned rule in the unowned list', () => {
    const owned = new Set(TABLES.flatMap((t) => Object.keys(t)))
    const both = Object.keys(UNOWNED).filter((id) => owned.has(id))
    expect(both, 'a rule cannot be both owned by a module and declared unowned').toEqual([])
  })

  it('reports the split', () => {
    const unowned = Object.keys(UNOWNED).length
    console.log(
      `registry closure: ${RULE_IDS.length} rules — ${RULE_IDS.length - unowned} owned by a module, ` +
        `${unowned} declared unowned with a reason.`,
    )
    // Every declared-unowned rule is D-layer, a MAY, deferred with `artifacts` (D7), or the
    // reserved OV-1. If a *new* rule lands unowned, that is a decision worth making explicitly
    // rather than inheriting, so pin the count.
    expect(unowned).toBe(13)
    expect(RULES['OV-1'].layer).toBeNull()
  })
})
