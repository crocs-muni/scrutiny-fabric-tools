/**
 * emit/advisorySpine.ts — the ROCA demo spine (design §2.1/§2.4/§2.6, README §Frozen
 * "Demo set", `ground-truth/roca-demo-shortlist.md`).
 *
 * Hardcoded, pre-verified chain strings: five card-side certificates (the four demo
 * cards' certs plus SERTIT-079) and the ROCA-marked chip certificate
 * BSI-DSZ-CC-0782-2012, each as TOE Product + certification-record Metadata; the
 * CVE-2017-15361 advisory; the advisory Bindings (direct for the chip certificate,
 * `transitive via BSI-DSZ-CC-0782-2012` for the certificates whose own
 * report/ST directly references it) and the four card ↔ certificate cross-links.
 *
 * Every value below is copied from the cited ground-truth artifacts; nothing is
 * invented. Fields the sources do not state stay null/[] and no indexer is emitted
 * for them.
 */

import type { SignedEvent } from '../types.js'
import { type BindingSpec, buildBinding } from './binding.js'
import {
  assertEventShape,
  assertRule2a,
  baseTags,
  composeContent,
  iTags,
  kTagsFor,
  vendorSlug,
} from './content.js'
import type { Clock, Signer } from './keys.js'

export const ROCA_CVE = 'CVE-2017-15361'
export const ROCA_CHIP_CERT_ID = 'BSI-DSZ-CC-0782-2012'

/** One spine certificate record (values from crosslink-matrix.json + roca-demo-shortlist.md). */
export interface SpineCert {
  /** sec-certs record digest (16-hex). */
  dgst: string
  certId: string
  name: string
  /** Verbatim `manufacturer` from the sec-certs record. */
  manufacturer: string
  /** 2-letter scheme code, lowercased for `scheme:`. */
  scheme: string
  /** Achieved level verbatim (`EAL6+`), or null when the sources do not state it. */
  eal: string | null
  /** Record status, or null when not stated by the sources. */
  status: string | null
  /** Direct reference edges (verified cert ids). */
  directRefs: string[]
  /** CVEs in this record's own heuristics (measured empty for the card-side certs). */
  relatedCves: string[]
  /** Reference edge to the ROCA chip certificate, when the sources state one. */
  bridge: { targetCertId: string; edge: string } | null
  /** Cross-linked JCAlgTest card (only where a cross-link Binding is published). */
  card: { jcard: string; cardName: string } | null
}

