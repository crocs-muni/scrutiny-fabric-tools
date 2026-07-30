/**
 * The Phase 6 coverage partition (part of BQ-6): the rules `query` owns.
 *
 * All five (DQ-1…4, BD-8) are D-layer with no rejection or annotation disposition — `query.ts` never
 * calls `issue()` at all (see its own module doc comment). This is the same shape as `admit.ts`'s
 * AG3 partition (0/9 emitted, all D-layer): `_coverage.ts`'s `itReportsTheSplit` accepts an
 * all-not-covered table exactly when every rule in it is D-layer. Working expectations drafted in
 * `docs/QUERY-BUILD.md` §4 before this file existed.
 */

import type { CoverageTable } from './_coverage.js'
import { notCovered } from './_coverage.js'

export const A_QUERY_COVERAGE: CoverageTable = {
  'DQ-1': notCovered(
    'Enforced structurally: every discovery filter but the kind-5 lookup includes ' +
      '#t:["scrutiny-fabric"] by construction (indexerFilter/searchFilter/fullScanFilter never omit ' +
      'it). No rejection disposition exists to emit — covered behaviourally in query.test.ts.',
  ),
  'DQ-2': notCovered(
    'deletionsFor builds exactly the recommended {kinds:[5], #e:[id]} shape. The SHOULD-poll- ' +
      'periodically-and-at-first-sight half is a caller scheduling discipline this module has no ' +
      'visibility into, not a predicate over an event. Covered behaviourally in query.test.ts.',
  ),
  'DQ-3': notCovered(
    'searchFilter builds the NIP-50 fallback filter (the structural half). Verifying returned ' +
      'events carry valid scrutiny-fabric tags and match user intent is explicitly a caller concern ' +
      '(docs/QUERY-BUILD.md §1.2) — this module never sees results. Covered behaviourally for the ' +
      'filter-building half in query.test.ts.',
  ),
  'DQ-4': notCovered(
    'classifyByRole is a pure classifier with no failure mode: every candidate event either carries ' +
      'a marked e tag naming the anchor (included, tagged with its real marker) or does not ' +
      '(excluded). There is nothing to reject. Covered behaviourally in query.test.ts.',
  ),
  'BD-8': notCovered(
    'This module can only enable the relay-hint-fallback discipline — every filter it returns is ' +
      'relay-agnostic by construction, which is the necessary condition for a caller’s own ' +
      'fall-back-to-full-relay-set logic to be possible at all — never enforce it structurally, ' +
      'since a plain EventFilter carries no relay field for this module to police ' +
      '(docs/QUERY-BUILD.md §1.4).',
  ),
}
