/**
 * The Phase 2 coverage gate.
 *
 * Every rule `docs/IMPLEMENTATION-PLAN.md` assigns to the `patch` module must either emit its code
 * here, or be listed as not-test-covered with a stated reason. The partition is machine-checked
 * against the plan's assignment, so a rule cannot be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import { RULES, type RuleId } from '../src/rules.js'
import { A_PATCH_COVERAGE } from './_a-patch-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

/** From the module-ownership table in `docs/IMPLEMENTATION-PLAN.md`, plus RL-3, which patch emits. */
const OWNED: readonly RuleId[] = [
  'T1',
  'T2',
  'T3',
  'H1',
  'N1',
  'N2',
  'N3',
  'C5',
  'C6',
  'PB-1',
  'PB-2',
  'E7',
  'RL-3',
]

describe('Phase 2 gate — patch-module rule coverage', () => {
  it('classifies every rule the module owns, and only those', () => {
    expect([...Object.keys(A_PATCH_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  itReportsTheSplit('patch-module coverage', A_PATCH_COVERAGE)

  it('assigns no V-layer rule to this module', () => {
    // The envelope and grammar (E1–E6, C1–C4) are validate.ts's, and stay there. A V rule
    // appearing here would mean application had started rejecting events, which TR-1 forbids.
    const misplaced = OWNED.filter((id) => RULES[id].layer === 'V')
    expect(misplaced).toEqual([])
  })

  itCoversEachRule('application attempt', A_PATCH_COVERAGE)
})