/** The six spine certificates, in publication order (cards first, chip last). */
export const SPINE_CERTS: readonly SpineCert[] = [
  {
    dgst: 'f29f88756682e034',
    certId: 'NSCIB-CC-22-180212-2-CR',
    name: 'NXP JCOP 4 P71',
    manufacturer: 'NXP Semiconductors',
    scheme: 'nl',
    eal: 'EAL6+',
    status: null,
    directRefs: [],
    relatedCves: [],
    bridge: null,
    card: { jcard: 'c071', cardName: 'NXP JCOP4 J3R180 P71' },
  },
  {
    dgst: '9b8e2c2e7f69fdbb',
    certId: 'SERTIT-091',
    name: 'Feitian FT-JCOS v1.0/0.106.13 running on Infineon M7892 B11',
    manufacturer: 'Feitian Technologies Co., Ltd.',
    scheme: 'no',
    eal: 'EAL5+',
    status: 'archived',
    directRefs: [ROCA_CHIP_CERT_ID],
    relatedCves: [],
    bridge: { targetCertId: ROCA_CHIP_CERT_ID, edge: 'st_references.directly_referencing' },
    card: { jcard: 'c008', cardName: 'Feitian-FTJCOS' },
  },
  {
    dgst: '4fdb0afc0bbabfb8',
    certId: 'SERTIT-079',
    name: 'Feitian FT-JCOS v1.0/0.106.13 running on Infineon M7892 B11',
    manufacturer: 'Feitian Technologies Co., Ltd.',
    scheme: 'no',
    eal: 'EAL4+',
    status: 'archived',
    directRefs: [ROCA_CHIP_CERT_ID],
    relatedCves: [],
    bridge: { targetCertId: ROCA_CHIP_CERT_ID, edge: 'st_references.directly_referencing' },
    card: null,
  },
  {
    dgst: 'd8473663e3e82527',
    certId: 'BSI-DSZ-CC-0868-2014',
    name: 'Sm@rtCafé® Expert 7.0 C1',
    manufacturer: 'G+D Mobile Security GmbH',
    scheme: 'de',
    eal: 'EAL5+',
    status: 'archived',
    directRefs: [ROCA_CHIP_CERT_ID],
    relatedCves: [],
    bridge: {
      targetCertId: ROCA_CHIP_CERT_ID,
      edge: 'report_references + st_references.directly_referencing',
    },
    card: { jcard: 'c026', cardName: 'G+D Smartcafe 7.0' },
  },
  {
    dgst: 'a43ba4af9421da93',
    certId: 'BSI-DSZ-CC-0869-2015',
    name: 'Java Card Platform Implementation for Infineon on SLE 78 (SLJ 52GxxyyyzR) V1.0',
    manufacturer: 'Oracle Corporation',
    scheme: 'de',
    eal: 'EAL5+',
    status: 'archived',
    directRefs: [ROCA_CHIP_CERT_ID],
    relatedCves: [],
    bridge: { targetCertId: ROCA_CHIP_CERT_ID, edge: 'report_references.directly_referencing' },
    card: { jcard: 'c046', cardName: 'Infineon SLE78 Universal JCard' },
  },
  {
    dgst: '4a69ab527a60ab5d',
    certId: ROCA_CHIP_CERT_ID,
    name:
      'Infineon Security Controller M7892 B11 with optional RSA2048/4096 v1.02.013, EC v1.02.013, ' +
      'SHA-2 v1.01 and Toolbox v1.02.013 libraries and with specific IC dedicated software (firmware)',
    manufacturer: 'Infineon Technologies AG',
    scheme: 'de',
    eal: null,
    status: 'archived',
    directRefs: [],
    relatedCves: [ROCA_CVE],
    bridge: null,
    card: null,
  },
]

/** The four demo-card cross-links (evidence strings verbatim from the crosslink matrix). */
export interface SpineCrosslink {
  jcard: string
  cardName: string
  cardAtr: string
  certDgst: string
  certId: string
  certName: string
  confidence: 'high' | 'medium'
  evidence: string[]
  /** True when the certificate bridges to the ROCA chip certificate (adds `t roca`). */
  roca: boolean
}

export const SPINE_CROSSLINKS: readonly SpineCrosslink[] = [
  {
    jcard: 'c071',
    cardName: 'NXP JCOP4 J3R180 P71',
    cardAtr: '3bfa1800ff10004a546178436f72655631',
    certDgst: 'f29f88756682e034',
    certId: 'NSCIB-CC-22-180212-2-CR',
    certName: 'NXP JCOP 4 P71',
    confidence: 'high',
    evidence: [
      'name: "NXP JCOP 4 P71" → card token nxp',
      'manufacturer: "NXP Semiconductors" → card token nxp',
      'name: "NXP JCOP 4 P71" → CPLC semantic key jcop4 (OperatingSystemID 4700)',
    ],
    roca: false,
  },
  {
    jcard: 'c008',
    cardName: 'Feitian-FTJCOS',
    cardAtr: '3bfc180000813180459067464a0100870600000000ea',
    certDgst: '9b8e2c2e7f69fdbb',
    certId: 'SERTIT-091',
    certName: 'Feitian FT-JCOS v1.0/0.106.13 running on Infineon M7892 B11',
    confidence: 'medium',
    evidence: [
      'name: "Feitian FT-JCOS v1.0/0.106.13 running on Infineon M7892 B11" → card token feitian',
      'manufacturer: "Feitian Technologies Co., Ltd." → card token feitian',
      'name: "Feitian FT-JCOS v1.0/0.106.13 running on Infineon M7892 B11" → card bigram feitian ftjcos (CPLC chip semantics: infineon)',
    ],
    roca: true,
  },
  {
    jcard: 'c026',
    cardName: 'G+D Smartcafe 7.0',
    cardAtr: '3bf99600008031fe4553434537200000202027',
    certDgst: 'd8473663e3e82527',
    certId: 'BSI-DSZ-CC-0868-2014',
    certName: 'Sm@rtCafé® Expert 7.0 C1',
    confidence: 'high',
    evidence: [
      'name: "Sm@rtCafé® Expert 7.0 C1" → card token expert',
      'name: "Sm@rtCafé® Expert 7.0 C1" → card bigram expert 7',
      'name: "Sm@rtCafé® Expert 7.0 C1" → CPLC semantic key smrtcafe (OperatingSystemID d001 → "G&D Sm@rtCafe 7")',
    ],
    roca: true,
  },
  {
    jcard: 'c046',
    cardName: 'Infineon SLE78 Universal JCard',
    cardAtr: '3bfd9600008131fe45534c4a353247444c313238435257',
    certDgst: 'a43ba4af9421da93',
    certId: 'BSI-DSZ-CC-0869-2015',
    certName: 'Java Card Platform Implementation for Infineon on SLE 78 (SLJ 52GxxyyyzR) V1.0',
    confidence: 'medium',
    evidence: [
      'name: "Java Card Platform Implementation for Infineon on SLE 78 (SLJ 52GxxyyyzR) V1.0" → card token infineon',
      'name: "Java Card Platform Implementation for Infineon on SLE 78 (SLJ 52GxxyyyzR) V1.0" → card token sle78',
      'name: "Java Card Platform Implementation for Infineon on SLE 78 (SLJ 52GxxyyyzR) V1.0" → CPLC chip semantics: infineon',
    ],
    roca: true,
  },
]

