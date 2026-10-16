/**
 * emit/seccerts/relations.ts — sec-certs binding projection (leg 2): SecCertsBundle → DesiredRelation[].
 *
 * Pure projection: headline + bullets + links + facets + provenance class + fingerprint only —
 * the engine resolves the endpoint roots, adds the binding `e` tags (NIP-10 root/link markers)
 * and the `Refs: root <hex> link <hex>` line (rule 8d), and owns signing/ledger/clock.
 *
 * Relation families (update-semantics §1/§3): `record` (Product ↔ its certification/validation
 * Metadata), `pp-membership` (PP Product ↔ cert Metadata, resolved refs only), `advisory-victim`
 * (cc/eucc/fips Product ↔ CVE advisory) and `adv-maint` (cc TOE Product ↔ CVE advisory triggered
 * by a maintenance-corpus record; ledger corpus = seccerts/maintenance, §3).
 *
 * Fingerprint = sha256(relationId|cls|rootRef.sourceId|linkRef.sourceId|headline) — the R2/R3
 * diff key. It covers logical keys, never event ids, so a relation keeps its identity across
 * re-points (§2 C4) while a class change (direct↔transitive) is an R3 replace, not a patch.
 */
import { sha256 } from '@noble/hashes/sha2.js'

import type {
  CveClass,
  CveRelation,
  DesiredRelation,
  SecCertsBundle,
  SecCertsCertRecord,
  SecCertsCrosslink,
  SecCertsMaintenanceRecord,
  SecCertsPpRecord,
} from '../../loaders/seccerts-types.js'
import { ROCA_CVE } from './roots.js'

function sha256Hex(text: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(text))).toString('hex')
}

function fingerprintOf(
  relationId: string,
  cls: CveClass | null,
  rootSourceId: string,
  linkSourceId: string,
  headline: string,
): string {
  const material = `${relationId}|${cls === null ? 'null' : cls}|${rootSourceId}|${linkSourceId}|${headline}`
  return sha256Hex(material)
}

/**
 * Cross-link fingerprint (decision 2026-10-11): sha256 over relationId|cardKey|certDgst|evidence.
 * Exported so the leg-1 seed bootstrap (emit/seccerts/index.ts) computes IDENTICAL fingerprints
 * for the 4 seeded demo pairs — seeded relation rows must compare R2-unchanged against the
 * plan's rows, never R3-replaced.
 */
export function crosslinkFingerprintOf(pair: SecCertsCrosslink): string {
  const material = `${crosslinkRelationId(pair)}|${pair.cardKey}|${pair.certDgst}|${pair.evidence.join('|')}`
  return sha256Hex(material)
}

export function crosslinkRelationId(pair: SecCertsCrosslink): string {
  return `xlink:${pair.cardKey}:${pair.certDgst}`
}

/** Card Product ↔ cert Metadata cross-links (design §2.6, JCAlgTest issue-#264 method). */
function crosslinkRelations(
  pair: SecCertsCrosslink,
  cert: SecCertsCertRecord | undefined,
): DesiredRelation[] {
  const relationId = crosslinkRelationId(pair)
  const certLabel = pair.certId ?? pair.certDgst
  const roca = cert?.cves.some((c) => c.cve === ROCA_CVE) ?? false
  const certFound = cert !== undefined
  const headline = `${pair.cardName} (${pair.cardKey}) ↔ ${certLabel}: card↔certificate cross-link (JCAlgTest issue #264).`
  return [
    {
      corpus: 'seccerts/cc',
      relationId,
      kind: 'crosslink',
      rootRef: {
        corpus: 'jcalgtest',
        sourceId: pair.cardKey,
        role: 'product' as const,
        label: pair.cardName,
      },
      linkRef: {
        corpus: 'seccerts/cc',
        sourceId: pair.certDgst,
        role: 'metadata' as const,
        label: certLabel,
      },
      cls: null,
      fingerprint: crosslinkFingerprintOf(pair),
      facets: roca ? ['sec-certs', 'jcalgtest', 'roca'] : ['sec-certs', 'jcalgtest'],
      headline,
      bullets: [
        'Cross-link method: JCAlgTest issue #264 — card-name full-text search inside sec-certs full text, filtered by CPLC ICType/OperatingSystemID (ground-truth/crosslink-matrix.json).',
        ...(pair.evidence.length === 0
          ? [
              'Evidence: none recorded for this pair in the matrix (seeded from leg-1 spine selection).',
            ]
          : pair.evidence.map((e) => `Evidence: ${e}`)),
        pair.score === null ? null : `Matrix score: ${pair.score} (confidence high).`,
        certFound
          ? null
          : `WARNING (plan-time): cert record ${pair.certDgst} is absent from this leg's cc corpus — relation cannot resolve its link endpoint.`,
        `Provenance: mirrored by scrutiny-mirror; the JCAlgTest side is leg 1 of this same mirror key, snapshot ${
          cert === undefined ? 'unknown' : cert.snapshot
        }.`,
      ].filter((line): line is string => line !== null),
      links: [
        `Certificate record page: https://sec-certs.org/cc/${pair.certDgst}/`,
        'JCAlgTest support matrix: https://www.fi.muni.cz/~xsvenda/jcalgtest/table.html',
      ],
    },
  ]
}

