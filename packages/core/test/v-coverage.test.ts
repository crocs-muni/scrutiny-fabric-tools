/**
 * The Phase 1 gate.
 *
 * Every Validity-layer rule must either **emit its code** here, or be listed as not-test-covered
 * **with a stated reason**. The partition is machine-checked against the generated registry, so a
 * rule cannot be silently dropped, and a new V rule in a future spec version fails this file until
 * someone classifies it.
 *
 * Coverage is measured by observed emission, never by annotation (D34): each `emitted` entry runs
 * real validation and asserts the code appears in the output. An entry that stops firing fails.
 *
 * The table itself lives in `_v-coverage.ts` so the invariant suite can consume it too.
 */

import { describe, expect, it } from 'vitest'
import { RULES, RULE_IDS, type RuleId } from '../src/rules.js'
import { V_COVERAGE } from './_v-coverage.js'

describe('Phase 1 gate — Validity-layer rule coverage', () => {
  const vRules = RULE_IDS.filter((id) => RULES[id].layer === 'V')

  it('classifies every V-layer rule, and only V-layer rules', () => {
    expect([...Object.keys(V_COVERAGE)].sort()).toEqual([...vRules].sort())
  })

  it('reports the split', () => {
    const emittedIds = Object.entries(V_COVERAGE)
      .filter(([, v]) => v.kind === 'emitted')
      .map(([k]) => k)
    const uncovered = vRules.length - emittedIds.length
    // Surfaced so the ratio is visible in CI output rather than buried in a doc.
    console.log(
      `V-layer coverage: ${emittedIds.length}/${vRules.length} emit a rule code; ` +
        `${uncovered} not test-covered, each with a stated reason.`,
    )
    expect(emittedIds.length + uncovered).toBe(vRules.length)
  })

  for (const [id, entry] of Object.entries(V_COVERAGE)) {
    if (entry.kind === 'emitted') {
      it(`${id} is emitted by a real validation`, () => {
        const codes = entry.issues().map((i) => i.code)
        expect(codes).toContain(id as RuleId)
      })
    } else {
      it(`${id} is declared not-test-covered with a reason`, () => {
        expect(entry.reason.length).toBeGreaterThan(40)
      })
    }
  }
})
