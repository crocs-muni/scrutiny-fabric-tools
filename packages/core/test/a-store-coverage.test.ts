/**
 * The Phase 5 gate, item SG4 (`#38` §8/§9).
 *
 * Every rule `#53` assigns to the `store` module must either emit its code
 * here, or be listed as not-test-covered with a stated reason. The partition is machine-checked
 * against the plan's assignment, so a rule cannot be silently dropped.
 */

import { describe, expect, it } from 'vitest'
import type { RuleId } from '../src/rules.js'
import { A_STORE_COVERAGE } from './_a-store-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

/** From the module-ownership table in `#53`. */
const OWNED: readonly RuleId[] = [
  'UR-1',
  'UR-2',
  'UR-3',
  'RC-3',
  'RC-4',
  'BD-6',
  'BD-7',
  'DEL-8',
  'DEL-9',
  'RL-2',
  'RL-3',
  'SIG-1',
]

describe('Phase 5 gate — store-module rule coverage', () => {
  it('classifies every rule the module owns, and only those', () => {
    expect([...Object.keys(A_STORE_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  itReportsTheSplit('store-module coverage', A_STORE_COVERAGE)
  itCoversEachRule('ingestion', A_STORE_COVERAGE)
})