/** Product ↔ its certification/validation Metadata (`record:<dgst>`, §2.1/§2.3/§2.10). */
function recordRelation(input: {
  corpus: string
  sourceId: string
  productLabel: string
  metaLabel: string
  snapshot: string
  edgeSentence: string
}): DesiredRelation {
  const relationId = `record:${input.sourceId}`
  const rootRef = {
    corpus: input.corpus,
    sourceId: input.sourceId,
    role: 'product' as const,
    label: input.productLabel,
  }
  const linkRef = {
    corpus: input.corpus,
    sourceId: input.sourceId,
    role: 'metadata' as const,
    label: input.metaLabel,
  }
  const headline = `${input.productLabel} ← ${input.metaLabel}: the binding from the certification record to its Product.`
  return {
    corpus: input.corpus,
    relationId,
    kind: 'record',
    rootRef,
    linkRef,
    cls: null,
    fingerprint: fingerprintOf(relationId, null, rootRef.sourceId, linkRef.sourceId, headline),
    facets: ['sec-certs'],
    headline,
    bullets: [
      input.edgeSentence,
      `Mirrored by scrutiny-mirror from sec-certs snapshot ${input.snapshot} (record dgst ${input.sourceId}); the binding exists iff both endpoints are live (update-semantics §2).`,
    ],
    links: [
      `Source page: https://sec-certs.org/${
        input.corpus === 'seccerts/fips' ? 'fips' : input.corpus === 'seccerts/eucc' ? 'eucc' : 'cc'
      }/${input.sourceId}/`,
    ],
  }
}

/**
 * PP Product ↔ cert Metadata memberships, resolved references only (`pp:<certDgst>:<ppDgst>`).
 * Membership = the intersection of the PP dataset's records with the cert records' natural
 * resolved-PP lists; a dgst without a PP record emits nothing (unresolved refs are tag-only,
 * design §9 Q7). Channel derivation (eucc-pp-census §1.4/§2.4): the loader collapses the two CC
 * channels (protection_profiles / resolved keyword token) into `ppRefsResolved`, so the
 * derivable distinction is corpus-level — cc references resolve against the record's own PP
 * evidence (record-resolved), EUCC references only through the keyword alias table
 * (keyword-alias-resolved; no URL/dgst PP channel exists for EUCC).
 */
function ppMembershipRelations(
  r: SecCertsCertRecord,
  ppByDgst: ReadonlyMap<string, SecCertsPpRecord>,
): DesiredRelation[] {
  const channel =
    r.corpus === 'seccerts/cc'
      ? "record-resolved (the certification record's own protection-profile evidence)"
      : 'keyword-alias-resolved (EUCC carries PP references only via keyword extraction — eucc-pp-census §1.4)'
  const out: DesiredRelation[] = []
  for (const ppDgst of r.ppRefsResolved) {
    const pp = ppByDgst.get(ppDgst)
    if (pp === undefined) continue
    const alias = pp.printedAliases[0]
    const relationId = `pp:${r.sourceId}:${ppDgst}`
    const rootRef = {
      corpus: 'seccerts/pp',
      sourceId: ppDgst,
      role: 'product' as const,
      label: pp.name,
    }
    const linkRef = {
      corpus: r.corpus,
      sourceId: r.sourceId,
      role: 'metadata' as const,
      label: r.certId ?? r.sourceId,
    }
    const headline = `${pp.name} ← ${r.certId ?? r.sourceId}: Protection Profile conformity claimed by a mirrored certification record.`
    out.push({
      corpus: r.corpus,
      relationId,
      kind: 'pp-membership',
      rootRef,
      linkRef,
      cls: null,
      fingerprint: fingerprintOf(relationId, null, rootRef.sourceId, linkRef.sourceId, headline),
      facets: ['sec-certs'],
      headline,
      bullets: [
        alias === undefined
          ? `Printed PP id: none derived for ${ppDgst} (no printable scheme id in the alias table).`
          : `Printed PP id: ${alias}.`,
        `PP reference channel: ${channel}.`,
        `Mirrored by scrutiny-mirror from sec-certs snapshot ${r.snapshot} (cert dgst ${r.sourceId}, pp ${ppDgst}); grant of conformity is the upstream record's claim, not the mirror's assessment.`,
      ],
      links: [`PP record page: https://sec-certs.org/pp/${ppDgst}/`],
    })
  }
  return out
}

