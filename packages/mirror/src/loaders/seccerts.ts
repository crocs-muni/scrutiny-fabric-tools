import { loadMaintenance } from './maintenance.js'
import { buildPpAliasTable, isProseAlias } from './ppAliases.js'
import { loadCc } from './seccerts-cc.js'
import { loadEucc } from './seccerts-eucc.js'
import { loadFips } from './seccerts-fips.js'
import { loadPp } from './seccerts-pp.js'
import { loadCrosslinks } from './seccerts-crosslinks.js'
/**
 * seccerts.ts — sec-certs bundle assembly (design §2.10 order; update-semantics.md §3/§5).
 *
 * One call loads the whole leg-2 corpus set in the frozen cross-corpus order:
 * **pp → cc → eucc → fips → maintenance** — the PP alias table must exist before cc/eucc
 * membership resolution, and maintenance is last (its relations bind TOEs whose roots live
 * in cc). `corp` carries the four corpus docs that own an emitted corpus Product + snapshot
 * (cc, eucc, pp, fips); maintenance is a ledger namespace only — it emits no corpus doc
 * (update-semantics.md §3).
 *
 * `groundTruthDir` is part of the pipeline signature (emit/gate consume it); the loaders
 * themselves read only `dataDir`. `warnings` are derived from the loaded records themselves —
 * real counts, never placeholders.
 */
import type { SecCertsBundle } from './seccerts-types.js'

/** Load every sec-certs corpus into one bundle (single pass per dataset file). */
export function loadSeccerts(opts: { dataDir: string; groundTruthDir: string }): SecCertsBundle {
  const { dataDir } = opts
  const warnings: string[] = []

  const pp = loadPp({ dataDir })
  const aliasTable = buildPpAliasTable(pp.aliasDocs)
  const diag = { prosePpTokens: 0 }
  const cc = loadCc({ dataDir, ppResolve: aliasTable.resolve, isProse: isProseAlias, diag })
  const eucc = loadEucc({ dataDir, ppResolve: aliasTable.resolve, isProse: isProseAlias, diag })
  const fips = loadFips({ dataDir })
  const maintenance = loadMaintenance({ dataDir })
  const { pairs: crosslinks, warnings: crosslinkWarnings } = loadCrosslinks({
    groundTruthDir: opts.groundTruthDir,
  })
  warnings.push(...crosslinkWarnings)

  const certRecords = [...cc.records, ...eucc.records]

  let ppResolved = 0
  let ppUnresolved = 0
  let ppUnresolvedRecords = 0
  for (const record of certRecords) {
    ppResolved += record.ppRefsResolved.length
    ppUnresolved += record.ppRefsUnresolved.length
    if (record.ppRefsUnresolved.length > 0) ppUnresolvedRecords += 1
  }

  let cveDirect = 0
  let cveTransitive = 0
  let cveMaintenance = 0
  const distinctCves = new Set<string>()
  for (const record of [...certRecords, ...fips.records]) {
    for (const relation of record.cves) {
      distinctCves.add(relation.cve)
      if (relation.cls === 'direct') cveDirect += 1
      else if (relation.cls === 'transitive') cveTransitive += 1
      else cveMaintenance += 1
    }
  }
  for (const record of maintenance.records) {
    for (const cve of record.cves) {
      distinctCves.add(cve)
      cveMaintenance += 1
    }
  }

  const certIdCounts: Record<string, number> = {}
  for (const record of certRecords) {
    if (record.certId === null) certIdCounts[record.corpus] = (certIdCounts[record.corpus] ?? 0) + 1
  }
  for (const [corpus, count] of Object.entries(certIdCounts)) {
    warnings.push(
      `${corpus}: ${count} records carry no printed cert id — no ${corpus === 'seccerts/cc' ? 'cc' : 'eucc'}: i tag`,
    )
  }
  if (ppUnresolvedRecords > 0) {
    warnings.push(
      `seccerts: ${ppUnresolvedRecords} certificate records carry unresolved PP references (${ppUnresolved} tag-only pp: values)`,
    )
  }
  if (diag.prosePpTokens > 0) {
    warnings.push(
      `seccerts: ${diag.prosePpTokens} PP keyword references are prose aliases — skipped, no pp: tag`,
    )
  }
  if (pp.records.length > 0 && aliasTable.stats.keys === 0) {
    warnings.push(
      'seccerts/pp: alias table built no keys — every PP keyword token stays unresolved',
    )
  }
  const oddStandards = fips.records.filter((record) => !/^140-[123]$/u.test(record.standard))
  if (oddStandards.length > 0) {
    warnings.push(
      `seccerts/fips: ${oddStandards.length} records carry an unexpected FIPS standard value`,
    )
  }
  const ccIds = new Set(cc.records.map((record) => record.sourceId))
  const orphanUpdates = maintenance.records.filter((record) => !ccIds.has(record.parentDgst))
  if (orphanUpdates.length > 0) {
    warnings.push(
      `seccerts/maintenance: ${orphanUpdates.length} updates reference a parent outside the cc dataset`,
    )
  }

  return {
    cc: cc.records,
    eucc: eucc.records,
    pp: pp.records,
    fips: fips.records,
    maintenance: maintenance.records,
    crosslinks,
    corp: [cc.corpus, eucc.corpus, pp.corpus, fips.corpus],
    warnings,
    stats: {
      ppResolved,
      ppUnresolved,
      ppUnresolvableProse: diag.prosePpTokens,
      cveDirect,
      cveTransitive,
      cveMaintenance,
      distinctCves: distinctCves.size,
    },
  }
}
