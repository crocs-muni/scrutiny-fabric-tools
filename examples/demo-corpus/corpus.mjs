/**
 * The 2026-11-24 company-testing corpus, as data (issue #192; report §4.4).
 *
 * Acme Secure is fictional. The *shapes* mirror the Tropic Square pilot corpus the report
 * designed: a vendor profile, one family Product, two part-number Products, six
 * test/evaluation records with PDF artifacts, one advisory, two specifications, the Bindings
 * that make them reachable, one patch and one clearly labelled test record with its retraction.
 *
 * WHY data and not a script of tool calls: `publish.mjs` drives these steps through the same
 * MCP handlers a host calls, so composition (rule 2a restatement), preflight and the derived
 * tags come from the server. Nothing here is event text; every field is a tool argument.
 *
 * A step is one tool call. Placeholders are resolved by `publish.mjs`:
 *
 * - `root: '<key>'` / `link: '<key>'` become the `root_ref`/`link_ref` event-id refs of the
 *   step that published that key;
 * - `target: '<key>'` becomes the `target_id` of a patch or a retraction;
 * - `replace: { from, to }` is the patch payload: `from` must be a substring of the resolved
 *   tip content, so a reworded root fails the run instead of publishing a stale patch.
 */

import { createHash } from 'node:crypto'

/** The vendor site is under `.test`'s sibling `.example`: RFC 2606 keeps it unresolvable. */
const SITE = 'https://www.acme-secure.example'

/**
 * Lens today reads only `report|target|maintenance|sbom|advisory`
 * (`src/lib/ai/agents/nodes.ts:49-56`); `specification` and `test` are accepted by the MCP schema
 * but render as `unknown`. The corpus therefore declares what each record *is* and publishes the
 * documented compatibility profile (report §3.3 gap 1). Flip a value here once Lens ships it.
 */
const LENS_SUBTYPE = {
  test: 'report',
  specification: 'report',
  advisory: 'advisory',
  maintenance: 'maintenance',
}

/**
 * One `imeta` row for a document this demo describes but does not host.
 *
 * WHY the hash is not a real file's: there are no bytes to serve, so `x` is the SHA-256 of a
 * fixed label and `size` is a plausible order of magnitude. Both fields are placeholders; the
 * URL never resolves. A real corpus computes `x` and `size` from the uploaded file (guide §5).
 */
function artifact(path, alt, size) {
  return {
    url: `${SITE}/${path}`,
    m: 'application/pdf',
    x: createHash('sha256').update(`acme-demo-corpus/${path}`).digest('hex'),
    size,
    alt,
  }
}

const VENDOR = ['vendor:acme-secure']

/** The CI-shaped value every event carries; kept in one place so a typo cannot fork the facet. */
const FAMILY_PART = 'AS-SE1'
const T301 = 'AS-SE1-C2P-T301'
const B2S = 'AS-SE1-B2S-T005'

/**
 * The profile the Lens publisher chip renders. `name` is the handle, not the display name.
 */
const profile = {
  name: 'acme-secure-demo',
  display_name: 'Acme Secure (demo corpus)',
  about:
    'Fictional smartcard vendor published by the #192 demo corpus. Every record is fabricated, the artifacts do not resolve, and the key is a throwaway.',
}

/** The family record. It carries the certificate the T301 configuration was evaluated under. */
const family = {
  headline: `Acme Secure ${FAMILY_PART} — secure element family for smartcard and embedded authentication (firmware 2.1.0)`,
  bullets: [
    `Part numbers in the family: ${T301} and ${B2S}; both share the SE-1 die and its RISC-V security core.`,
    'Certified configuration: Common Criteria certificate BSI-DSZ-CC-1234-2026 covers the T301 package at EAL6+ AVA_VAN.5.',
    `Ships with firmware 2.1.0; the vendor facet is vendor:acme-secure and the family part key is part:${FAMILY_PART}.`,
  ],
  indexers: [...VENDOR, `part:${FAMILY_PART}`, 'cc:BSI-DSZ-CC-1234-2026'],
  card: {
    type: 'acme-product@1',
    family: 'SE-1',
    firmware: '2.1.0',
    certificate: 'BSI-DSZ-CC-1234-2026',
    eal: 'EAL6+',
  },
}