/**
 * Product ↔ CVE advisory bindings from a record's `cves` (cc/eucc/fips), deduped per
 * product+CVE with direct precedence over transitive (`adv:<productDgst>:<cve>`, §9 Q6).
 */
function advisoryVictimRelations(
  r: { sourceId: string; snapshot: string; cves: readonly CveRelation[] },
  corpus: string,
  productLabel: string,
): DesiredRelation[] {
  const grouped = new Map<string, CveRelation[]>()
  for (const c of r.cves) {
    const list = grouped.get(c.cve)
    if (list === undefined) grouped.set(c.cve, [c])
    else list.push(c)
  }
  const out: DesiredRelation[] = []
  for (const cve of [...grouped.keys()].sort()) {
    const entries = grouped.get(cve)
    if (entries === undefined) continue
    const cls: CveClass = entries.some((e) => e.cls === 'direct')
      ? 'direct'
      : entries.some((e) => e.cls === 'transitive')
        ? 'transitive'
        : 'maintenance'
    const vias = entries
      .flatMap((e) => (e.cls === 'transitive' && e.via !== null ? [e.via] : []))
      .sort()
    const via = vias.length === 0 ? null : (vias[0] ?? null)
    const relationId = `adv:${r.sourceId}:${cve}`
    const rootRef = {
      corpus,
      sourceId: r.sourceId,
      role: 'product' as const,
      label: productLabel,
    }
    const linkRef = {
      corpus: 'seccerts/global',
      sourceId: `cve:${cve}`,
      role: 'advisory' as const,
      label: cve,
    }
    const classBullet =
      cls === 'direct'
        ? `Relation class: direct — ${cve} is listed in the record's own related_cves heuristics (design §9 Q6).`
        : cls === 'transitive'
          ? `Relation class: transitive${
              via === null ? ' (referencing cert not recorded)' : ` via ${via}`
            } — bridged through the sec-certs reference graph.`
          : 'Relation class: maintenance — harvested from maintenance report keyword extraction.'
    const headline = `${productLabel} ← ${cve}: advisory binding (${cls}${
      cls === 'transitive' && via !== null ? ` via ${via}` : ''
    }).`
    out.push({
      corpus,
      relationId,
      kind: 'advisory-victim',
      rootRef,
      linkRef,
      cls,
      fingerprint: fingerprintOf(relationId, cls, rootRef.sourceId, linkRef.sourceId, headline),
      facets: cve === ROCA_CVE ? ['sec-certs', 'roca'] : ['sec-certs'],
      headline,
      bullets: [
        classBullet,
        'CVE mapping is sec-certs-derived (heuristics ~89% precision, arXiv:2311.17603) — an association signal, not a patch list or a vendor confirmation.',
        `Mirrored by scrutiny-mirror from sec-certs snapshot ${r.snapshot}; absence of a binding means no relation recorded in the mirrored source, not verified clean; bindings are assertion-immutable — re-emitted on change, never patched (BD-9).`,
      ],
      links: [`NVD: https://nvd.nist.gov/vuln/detail/${cve}`],
    })
  }
  return out
}

/**
 * Maintenance-harvest advisory bindings (`adv-maint:<updateDgst>:<cve>`): the trigger is the
 * maintenance corpus record (raw PDF keyword extraction, no upstream CVE matching —
 * maintenance-deepdive §4.1), the bound product is the parent cert's TOE Product in cc.
 */
