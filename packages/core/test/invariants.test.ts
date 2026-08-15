import { describe, expect, it } from 'vitest'
import { issue } from '../src/errors.js'
import { RULES, RULE_IDS } from '../src/rules.js'
import { ALL_ADMIT_ISSUES } from './_a-admit-coverage.js'
import { ALL_BUILD_ISSUES } from './_a-build-coverage.js'
import { ALL_PATCH_ISSUES } from './_a-patch-coverage.js'
import { ALL_QUERY_ISSUES } from './_a-query-coverage.js'
import { ALL_RESOLVE_ISSUES } from './_a-resolve-coverage.js'
import { ALL_STORE_ISSUES } from './_a-store-coverage.js'
import { ALL_VALIDATE_D_ISSUES } from './_a-validate-coverage.js'
import { ALL_EMITTED_ISSUES as V_ISSUES } from './_v-coverage.js'

/**
 * Every partition, without exception. `admit` and `query` were missing before the Phase 8 audit:
 * both tables are all-`not-covered` today, so the roll-up was unchanged by their absence — and
 * would have stayed silently unchanged the first time either gained an `emitted` entry, which is
 * exactly when TR-1 starts mattering for it.
 */
const ALL_EMITTED_ISSUES = [
  ...V_ISSUES,
  ...ALL_VALIDATE_D_ISSUES,
  ...ALL_PATCH_ISSUES,
  ...ALL_RESOLVE_ISSUES,
  ...ALL_ADMIT_ISSUES,
  ...ALL_STORE_ISSUES,
  ...ALL_QUERY_ISSUES,
  ...ALL_BUILD_ISSUES,
]

describe('structural invariants', () => {
  it('never emits an error citing an A-layer or D-layer rule (TR-1)', () => {
    // §6.0: "A V-valid event MUST NOT be rejected by an A or D rule." TR-1 makes this normative,
    // and `error` in this codebase means exactly "reject the event", so the obligation covers both
    // layers — not just D, which is all the Phase 1 form of this assertion checked.
    //
    // This is what keeps HALT honest. A patch that fails to apply is a severe outcome, but it does
    // not make the event invalid: §5.3 keeps the event in the chain and §5.4 says the same of a
    // resource limit in as many words. The `status` discriminant carries that weight instead.
    //
    // Checked across every issue the coverage suites actually produce, rather than asserted for
    // the cases someone remembered to think about.
    const violations = ALL_EMITTED_ISSUES.filter(
      (i) => i.severity === 'error' && (i.layer === 'A' || i.layer === 'D'),
    ).map((i) => `${i.code} (${i.layer}): ${i.message}`)

    expect(violations).toEqual([])
  })

  it('never cites a reserved rule id', () => {
    const reserved = ALL_EMITTED_ISSUES.filter((i) => RULES[i.code].reserved)
    expect(reserved).toEqual([])
  })

  it('refuses to build an issue citing a reserved rule id (S3-15)', () => {
    // The builder-level backstop for the observation test above: a reserved rule carries no
    // normative content, so citing one is a programming error, and it used to succeed silently
    // anywhere outside the coverage arrays.
    for (const id of RULE_IDS.filter((id) => RULES[id].reserved)) {
      expect(() => issue(id, 'warning', 'probe'), id).toThrow(TypeError)
    }
  })

  it('attaches the layer and section Appendix F records for the cited rule (D40)', () => {
    for (const i of ALL_EMITTED_ISSUES) {
      expect(i.layer, i.code).toBe(RULES[i.code].layer)
      expect(i.section, i.code).toBe(RULES[i.code].section)
    }
  })

  it('cannot construct an issue whose layer or section disagrees with the registry', () => {
    for (const id of RULE_IDS.filter((id) => !RULES[id].reserved)) {
      const built = issue(id, 'warning', 'probe')
      expect(built.layer).toBe(RULES[id].layer)
      expect(built.section).toBe(RULES[id].section)
    }
  })
})
