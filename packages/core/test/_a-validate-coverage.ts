/**
 * The D-layer rules `validate.ts` emits — the partition that was missing.
 *
 * `_v-coverage.ts` is derived from the registry's **V** set, so the six advisory rules below fell
 * outside it when v0.6.0 retagged them V → D, and no other table picked them up. The Phase 8 audit
 * found them to be the only rules in the package that `issue()` can produce with no coverage entry
 * anywhere, which made D34's claim — "every rule either emits its code in a test or is listed with
 * a reason" — false for exactly these six.
 *
 * All six are genuine emissions with a real failure mode, so all six are `emitted`; none needed a
 * written excuse. They are warnings, never errors: TR-1 forbids a D-layer rule rejecting a V-valid
 * event, and `invariants.test.ts` asserts that repo-wide.
 */

import type { Issue } from '../src/errors.js'
import type { NostrEvent } from '../src/events.js'
import { validateEvent } from '../src/validate.js'
import { type CoverageTable, allIssues, emitted } from './_coverage.js'
import { baseTags, metadata, product } from './_fixtures.js'

const MANY = (name: 'i' | 'k') =>
  Array.from({ length: 65 }, (_, n) => [name, name === 'i' ? `cve:CVE-${n}` : `cve${n}`])

const issuesOf = (event: NostrEvent): readonly Issue[] => {
  const result = validateEvent(event)
  return result.status === 'not-scrutiny' ? [] : result.issues
}

/** Past 64 `i` tags on a Product / Metadata. */
const overIndexers = (type: 'product' | 'metadata') => () =>
  issuesOf(
    (type === 'product' ? product : metadata)({
      tags: [...baseTags(type), ...MANY('i'), ['k', 'cve']],
    }),
  )

/** Past 64 `k` tags on a Product / Metadata. */
const overKinds = (type: 'product' | 'metadata') => () =>
  issuesOf(
    (type === 'product' ? product : metadata)({
      tags: [...baseTags(type), ['i', 'cve:CVE-1'], ...MANY('k')],
    }),
  )

/** An `i` prefix with no matching `k` entry — costs discoverability, never validity. */
const missingKind = (type: 'product' | 'metadata') => () =>
  issuesOf(
    (type === 'product' ? product : metadata)({
      tags: [...baseTags(type), ['i', 'cve:CVE-1']],
    }),
  )

export const A_VALIDATE_COVERAGE: CoverageTable = {
  'PR-2': emitted(overIndexers('product')),
  'PR-3': emitted(overKinds('product')),
  'PR-4': emitted(missingKind('product')),
  'MD-2': emitted(overIndexers('metadata')),
  'MD-3': emitted(overKinds('metadata')),
  'MD-4': emitted(missingKind('metadata')),
}

/** Every issue this partition produces. Consumed by the gate and invariant suites. */
export const ALL_VALIDATE_D_ISSUES: readonly Issue[] = allIssues(A_VALIDATE_COVERAGE)