/** The recommended ordering number: it owns the datasheet. */
const t301 = {
  headline: `Acme Secure ${T301} — recommended SE-1 part, CC certified configuration (firmware 2.1.0)`,
  bullets: [
    `Part number ${T301} is the recommended ordering number; the package is a 4 mm × 4 mm QFN32.`,
    'Certified by BSI under BSI-DSZ-CC-1234-2026 at EAL6+ AVA_VAN.5, the same certificate as the SE-1 family.',
    'Ships with firmware 2.1.0 and the open firmware SDK; the vendor facet is vendor:acme-secure.',
  ],
  indexers: [...VENDOR, `part:${T301}`, 'cc:BSI-DSZ-CC-1234-2026'],
  card: {
    type: 'acme-product@1',
    part: T301,
    certificate: 'BSI-DSZ-CC-1234-2026',
    eal: 'EAL6+',
    firmware: '2.1.0',
    package: 'QFN32',
  },
}

/**
 * The identity-only product: a discontinued board with no documents and no certificate. It is
 * the answer to the "which product has no certification record" query, and it exists so the
 * graph shows a node that carries its own identity and nothing else.
 */
const b2s = {
  headline: `Acme Secure ${B2S} — discontinued evaluation board for the SE-1 family`,
  bullets: [
    `Part number ${B2S} is a discontinued evaluation board; no security documentation is published for it.`,
    `Replacement: ${T301}. The board shipped with firmware 0.9.0, which is not supported.`,
    'The vendor facet is vendor:acme-secure. The board exposes the debug port the ISAP evaluation used.',
  ],
  indexers: [...VENDOR, `part:${B2S}`, 'firmware:0.9.0'],
  card: {
    type: 'acme-product@1',
    part: B2S,
    lifecycle: 'discontinued',
    firmware: '0.9.0',
  },
}

/**
 * The six test/evaluation records, one per evaluation report, in report-number order. Each is a
 * Metadata child of the family; the fault-injection report is also bound to the T301 part, which
 * makes it a bridge node (report §4.2).
 */
