/**
 * One-shot bootstrap: sec-certs.org Common Criteria dataset → SCRUTINY Fabric events.
 *
 *   node --experimental-strip-types port.mjs --dataset <dataset.json>
 *       [--test] [--key-file <path>] [--dry-run] [--limit N] [--out f]
 *
 * Subset (bootstrap #2, test-quarantined):
 *   (category 'ICs, Smart Cards and Smart Card-Related Devices and Systems' AND status
 *   active) UNION (name/keyword PQC-vocabulary hits), then any referenced protection
 *   profiles that are themselves certs in the dataset, plus in-subset reference edges.
 *
 * Full-mirror test tagging: with --test every SCRUTINY t-tag value
 * (scrutiny-fabric/-v0.8.1/-product/-metadata/-binding/-patch) gets a `-test` suffix on
 * the UNSIGNED template before signing — the same rule as the jcalgtest sibling
 * (examples/jcalgtest-port/port.mjs). i/k/imeta/e tags are untouched by construction.
 *
 * Mapping (v0.8.1, v059 semantics from scrutiny-mvp packages/sec-certs-publisher):
 *   Product per cert: i cc:<cert_id> + i cc-dgst:<dgst> + facet indexers (scheme, vendor,
 *     lab, standard, cce, category letter) with matching k tags; content = human sentence
 *     + fenced json block.
 *   Metadata per artifact: certificate PDF, security-target PDF ("target.pdf" on
 *     sec-certs.org), certification-report PDF, maintenance reports — each with a NIP-92
 *     imeta tag (url absolute from the sec-certs.org cert path, m application/pdf,
 *     x sha256 / size only when the dataset exposes them — never invented) + content
 *     sentence; Binding root→cert product, link→metadata (NIP-10 via core builder).
 *   PQC augmentation: one extra Metadata (pqc-analysis) per cert whose name/keywords hit
 *     the PQC vocabulary — no second product.
 *   PP hubs: one Metadata (i pp:<id>, k pp) per protection profile claimed by ≥1 subset
 *     cert + a 1:1 Binding per member cert product (v059 direction: root=member product,
 *     link=PP hub).
 *   Reference edges: in-subset A cites B → one Metadata with dual i cc:<A> i cc:<B>, one
 *     Binding from the citing product, one per resolved target product (v059 semantics).
 *   Reference fields ARE populated on this snapshot (0.4.1.dev): report_references.
 *   directly_referencing on 58.6% of subset certs, st_references on 41.6% — 700 deduped
 *   (fromDgst, toCertId) pairs in-subset, 534 with both endpoints in-subset, 205 targets
 *   out-of-subset, 0 unresolved. PP hubs: 56 profiles claimed by 680 subset certs
 *   (1001 claims). protection_profile_links: Set of PP PDF URLs on 682 subset certs
 *   (1003 links) — emitted as per-cert pp-links metadata events.
 *
 * Deterministic: subset sorted by dgst before build; created_at = fixed base +
 * certIndex * EVENT_SPACING + intra-cert offset; shared events in a clock after the
 * cert band (v059 SHARED_EPOCH_GAP). Stable event ids across runs given the same
 * dataset + key.
 *
 * Nothing is published — no relay I/O at all. --dry-run emits unsigned templates;
 * otherwise signed events are written to <out> only.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { buildBinding, buildMetadata, buildProduct } from '@scrutiny-fabric/core/build.js'
import { createStore } from '@scrutiny-fabric/core/store.js'

const BOOTSTRAP_EPOCH = 1_784_700_000
const EVENT_SPACING = 10
const SHARED_EPOCH_GAP = 1_000_000

const IC_CATEGORY = 'ICs, Smart Cards and Smart Card-Related Devices and Systems'
const PQC_VOCAB = ['kyber', 'dilithium', 'ml-kem', 'ml-dsa', 'crystals', 'post-quantum', 'pqc']
const PQC_RE = /kyber|dilithium|ml-kem|ml-dsa|crystals|post-quantum|pqc/i

// PQC algorithm flag table: first-match-wins over the pq_crypto keyword-group leaves.
// Parameterised rows (512/768/1024, 44/65/87) MUST precede bare-family rows so
// "CRYSTALS-Kyber 768" lands on ml-kem-768, not the family row. Bare "Kyber"/"ML-KEM"
// map to the family flag (deviation, see report). A leaf matching no row is skipped.
// `ids` are full `i`-tag values (prefix `pq:`), `fips` the FIPS-standard labels.
const PQC_FLAG_TABLE = [
  { re: /(?:^|[- ])(?:kyber|ml[-_ ]?kem)[- ]?512$/i, ids: ['pq:ml-kem-512'], fips: ['fips-203'] },
  { re: /(?:^|[- ])(?:kyber|ml[-_ ]?kem)[- ]?768$/i, ids: ['pq:ml-kem-768'], fips: ['fips-203'] },
  { re: /(?:^|[- ])(?:kyber|ml[-_ ]?kem)[- ]?1024$/i, ids: ['pq:ml-kem-1024'], fips: ['fips-203'] },
  { re: /(?:^|[- ])(?:kyber|ml[-_ ]?kem)$/i, ids: ['pq:ml-kem'] },
  { re: /(?:^|[- ])(?:ml[-_ ]?dsa|dilithium)[- ]?44$/i, ids: ['pq:ml-dsa-44'], fips: ['fips-204'] },
  { re: /(?:^|[- ])(?:ml[-_ ]?dsa|dilithium)[- ]?65$/i, ids: ['pq:ml-dsa-65'], fips: ['fips-204'] },
  { re: /(?:^|[- ])(?:ml[-_ ]?dsa|dilithium)[- ]?87$/i, ids: ['pq:ml-dsa-87'], fips: ['fips-204'] },
  { re: /(?:^|[- ])(?:ml[-_ ]?dsa|dilithium)$/i, ids: ['pq:ml-dsa'], fips: ['fips-204'] },
  { re: /(?:^|[- ])(?:slh[- ]?dsa|sphincs[+]?)$/i, ids: ['pq:slh-dsa'], fips: ['fips-205'] },
  { re: /(?:^|[- ])lms$/i, ids: ['pq:lms'] },
  { re: /(?:^|[- ])xmss$/i, ids: ['pq:xmss'] },
  { re: /(?:^|[- ])falcon/i, ids: ['pq:falcon'] },
  { re: /(?:^|[- ])hqc/i, ids: ['pq:hqc'] },
  { re: /(?:^|[- ])frodo/i, ids: ['pq:frodokem'] },
  { re: /crystals[- ]kyber/i, ids: ['pq:kyber-family'] },
  { re: /crystals[- ]dilithium/i, ids: ['pq:dilithium-family'] },
  { re: /(?:^|[- ])ntru$/i, ids: ['pq:ntru'] },
  { re: /(?:^|[- ])rainbow$/i, ids: ['pq:rainbow'] },
]

// Category letter ids per https://sec-certs.org/cc/categories.json (fetched 2026-09-16).
const CATEGORY_LETTER = {
  'Access Control Devices and Systems': 'a',
  'Boundary Protection Devices and Systems': 'b',
  'Data Protection': 'c',
  Databases: 'd',
  'Detection Devices and Systems': 'e',
  'ICs, Smart Cards and Smart Card-Related Devices and Systems': 'f',
  'Key Management Systems': 'g',
  Mobility: 'h',
  'Multi-Function Devices': 'i',
  'Network and Network-Related Devices and Systems': 'j',
  'Operating Systems': 'k',
  'Other Devices and Systems': 'l',
  'Products for Digital Signatures': 'm',
  'Trusted Computing': 'o',
  'Biometric Systems and Devices': 'p',
}

// ---------------------------------------------------------------- args / io

const argv = process.argv.slice(2)
function die(msg) { console.error(`error: ${msg}`); process.exit(1) }
function opt(name) { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined }
const flag = (name) => argv.includes(name)

const datasetPath = opt('--dataset') ?? die('usage: port.mjs --dataset <dataset.json> [--test] [--key-file <path>] [--dry-run] [--limit N] [--out f]')
const dryRun = flag('--dry-run')
const testTags = flag('--test')
const limitRaw = opt('--limit')
const limitN = limitRaw !== undefined ? Number(limitRaw) : undefined
if (limitRaw !== undefined && (!Number.isInteger(limitN) || limitN <= 0)) die('--limit must be a positive integer')
const outPath = opt('--out') ?? 'events.ndjson'

// ---------------------------------------------------------- key + signature

// --key-file overrides SCRUTINY_NSEC_HEX. mocnpub key-file format: a line reading
// "Secret key (hex): <64 hex>" (CRLF/extra whitespace tolerated). A present but
// unparseable key file is a loud failure — never silently fall back. Identical to the
// jcalgtest sibling; the key is read on demand, never hardcoded, never sent anywhere
// (there is no relay path in this file).
function secretKeyHex() {
  const keyFile = opt('--key-file')
  if (keyFile !== undefined) {
    const text = readFileSync(keyFile, 'utf8')
    const m = /^Secret key \(hex\):\s*([0-9a-fA-F]{64})\s*$/im.exec(text)
    if (m) return m[1]
    die(`--key-file ${keyFile}: no "Secret key (hex): <64 hex>" line found`)
  }
  return process.env.SCRUTINY_NSEC_HEX
}

let skBytes, pubkey
if (!dryRun) {
  const hex = secretKeyHex()
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) die('provide a 64-hex secret via --key-file <path> or SCRUTINY_NSEC_HEX (or --dry-run for an unsigned dry run)')
  skBytes = hexToBytes(hex)
  pubkey = bytesToHex(schnorr.getPublicKey(skBytes))
}

// Full-mirror test tagging — identical rule to the jcalgtest sibling: every SCRUTINY
// `t`-tag value gets a `-test` suffix on the unsigned template, before id computation.
// Only ['t', v] tags with v.startsWith('scrutiny-') are matched: i/k/imeta/e untouched.
const testSwap = (tag) =>
  testTags && tag[0] === 't' && typeof tag[1] === 'string' && tag[1].startsWith('scrutiny-') && !tag[1].endsWith('-test')
    ? ['t', `${tag[1]}-test`]
    : tag

// Serialization-consensus scrub: JS and Go JSON encoders disagree on C0 control chars
// outside \n\t\r (and on U+2028/2029) — the same string hashes to different event ids
// across implementations (nak verify caught 5 such events: STX junk from PDF-extracted
// text). Those characters would be rejected by Go-canonical relays, so they are
// replaced with a space everywhere they can enter the id preimage (content + tag
// strings), applied here at the one choke point every event passes through.
const UNSAFE_FOR_ID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u2028\u2029]/g
const scrub = (v) => (typeof v === 'string' ? v.replace(UNSAFE_FOR_ID, ' ') : v)

const sign = (template) => {
  const staged0 = testTags ? { ...template, tags: template.tags.map(testSwap) } : template
  const staged = { ...staged0, content: scrub(staged0.content), tags: staged0.tags.map((t) => t.map(scrub)) }
  if (dryRun) return staged
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, staged.created_at, staged.kind, staged.tags, staged.content]))))
  return { ...staged, id, pubkey, sig: bytesToHex(schnorr.sign(hexToBytes(id), skBytes)) }
}

// ------------------------------------------------------------ dataset + subset

const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'))
const allCerts = dataset.certs
const byDgst = new Map(allCerts.map((c) => [c.dgst, c]))

const setElems = (o) => (o && Array.isArray(o.elements) ? o.elements : [])

// Text scanned for PQC vocabulary: name, manufacturer, keyword dicts, PDF frontpage
// text, and heuristic text fields (extracted_versions, cpe strings, cves, scheme data).
// Identical rule to the census in this session so the counts agree.
const pqcText = (c) => {
  const bits = [c.name ?? '', c.manufacturer ?? '']
  const pd = c.pdf_data ?? {}
  for (const k of ['report_keywords', 'st_keywords', 'cert_keywords', 'report_frontpage', 'st_frontpage', 'cert_frontpage']) {
    if (pd[k] != null) bits.push(JSON.stringify(pd[k]))
  }
  const h = c.heuristics ?? {}
  for (const k of ['extracted_versions', 'cpe_matches', 'verified_cpe_matches', 'related_cves', 'scheme_data']) {
    if (h[k] != null) bits.push(JSON.stringify(h[k]))
  }
  return bits.join('\n')
}

const pqcMatches = (c) => {
  const text = pqcText(c).toLowerCase()
  return PQC_VOCAB.filter((t) => text.includes(t))
}

const icActive = allCerts.filter((c) => c.category === IC_CATEGORY && c.status === 'active')
const pqcHitCerts = allCerts.filter((c) => PQC_RE.test(pqcText(c)))

const subset = new Map()
for (const c of icActive) subset.set(c.dgst, c)
for (const c of pqcHitCerts) subset.set(c.dgst, c)
// referenced protection profiles that are themselves certs in the dataset
for (const c of [...subset.values()]) {
  for (const pp of setElems(c.heuristics?.protection_profiles)) {
    if (pp && byDgst.has(pp) && !subset.has(pp)) subset.set(pp, byDgst.get(pp))
  }
}
let subsetCerts = [...subset.values()].sort((a, b) => a.dgst.localeCompare(b.dgst))
if (limitN !== undefined) subsetCerts = subsetCerts.slice(0, limitN)

// ------------------------------------------------------------- facet source

/** Top-level group keys of a keyword dictionary, merged across report/ST/cert keywords. */
const keywordGroups = (c, key) => {
  const g = new Set()
  for (const src of ['report_keywords', 'st_keywords', 'cert_keywords']) {
    const kd = c.pdf_data?.[src]?.[key]
    if (kd && typeof kd === 'object') {
      for (const k of Object.keys(kd)) {
        const v = String(k).trim()
        if (v.length > 0) g.add(v)
      }
    }
  }
  return [...g]
}

