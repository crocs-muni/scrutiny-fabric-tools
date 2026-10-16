import {
  cveIdsFromVulnerabilityKeywords,
  readDatasetJson,
  sourceHashOf,
  str,
} from './seccerts-common.js'
/**
 * maintenance.ts — CC maintenance-update dataset → `SecCertsMaintenanceRecord`
 * (ground-truth/maintenance-deepdive.md §1.1/§4.1).
 *
 * The maintenance file holds the 882 doc-bearing updates whose report/ST PDFs were downloaded
 * and extracted; it carries NO heuristics (all null — `certs_analyzed=false`). Its only
 * mirror-relevant payload beyond the parent 4-tuple is the raw keyword extraction, and the
 * one fact the parent record does not have is the harvested CVE list (deepdive §4.1: 51
 * records / 1,289 mentions on the old bytes; 0 overlap with parent-side CVEs).
 *
 * Live-verified shapes (fresh 2026-10-11 bytes, 882 records):
 *  - `dgst` = `cert_<parent16hex>_update_<16hex>`; `related_cert_digest` = the parent dgst;
 *  - `pdf_data.*_keywords.vulnerability` = `{"CVE":{"CVE-…":count}}` (report side mostly);
 *  - `state.report.json_hash` on 878, `state.st.json_hash` on 879, `state.cert` never —
 *    `sourceHashOf` resolves the precedence and falls back to the normalized bytes.
 *
 * CVE-empty records are kept: the maintenance row is a ledger relation trigger, not a
 * CVE-only carrier (update-semantics.md §3).
 */
import type { SecCertsMaintenanceRecord } from './seccerts-types.js'

export interface MaintenanceLoadResult {
  records: SecCertsMaintenanceRecord[]
}

/**
 * Maintenance dataset → one record per update. Ordering follows the dataset file; records
 * without a `dgst` are skipped defensively.
 */
export function loadMaintenance(opts: { dataDir: string }): MaintenanceLoadResult {
  const dataset = readDatasetJson(opts.dataDir, 'maintenance')
  const { snapshot } = dataset

  const records: SecCertsMaintenanceRecord[] = []
  for (const raw of dataset.docs) {
    const dgst = str(raw['dgst'])
    if (dgst === null) continue
    const cves = new Set<string>()
    for (const cve of cveIdsFromVulnerabilityKeywords(raw['pdf_data'])) {
      if (cve.length > 0) cves.add(cve)
    }
    const projection: Omit<SecCertsMaintenanceRecord, 'sourceHash' | 'sourceHashKind'> = {
      corpus: 'seccerts/maintenance',
      sourceId: dgst,
      parentDgst: str(raw['related_cert_digest']) ?? '', // present on 100% of records
      date: str(raw['maintenance_date']),
      name: str(raw['name']),
      reportLink: str(raw['report_link']),
      stLink: str(raw['st_link']),
      cves: [...cves].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      snapshot,
    }
    const { hash, kind } = sourceHashOf(raw, projection)
    records.push({ ...projection, sourceHash: hash, sourceHashKind: kind })
  }
  return { records }
}