const tests = [
  {
    key: 'puf',
    meta: {
      headline:
        'PUF evaluation ODR_AS-SE1_PSR_001 — physical unclonable function on the SE-1 die (Acme Secure)',
      bullets: [
        'Evaluated by Acme Secure; report ODR_AS-SE1_PSR_001 covers the PUF that derives device keys on the SE-1 die.',
        'Two versions are attached: v1.0 from 2026-05-12 and v1.1 from 2026-09-30, which adds the temperature-sweep results.',
        'Result: pass. The PUF met the stability criteria from 1.8 V to 3.3 V and from −40 °C to 105 °C.',
      ],
      indexers: [...VENDOR, 'test:ODR_AS-SE1_PSR_001'],
      card: {
        type: 'acme-test-report@1',
        report: 'ODR_AS-SE1_PSR_001',
        lab: 'Acme Secure',
        result: 'pass',
      },
      // Both versions at first publication: `imeta` on a root is immutable (IX-3, report §4.3).
      imeta: [
        artifact('reports/ODR_AS-SE1_PSR_001_PUF_v1.0.pdf', 'PUF evaluation v1.0', 412033),
        artifact('reports/ODR_AS-SE1_PSR_001_PUF_v1.1.pdf', 'PUF evaluation v1.1', 438900),
      ],
    },
  },
  {
    key: 'isap',
    meta: {
      headline:
        'ISAP side-channel evaluation ODR_AS-SE1_PSR_002 — masked authenticated encryption on the SE-1 (Cobalt Ridge Labs)',
      bullets: [
        'Cobalt Ridge Labs evaluated the ISAP authenticated-encryption core for Acme Secure; report ODR_AS-SE1_PSR_002 covers first-order and second-order side-channel resistance.',
        'Result: pass at first order. The second-order measurement exceeded the 10 000-trace budget and is reported as inconclusive.',
        `The evaluation used the ${B2S} evaluation board, the only part that exposes the debug port.`,
      ],
      indexers: [...VENDOR, 'test:ODR_AS-SE1_PSR_002'],
      card: {
        type: 'acme-test-report@1',
        report: 'ODR_AS-SE1_PSR_002',
        lab: 'Cobalt Ridge Labs',
        result: 'pass',
      },
      imeta: [artifact('reports/ODR_AS-SE1_PSR_002_ISAP.pdf', 'ISAP evaluation', 356210)],
    },
  },
  {
    key: 'aesgcm',
    meta: {
      headline:
        'AES-GCM side-channel evaluation ODR_AS-SE1_PSR_003 — hardware AES engine on the SE-1 (Cobalt Ridge Labs)',
      bullets: [
        'Cobalt Ridge Labs evaluated the hardware AES-GCM engine for Acme Secure; report ODR_AS-SE1_PSR_003 covers the 128-bit and 256-bit key paths.',
        'Result: pass. No key-dependent leakage was found above the noise floor in 50 000 traces.',
        'Scope: the evaluation covers the AES core only; RSA and ECC are outside report ODR_AS-SE1_PSR_003.',
      ],
      indexers: [...VENDOR, 'test:ODR_AS-SE1_PSR_003'],
      card: {
        type: 'acme-test-report@1',
        report: 'ODR_AS-SE1_PSR_003',
        lab: 'Cobalt Ridge Labs',
        result: 'pass',
      },
      imeta: [artifact('reports/ODR_AS-SE1_PSR_003_AESGCM.pdf', 'AES-GCM evaluation', 298744)],
    },
  },
  {
    key: 'trng',
    meta: {
      headline:
        'TRNG evaluation ODR_AS-SE1_PSR_004 — true random number generator on the SE-1 die (Acme Secure)',
      bullets: [
        'Acme Secure evaluated the TRNG; report ODR_AS-SE1_PSR_004 covers startup health tests, entropy estimation and the AIS 31 test suite.',
        'Result: pass. The generator reached 0.997 bits of min-entropy per bit after the online health tests.',
        'The noise source is a pair of ring oscillators; report ODR_AS-SE1_PSR_004 documents the failure modes it was tested against.',
      ],
      indexers: [...VENDOR, 'test:ODR_AS-SE1_PSR_004'],
      card: {
        type: 'acme-test-report@1',
        report: 'ODR_AS-SE1_PSR_004',
        lab: 'Acme Secure',
        result: 'pass',
      },
      imeta: [artifact('reports/ODR_AS-SE1_PSR_004_TRNG.pdf', 'TRNG evaluation', 331902)],
    },
  },
  {
    key: 'decap',
    meta: {
      headline:
        'Decapsulation analysis ODR_AS-SE1_PSR_005 — die and package inspection of the SE-1 (Northgate Evaluation Labs)',
      bullets: [
        'Northgate Evaluation Labs opened two SE-1 samples for Acme Secure; report ODR_AS-SE1_PSR_005 documents the die markings, the metal stack and the package construction.',
        'Result: pass. The die matches the published block diagram, and no undocumented test interface was found.',
        `The samples came from the ${T301} ordering number.`,
      ],
      indexers: [...VENDOR, 'test:ODR_AS-SE1_PSR_005'],
      card: {
        type: 'acme-test-report@1',
        report: 'ODR_AS-SE1_PSR_005',
        lab: 'Northgate Evaluation Labs',
        result: 'pass',
      },
      imeta: [artifact('reports/ODR_AS-SE1_PSR_005_Decap.pdf', 'Decapsulation analysis', 12740881)],
    },
  },
  {
    key: 'fault-injection',
    meta: {
      headline:
        'Fault-injection evaluation ODR_AS-SE1_PSR_006 — laser and electromagnetic fault injection on the SE-1 (Helvetia Institute for Hardware Security)',
      bullets: [
        'The Helvetia Institute for Hardware Security ran laser and electromagnetic fault injection for Acme Secure; report ODR_AS-SE1_PSR_006 covers the boot ROM, the firmware signature check and the AES engine.',
        'Result: fail on the boot path. A laser pulse during firmware verification skipped the signature check, which is the finding behind advisory ODR_AS-SE1_SA_2026030100.',
        'The AES and TRNG paths resisted the same campaign; the report lists the pulse parameters and the glitch windows that worked.',
      ],
      indexers: [...VENDOR, 'test:ODR_AS-SE1_PSR_006'],
      card: {
        type: 'acme-test-report@1',
        report: 'ODR_AS-SE1_PSR_006',
        lab: 'Helvetia Institute for Hardware Security',
        result: 'fail',
      },
      imeta: [artifact('reports/ODR_AS-SE1_PSR_006_FI.pdf', 'Fault-injection evaluation', 2140773)],
    },
  },
]

/**
 * The advisory. Its root content says the fix "is in development"; the corpus patches that
 * sentence when the fixed release ships. `i` values are immutable, so the update cannot be a
 * new tag — it is prose, which is exactly what `publish_patch` is for (report §4.3).
 */
