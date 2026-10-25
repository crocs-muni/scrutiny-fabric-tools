import { algFamiliesOf, asRecord } from './seccerts-cc.js'
import {
  extractAlgFamilies,
  extractCertCves,
  normalizeCavpRefs,
  readDatasetJson,
  sourceHashOf,
  str,
  unwrapSet,
} from './seccerts-common.js'
/**
 * seccerts-fips.ts — FIPS 140 validation dataset → `SecCertsFipsRecord` projection
 * (design §1.2/§2.3/§10.3).
 *
 * Live-verified shapes of the fresh 2026-10-11 `fips_dataset.json` (5,533 records):
 *  - `cert_id` is the TOP-LEVEL numeric id (verified: `web_data.cert_id` is null on every
 *    record) — `standard` comes from `web_data.standard` ∈ {FIPS 140-1, FIPS 140-2, FIPS 140-3};
 *  - `web_data.validation_history` entries are `{date, validation_type, lab}` objects, in file
 *    order; `hw_/fw_/sw_versions` are `;`-joined strings (or null), never arrays;
 *  - `state.policy.source_hash` exists on 5,532/5,533 records; `state.module` never carries a
 *    hash. The policy PDF URL is NOT stored on the record — it is reconstructed from sec-certs'
 *    frozen `FIPS_SP_URL` template (src/sec_certs/constants.py) for exactly the file
 *    `state.policy` hashes, and stays null when no upstream hash exists (imeta-pinnable only);
 *  - CAVP strings in `pdf_data.module_algorithms` glue an algorithm name to its certificate
 *    number (`AES-CBCA7673`, `SHS#A954`, `Triple-DES#773`); `policy_algorithms` holds bare
 *    `#A2518` refs that carry NO name — those are skipped for `cavp:` refs (nothing to name).
 *    Normalization (token family-mapping + number form) is the shared `normalizeCavpRefs`
 *    from `seccerts-common.ts` — one CAVP rule for the whole package.
 */
import type { SecCertsCorpusDoc, SecCertsFipsRecord } from './seccerts-types.js'

export interface FipsLoadResult {
  records: SecCertsFipsRecord[]
  corpus: SecCertsCorpusDoc
}

/** sec-certs `FIPS_SP_URL` (src/sec_certs/constants.py) — the policy PDF the record hashes. */
const FIPS_SP_URL =
  'https://csrc.nist.gov/CSRC/media/projects/cryptographic-module-validation-program/documents/security-policies/140sp{}.pdf'

/** FIPS `state` slots that carry `json_hash` (policy first; `module` is download-only live). */
const FIPS_JSON_HASH_ORDER: readonly string[] = ['policy', 'module', 'cert']

/** FIPS `cert_id` is numeric in the live data (and may be absent); other fields are strings. */
function certIdText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value)
}

/** `cavp:` refs from both algorithm fields, deduped + sorted by the shared normalization. */
function cavpRefs(pdfData: unknown): string[] {
  const pdf = asRecord(pdfData)
  if (pdf === null) return []
  const elements: string[] = []
  for (const field of ['module_algorithms', 'policy_algorithms']) {
    for (const element of unwrapSet(pdf[field])) {
      if (typeof element === 'string') elements.push(element)
    }
  }
  return normalizeCavpRefs(elements)
}

