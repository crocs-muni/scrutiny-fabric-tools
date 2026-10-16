import { buildPpAliasTable } from './ppAliases.js'
import { readDatasetJson, schemeTag, sourceHashOf, str } from './seccerts-common.js'
/**
 * seccerts-pp.ts — Protection Profile dataset → SecCertsPpRecord (design §2.2,
 * ground-truth/eucc-pp-census §2.1–§2.2 record schema).
 *
 * PP records carry EMPTY heuristics (census §2.1); everything comes from web_data.*
 * (name, version, scheme, status, not_valid_*, pp_link/report_link) plus scheme_metadata
 * (NIAP/US short names) plus the alias table's derived printed ids. `vendorRaw` stays null:
 * the PP dataset has no author/sponsor name field (the IR's "when present"; never fabricated).
 */
import type { SecCertsCorpusDoc, SecCertsPpRecord } from './seccerts-types.js'

/** `state.pp` is the PP document itself — hash it first, then the companion report artifact. */
const PP_JSON_HASH_ORDER = ['pp', 'report'] as const

export function loadPp(opts: { dataDir: string }): {
  records: SecCertsPpRecord[]
  aliasDocs: Record<string, unknown>[]
  corpus: SecCertsCorpusDoc
} {
  const ds = readDatasetJson(opts.dataDir, 'pp')
  const { printedAliases } = buildPpAliasTable(ds.docs)

  const records: SecCertsPpRecord[] = []
  for (const doc of ds.docs) {
    const dgst = str(doc['dgst'])
    if (dgst === null) continue
    const web = (doc['web_data'] as Record<string, unknown> | null) ?? {}
    const name = str(web['name'])
    if (name === null) continue
    const link = str(web['pp_link']) ?? str(web['report_link'])
    const host = link === null ? null : /^https?:\/\/([^/]+)/iu.exec(link)?.[1]
    const projection: Omit<SecCertsPpRecord, 'sourceHash' | 'sourceHashKind'> = {
      corpus: 'seccerts/pp',
      sourceId: dgst,
      name,
      version: str(web['version']),
      schemeTag: schemeTag(web['scheme']),
      schemeName: str(web['scheme']),
      vendorRaw: null,
      status: str(web['status']),
      printedAliases: printedAliases.get(dgst) ?? [],
      link,
      source: host?.replace(/^www\./iu, '') ?? 'sec-certs.org',
      snapshot: ds.snapshot,
    }
    const { hash, kind } = sourceHashOf(doc, projection, PP_JSON_HASH_ORDER)
    records.push({ ...projection, sourceHash: hash, sourceHashKind: kind })
  }

  return {
    records,
    aliasDocs: ds.docs,
    corpus: {
      corpus: 'seccerts/pp',
      label: 'sec-certs Protection Profile corpus',
      snapshot: ds.snapshot,
      tool: ds.tool,
      counts: { pp: records.length },
      datasetSha256: ds.datasetSha256,
      datasetUrl: ds.datasetUrl,
      datasetSizeBytes: ds.datasetSizeBytes,
    },
  }
}
