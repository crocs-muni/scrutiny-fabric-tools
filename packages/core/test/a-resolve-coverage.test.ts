/**
 * The Phase 3 gate, item G4.
 *
 * Every rule `#53` assigns to the `resolve` module must either emit its
 * code here, or be listed as not-test-covered with a stated reason. The partition is machine-checked
 * against the plan's assignment, so a rule cannot be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import { RULES, type RuleId } from '../src/rules.js'
import { A_RESOLVE_COVERAGE } from './_a-resolve-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

/** From the module-ownership table in `#53`, plus RL-3, passed through. */
const OWNED: readonly RuleId[] = [
  'CHN-1',
  'CHN-2',
  'CHN-3',
  'RC-1',
  'RC-2',
  'RC-3',
  'RC-4',
  'SF-1',
  'SF-2',
  'SF-3',
  'SF-4',
  'SF-5',
  'SF-6',
  'H1',
  'H2',
  'OV-2',
  'OV-3',
  'OV-4',
  'OV-6',
  'OV-8',
  'DEL-1',
  'DEL-2',
  'DEL-3',
  'DEL-6',
  'DEL-7',
  'PT-5',
  'PT-6',
  'PT-8',
  'PT-9',
  'IX-3',
  'BD-9',
  'RL-3',
  // New in spec v0.6.1 — see _a-resolve-coverage.ts for why each is not-covered.
  'RC-5',
  'SF-7',
  'OV-9',
  'RL-5',
  // New in spec v0.8.0 (F16) — hold-pending; the six pins in resolve.test.ts + the vendored
  // chain vector cover it behaviorally; no issue code exists or should.
  'UR-4',
]

describe('Phase 3 gate — resolve-module rule coverage', () => {
  it('classifies every rule the module owns, and only those', () => {
    expect([...Object.keys(A_RESOLVE_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  it('assigns no V-layer rule to this module', () => {
    // Chain resolution is the A layer. A V rule appearing here would mean resolution had started
    // rejecting events, which TR-1 forbids.
    expect(OWNED.filter((id) => RULES[id].layer === 'V')).toEqual([])
  })

  itReportsTheSplit('resolve-module coverage', A_RESOLVE_COVERAGE)
  itCoversEachRule('resolution', A_RESOLVE_COVERAGE)
})
