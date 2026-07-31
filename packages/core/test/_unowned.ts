/**
 * Rules no module owns — the third bucket the registry-closure gate needs.
 *
 * D34 promises that a rule either emits its code in a test or is listed as not-test-covered with a
 * written reason, "so a rule cannot be silently dropped". That promise was only kept for the V
 * layer: `v-coverage.test.ts` derives its expected set from the generated registry, so a new V rule
 * fails the build until someone classifies it. Every A/D gate instead compares its table against an
 * `OWNED` array hand-transcribed from the plan's module-ownership table — a closed loop that can
 * only catch a rule the transcription already knows about.
 *
 * The Phase 8 audit measured the gap: 21 real rules (plus reserved OV-1) appeared in no table at
 * all, including six — PR-2/PR-3/PR-4/MD-2/MD-3/MD-4 — that `validate.ts` actively emits. This file
 * plus `rule-closure.test.ts` closes it, so the union of every table and this list is now checked
 * against the registry itself rather than against a document.
 *
 * An entry here is a claim that **no module in this package should implement the rule**, with the
 * reason why. It is not a parking space for work that is merely unfinished: a rule a module ought
 * to check belongs in that module's coverage table as `emitted`, or in its plan row.
 */

import type { RuleId } from '../src/rules.js'

/** Why a rule is owned by no module. Reasons are prose, and the gate enforces a floor on length. */
export const UNOWNED: Readonly<Partial<Record<RuleId, string>>> = {
  'OV-1':
    'Reserved in the spec itself (§7.3): foreign-patch reply-target validity is normative under ' +
    'PT-7, and the ID is retained only for cross-reference stability. There is no rule to ' +
    'implement, and the registry carries it with no layer.',

  'OTS-1':
    'A prohibition this package satisfies by never doing the thing: no code path reads an ' +
    'OpenTimestamps attestation, so OTS-derived timestamps cannot reach canonical-chain ' +
    'construction, overlay classification or self-fork resolution. Satisfied vacuously, and it ' +
    'stays satisfied only while nothing parses OTS — which is why it is recorded rather than ' +
    'left implicit.',

  'CA-1':
    'A publisher obligation about wall-clock intent that a library cannot evaluate: build.ts ' +
    'receives createdAt as a number and has no way to know whether it names publish time or a ' +
    'historical date the content describes. Hazard #5 in the plan makes this a documentation and ' +
    'CLI concern; see the Phase 8 report for the proposal to warn on far-past timestamps in a ' +
    'future producer-side pass.',

  'BD-11':
    'Explicitly a presentation concern, and phrased as a MAY: implementations *may* collapse ' +
    'visually-identical bindings at render time. This package renders nothing, and a MAY creates ' +
    'no obligation to discharge.',

  'OV-5':
    'Discharged by the shape of the public API rather than by a check: resolve() returns each ' +
    "overlay's classification as data on Resolution.overlays, which is exactly the ''expose it " +
    "through the API/data layer'' the rule asks for. Visual rendering is client-defined and out " +
    'of scope. There is no failure mode to emit.',

  'DEL-10':
    'A client UI obligation (a "show deleted events" toggle). The enabling half is real and ' +
    'already provided — EventStorage.query takes includeDeleted, and deletion is a predicate over ' +
    'a retained event rather than a removal — but the toggle itself is not something a sans-IO ' +
    'library can offer.',

  'DEL-11':
    'Addressed to SCRUTINY-aware relays, not to consumers. This package is not a relay and has no ' +
    'storage-side behaviour a relay operator would inherit from it.',

  'IX-1':
    'The implementable residue is too weak to be worth a check. "Canonical i tags for the ' +
    'indexers the event is *about*" needs an oracle for aboutness that only the publisher has; ' +
    'the one locally decidable proxy — warning when an indexed event is built with zero indexers ' +
    '— would fire on legitimately un-indexed events, and the spec itself allows those ("Publishers ' +
    'who omit i tags rely on content search to be discovered").',

  'IX-4':
    'Requires distinguishing indexers a payload *mentions* from indexers the event is *about*, ' +
    'which means parsing the payload (an SBOM component list) — something this package ' +
    "deliberately never does. IX-2's 64-tag ceiling is the mechanical proxy for the same intent " +
    'and is enforced on both the receipt and producer sides.',

  'IM-1':
    'Deferred with the artifacts package (D7, Phase 9). imeta/Blossom verification needs streaming ' +
    'IO and a hasher, neither of which core has; see the Phase 8 report for the standing verdict ' +
    'on whether Phase 9 happens at all.',
  'IM-2': 'Deferred with the artifacts package (D7, Phase 9) — see IM-1 for the full reason.',
  'IM-3': 'Deferred with the artifacts package (D7, Phase 9) — see IM-1 for the full reason.',
  'IM-4':
    'Deferred with the artifacts package (D7, Phase 9). Note this one is a MUST, not a SHOULD: ' +
    'whoever displays an artifact owes the warning, so shipping artifact handling without it ' +
    'would be a conformance failure rather than a missing nicety.',
}

/** The rule ids declared unowned, for the closure gate. */
export const UNOWNED_IDS = Object.keys(UNOWNED) as readonly RuleId[]
