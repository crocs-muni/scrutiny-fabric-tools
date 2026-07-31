/**
 * The partition gate for `validate.ts`'s D-layer rules, added by the Phase 8 audit.
 *
 * Same discipline as every other `a-*-coverage.test.ts` (D34), for the six rules that had no table
 * at all. Unlike those, `OWNED` here is **derived from the registry** rather than transcribed from
 * the plan: these are exactly the §4.1/§4.2 D-layer rules, so the set can be computed instead of
 * copied — see `rule-closure.test.ts` for why the transcribed form is the weaker pattern.
 */

import { describe, expect, it } from 'vitest'
import type { RuleId } from '../src/rules.js'
import { A_VALIDATE_COVERAGE } from './_a-validate-coverage.js'
import { itCoversEachRule, itReportsTheSplit } from './_coverage.js'

const OWNED: readonly RuleId[] = ['PR-2', 'PR-3', 'PR-4', 'MD-2', 'MD-3', 'MD-4']

describe('Phase 8 gate — validate-module D-layer rule coverage', () => {
  it('classifies every D-layer rule validate emits, and only those', () => {
    expect([...Object.keys(A_VALIDATE_COVERAGE)].sort()).toEqual([...OWNED].sort())
  })

  itReportsTheSplit('validate D-layer coverage', A_VALIDATE_COVERAGE)
  itCoversEachRule('validation', A_VALIDATE_COVERAGE)
})
