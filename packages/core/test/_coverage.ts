/**
 * The mechanism shared by the Phase 1 and Phase 2 coverage gates.
 *
 * Both phases make the same claim in the same way (D34): a rule is covered when a test **observes
 * its code being emitted**, or it is listed as not-test-covered **with a written reason**. Only the
 * tables differ — `_v-coverage.ts` partitions the Validity layer, `_a-patch-coverage.ts` the rules
 * `patch.ts` owns — so the constructors, the roll-up and the per-rule gate live here once.
 *
 * Tables are keyed by {@link RuleId} rather than `string`, so a typo'd or renamed rule id in the
 * artifact that *certifies* rule coverage is a compile error, the same guarantee {@link issue}
 * gives issues themselves (D35).
 */

import { expect, it } from 'vitest'
import type { Issue } from '../src/errors.js'
import { RULES, type RuleId } from '../src/rules.js'

/** A case that must produce a given rule code. */
export type Emitted = { readonly kind: 'emitted'; readonly issues: () => readonly Issue[] }
/** A rule with no emission, and why. */
export type NotCovered = { readonly kind: 'not-covered'; readonly reason: string }
export type CoverageEntry = Emitted | NotCovered

/** Partial because each table covers one layer's rules, not all of them. */
export type CoverageTable = Readonly<Partial<Record<RuleId, CoverageEntry>>>

export const emitted = (issues: () => readonly Issue[]): Emitted => ({ kind: 'emitted', issues })
export const notCovered = (reason: string): NotCovered => ({ kind: 'not-covered', reason })

/** `Object.entries` widens the key to `string`; the table's own type is the narrower truth. */
export function entriesOf(table: CoverageTable): [RuleId, CoverageEntry][] {
  return Object.entries(table) as [RuleId, CoverageEntry][]
}

/** Every issue a table's emitting entries produce. Consumed by the invariant suite. */
export function allIssues(table: CoverageTable): readonly Issue[] {
  return entriesOf(table).flatMap(([, e]) => (e.kind === 'emitted' ? [...e.issues()] : []))
}

/**
 * Surface the ratio in CI output rather than burying it in a doc.
 *
 * Every prior partition (V, patch, resolve) has at least one rule with a real rejection/HALT/limit
 * disposition, so a table reporting zero would normally signal the harness silently losing
 * coverage — except when *no* rule in the table could ever have one to lose. §6.0 draws that line
 * exactly at the D layer: D rules "are not admission criteria for the event itself," so a table
 * whose every entry is D-layer (`admit`'s is the first such case; see `#37` §10, AG3) is
 * legitimately all-`not-covered`, and the zero-emission assertion below is derived from that fact
 * rather than passed in by the caller — a future all-D-layer table gets this for free, and a table
 * mixing in a V/A rule that stops emitting still fails, because `allNonRejecting` is false for it.
 */
export function itReportsTheSplit(label: string, table: CoverageTable): void {
  it('reports the split', () => {
    const entries = entriesOf(table)
    const emittedCount = entries.filter(([, e]) => e.kind === 'emitted').length
    console.log(
      `${label}: ${emittedCount}/${entries.length} emit a rule code; ` +
        `${entries.length - emittedCount} not test-covered, each with a stated reason.`,
    )
    const allNonRejecting = entries.every(([id]) => RULES[id].layer === 'D')
    expect(emittedCount > 0 || allNonRejecting).toBe(true)
  })
}

/**
 * The per-rule gate: each entry either emits its code for real, or states why it cannot.
 *
 * `what` names the act being observed — "validation", "application attempt" — so a failure reads as
 * a claim about behaviour rather than about a table.
 */
export function itCoversEachRule(what: string, table: CoverageTable): void {
  for (const [id, entry] of entriesOf(table)) {
    if (entry.kind === 'emitted') {
      it(`${id} is emitted by a real ${what}`, () => {
        expect(entry.issues().map((i) => i.code)).toContain(id)
      })
    } else {
      it(`${id} is declared not-test-covered with a reason`, () => {
        expect(entry.reason.length).toBeGreaterThan(40)
      })
    }
  }
}
