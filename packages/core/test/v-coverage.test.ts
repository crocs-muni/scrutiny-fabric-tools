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
import { RULES, RULE_IDS } from '../src/rules.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'
import { V_COVERAGE } from './_v-coverage.js'

describe('Phase 1 gate — Validity-layer rule coverage', () => {
  const vRules = RULE_IDS.filter((id) => RULES[id].layer === 'V')

  it('classifies every V-layer rule, and only V-layer rules', () => {
    expect([...Object.keys(V_COVERAGE)].sort()).toEqual([...vRules].sort())
  })

  itReportsTheSplit('V-layer coverage', V_COVERAGE)
  itCoversEachRule('validation', V_COVERAGE)
})
