/**
 * The Phase 6 gate, item BQ-6, `build` half (`docs/QUERY-BUILD.md` §4/§5).
 *
 * Every rule `docs/IMPLEMENTATION-PLAN.md` assigns to the `build` module must either emit its code
 * here, or be listed as not-test-covered with a stated reason. The partition is machine-checked
 * against the plan's assignment, so a rule cannot be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import type { RuleId } from '../src/rules.js'
import { A_BUILD_COVERAGE } from './_a-build-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

/**
 * From the module-ownership table in `docs/IMPLEMENTATION-PLAN.md`.
 *
 * RL-1 and IX-2 were added by the Phase 8 audit, which found them checkable from the template this
 * module already builds rather than "producer guidance" no module can discharge.
 */
const OWNED: readonly RuleId[] = ['E4', 'P1', 'P2', 'P3', 'P4', 'RL-1', 'IX-2']

describe('Phase 6 gate — build-module rule coverage', () => {
  it('classifies every rule the module owns, and only those', () => {
    expect([...Object.keys(A_BUILD_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  itReportsTheSplit('build-module coverage', A_BUILD_COVERAGE)
  itCoversEachRule('template construction', A_BUILD_COVERAGE)
})
