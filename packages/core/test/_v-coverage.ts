/**
 * The Phase 1 gate.
 *
 * Every Validity-layer rule must either **emit its code** in a test here, or be listed as
 * not-test-covered **with a stated reason**. The partition is machine-checked against the generated
 * registry, so a rule cannot be silently dropped and a new V rule in a future spec version fails
 * this file until someone classifies it.
 *
 * Coverage is measured by observed emission, never by annotation (D34): each `emitted` entry runs
 * real validation and asserts the code appears in the output. An entry that stops firing fails.
 */

import type { Issue } from '../src/errors.js'
import type { RuleId } from '../src/rules.js'
import { type CoverageTable, allIssues, emitted, notCovered } from './_coverage.js'
import {
  MINIMAL_PAYLOAD,
  PK_FOREIGN,
  PK_OTHER,
  PK_ROOT,
  baseTags,
  binding,
  ev,
  fenced,
  issuesOf,
  lookup,
  metadata,
  patch,
  product,
} from './_fixtures.js'

const ROOT = product()
const META = metadata({ pubkey: PK_FOREIGN })
const OTHER_PRODUCT = product()
const FOREIGN_PATCH = patch(ROOT.id, ROOT.id, '', { pubkey: PK_FOREIGN })

const patchOf = (content: string) => () => issuesOf(patch(ROOT.id, ROOT.id, content), lookup(ROOT))