/** Event-id index of the published spine nodes (bindings are built from it). */
export interface SpineIndex {
  /** cert id → TOE Product event id */
  toeByCert: Record<string, string>
  /** cert id → certify-record Metadata event id */
  certMetaByCert: Record<string, string>
  dgstByCert: Record<string, string>
  advisoryId: string
}

/**
 * Digests of spine certificates that are ROCA-affected: the chip certificate (own
 * heuristics) plus every certificate whose reference edge bridges to it. Cards
 * cross-linked to these records are the ROCA-reachable card-side events (§3.7).
 */
export const ROCA_REACHABLE_DGSTS: Readonly<Record<string, true>> = Object.fromEntries(
  SPINE_CERTS.filter((cert) => cert.relatedCves.includes(ROCA_CVE) || cert.bridge !== null).map(
    (cert) => [cert.dgst, true],
  ),
) as Readonly<Record<string, true>>

function schemeName(scheme: string): string {
  const names: Record<string, string> = {
    de: 'Germany (BSI)',
    nl: 'Netherlands (NSCIB)',
    no: 'Norway (SERTIT)',
  }
  return names[scheme] ?? scheme
}

/** Build the spine node events (6 TOE + 6 cert Metadata + 1 advisory). */
export function buildSpineNodes(
  snapshot: string,
  clock: Clock,
  signer: Signer,
): { events: SignedEvent[]; index: SpineIndex } {
  const events: SignedEvent[] = []
  const toeByCert: Record<string, string> = {}
  const certMetaByCert: Record<string, string> = {}
  const dgstByCert: Record<string, string> = {}

  for (const cert of SPINE_CERTS) {
    const vendor = vendorSlug(cert.manufacturer)
    const affected = cert.relatedCves.includes(ROCA_CVE) || cert.bridge !== null
    const facets = affected ? ['sec-certs', 'roca'] : ['sec-certs']

    const toeI = iTags([
      `cc:${cert.certId}`,
      `scheme:${cert.scheme}`,
      vendor === null ? null : `vendor:${vendor}`,
    ])
    const toe = signer.sign({
      kind: 1,
      created_at: clock.next(),
      tags: [...baseTags('scrutiny-product', facets), ...toeI, ...kTagsFor(toeI)],
      content: composeContent({
        headline:
          `${cert.name} — smart-card platform certified under ${cert.certId} ` +
          `(${schemeName(cert.scheme)}, ${cert.eal ?? 'EAL not recorded in this snapshot'}).`,
        bullets: [
          `Product identity: TOE ${cert.name}; manufacturer ${cert.manufacturer} (vendor slug ${vendor ?? 'not applicable'}); record dgst ${cert.dgst}.`,
          `Certification: ${cert.certId}, scheme ${cert.scheme} — ${schemeName(cert.scheme)}` +
            `${cert.eal === null ? '' : `, ${cert.eal}`}` +
            `${cert.status === null ? ', status not recorded in this snapshot' : `, status ${cert.status}`}.`,
          cert.directRefs.length === 0
            ? "Reference edges: none recorded in this snapshot's heuristics for this record."
            : `Reference edges: directly references ${cert.directRefs.join(', ')} (report/ST reference; indexer cc:${cert.directRefs[0]}).`,
          cert.relatedCves.length === 0
            ? 'Known vulnerability (own heuristics): none recorded in this snapshot — see the certificate record for the reference-graph bridge.'
            : `Known vulnerability (own heuristics): ${cert.relatedCves.join(', ')} (ROCA) — bound directly to this Product by the advisory Binding.`,
          cert.card === null
            ? 'Cross-dataset: no JCAlgTest card cross-link is published for this record in this import.'
            : `Cross-dataset: cross-linked from JCAlgTest card profile ${cert.card.jcard} (${cert.card.cardName}) — see the card↔certificate Binding.`,
          `Snapshot: ${snapshot}; mirrored by scrutiny-mirror from the sec-certs.org CC dataset; derived heuristics are sec-certs' output, not the mirror's.`,
        ],
        links: [`Source page: https://sec-certs.org/cc/${cert.dgst}/`],
        card: {
          type: 'sec-certs-cc-toe@1',
          dgst: cert.dgst,
          cert_id: cert.certId,
          scheme: cert.scheme,
          eal: cert.eal === null ? [] : [cert.eal],
          status: cert.status,
          valid_from: null,
          valid_until: null,
          vendor,
          cpe_verified: [],
          cpe_unverified: [],
          snapshot,
        },
      }),
    })
    assertEventShape(toe, `spine-toe:${cert.certId}`)
    assertRule2a(toe, `spine-toe:${cert.certId}`)
    toeByCert[cert.certId] = toe.id
    dgstByCert[cert.certId] = cert.dgst
    events.push(toe)

    const metaI = iTags([
      `cc:${cert.certId}`,
      `scheme:${cert.scheme}`,
      cert.eal === null ? null : `eal:${cert.eal}`,
      vendor === null ? null : `vendor:${vendor}`,
      ...cert.directRefs.map((r) => `cc:${r}`),
    ])
    const meta = signer.sign({
      kind: 1,
      created_at: clock.next(),
      tags: [...baseTags('scrutiny-metadata', facets), ...metaI, ...kTagsFor(metaI)],
      content: composeContent({
        headline:
          `${cert.certId} — ${cert.name}, ${cert.scheme.toUpperCase()} scheme` +
          `${cert.eal === null ? '' : ` ${cert.eal}`}` +
          `${cert.status === null ? '' : ` (${cert.status})`}.`,
        bullets: [
          `TOE: ${cert.name}; manufacturer ${cert.manufacturer} (vendor slug ${vendor ?? 'not applicable'}); record dgst ${cert.dgst}.`,
          `Scheme: ${schemeName(cert.scheme)}; security level ${cert.eal ?? 'not recorded in this snapshot'}.`,
          cert.directRefs.length === 0
            ? 'Certificate reference graph: no direct references recorded for this record in this snapshot.'
            : `Certificate reference graph: directly references ${cert.directRefs.join(', ')} (${cert.bridge === null ? 'report/ST' : cert.bridge.edge}); indirect/transitive closures stay in the source record JSON, never in indexers (IX-4).`,
          cert.relatedCves.length === 0
            ? "Related CVE (sec-certs heuristics): none recorded — the ROCA bridge for this record rides the certificate reference edge, not this record's own CVE set."
            : `Related CVE (sec-certs heuristics, ~89% precision, arXiv:2311.17603): ${cert.relatedCves.join(', ')} — bound as an advisory, not as an indexer.`,
          `Snapshot: ${snapshot}; mirrored by scrutiny-mirror from the sec-certs.org CC dataset (per-record page cached; no mirrored artifact hash is published for this record in this import).`,
        ],
        links: [`Source page: https://sec-certs.org/cc/${cert.dgst}/`],
        card: {
          type: 'sec-certs-cc-record@1',
          dgst: cert.dgst,
          cert_id: cert.certId,
          scheme: cert.scheme,
          status: cert.status,
          eal: cert.eal === null ? [] : [cert.eal],
          pp: [],
          vendor,
          maintenance: [],
          related_cves: cert.relatedCves,
          direct_refs: cert.directRefs,
          snapshot,
        },
      }),
    })
    assertEventShape(meta, `spine-record:${cert.certId}`)
    assertRule2a(meta, `spine-record:${cert.certId}`)
    certMetaByCert[cert.certId] = meta.id
    events.push(meta)
  }

  const advisoryI = iTags([`cve:${ROCA_CVE}`, 'cwe:CWE-310'])
  const advisory = signer.sign({
    kind: 1,
    created_at: clock.next(),
    tags: [
      ...baseTags('scrutiny-metadata', ['sec-certs', 'jcalgtest', 'roca']),
      ...advisoryI,
      ...kTagsFor(advisoryI),
    ],
    content: composeContent({
      headline: `ROCA — ${ROCA_CVE}: predictable RSA key generation in Infineon RSALib (disclosed 2017-10).`,
      bullets: [
        "Impact: RSA keys generated by affected Infineon cryptographic hardware (smart cards, TPMs, security tokens) are factorable from the public key alone (Coppersmith's attack on a structured-prime weakness); devices dating back to at least 2012.",
        'Scope: independent of RNG quality; affects cryptographic hardware across vendors and firmware versions; an EAL4+/EAL5+ certificate does not imply immunity.',
        'CWE: CWE-310 (cryptographic issues); reference: "The Return of Coppersmith\'s Attack", ACM CCS 2017.',
        "Mirror provenance: this advisory is bound to each affected Product mirrored by this key, using sec-certs' derived certificate↔CVE relation plus, for records whose own heuristics do not carry the CVE, the certificate-reference bridge (provenance class stated in each Binding; sec-certs reports ~89% precision for its CVE/CPE mapping, arXiv:2311.17603) — treat bindings as source-derived, not authoritative.",
        `Record source: sec-certs heuristics + NVD; snapshot ${snapshot} (mirror import date, also in the record card below).`,
        'Binding semantics: absence of a binding means "no relation recorded in the mirrored source", not "verified clean"; new affected products appear as new bindings, never by patching this record.',
        "Mitigations (informational): vendor detection tools, key replacement, migration to ECC — outside this record's scope.",
      ],
      links: [
        `NVD: https://nvd.nist.gov/vuln/detail/${ROCA_CVE}`,
        'CRoCS ROCA page: https://crocs.fi.muni.cz/doku.php?id=public:papers:rsa_ccs17',
        'sec-certs CC reference graph: https://sec-certs.org/cc/network/',
        'Mirrored by scrutiny-mirror from sec-certs derived data + NVD; not authored by MITRE or Infineon.',
      ],
      card: {
        type: 'cve-advisory@1',
        cve: ROCA_CVE,
        aliases: ['ROCA'],
        cwe: ['CWE-310'],
        disclosed: '2017-10',
        source: 'sec-certs heuristics + NVD',
        snapshot,
      },
    }),
  })
  assertEventShape(advisory, `spine-advisory:${ROCA_CVE}`)
  assertRule2a(advisory, `spine-advisory:${ROCA_CVE}`)
  events.push(advisory)

  return { events, index: { toeByCert, certMetaByCert, dgstByCert, advisoryId: advisory.id } }
}