function maintenanceAdvisoryRelations(
  m: SecCertsMaintenanceRecord,
  parentLabel: string,
): DesiredRelation[] {
  const out: DesiredRelation[] = []
  for (const cve of [...m.cves].sort()) {
    const relationId = `adv-maint:${m.sourceId}:${cve}`
    const rootRef = {
      corpus: 'seccerts/cc',
      sourceId: m.parentDgst,
      role: 'product' as const,
      label: parentLabel,
    }
    const linkRef = {
      corpus: 'seccerts/global',
      sourceId: `cve:${cve}`,
      role: 'advisory' as const,
      label: cve,
    }
    const headline = `${parentLabel} ← ${cve}: advisory binding harvested from a maintenance report (maintenance).`
    const links = [`NVD: https://nvd.nist.gov/vuln/detail/${cve}`]
    if (m.reportLink !== null) links.push(`Maintenance report (upstream): ${m.reportLink}`)
    out.push({
      corpus: 'seccerts/maintenance',
      relationId,
      kind: 'advisory-victim',
      rootRef,
      linkRef,
      cls: 'maintenance',
      fingerprint: fingerprintOf(
        relationId,
        'maintenance',
        rootRef.sourceId,
        linkRef.sourceId,
        headline,
      ),
      facets: cve === ROCA_CVE ? ['sec-certs', 'roca'] : ['sec-certs'],
      headline,
      bullets: [
        'Note: harvested from maintenance report keyword extraction (raw text, no upstream CVE matching — maintenance-deepdive §4.1).',
        "Relation class: maintenance — the CVE appears in the maintenance report's extracted vulnerability keywords, not in the parent record's related_cves.",
        `Mirrored by scrutiny-mirror from maintenance snapshot ${m.snapshot} (update ${m.sourceId}); the ledger row lives under seccerts/maintenance while the bound product's root lives in seccerts/cc (update-semantics §3).`,
      ],
      links,
    })
  }
  return out
}

/**
 * Plan every binding of the leg-2 bundle. Deterministic order: per cert record
 * (record → pp-memberships → advisory bindings) for cc, then eucc, then fips records
 * (record → advisory bindings), then maintenance `adv-maint` rows.
 */
export function planRelations(bundle: SecCertsBundle): DesiredRelation[] {
  const ppByDgst = new Map<string, SecCertsPpRecord>()
  for (const pp of bundle.pp) ppByDgst.set(pp.sourceId, pp)
  const ccByDgst = new Map<string, SecCertsCertRecord>()
  for (const r of bundle.cc) ccByDgst.set(r.sourceId, r)

  const out: DesiredRelation[] = []
  for (const r of bundle.cc) {
    out.push(
      recordRelation({
        corpus: r.corpus,
        sourceId: r.sourceId,
        productLabel: r.name,
        metaLabel: r.certId ?? r.sourceId,
        snapshot: r.snapshot,
        edgeSentence:
          'One certification record per TOE Product (design §2.1/§2.10): the metadata is the record, the product is the TOE; products are never merged across certificates.',
      }),
    )
    out.push(...ppMembershipRelations(r, ppByDgst))
    out.push(...advisoryVictimRelations(r, r.corpus, r.name))
  }
  for (const r of bundle.eucc) {
    out.push(
      recordRelation({
        corpus: r.corpus,
        sourceId: r.sourceId,
        productLabel: r.name,
        metaLabel: r.certId ?? r.sourceId,
        snapshot: r.snapshot,
        edgeSentence:
          'One certification record per TOE Product (design §2.1/§2.10): the metadata is the record, the product is the TOE; products are never merged across certificates.',
      }),
    )
    out.push(...ppMembershipRelations(r, ppByDgst))
    out.push(...advisoryVictimRelations(r, r.corpus, r.name))
  }
  for (const r of bundle.fips) {
    const fipsId = `${r.standard}-${r.certId}`
    out.push(
      recordRelation({
        corpus: r.corpus,
        sourceId: r.sourceId,
        productLabel: r.module,
        metaLabel: fipsId,
        snapshot: r.snapshot,
        edgeSentence:
          'One validation record per module Product (design §2.3/§2.10): the metadata is the validation record, the product is the module; products are never merged across validations.',
      }),
    )
    out.push(...advisoryVictimRelations(r, r.corpus, r.module))
  }
  for (const m of bundle.maintenance) {
    out.push(...maintenanceAdvisoryRelations(m, ccByDgst.get(m.parentDgst)?.name ?? m.parentDgst))
  }
  for (const pair of bundle.crosslinks) {
    out.push(...crosslinkRelations(pair, ccByDgst.get(pair.certDgst)))
  }
  return out
}