/** Deepest primitive-valued keys of a nested keyword dict ({A:{B:{C:1}}} → [C]), trimmed, non-empty. */
const leafKeys = (obj) => {
  const out = new Set()
  const walk = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v !== null && typeof v === 'object') {
        if (Object.keys(v).length > 0) walk(v)
      } else {
        const t = String(k).trim()
        if (t.length > 0) out.add(t)
      }
    }
  }
  if (obj && typeof obj === 'object') walk(obj)
  return [...out]
}

/** Union of one keyword group's deepest leaves across report/ST/cert dicts, sorted. */
const mergedLeafKeys = (c, group) => {
  const s = new Set()
  for (const src of ['report_keywords', 'st_keywords', 'cert_keywords']) {
    const g = c.pdf_data?.[src]?.[group]
    if (g && typeof g === 'object') for (const l of leafKeys(g)) s.add(l)
  }
  return [...s].sort((a, b) => a.localeCompare(b))
}

const CRYPTO_GROUPS = ['symmetric_crypto', 'asymmetric_crypto', 'hash_function', 'cipher_mode', 'randomness', 'ecc_curve', 'crypto_protocol', 'crypto_scheme', 'crypto_library']
const KEYWORD_SRC = ['report_keywords', 'st_keywords', 'cert_keywords']

