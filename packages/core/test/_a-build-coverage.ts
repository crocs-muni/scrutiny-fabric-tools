/**
 * The Phase 6 coverage partition (part of BQ-6): the rules `build` owns.
 *
 * Four of five (E4, P1, P3, and build's own share of P2) are not-covered — each a computation or an
 * obligation satisfied by construction, with no rejection disposition of its own (see
 * `docs/QUERY-BUILD.md` §2.2/§4 for the P2 double-listing note). P4 is the one real emission: a
 * genuinely ambiguous `before` makes `buildPatch`'s self-check disagree with the given `after`.
 */

import { buildProduct } from '../src/build.js'
import { buildPatch } from '../src/build.js'
import type { Issue } from '../src/errors.js'
import { type CoverageTable, allIssues, emitted, notCovered } from './_coverage.js'

const ROOT = { id: 'a'.repeat(64) }
const REPLY = { id: 'b'.repeat(64) }

/**
 * A `before`/`after` pair engineered so T1 can never disambiguate the resulting hunk: three repeats
 * of a/b/c/d, the second repeat's `c` changed to `C`. The (d,a,b,c,d,a,b) context+removed pattern
 * recurs at another repeat boundary. Shared with `build.test.ts`'s BQ-4, so the one directly-built
 * case both files rely on can't drift apart.
 */
export function ambiguousPatchPair(): { before: string; after: string } {
  const lines: string[] = []
  for (let i = 0; i < 4; i++) lines.push('a', 'b', 'c', 'd')
  const before = `${lines.join('\n')}\n`
  const beforeLines = before.split('\n')
  beforeLines[6] = 'C'
  return { before, after: beforeLines.join('\n') }
}

/** P4 — the same concrete case {@link ambiguousPatchPair} names, with the widening budget pre-spent
 *  (CONTEXT-WIDENING.md §6: post-widening, P4 is reachable only through the ceiling). */
function p4Issues(): readonly Issue[] {
  const { before, after } = ambiguousPatchPair()
  return buildPatch(ROOT, REPLY, before, after, 1, 3, 0).issues
}

/** RL-1 — an `i` tag past §5.4's 1024-byte per-tag-value ceiling. */
function rl1Issues(): readonly Issue[] {
  return buildProduct('c', 1, [`cpe:2.3:h:${'x'.repeat(1100)}`]).issues
}

/** IX-2 — more than 64 `i` tags on one event. */
function ix2Issues(): readonly Issue[] {
  return buildProduct(
    'c',
    1,
    Array.from({ length: 65 }, (_, i) => `cve:CVE-2024-${1000 + i}`),
  ).issues
}

export const A_BUILD_COVERAGE: CoverageTable = {
  E4: notCovered(
    'A computation (fenceLength = max(3, N+1)), not a predicate with a rejection disposition. Its ' +
      'own property test (BQ-3, build.test.ts) is the coverage: the fence never closes early on an ' +
      'embedded backtick run, checked against the real consumer-side parser.',
  ),
  P1: notCovered(
    "Satisfied transitively via patch.ts's own default context of 3, which patch.ts's own doc " +
      "comment already names as P1's enforcement point. buildPatch threads an optional override " +
      'through and — since Phase 18 (CONTEXT-WIDENING.md §0: "does not reopen F1" — the floor is ' +
      'never reinterpreted) may additionally widen *above* the floor when the floor itself would ' +
      "be ambiguous. Covered by regression tests (the parameter thread, and Phase 18's §5 " +
      'worked example), not a rule-code emission.',
  ),
  P2: notCovered(
    'The emittable half of P2 belongs to validate.ts (a V-layer rejection over a received payload), ' +
      "not to this module — see docs/QUERY-BUILD.md §2.2. build.ts's own half is satisfied by " +
      "construction: makePatch reaches jsdiff's structuredPatch/formatPatch, which never emits an " +
      '"index"/"mode"/"similarity index" line (only git diff\'s own default output does). There is ' +
      'nothing for this module to check or emit.',
  ),
  P3: notCovered(
    "No code path in this module can introduce CRLF: jsdiff's output is LF-only and PB-1 forbids " +
      'normalising content in the first place. Nothing here is a validity check to emit against — ' +
      'it is guaranteed by construction, not observed by a test.',
  ),
  P4: emitted(p4Issues),
  /**
   * Added by the Phase 8 audit. The plan listed both as "not owned by any module, by design
   * (producer guidance)"; three of §5.4's four bounds and the whole of IX-2's ceiling are in fact
   * computable from the template this module assembles, so they are enforced here the way P4 is.
   */
  'RL-1': emitted(rl1Issues),
  'IX-2': emitted(ix2Issues),
}

/** Every issue this partition produces. Consumed by the gate and invariant suites. */
export const ALL_BUILD_ISSUES: readonly Issue[] = allIssues(A_BUILD_COVERAGE)