/** Build the spine's certificate-record bindings and advisory bindings (11 events). */
export function buildSpineBindings(
  index: SpineIndex,
  snapshot: string,
  clock: Clock,
  signer: Signer,
): SignedEvent[] {
  const events: SignedEvent[] = []
  const advisory = index.advisoryId

  for (const cert of SPINE_CERTS) {
    const toeId = index.toeByCert[cert.certId]
    const metaId = index.certMetaByCert[cert.certId]
    if (toeId === undefined || metaId === undefined) continue
    events.push(
      buildBinding(
        {
          root: { id: toeId, label: cert.name },
          link: { id: metaId, label: cert.certId },
          facets: ['sec-certs'],
          headline: `${cert.name} ← ${cert.certId}: the certificate record bound to its TOE Product.`,
          bullets: [
            `Edge shape: root = TOE Product (${cert.name}), link = certification-record Metadata (${cert.certId}) — one record, one Product, one Metadata, one Binding (design §2.1).`,
            `The linked Metadata carries the record's indexers (cc:${cert.certId}, scheme:${cert.scheme}${cert.eal === null ? '' : `, eal:${cert.eal}`}) and its single-line record card.`,
            `Source: sec-certs.org CC dataset, record dgst ${cert.dgst}, snapshot ${snapshot}; mirrored by scrutiny-mirror.`,
          ],
          links: [`Source page: https://sec-certs.org/cc/${cert.dgst}/`],
        },
        clock.next(),
        signer,
        `spine-b1:${cert.certId}`,
      ),
    )

    const direct = cert.relatedCves.includes(ROCA_CVE)
    if (!direct && cert.bridge === null) continue
    const linkTarget =
      cert.bridge === null
        ? "this record's own heuristics.related_cves"
        : `${cert.certId} directly references ${cert.bridge.targetCertId} (${cert.bridge.edge}); the chip certificate's own heuristics.related_cves carry ${ROCA_CVE}`
    events.push(
      buildBinding(
        {
          root: { id: toeId, label: cert.name },
          link: { id: advisory, label: ROCA_CVE },
          facets: ['sec-certs', 'roca'],
          headline:
            `${cert.name} — ${ROCA_CVE} (ROCA) affects this product ` +
            `(provenance class: ${direct ? 'direct' : `transitive via ${ROCA_CHIP_CERT_ID}`}).`,
          bullets: [
            direct
              ? `Provenance class: direct — ${ROCA_CVE} appears in this certificate's own heuristics (sec-certs derived relation, ~89% precision, arXiv:2311.17603).`
              : `Provenance class: transitive via ${ROCA_CHIP_CERT_ID} — ${linkTarget}; no CVE appears in ${cert.certId}'s own heuristics (measured 2026-10-04), so this edge is the certificate reference, labelled as such.`,
            'Binding semantics: absence of a binding means no relation recorded in the mirrored source, not verified clean; a relation correction is a kind-5 retraction of this edge plus a replacement, never a patch (§6.5).',
            `Scope note: the affected object is ${cert.name} as certified under ${cert.certId}; reachable JCAlgTest cards are those cross-linked to this certificate record.`,
          ],
          links: [`Source page: https://sec-certs.org/cc/${cert.dgst}/`],
        },
        clock.next(),
        signer,
        `spine-advisory-binding:${cert.certId}`,
      ),
    )
  }

  return events
}