const advisory = {
  headline:
    'Security advisory ODR_AS-SE1_SA_2026030100 — firmware signature verification bypassable by laser fault injection',
  bullets: [
    'Affected version: firmware 2.0.0 and earlier on the SE-1 family; a firmware fix is in development and this record is updated when it ships.',
    'A laser fault injection during boot can skip the signature check on the firmware image, so an unsigned image runs.',
    'Severity: CVSS 5.7. The finding comes from the fault-injection evaluation ODR_AS-SE1_PSR_006 and was reported to Acme Secure before publication.',
    'Mitigation: restrict physical access to the device; no firmware mitigation was available at publication. No CVE has been assigned.',
  ],
  indexers: [...VENDOR, 'advisory:ODR_AS-SE1_SA_2026030100'],
  card: {
    type: 'acme-advisory@1',
    advisory: 'ODR_AS-SE1_SA_2026030100',
    affected: '2.0.0 and earlier',
    severity: 'CVSS 5.7',
  },
  imeta: [
    artifact(
      'advisories/ODR_AS-SE1_SA_2026030100.pdf',
      'Advisory ODR_AS-SE1_SA_2026030100',
      186512,
    ),
  ],
}

/** The patch payload: the sentence that changes when firmware 2.1.0 ships. */
const advisoryFix = {
  from: 'a firmware fix is in development and this record is updated when it ships.',
  to: 'firmware 2.1.0, released 2026-11-20, contains the fix.',
}

/**
 * The two specifications. The architecture note covers both parts and is therefore bound to
 * both — a bridge node Lens draws between the family and the T301 card (report §4.2).
 */
const specs = [
  {
    key: 'sec-arch',
    meta: {
      headline:
        'SE-1 security architecture application note ODN_AS-SE1_APP_008 — boot chain, key hierarchy and isolation (Acme Secure)',
      bullets: [
        'Application note ODN_AS-SE1_APP_008 documents the immutable boot ROM, the firmware signature check and the key hierarchy of the SE-1 family.',
        `It covers both ordering numbers ${T301} and ${B2S}; the debug port exists only on the evaluation board.`,
        'The note is the reference the fault-injection evaluation ODR_AS-SE1_PSR_006 is read against.',
      ],
      indexers: [...VENDOR, 'doc:ODN_AS-SE1_APP_008'],
      card: { type: 'acme-specification@1', doc: 'ODN_AS-SE1_APP_008' },
      imeta: [artifact('docs/ODN_AS-SE1_APP_008.pdf', 'SE-1 architecture app note', 968344)],
    },
  },
  {
    key: 't301-datasheet',
    meta: {
      headline:
        'Acme Secure AS-SE1-C2P-T301 datasheet ODD_AS-SE1_DS_011 — pinout, electrical characteristics and ordering information',
      bullets: [
        `Datasheet ODD_AS-SE1_DS_011 covers the ${T301} package: 4 mm × 4 mm QFN32, 1.62 V to 3.3 V supply, ISO/IEC 7816 and I2C interfaces.`,
        'It ships with firmware 2.1.0 by default; the CC certificate BSI-DSZ-CC-1234-2026 is listed in the ordering table.',
        `The document applies to the T301 ordering number; it does not apply to the discontinued ${B2S}.`,
      ],
      indexers: [...VENDOR, `part:${T301}`, 'doc:ODD_AS-SE1_DS_011'],
      card: {
        type: 'acme-specification@1',
        part: T301,
        doc: 'ODD_AS-SE1_DS_011',
        package: 'QFN32',
      },
      imeta: [artifact('docs/ODD_AS-SE1_DS_011.pdf', 'T301 datasheet', 1204510)],
    },
  },
]

/**
 * The session-only record. It is labelled as a test record in the headline because a reader who
 * sees the red node must not mistake it for a vendor claim; the run retracts it immediately.
 */
const testRecord = {
  headline:
    'TEST RECORD (demo) — fault-injection retest draft TEST-ACME-DEMO-0001, not a vendor claim',
  bullets: [
    'This Acme Secure record exists only for the 2026-11-24 company testing: it is retracted in the same run to show how Lens renders a withdrawn event.',
    'It carries no evaluation result; the fault-injection evidence is ODR_AS-SE1_PSR_006, and the advisory is ODR_AS-SE1_SA_2026030100.',
  ],
  indexers: [...VENDOR, 'test:TEST-ACME-DEMO-0001'],
  card: {
    type: 'acme-test-report@1',
    report: 'TEST-ACME-DEMO-0001',
    state: 'draft',
  },
}

