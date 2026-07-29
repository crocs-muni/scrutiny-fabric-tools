/**
 * The Phase 4 gate, item AG3 (`docs/ADMIT.md` §10).
 *
 * Every rule `docs/IMPLEMENTATION-PLAN.md` assigns to the `admit` module must either emit its code
 * here, or be listed as not-test-covered with a stated reason. The partition is machine-checked
 * against the plan's assignment, so a rule cannot be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import { RULES, type RuleId } from '../src/rules.js'
import { A_ADMIT_COVERAGE } from './_a-admit-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

/** From the module-ownership table in `docs/IMPLEMENTATION-PLAN.md`. */
const OWNED: readonly RuleId[] = [
  'TR-2',
  'TR-3',
  'TR-4',
  'TR-5',
  'TR-6',
  'TR-7',
  'OV-7',
  'DEL-4',
  'DEL-5',
]

describe('Phase 4 gate — admit-module rule coverage', () => {
  it('classifies every rule the module owns, and only those', () => {
    expect([...Object.keys(A_ADMIT_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  it('assigns only D-layer rules to this module', () => {
    // admit computes visibility, never rejection — a V or A rule appearing here would mean this
    // module had started influencing what an event *is* rather than what a user *sees* (§6.0).
    expect(OWNED.filter((id) => RULES[id].layer !== 'D')).toEqual([])
  })

  itReportsTheSplit('admit-module coverage', A_ADMIT_COVERAGE, 0)
  itCoversEachRule('admission', A_ADMIT_COVERAGE)
})