/** Build one card ↔ certificate cross-link Binding (design §2.6, issue #264 method). */
export function buildSpineCrosslinkBinding(
  cross: SpineCrosslink,
  rootId: string,
  linkId: string,
  snapshot: string,
  clock: Clock,
  signer: Signer,
): SignedEvent {
  const spec: BindingSpec = {
    root: { id: rootId, label: cross.cardName },
    link: { id: linkId, label: cross.certId },
    facets: cross.roca ? ['jcalgtest', 'roca'] : ['jcalgtest'],
    headline: `${cross.cardName} — cross-link to certificate record ${cross.certId} (${cross.certName}).`,
    bullets: [
      'Method: JCAlgTest issue #264 — the card name is searched in the sec-certs full text and filtered by CPLC ICType / OperatingSystemID; reproduced in ground-truth/crosslink-matrix.json.',
      `Evidence (${cross.confidence} confidence): ${cross.evidence.join('; ')}.`,
      `Card identity used for the match: ${cross.cardName}, ATR ${cross.cardAtr}, JCAlgTest profile ${cross.jcard}.`,
      cross.roca
        ? `ROCA bridge: ${cross.certId} directly references ${ROCA_CHIP_CERT_ID}, whose heuristics carry ${ROCA_CVE}; the card therefore gains advisory visibility through this cross-link (transitive, not a direct CVE on the card).`
        : 'ROCA bridge: none — this certificate record does not reference the ROCA-affected chip certificate in this snapshot.',
      'Caveat: the cross-link is source-derived (issue-#264 method, confidence class above) and is not authoritative; card and TOE identities are never merged — this Binding is the junction (design §2.10.2).',
      `Snapshot: ${snapshot}; mirrored by scrutiny-mirror.`,
    ],
    links: [`Certificate page: https://sec-certs.org/cc/${cross.certDgst}/`],
  }
  return buildBinding(spec, clock.next(), signer, `spine-crosslink:${cross.jcard}`)
}