export const V_COVERAGE: CoverageTable = {
  // --- §3 tags and versioning -----------------------------------------------
  'TAG-1': emitted(() =>
    issuesOf(product({ tags: [...baseTags('product'), ['t', 'scrutiny-fabric']] })),
  ),
  'TAG-2': emitted(() =>
    issuesOf(
      product({
        tags: [
          ['t', 'scrutiny-fabric'],
          ['t', 'scrutiny-product'],
        ],
      }),
    ),
  ),
  'TAG-3': emitted(() =>
    issuesOf(product({ tags: [...baseTags('product'), ['t', 'scrutiny-metadata']] })),
  ),
  'TAG-4': emitted(() =>
    issuesOf(product({ tags: [...baseTags('product'), ['t', 'scrutiny_v032']] })),
  ),
  'TAG-5': notCovered(
    'A parser obligation to ignore, with no failure mode to report. Covered behaviourally: ' +
      'validate.test.ts asserts an event carrying unknown tags is valid.',
  ),

  'VER-1': notCovered(
    'Defines version-tag comparison semantics rather than an event property. Implemented as ' +
      'parseVersionTag/compareVersionTags and covered directly in events.test.ts.',
  ),
  'VER-2': notCovered(
    'A permission (higher-version events MAY be admitted opaquely), so it has no failure mode. ' +
      'Covered behaviourally: a scrutiny-v099 event that satisfies every V invariant is valid.',
  ),
  'VER-3': emitted(() =>
    issuesOf(
      ev({
        tags: [
          ['t', 'scrutiny-fabric'],
          ['t', 'scrutiny-v099'],
          ['t', 'scrutiny-attestation'],
        ],
      }),
    ),
  ),
  'VER-4': notCovered(
    'A prohibition on the implementation, not a property of an event, so nothing can be emitted. ' +
      'Covered behaviourally by the assertion that a higher-version event validates, and ' +
      'structurally by VERSION_TAG never entering a relay filter — the failure that made the ' +
      'previous implementation violate VER-4 invisibly.',
  ),

  'SIG-1': notCovered(
    'Needs a hash, which core does not contain (D12). The recompute half is implemented in id.ts ' +
      'and covered in id.test.ts, including the tamper case a signature-only check misses. ' +
      'Enforcement, and therefore the emitted issue, belongs to store (Phase 5, D18).',
  ),

  // --- §4.1 / §4.2 Product and Metadata -------------------------------------
  'PR-1': emitted(() => issuesOf(product({ content: undefined as unknown as string }))),
  'PR-5': notCovered(
    'States that imeta attachments are OPTIONAL. A permission with no failure mode.',
  ),
  'MD-1': emitted(() => issuesOf(metadata({ content: undefined as unknown as string }))),
  'MD-5': notCovered(
    'States that imeta attachments are OPTIONAL. A permission with no failure mode.',
  ),

  // --- §4.3 Binding ---------------------------------------------------------
  'BD-1': emitted(() =>
    issuesOf(ev({ tags: [...baseTags('binding'), ['e', META.id, '', 'link', PK_FOREIGN]] })),
  ),
  'BD-2': emitted(() =>
    issuesOf(ev({ tags: [...baseTags('binding'), ['e', ROOT.id, '', 'root', PK_ROOT]] })),
  ),
  'BD-3': emitted(() => issuesOf(binding(META.id, META.id), lookup(META))),
  'BD-4': emitted(() => issuesOf(binding(ROOT.id, OTHER_PRODUCT.id), lookup(ROOT, OTHER_PRODUCT))),
  'BD-5': emitted(() => issuesOf(binding(META.id, META.id), lookup(META))),
  'BD-7': emitted(() => issuesOf(binding(META.id, META.id), lookup(META))),
  'BD-10': emitted(() =>
    issuesOf(binding(ROOT.id, META.id, [['e', ROOT.id, '', 'root', PK_ROOT]])),
  ),
  'BD-12': emitted(() =>
    issuesOf(
      ev({
        tags: [
          ...baseTags('binding'),
          ['e', ROOT.id, '', 'root', PK_OTHER],
          ['e', META.id, '', 'link', PK_FOREIGN],
        ],
      }),
      lookup(ROOT, META),
    ),
  ),

  // --- §4.4 Patch -----------------------------------------------------------
  'PT-1': emitted(() =>
    issuesOf(ev({ tags: [...baseTags('patch'), ['e', ROOT.id, '', 'reply', PK_ROOT]] })),
  ),
  'PT-2': emitted(() =>
    issuesOf(ev({ tags: [...baseTags('patch'), ['e', ROOT.id, '', 'root', PK_ROOT]] })),
  ),
  'PT-3': emitted(patchOf(`${fenced(MINIMAL_PAYLOAD)}\n\n${fenced(MINIMAL_PAYLOAD)}`)),
  'PT-4': notCovered(
    'Restates E6 at the event-type layer: both say the first matching fenced block is the payload ' +
      'and later ones are prose. E6 is the envelope-level source and is the code emitted for the ' +
      'shared condition; emitting both would report one fact twice.',
  ),
  'PT-7': emitted(() =>
    issuesOf(
      patch(ROOT.id, FOREIGN_PATCH.id, '', { pubkey: PK_OTHER }),
      lookup(ROOT, FOREIGN_PATCH),
    ),
  ),

  // --- §4.6 imeta -----------------------------------------------------------
  'IM-5': notCovered(
    'States that imeta attachments need not be referenced in content — an extension of NIP-92 ' +
      'with no failure mode. The rest of imeta handling ships with artifacts, deferred by D7.',
  ),

  // --- §5.2 envelope --------------------------------------------------------
  E1: emitted(patchOf(fenced(MINIMAL_PAYLOAD, 'diff', '~~~'))),
  E2: notCovered(
    'A selection rule: it defines which fenced block is the payload. A non-matching info string ' +
      'produces a no-op patch (E7), not an error. Covered behaviourally in patch-grammar.test.ts ' +
      'across diff/patch/DIFF/extra-token/non-matching info strings.',
  ),
  E3: emitted(patchOf(`\`\`\`diff\n${MINIMAL_PAYLOAD}\n`)),
  // E4 retagged V -> A in v0.6.1 (producer obligation, unfalsifiable on receipt — see docs/
  // SPEC-FEEDBACK-v0.6.0.md). No longer a V-layer rule, so it does not belong in this table at
  // all; it lands with whichever module implements build.ts (Phase 6).
  E5: notCovered(
    'Defines the payload byte boundary rather than a constraint that can fail. Covered by a ' +
      'byte-exact assertion that the payload is the lines strictly between the fences, each ' +
      'LF-terminated.',
  ),
  E6: emitted(patchOf(`${fenced(MINIMAL_PAYLOAD)}\n\n${fenced(MINIMAL_PAYLOAD)}`)),

  // --- §5.2 consumer grammar ------------------------------------------------
  C1: emitted(patchOf(fenced(['--- a/i', '+++ b/i', '@@ -1 +1 @@', '-o', '+n'].join('\n')))),
  C2: notCovered(
    'An obligation to tolerate trailing data, satisfied by the absence of an error. Covered ' +
      'behaviourally by accepting patch -u timestamps on the header lines and trailing text on @@.',
  ),
  C3: notCovered(
    'An obligation to tolerate the Index: preamble, satisfied by the absence of an error. ' +
      'Covered behaviourally.',
  ),
  C4: notCovered(
    'An obligation to tolerate the diff --git line, satisfied by the absence of an error. ' +
      'Covered behaviourally.',
  ),
  C7: notCovered(
    'A MUST-ACCEPT rule: it is satisfied by emitting nothing, so it can never appear in the ' +
      'observed-emission bucket, and inventing a C7 "info" issue to score it would make the ' +
      'coverage number lie in exactly the way D34 exists to prevent. Covered by the acceptance ' +
      'block in patch-grammar.test.ts and, once vectors exist, by their rule field (D34 bucket 2). ' +
      'Limit: those fixtures prove acceptance of the shapes considered, not of every payload the ' +
      'grammar admits — a generated grammar-conformance property test is a Phase 2 gate item.',
  ),

  // --- §5.2 producer rules --------------------------------------------------
  // P1 and P3 retagged V -> A in v0.6.1 — both are producer obligations (context-line minimum,
  // payload encoding/line endings), not Validity criteria for a received event, and neither
  // belongs in this table any longer. P1 was already `notCovered` here for exactly that reason
  // before the retag made it official (see SPEC-FEEDBACK F1); P3 was wrongly `emitted` as a V-layer
  // rejection — validate.ts still observes it (the check is falsifiable on receipt, unlike P1/E4),
  // but now as a non-rejecting A-layer annotation, tracked by patch-grammar.test.ts rather than
  // this V-only partition.
  P2: emitted(patchOf(fenced(['index 7ebcdab..331da67 100644', MINIMAL_PAYLOAD].join('\n')))),

  // --- §6 trust -------------------------------------------------------------
  'TR-1': notCovered(
    'A meta-rule about how the layers relate, not a property of any event: V-invalid events must ' +
      'not be processed, and a V-valid event must not be rejected by an A or D rule. Enforced ' +
      'structurally and asserted in invariants.test.ts, which checks that no error-severity issue ' +
      'produced anywhere in this suite cites a D-layer rule.',
  ),

  // --- §9 indexer registry --------------------------------------------------
  'IR-1': emitted(() => issuesOf(product({ tags: [...baseTags('product'), ['i', 'CVE:CVE-1']] }))),
  'IR-2': notCovered(
    'Requires the value to be the issuing authority’s canonical form, for which there is no ' +
      'local oracle — an implementation cannot know what MITRE or BSI considers canonical. ' +
      'Satisfied by never normalising the value, asserted behaviourally in events.test.ts.',
  ),
  'IR-3': notCovered(
    'Defines the parse (split on the first colon only) rather than a constraint that can fail. ' +
      'Covered behaviourally by a CPE value, whose payload itself contains colons.',
  ),
  'IR-4': notCovered(
    'States that unknown prefixes are valid — a permission with no failure mode, and the one ' +
      'most worth a positive test: the previous implementation’s closed prefix enum rejected ' +
      'pp, vendor, scheme, cc-cert-id and cc-scheme, all present in real data (R13). ' +
      'events.test.ts and validate.test.ts both assert those five are accepted.',
  ),
}

/** Every issue any coverage case produces. Consumed by the gate and invariant suites. */
export const ALL_EMITTED_ISSUES: readonly Issue[] = allIssues(V_COVERAGE)
