import { describe, expect, it } from 'vitest'
import { issue } from '../src/errors.js'
import { RULES, RULE_IDS } from '../src/rules.js'
import { ALL_EMITTED_ISSUES } from './_v-coverage.js'

describe('structural invariants', () => {
  it('never emits an error citing a D-layer rule (TR-1)', () => {
    // §6.0: "A consumer MUST NOT reject a V-valid event because it violates a D-rule." TR-1 makes
    // this normative. Checked across every issue the coverage suite actually produces, rather than
    // asserted for the cases someone remembered to think about.
    const violations = ALL_EMITTED_ISSUES.filter(
      (i) => i.severity === 'error' && i.layer === 'D',
    ).map((i) => `${i.code} (${i.layer}): ${i.message}`)

    expect(violations).toEqual([])
  })

  it('never cites a reserved rule id', () => {
    const reserved = ALL_EMITTED_ISSUES.filter((i) => RULES[i.code].reserved)
    expect(reserved).toEqual([])
  })

  it('attaches the layer and section Appendix F records for the cited rule (D40)', () => {
    for (const i of ALL_EMITTED_ISSUES) {
      expect(i.layer, i.code).toBe(RULES[i.code].layer)
      expect(i.section, i.code).toBe(RULES[i.code].section)
    }
  })

  it('cannot construct an issue whose layer or section disagrees with the registry', () => {
    for (const id of RULE_IDS) {
      const built = issue(id, 'warning', 'probe')
      expect(built.layer).toBe(RULES[id].layer)
      expect(built.section).toBe(RULES[id].section)
    }
  })
})