/** `;`-joined version string → list (single versions stay one entry; "N/A" is verbatim). */
function versionList(value: unknown): string[] {
  const raw = str(value)
  if (raw === null) return []
  const out: string[] = []
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/**
 * FIPS dataset → one `SecCertsFipsRecord` per validation record. Ordering follows the dataset
 * file; records without a `dgst` are skipped defensively.
 */
export function loadFips(opts: { dataDir: string }): FipsLoadResult {
  const dataset = readDatasetJson(opts.dataDir, 'fips')
  const { snapshot } = dataset

  // cert number → standard ("140-2"), for standard-qualified cross-references.
  const standardById = new Map<string, string>()
  for (const raw of dataset.docs) {
    const id = certIdText(raw['cert_id'])
    const standard = str(asRecord(raw['web_data'])?.['standard'])
    if (id === null || standard === null) continue
    standardById.set(id, standard.replace(/^FIPS\s+/u, '').trim())
  }

  const records: SecCertsFipsRecord[] = []
  for (const raw of dataset.docs) {
    const dgst = str(raw['dgst'])
    if (dgst === null) continue
    const web = asRecord(raw['web_data']) ?? {}
    const heuristics = asRecord(raw['heuristics']) ?? {}
    const certId = certIdText(raw['cert_id']) ?? ''
    const status = str(web['status'])
    const standard = (str(web['standard']) ?? '').replace(/^FIPS\s+/u, '').trim()

    const validations: Array<[string, string]> = []
    let certLab: string | null = null
    for (const element of unwrapSet(web['validation_history'])) {
      const entry = asRecord(element)
      if (entry === null) continue
      const date = str(entry['date'])
      const label = str(entry['validation_type'])
      if (date !== null && label !== null) validations.push([date, label])
      const lab = str(entry['lab'])
      if (lab !== null) certLab = lab // last entry wins — the latest validation body
    }

    const directRefs = new Set<string>()
    const refNumbers = asRecord(heuristics['module_processed_references'])?.['directly_referencing']
    for (const element of unwrapSet(refNumbers)) {
      const number = str(element)
      if (number === null) continue
      const refStandard = standardById.get(number)
      // A ref outside the loaded dataset cannot be standard-qualified without guessing its
      // generation — skip it (0 live occurrences on the fresh bytes).
      if (refStandard === undefined) continue
      directRefs.add(`fips:${refStandard}-${number}`)
    }

    const policyHash = str(asRecord(asRecord(raw['state'])?.['policy'])?.['source_hash'])
    const algorithms = extractAlgFamilies(raw, 'fips')
    const projection: Omit<SecCertsFipsRecord, 'sourceHash' | 'sourceHashKind'> = {
      corpus: 'seccerts/fips',
      sourceId: dgst,
      certId,
      standard,
      module: str(web['module_name']) ?? '',
      vendorRaw: str(web['vendor']),
      status,
      statusReason:
        status === 'revoked'
          ? str(web['revoked_reason'])
          : status === 'historical'
            ? str(web['historical_reason'])
            : null,
      level: typeof web['level'] === 'number' ? web['level'] : null,
      moduleType: str(web['module_type']),
      embodiment: str(web['embodiment']),
      hwVersions: versionList(web['hw_versions']),
      fwVersions: versionList(web['fw_versions']),
      swVersions: versionList(web['sw_versions']),
      validations,
      cavpRefs: cavpRefs(raw['pdf_data']),
      algFamilies: algFamiliesOf(algorithms.families),
      algUnknown: algorithms.unknown,
      cves: extractCertCves(heuristics),
      directRefs: [...directRefs],
      certificatePdfUrl: str(web['certificate_pdf_url']),
      policy: {
        url: policyHash !== null && certId.length > 0 ? FIPS_SP_URL.replace('{}', certId) : null,
        sha256: policyHash,
        sizeBytes: null, // DocumentState has no size field (verified 2026-10-11)
      },
      certLab,
      snapshot,
    }
    const { hash, kind } = sourceHashOf(raw, projection, FIPS_JSON_HASH_ORDER)
    records.push({ ...projection, sourceHash: hash, sourceHashKind: kind })
  }

  const corpus: SecCertsCorpusDoc = {
    corpus: 'seccerts/fips',
    label: 'sec-certs FIPS corpus',
    snapshot,
    tool: dataset.tool,
    counts: { fips: records.length },
    datasetSha256: dataset.datasetSha256,
    datasetUrl: dataset.datasetUrl,
    datasetSizeBytes: dataset.datasetSizeBytes,
  }
  return { records, corpus }
}