/** Retraction reason: a reader's sentence, not the word "retracted" (guide §6). */
const retractReason =
  'demo corpus: TEST-ACME-DEMO-0001 is a fabricated record created only to show the retracted state; the fault-injection evidence is ODR_AS-SE1_PSR_006'

/**
 * The publish order is the read order: identity, then the products a reader searches for, then
 * the records, then the edges, then the lifecycle events. Bindings follow their endpoints
 * because a `root_ref` needs an id.
 */
export const steps = [
  { key: 'profile', role: 'profile', tool: 'set_profile', args: profile },

  { key: 'family', role: 'product', tool: 'publish_product', args: family },
  { key: 't301', role: 'product', tool: 'publish_product', args: t301 },
  { key: 'b2s', role: 'product', tool: 'publish_product', args: b2s },

  ...tests.map(({ key, meta }) => ({
    key,
    role: 'metadata:test',
    tool: 'publish_metadata',
    args: meta,
  })),
  { key: 'advisory', role: 'metadata:advisory', tool: 'publish_metadata', args: advisory },
  ...specs.map(({ key, meta }) => ({
    key,
    role: 'metadata:specification',
    tool: 'publish_metadata',
    args: meta,
  })),
  { key: 'test-record', role: 'metadata:test-record', tool: 'publish_metadata', args: testRecord },

  // Six family-wide evaluations, one part-specific bridge, the advisory, the specification
  // bridge, the datasheet and the session record: 12 Bindings.
  ...tests.map(({ key }) => ({
    key: `binding-${key}`,
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 'family', link: key, label: 'tests' },
  })),
  {
    key: 'binding-fault-injection-t301',
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 't301', link: 'fault-injection', label: 'tests' },
  },
  {
    key: 'binding-advisory',
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 'family', link: 'advisory', label: 'affects' },
  },
  {
    key: 'binding-sec-arch-family',
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 'family', link: 'sec-arch', label: 'documents' },
  },
  {
    key: 'binding-sec-arch-t301',
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 't301', link: 'sec-arch', label: 'documents' },
  },
  {
    key: 'binding-t301-datasheet',
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 't301', link: 't301-datasheet', label: 'documents' },
  },
  {
    key: 'binding-test-record',
    role: 'binding',
    tool: 'publish_binding',
    args: { root: 'family', link: 'test-record', label: 'tests' },
  },

  {
    key: 'advisory-fix',
    role: 'patch',
    tool: 'publish_patch',
    patch: { target: 'advisory', replace: advisoryFix },
  },
  {
    key: 'test-record-retraction',
    role: 'retraction',
    tool: 'retract',
    args: { target: 'test-record', reason: retractReason },
  },
]

/**
 * The subtype each step publishes. Kept out of the step args so the corpus states what a record
 * *is* (`test`, `specification`) while the wire value follows the Lens compatibility map.
 */
const SUBTYPE_OF_ROLE = {
  'metadata:test': 'test',
  'metadata:advisory': 'advisory',
  'metadata:specification': 'specification',
  'metadata:test-record': 'test',
}

/** A Metadata step with the Lens-compatible subtype applied (the MCP schema enum owns the rest). */
export function toolArgs(step) {
  const subtype = SUBTYPE_OF_ROLE[step.role]
  if (subtype === undefined) return step.args
  return { ...step.args, meta_subtype: LENS_SUBTYPE[subtype] }
}

/** The headline a run prints next to each event id, so the log reads like the corpus. */
export function labelOf(step) {
  if (step.args?.headline !== undefined) return step.args.headline
  if (step.tool === 'publish_binding') {
    return `${step.args.label}: ${step.args.root} -> ${step.args.link}`
  }
  if (step.tool === 'publish_patch') return `patch ${step.patch.target}: ${step.patch.replace.to}`
  if (step.tool === 'retract') return `retract ${step.args.target}`
  return step.args?.name ?? step.key
}

/** The role/count table the run summary prints, in first-seen order. */
export function countsByRole() {
  const counts = new Map()
  for (const step of steps) counts.set(step.role, (counts.get(step.role) ?? 0) + 1)
  return [...counts]
}

/** The fake vendor, for the run header and the README. */
export const vendor = {
  slug: 'acme-secure',
  name: 'Acme Secure',
  family: FAMILY_PART,
  parts: [T301, B2S],
}
