/**
 * The Phase 6 gate, item BQ-6, `query` half (`docs/QUERY-BUILD.md` §4/§5).
 *
 * Every rule `docs/IMPLEMENTATION-PLAN.md` assigns to the `query` module must either emit its code
 * here, or be listed as not-test-covered with a stated reason. The partition is machine-checked
 * against the plan's assignment, so a rule cannot be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import type { RuleId } from '../src/rules.js'
import { A_QUERY_COVERAGE } from './_a-query-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

/** From the module-ownership table in `docs/IMPLEMENTATION-PLAN.md`. */
const OWNED: readonly RuleId[] = ['DQ-1', 'DQ-2', 'DQ-3', 'DQ-4', 'BD-8']

describe('Phase 6 gate — query-module rule coverage', () => {
  it('classifies every rule the module owns, and only those', () => {
    expect([...Object.keys(A_QUERY_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  itReportsTheSplit('query-module coverage', A_QUERY_COVERAGE)
  itCoversEachRule('filter building/classification', A_QUERY_COVERAGE)
})
