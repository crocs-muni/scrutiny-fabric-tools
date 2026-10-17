import { isProseAlias, tidyPpToken } from './ppAliases.js'
import type { CertLoadOpts, CertLoadResult } from './seccerts-cc.js'
import { algFamiliesOf, artifactsOf, asRecord, ppKeywordTokens, stringSet } from './seccerts-cc.js'
import {
  compareStrings,
  extractAlgFamilies,
  extractCertCves,
  normalizeDirectRefs,
  normalizeEal,
  readDatasetJson,
  schemeTag,
  sourceHashOf,
  str,
} from './seccerts-common.js'
/**
 * seccerts-eucc.ts — EUCC certificate dataset → `SecCertsCertRecord` projection
 * (ground-truth/eucc-pp-census.md §1; design §2.1/§10.1).
 *
 * The census exceptions this loader implements (verified again on the fresh 2026-10-11 bytes,
 * 109 records):
 *  - `certId` = TOP-LEVEL `cert_id`, verbatim. `heuristics.cert_id` is a lossy normalization
 *    (zero-strips, drops interim markers) and MUST NOT be the source (103/109 differ live);
 *  - `schemeTag` is null on the 15 records with an empty `scheme` (EU-scheme records);
 *    `schemeName` comes from `other_metadata.scheme` ("(UE) 2024/482 - EUCC" on all records);
 *  - PP references ride the keyword alias channel ONLY — EUCC has no `heuristics.
 *    protection_profiles` dgst channel and `protection_profile_links` is empty;
 *  - `maintenance` is always [] (EUCC records carry no maintenance array).
 */
import type { SecCertsCertRecord, SecCertsCorpusDoc } from './seccerts-types.js'

/**
 * EUCC dataset → one `SecCertsCertRecord` per record. Ordering follows the dataset file;
 * records without a `dgst` are skipped defensively (datasets guarantee one).
 */
export function loadEucc(opts: CertLoadOpts): CertLoadResult {
  const dataset = readDatasetJson(opts.dataDir, 'eucc')
  const { snapshot } = dataset

  // dgst → canonical cert id map for the reference graph (same rule as CC: heuristics.cert_id).
  const dgstToCertId = new Map<string, string | null>()
  for (const raw of dataset.docs) {
    const dgst = str(raw['dgst'])
    if (dgst === null) continue
    dgstToCertId.set(dgst, str(asRecord(raw['heuristics'])?.['cert_id']))
  }

  const records: SecCertsCertRecord[] = []
  for (const raw of dataset.docs) {
    const dgst = str(raw['dgst'])
    if (dgst === null) continue
    const heuristics = asRecord(raw['heuristics']) ?? {}
    const refs = normalizeDirectRefs(heuristics, (dgstKey) => dgstToCertId.get(dgstKey) ?? null)

    const resolved = new Set<string>()
    const unresolved = new Set<string>()
    for (const token of ppKeywordTokens(raw['pdf_data'])) {
      const hit = opts.ppResolve(token)
      if (hit !== null && hit.length > 0) {
        resolved.add(hit.toLowerCase())
        continue
      }
      if (isProseAlias(token)) {
        if (opts.diag !== undefined) opts.diag.prosePpTokens += 1
        continue
      }
      const tidied = tidyPpToken(token)
      if (tidied.length > 0) unresolved.add(tidied)
    }

    const algorithms = extractAlgFamilies(raw, 'cc')
    const projection: Omit<SecCertsCertRecord, 'sourceHash' | 'sourceHashKind'> = {
      corpus: 'seccerts/eucc',
      sourceId: dgst,
      name: str(raw['name']) ?? '',
      manufacturerRaw: str(raw['manufacturer']),
      schemeTag: schemeTag(str(raw['scheme'])),
      schemeName: str(asRecord(raw['other_metadata'])?.['scheme']),
      certId: str(raw['cert_id']), // top-level, verbatim — never heuristics.cert_id
      eal: normalizeEal(str(heuristics['eal'])),
      securityLevel: stringSet(raw['security_level']),
      status: str(raw['status']),
      notValidBefore: str(raw['not_valid_before']),
      notValidAfter: str(raw['not_valid_after']),
      category: str(raw['category']),
      certLab: str(heuristics['cert_lab']),
      reportLink: str(raw['report_link']),
      stLink: str(raw['st_link']),
      certLink: str(raw['cert_link']),
      manufacturerWeb: str(raw['manufacturer_web']),
      ppRefsResolved: [...resolved].sort(compareStrings),
      ppRefsUnresolved: [...unresolved].sort(compareStrings),
      directRefs: refs.refs,
      directRefsTruncated: refs.truncated,
      indirectRefs: refs.indirect,
      cves: extractCertCves(heuristics),
      algFamilies: algFamiliesOf(algorithms.families),
      algUnknown: algorithms.unknown,
      cpeMatches: stringSet(heuristics['cpe_matches']),
      maintenance: [], // EUCC records carry no maintenance array (census exception)
      artifacts: artifactsOf(raw['state'], raw),
      snapshot,
    }
    const { hash, kind } = sourceHashOf(raw, projection)
    records.push({ ...projection, sourceHash: hash, sourceHashKind: kind })
  }

  const corpus: SecCertsCorpusDoc = {
    corpus: 'seccerts/eucc',
    label: 'sec-certs EUCC corpus',
    snapshot,
    tool: dataset.tool,
    counts: { eucc: records.length },
    datasetSha256: dataset.datasetSha256,
    datasetUrl: dataset.datasetUrl,
    datasetSizeBytes: dataset.datasetSizeBytes,
  }
  return { records, corpus }
}