/** group → leaf → summed presence counts across the three dicts, only groups with data. */
function cryptoSummary(c) {
  const out = {}
  for (const group of CRYPTO_GROUPS) {
    const tally = new Map()
    for (const src of KEYWORD_SRC) {
      const g = c.pdf_data?.[src]?.[group]
      if (!g || typeof g !== 'object') continue
      const walk = (o) => {
        for (const [k, v] of Object.entries(o)) {
          if (v !== null && typeof v === 'object') {
            if (Object.keys(v).length > 0) walk(v)
          } else if (typeof v === 'number') tally.set(k, (tally.get(k) ?? 0) + v)
        }
      }
      walk(g)
    }
    if (tally.size > 0) {
      out[group] = Object.fromEntries([...tally.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    }
  }
  return out
}

/** CPLD data: presence-only leaves under ICVersion/ICFab/ICType → version/fabricator/type. */
const CPLC_TOP = { ICVersion: 'version', ICFab: 'fabricator', ICType: 'type' }
function cplcSummary(c) {
  const out = {}
  for (const src of KEYWORD_SRC) {
    const g = c.pdf_data?.[src]?.['cplc_data']
    if (!g || typeof g !== 'object') continue
    for (const [top, field] of Object.entries(CPLC_TOP)) {
      const sub = g[top]
      if (sub && typeof sub === 'object') {
        const labels = leafKeys(sub).sort()
        if (labels.length > 0) out[field] = labels[0]
      }
    }
  }
  return out
}

/** report_frontpage: normalize `. <scheme>` dicts to the four string fields, first populated scheme. */
const FRONTPAGE_FIELDS = ['cert_id', 'cert_item', 'developer', 'cert_lab']
function frontpageBlock(c) {
  const fp = c.pdf_data?.report_frontpage
  if (!fp || typeof fp !== 'object') return null
  for (const scheme of Object.keys(fp).sort()) {
    const s = fp[scheme]
    if (!s || typeof s !== 'object') continue
    const row = Object.fromEntries(FRONTPAGE_FIELDS.map((f) => [f, s[f] != null ? s[f] : null]))
    if (FRONTPAGE_FIELDS.some((f) => row[f] != null && String(row[f]).trim() !== '')) return { scheme, ...row }
  }
  return null
}

const STATE_FIELDS = ['download_ok', 'convert_ok', 'extract_ok', 'source_hash', 'txt_hash', 'json_hash']
function stateBlock(c) {
  const out = {}
  for (const kind of ['report', 'st', 'cert']) {
    const s = c.state?.[kind]
    if (!s || typeof s !== 'object') continue
    const row = {}
    for (const f of STATE_FIELDS) if (f in s) row[f] = s[f]
    if (Object.keys(row).length > 0) out[kind] = row
  }
  return Object.keys(out).length > 0 ? out : null
}

const pdfName = (c, key) => {
  const v = c.pdf_data?.[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

const schemeDataBlock = (c) => {
  const sd = c.heuristics?.scheme_data
  if (!sd || typeof sd !== 'object' || Object.keys(sd).length === 0) return null
  return sd
}

const PDF_HYPERLINK_CAP = 20

/** per-kind sorted hyperlink lists (capped) + full per-kind counts. Source is a Set of URL strings. */
function pdfHyperlinks(c) {
  const list = {}
  const counts = {}
  for (const slot of ARTIFACT_SLOTS) {
    const links = setElems(c.pdf_data?.[slot.pdfKey]?.pdf_hyperlinks).slice().sort((a, b) => a.localeCompare(b))
    counts[slot.kind] = links.length
    list[slot.kind] = links.slice(0, PDF_HYPERLINK_CAP)
  }
  return { list, counts }
}

/** Full merged CVE list: heuristics.related_cves ∪ vulnerability keyword-group leaves, sorted dedup. */
function cveList(c) {
  const s = new Set()
  for (const v of setElems(c.heuristics?.related_cves)) if (v) s.add(v)
  for (const l of mergedLeafKeys(c, 'vulnerability')) s.add(l)
  return [...s].sort((a, b) => a.localeCompare(b))
}

const CVE_INDEXER_CAP = 64

/** cc_protection_profile_id scheme→leaf pairs as literal "<scheme>-<leaf>". */
const ppIdLeaves = (c) => {
  const out = new Set()
  for (const src of KEYWORD_SRC) {
    const g = c.pdf_data?.[src]?.['cc_protection_profile_id']
    if (!g || typeof g !== 'object') continue
    for (const [scheme, ids] of Object.entries(g)) {
      if (!ids || typeof ids !== 'object') continue
      for (const l of leafKeys(ids)) out.add(`${scheme}-${l}`)
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

/** javacard_version leaves → gp:/jc: version indexers (first dotted version, global→gp else java/jc→jc). */
function jcGpIndexers(c) {
  const out = new Set()
  for (const l of mergedLeafKeys(c, 'javacard_version')) {
    const m = /(\d+(?:\.\d+){1,2})/.exec(l)
    const low = l.toLowerCase()
    if (!m) continue
    if (low.includes('global')) out.add(`gp:${m[1]}`)
    else if (low.includes('java') || low.startsWith('jc')) out.add(`jc:${m[1]}`)
  }
  return [...out].sort()
}

/** PQC flags on one cert: sorted deduped `pq:` indexers + FIPS labels from the flag table. */
const pqFlags = (c) => {
  const ids = new Set()
  const fips = new Set()
  for (const leaf of mergedLeafKeys(c, 'pq_crypto')) {
    for (const row of PQC_FLAG_TABLE) {
      if (row.re.test(leaf)) {
        for (const id of row.ids) ids.add(id)
        for (const f of row.fips ?? []) fips.add(f)
        break
      }
    }
  }
  return { ids: [...ids].sort(), fips: [...fips].sort() }
}

/** Facet indexers from keyword leaves + heuristics (SAR, crypto, SCA, icdg, os, jc/gp, tee, tr, sfr, claim, pp-name, cpe, cve). */
function facetIndexers(c) {
  const ix = []
  for (const sar of setElems(c.heuristics?.extracted_sars)) {
    if (sar && typeof sar === 'object' && sar.family != null && sar.level != null) ix.push(`sar:${sar.family}.${sar.level}`)
  }
  for (const group of CRYPTO_GROUPS) for (const l of mergedLeafKeys(c, group)) ix.push(`crypto:${l}`)
  for (const l of mergedLeafKeys(c, 'side_channel_analysis')) ix.push(`sca:${l}`)
  for (const l of mergedLeafKeys(c, 'ic_data_group')) ix.push(`icdg:${l}`)
  for (const l of mergedLeafKeys(c, 'os_name')) ix.push(`os:${l.toLowerCase()}`)
  for (const l of mergedLeafKeys(c, 'tee_name')) ix.push(`tee:${l}`)
  for (const l of mergedLeafKeys(c, 'technical_report_id')) ix.push(`tr:${l}`)
  for (const l of mergedLeafKeys(c, 'cc_sfr')) ix.push(`sfr:${l}`)
  for (const l of mergedLeafKeys(c, 'cc_claims')) ix.push(`claim:${l}`)
  for (const l of ppIdLeaves(c)) ix.push(`pp-name:${l}`)
  for (const v of jcGpIndexers(c)) ix.push(v)
  for (const v of setElems(c.heuristics?.cpe_matches)) {
    if (/^cpe:2\.3:[ho]:/i.test(v)) ix.push(`cpe:${v}`)
  }
  for (const v of cveList(c).slice(0, CVE_INDEXER_CAP)) ix.push(`cve:${v}`)
  return [...new Set(ix)].sort((a, b) => a.localeCompare(b))
}

/** Facet `i`-tags for cheap #i filtering. Sorted after assembly for deterministic order. */
function productIndexers(c) {
  const h = c.heuristics ?? {}
  const certId = certIdOf(c)
  const ix = [`cc:${certId}`, `cc-dgst:${c.dgst}`]
  if (c.scheme) ix.push(`scheme:${c.scheme}`)
  if (c.manufacturer) ix.push(`vendor:${c.manufacturer}`)
  const labs = new Set([...keywordGroups(c, 'eval_facility'), ...(h.cert_lab ? [String(h.cert_lab)] : [])])
  for (const l of [...labs].sort()) ix.push(`lab:${l}`)
  for (const s of keywordGroups(c, 'standard_id').sort()) ix.push(`standard:${s}`)
  for (const v of setElems(h.extracted_versions).sort()) ix.push(`cce:${v}`)
  const letter = CATEGORY_LETTER[c.category]
  if (letter) ix.push(`category:${letter}`)
  for (const f of facetIndexers(c)) ix.push(f)
  return ix
}

const certIdOf = (c) => {
  const h = c.heuristics ?? {}
  return typeof h.cert_id === 'string' && h.cert_id.length > 0 ? h.cert_id : c.dgst
}

// distinct hits of the PQC vocabulary on one cert (for the pqc-analysis event)
const pqKeywordGroups = (c) => {
  const tabs = []
  for (const src of ['report_keywords', 'st_keywords', 'cert_keywords']) {
    const kd = c.pdf_data?.[src]?.pq_crypto
    if (kd && typeof kd === 'object' && Object.keys(kd).length > 0) tabs.push({ src: src.replace('_keywords', ''), groups: kd })
  }
  return tabs
}

// ---------------------------------------------------------------- content

const jblock = (obj) => '\n\n```json\n' + JSON.stringify(obj) + '\n```'
const certPage = (dgst) => `https://sec-certs.org/cc/${dgst}/`
const artifactUrl = (dgst, page) => `https://sec-certs.org/cc/${dgst}/${page}`
const bindingContent = (rootId, linkId, prose) => `SCRUTINY Binding: ${rootId} ↔ ${linkId}\n${prose}`

const ARTIFACT_SLOTS = [
  { kind: 'cert', page: 'cert.pdf', alt: 'Certificate (PDF)', stateKey: 'cert', pdfKey: 'cert_metadata', linkKey: 'cert_link' },
  { kind: 'report', page: 'report.pdf', alt: 'Certification report (PDF)', stateKey: 'report', pdfKey: 'report_metadata', linkKey: 'report_link' },
  { kind: 'st', page: 'target.pdf', alt: 'Security target (PDF)', stateKey: 'st', pdfKey: 'st_metadata', linkKey: 'st_link' },
]

function productContent(c) {
  const h = c.heuristics ?? {}
  const eal = h.eal ?? null
  const cat = c.category ?? null
  const hyp = pdfHyperlinks(c)
  return (
    `${c.name} — ${cat ?? 'Common Criteria'} certificate under the ${c.scheme ?? '?'} scheme (${c.status ?? '?'}${eal ? `, EAL ${eal}` : ''}); ${c.manufacturer ? `claimant ${c.manufacturer}; ` : ''}valid ${c.not_valid_before ?? '?'}–${c.not_valid_after ?? '?'}.` +
    jblock({
      $schema: 'sec-certs/product@1',
      dgst: c.dgst,
      cert_id: certIdOf(c),
      name: c.name,
      scheme: c.scheme ?? null,
      category: cat,
      category_letter: CATEGORY_LETTER[cat] ?? null,
      status: c.status ?? null,
      eal,
      assurance: setElems(c.security_level).sort(),
      crypto: cryptoSummary(c),
      cplc: cplcSummary(c),
      cce_versions: setElems(h.extracted_versions),
      pp_links: ppLinks(c),
      frontpage: frontpageBlock(c),
      state: stateBlock(c),
      scheme_data: schemeDataBlock(c),
      filenames: {
        report: pdfName(c, 'report_filename'),
        st: pdfName(c, 'st_filename'),
        cert: pdfName(c, 'cert_filename'),
      },
      pdf_hyperlinks: hyp.list,
      pdf_hyperlink_counts: hyp.counts,
      cves: cveList(c),
      not_valid_before: c.not_valid_before ?? null,
      not_valid_after: c.not_valid_after ?? null,
      manufacturer: c.manufacturer ?? null,
      manufacturer_web: c.manufacturer_web ?? null,
      cert_link: c.cert_link ?? null,
      st_link: c.st_link ?? null,
      report_link: c.report_link ?? null,
      sec_certs_page: certPage(c.dgst),
      dataset: { sec_certs_version: dataset.state.sec_certs_version, timestamp: dataset.timestamp },
    })
  )
}

function artifactContent(c, slot, url, hash, size) {
  const pages = c.pdf_data?.[slot.pdfKey]?.pdf_number_of_pages
  return (
    `${slot.alt.replace(' (PDF)', '')} for ${c.name} (${certIdOf(c)}).` +
    jblock({
      $schema: `sec-certs/${slot.kind}@1`,
      dgst: c.dgst,
      cert_id: certIdOf(c),
      name: c.name,
      kind: slot.kind,
      url,
      origin_link: c[slot.linkKey] ?? null,
      ...(hash ? { sha256: hash } : {}),
      ...(size !== undefined ? { size_bytes: size } : {}),
      ...(pages != null ? { pages } : {}),
    })
  )
}

function pqcAnalysisContent(c, matches, tabs) {
  const h = c.heuristics ?? {}
  const fl = pqFlags(c)
  return (
    `PQC keyword hits on ${c.name} (${certIdOf(c)}): ${matches.join(', ')}.` +
    jblock({
      $schema: 'sec-certs/pqc-analysis@1',
      dgst: c.dgst,
      cert_id: certIdOf(c),
      name: c.name,
      vocabulary: PQC_VOCAB,
      matched_vocabulary: matches,
      pq_crypto_keyword_groups: tabs,
      flags: fl.ids.map((id) => id.replace(/^pq:/, '')),
      fips: fl.fips,
      eal: h.eal ?? null,
      cce_versions: setElems(h.extracted_versions),
    })
  )
}

function maintenanceContent(c, m, idx) {
  return (
    `Maintenance report for ${c.name} (${certIdOf(c)})${m.maintenance_date ? `, dated ${m.maintenance_date}` : ''}.` +
    jblock({
      $schema: 'sec-certs/maintenance_report@1',
      dgst: c.dgst,
      cert_id: certIdOf(c),
      name: c.name,
      index: idx,
      title: m.maintenance_title ?? null,
      date: m.maintenance_date ?? null,
      report_link: m.maintenance_report_link ?? null,
      st_link: m.maintenance_st_link ?? null,
    })
  )
}

/** protection_profile_links is a top-level Set of PP PDF URLs (deduped, sorted). */
const ppLinks = (c) => [...new Set(setElems(c.protection_profile_links))].sort((a, b) => a.localeCompare(b))

const ppLinksContent = (c) => {
  const links = ppLinks(c).map((url) => ({ url, filename: url.split('/').filter(Boolean).pop() ?? null }))
  return (
    `Protection profile links for ${c.name} (${certIdOf(c)}): ${links.length} PP PDF(s) referenced.` +
    jblock({
      $schema: 'sec-certs/pp-links@1',
      dgst: c.dgst,
      cert_id: certIdOf(c),
      name: c.name,
      links,
    })
  )
}

const ppHubContent = (ppId, memberCerts) =>
  `Protection profile hub — ${memberCerts.length} certificate(s) in this subset claim PP ${ppId}: ${memberCerts.map((m) => m.certId).join(', ')}.` +
  jblock({
    $schema: 'sec-certs/pp-hub@1',
    pp: ppId,
    members: memberCerts.map((m) => ({ dgst: m.dgst, cert_id: m.certId, name: m.name })),
  })

const referenceContent = (fromCertId, toCertId) =>
  `Reference edge — ${fromCertId} cites ${toCertId}.` +
  jblock({ $schema: 'sec-certs/reference@1', from: fromCertId, to: toCertId })

// ---------------------------------------------------------------- assembly

const events = []
const pushEvent = (t) => { events.push(sign(t)) }
const createdFor = (ci, offset = 0) => BOOTSTRAP_EPOCH + ci * EVENT_SPACING + offset

subsetCerts.forEach((c, ci) => {
  let offset = 0

  const productSigned = sign(buildProduct(productContent(c), createdFor(ci, offset++), productIndexers(c)).template)
  events.push(productSigned)
  const productId = productSigned.id ?? '(unsigned)'

  const addMetadataAndBinding = (kind, content, imeta, prose, extraIndexers = [], extraImeta = []) => {
    let mt = buildMetadata(content, createdFor(ci, offset++), [`cc:${certIdOf(c)}`, `cc-dgst:${c.dgst}`, ...extraIndexers]).template
    const extra = []
    if (imeta) extra.push(imeta)
    for (const ei of extraImeta) extra.push(ei)
    if (extra.length > 0) mt = { ...mt, tags: [...mt.tags, ...extra] }
    const mdSigned = sign(mt)
    events.push(mdSigned)
    const mdId = mdSigned.id ?? '(unsigned)'
    pushEvent(buildBinding({ id: productId }, { id: mdId }, bindingContent(productId, mdId, prose), createdFor(ci, offset++)).template)
  }

  // artifact metadata: cert / report / st PDFs
  for (const slot of ARTIFACT_SLOTS) {
    const link = c[slot.linkKey]
    const hash = c.state?.[slot.stateKey]?.source_hash ?? null
    if (!link && !hash) continue
    const size = c.pdf_data?.[slot.pdfKey]?.pdf_file_size_bytes ?? undefined
    const url = artifactUrl(c.dgst, slot.page)
    const imeta = ['imeta', `url ${url}`, 'm application/pdf', `alt ${slot.alt}`]
    if (hash) imeta.push(`x ${hash}`)
    if (size !== undefined) imeta.push(`size ${size}`)
    addMetadataAndBinding(slot.kind, artifactContent(c, slot, url, hash, size), imeta, `${slot.alt.toLowerCase()} for ${certIdOf(c)}.`)
  }

  // maintenance updates
  setElems(c.maintenance_updates).forEach((m, mi) => {
    const imeta = m.maintenance_report_link ? ['imeta', `url ${m.maintenance_report_link}`, 'm application/pdf', 'alt Maintenance report (PDF)'] : null
    const extraImeta = m.maintenance_st_link ? [['imeta', `url ${m.maintenance_st_link}`, 'm application/pdf', 'alt Security target (PDF)']] : []
    addMetadataAndBinding('maintenance', maintenanceContent(c, m, mi), imeta, `maintenance report metadata for ${certIdOf(c)}.`, [], extraImeta)
  })

  // one PQC-analysis metadata per cert with vocabulary hits (no second product)
  const matches = pqcMatches(c)
  if (matches.length > 0) addMetadataAndBinding('pqc', pqcAnalysisContent(c, matches, pqKeywordGroups(c)), null, `pqc-analysis metadata for ${certIdOf(c)}.`, pqFlags(c).ids)

  // one pp-links metadata per cert with referenced PP PDFs (no second product, no binding to the PPs)
  if (ppLinks(c).length > 0) addMetadataAndBinding('pp-links', ppLinksContent(c), null, `pp-links metadata for ${certIdOf(c)}.`)
})

// ------------------------------------------------------------- shared block

// Gap after the per-cert band so shared nodes (PP hubs, reference edges) never collide
// with per-cert events (v059 SHARED_EPOCH_GAP semantics).
let clock = BOOTSTRAP_EPOCH + subsetCerts.length * EVENT_SPACING + SHARED_EPOCH_GAP

const certIdToCerts = new Map()
for (const c of subsetCerts) {
  const cid = certIdOf(c)
  if (!certIdToCerts.has(cid)) certIdToCerts.set(cid, [])
  certIdToCerts.get(cid).push(c)
}

// PP hubs: one metadata per referenced PP + a 1:1 binding per claiming member product.
const ppMembers = new Map() // ppId -> Map(dgst -> cert)
for (const c of subsetCerts) {
  for (const pp of setElems(c.heuristics?.protection_profiles)) {
    if (!pp) continue
    if (!ppMembers.has(pp)) ppMembers.set(pp, new Map())
    ppMembers.get(pp).set(c.dgst, c)
  }
}
for (const ppId of [...ppMembers.keys()].sort()) {
  const members = [...ppMembers.get(ppId).values()].sort((a, b) => a.dgst.localeCompare(b.dgst)).map((c) => ({ dgst: c.dgst, certId: certIdOf(c), name: c.name }))
  const hubSigned = sign(buildMetadata(ppHubContent(ppId, members), clock++, [`pp:${ppId}`]).template)
  events.push(hubSigned)
  const hubId = hubSigned.id ?? '(unsigned)'
  const prose = `pp hub ${ppId}.`
  for (const m of members) {
    const memberEvent = events.find((e) => e.tags.some((t) => t[0] === 't' && /^scrutiny-product(-test)?$/.test(t[1])) && e.tags.some((t) => t[0] === 'i' && t[1] === `cc-dgst:${m.dgst}`))
    const memberId = memberEvent?.id ?? null
    if (!memberId) continue
    pushEvent(buildBinding({ id: memberId }, { id: hubId }, bindingContent(memberId, hubId, prose), clock++).template)
  }
}

// Reference edges: subset certs citing other subset certs (report/st directly_referencing).
const edges = [] // {fromDgst, fromCertId, toCertId}
for (const c of subsetCerts) {
  const h = c.heuristics ?? {}
  const fromCertId = certIdOf(c)
  const seen = new Set()
  for (const k of ['report_references', 'st_references']) {
    const rr = h[k]
    const list = setElems(rr?.directly_referencing)
    for (const to of list) {
      if (!to || to === fromCertId || seen.has(to)) continue
      seen.add(to)
      edges.push({ fromDgst: c.dgst, fromCertId, toCertId: to })
    }
  }
}
edges.sort((a, b) => a.fromDgst.localeCompare(b.fromDgst) || a.toCertId.localeCompare(b.toCertId))

const productIdByDgst = new Map()
for (const c of subsetCerts) {
  const pid = events.find((e) => e.tags.some((t) => t[0] === 't' && /^scrutiny-product(-test)?$/.test(t[1])) && e.tags.some((t) => t[0] === 'i' && t[1] === `cc-dgst:${c.dgst}`))?.id
  if (pid) productIdByDgst.set(c.dgst, pid)
}

for (const edge of edges) {
  const fromProductId = productIdByDgst.get(edge.fromDgst)
  if (!fromProductId) continue
  const metaSigned = sign(buildMetadata(referenceContent(edge.fromCertId, edge.toCertId), clock++, [`cc:${edge.fromCertId}`, `cc:${edge.toCertId}`]).template)
  events.push(metaSigned)
  const metaId = metaSigned.id ?? '(unsigned)'
  const prose = `reference ${edge.fromCertId} → ${edge.toCertId}.`
  pushEvent(buildBinding({ id: fromProductId }, { id: metaId }, bindingContent(fromProductId, metaId, prose), clock++).template)
  for (const toCert of [...(certIdToCerts.get(edge.toCertId) ?? [])].sort((a, b) => a.dgst.localeCompare(b.dgst))) {
    const toProductId = productIdByDgst.get(toCert.dgst)
    if (toProductId) pushEvent(buildBinding({ id: toProductId }, { id: metaId }, bindingContent(toProductId, metaId, prose), clock++).template)
  }
}

// ------------------------------------------------------------verification

const verifyEvent = (e) => {
  if (dryRun) return true
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))))
  return id === e.id && schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey))
}

if (!dryRun) {
  const store = createStore({ verify: verifyEvent })
  const batch = await store.add(events)
  if (batch.rejected.length + batch.pending.length > 0) {
    for (const r of batch.rejected) console.error(`  rejected: ${r.event.tags.find((t) => t[0] === 't')?.[1]} ${r.event.id?.slice(0, 12)}`)
    die(`${batch.rejected.length + batch.pending.length}/${events.length} events failed admission — nothing written`)
  }
}

// ------------------------------------------------------------- emit + report

const emit = (e) => (dryRun ? { kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content } : e)
writeFileSync(outPath, events.map((e) => JSON.stringify(emit(e))).join('\n') + '\n')

// counts — exact-type t-tag filter tolerant of the -test mirror (RetagJc's fixed rule).
const counts = {}
for (const e of events) {
  const t = e.tags.find((x) => x[0] === 't' && /^scrutiny-(product|metadata|binding|patch)(-test)?$/.test(x[1]))?.[1] ?? 'unknown'
  counts[t] = (counts[t] ?? 0) + 1
}

// t-tag census across every event
const tTagCensus = new Map()
for (const e of events) {
  for (const t of e.tags.filter((tg) => tg[0] === 't').map((tg) => tg[1])) tTagCensus.set(t, (tTagCensus.get(t) ?? 0) + 1)
}

const maxContent = Math.max(...events.map((e) => utf8ToBytes(e.content).length))
const maxEvent = Math.max(...events.map((e) => utf8ToBytes(JSON.stringify(emit(e))).length))

// biggest serialised product event: cc cert id, byte size, i-tag count, distinct-k count.
let biggest = null
for (const e of events) {
  if (!e.tags.some((t) => t[0] === 't' && /^scrutiny-product(-test)?$/.test(t[1]))) continue
  const size = utf8ToBytes(JSON.stringify(emit(e))).length
  const ccId = e.tags.find((t) => t[0] === 'i' && t[1].startsWith('cc:') && !t[1].startsWith('cc-dgst:'))?.[1] ?? '?'
  const iCount = e.tags.filter((t) => t[0] === 'i').length
  const kCount = new Set(e.tags.filter((t) => t[0] === 'k').map((t) => t[1])).size
  if (!biggest || size > biggest.size) biggest = { size, ccId: ccId.slice(3), iCount, kCount }
}
const sample = (keys, pred) => events.find((e) => keys.some((k) => e.tags.some((t) => t[0] === 't' && pred(k, t[1]))))
const findFirst = (pred) => events.find(pred)
const productSample = findFirst((e) => e.tags.some((t) => t[0] === 't' && /^scrutiny-product(-test)?$/.test(t[1])))
const artifactSample = findFirst((e) => e.tags.some((t) => t[0] === 'imeta'))
const ppHubSample = findFirst((e) => e.tags.some((t) => t[0] === 'i' && t[1].startsWith('pp:')))
const refSample = findFirst((e) => e.tags.filter((t) => t[0] === 'i' && t[1].startsWith('cc:')).length >= 2)
const bindingSample = findFirst((e) => e.tags.some((t) => t[0] === 'e' && t[3] === 'root'))

const printEvent = (label, e) => {
  console.log(`\n--- ${label} ---`)
  if (!e) { console.log('(none produced)'); return }
  console.log(JSON.stringify(emit(e), null, 2))
}

const ppRefCount = new Set([...ppMembers.keys()])
const ppInDataset = [...ppRefCount].filter((id) => byDgst.has(id)).length

console.log('=== sec-certs port — SCRUTINY Fabric bootstrap (no relay publishing) ===')
console.log(`dataset: ${datasetPath}`)
console.log(`dataset version: sec_certs_version=${dataset.state.sec_certs_version}  timestamp=${dataset.timestamp}  n_certs=${dataset.n_certs} actual=${allCerts.length}`)
console.log(`subset: (a) IC-category-active=${icActive.length}  (b) PQC-keyword=${pqcHitCerts.length}  (c) union=${new Set([...icActive, ...pqcHitCerts].map((c) => c.dgst)).size}  (d) referenced-PPs-in-dataset=${ppInDataset} (referenced-PPs-total=${ppRefCount.size})`)
console.log(`built subset (${subsetCerts.length} cert(s)${limitN !== undefined ? ` after --limit ${limitN}` : ''}) → ${events.length} events`)
console.log(`per-type counts: ${JSON.stringify(counts)}`)
console.log(`t-tag census: ${JSON.stringify(Object.fromEntries([...tTagCensus.entries()].sort((a, b) => a[0].localeCompare(b[0]))))}`)
console.log(`max content bytes: ${maxContent}   max serialised event bytes: ${maxEvent}  (limits: content < 65536, signed event ~< ${65536 + 285})`)
console.log(`biggest product event: cc ${biggest?.ccId}  ${biggest?.size} bytes  ${biggest?.iCount} i-tags  ${biggest?.kCount} distinct k-tags`)

printEvent('sample: product', productSample)
printEvent('sample: artifact metadata w/ imeta', artifactSample)
printEvent('sample: PP hub', ppHubSample)
printEvent('sample: reference edge', refSample)
printEvent('sample: binding', bindingSample)

console.log(`\nwrote ${events.length} events → ${outPath}${dryRun ? ' (DRY RUN, unsigned)' : ''}`)
