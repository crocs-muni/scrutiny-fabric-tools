/**
 * One-shot bootstrap: jcalgtest_results (+ jcalgtest site PNGs) → SCRUTINY Fabric events → relays.
 *
 *   node --experimental-strip-types port.mjs <corpusRoot> <commit>
 *       [--manifest manifest.json] [--relays wss://a,wss://b]
 *       [--out events.ndjson] [--unsigned] [--created-base <epoch>]
 *       [--test] [--key-file mocnpub-keys.txt]
 *
 * Shapes (from the brainstorm rulings, 2026-09-16):
 * - Product per card MODEL(+config variant per ATR-set, e.g. "J3R180 NFC" ≠ "J3R180 USB").
 *   Content carries ONLY model-level invariants — name, ATR set, unit census. Unit facts
 *   (CPLC serial, fab date, reader, provider, run date) live in the run reports.
 * - One run-report Metadata per artifact CSV (support / perf-fixed / perf-variable /
 *   aid-scan), plus CPLC txt for the three bank cards. imeta: commit-pinned raw URL,
 *   m, x (sha256), size, alt — verified honesty per §4.6.
 * - i tags: atr: on products+runs with real ATRs (not 'xx'/'00'-redacted); jca: class.CONSTANT
 *   on support runs; aid: on AID scans.
 * - Bindings edge every run to its model; one "JCAlgTest corpus" pseudo-product anchors the
 *   aggregate report carrying the five site PNGs (imeta image/png, hashed at build time).
 * - created_at = publish time; historical dates in content only (CA-1). Deterministic
 *   (manifest-pinned) → re-running whole thing yields identical ids = relay dedupe.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { buildBinding, buildMetadata, buildProduct } from '@scrutiny-fabric/core/build.js'
import { createStore } from '@scrutiny-fabric/core/store.js'

const RAW = 'https://raw.githubusercontent.com/crocs-muni/jcalgtest_results'
const SITE = 'https://www.fi.muni.cz/~xsvenda/jcalgtest'
const DEFAULT_CREATED_BASE = 1_784_700_000

const SITE_PICS = ['logo.png', 'scheme.png', 'scalability_example.png', 'run_time_example.png', 'numCardsInDB.png']

// ---------------------------------------------------------------- args / io

const argv = process.argv.slice(2)
function die(msg) { console.error(`error: ${msg}`); process.exit(1) }
function opt(name) { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined }
const flag = (name) => argv.includes(name)

const root = argv[0] ?? die('usage: port.mjs <corpusRoot> <commit> [--manifest f] [--relays wss://a,b] [--out f] [--unsigned] [--test] [--key-file f]')
const commit = argv[1] && !argv[1].startsWith('--') ? argv[1] : execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) die('need a pinned full commit sha (branch tips orphan every x hash)')

// ------------------------------------------------------- catalog (walk+hash)

function* walk(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name)
    if (d.isDirectory()) yield* walk(abs)
    else yield abs
  }
}

const sha256File = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex')
const hexOf = (raw) => { const h = (raw ?? '').toLowerCase().replace(/[^0-9a-f]/g, ''); return h || undefined }
const clean = (v) => {
  if (v === undefined) return undefined
  const s = String(v).trim().replace(/^;+|;+$/g, '').trim()
  return s === '' || /insert (your name|link\/description)/i.test(s) ? undefined : s
}
const usableAtr = (h) => h !== undefined && h.length >= 4 && h.length % 2 === 0 && !/^0+$/.test(h) && (h.startsWith('3b') || h.startsWith('3f'))

function classify(rel, name) {
  if (/already_measured\.list$/.test(rel)) return undefined
  if (rel.startsWith('cplc/') && name.endsWith('.txt')) return 'cplc'
  if (!/\.csv(_|\.csv)?$/.test(name)) return undefined
  // tpm/ is a second corpus family in the same pinned repo (advisory catch 2026-09-16 —
  // the javacard-only census silently claimed completeness). Different grammar
  // (TPM_PT_* properties, TPM2_* command blocks, no ATR/CPLC); same run-report skeleton.
  if (rel.startsWith('tpm/profiles/results/')) return 'tpm-support'
  if (rel.startsWith('tpm/profiles/performance/')) return 'tpm-perf'
  if (rel.includes('/Profiles/aid/') || name.includes('AIDSUPPORT')) return 'aid'
  if (rel.includes('/performance/fixed/')) return 'perf-fixed'
  if (rel.includes('/performance/variable/')) return 'perf-variable'
  if (rel.includes('/Profiles/results/') || name.includes('ALGSUPPORT')) return 'support'
  return undefined
}

/** One semicolon-CSV header block → identity facts (works for algsupport/perf/aidscan). */
function headerOf(text) {
  const h = { cplc: {} }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('method name:')) break
    const i = line.indexOf(';')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const val = clean(line.slice(i + 1))
    if (val === undefined) continue
    if (key === 'Card name') h.cardName = val
    else if (key === 'Card ATR') h.atr = hexOf(val)
    else if (key === 'Tested and provided by') h.provider = val
    else if (key === 'Execution date/time') h.executionDate = val
    else if (key === 'AlgTestJClient version') h.client = val
    else if (key === 'AlgTest applet version') h.applet = val
    else if (key === 'Used reader') h.reader = val
    else if (key === 'Used protocol') h.protocol = val
    else if (key === 'JavaCard support version' || key === 'JCSystem.getVersion()[Major.Minor]') h.javaCard ??= val.replace(/;$/, '')
    else if (key === 'JCSystem.MEMORY_TYPE_PERSISTENT') h.memPersistent = val.replace(/;$/, '')
    else if (key === 'JCSystem.MEMORY_TYPE_TRANSIENT_RESET') h.memTransient = val.replace(/;$/, '')
    else if (key.startsWith('CPLC.')) {
      const cells = line.split(';').map((c) => c.trim())
      const hex = hexOf(cells[1])
      if (hex) h.cplc[key.slice(5)] = hex
      if (key === 'CPLC.ICFabricator' && cells[2]) h.fabricator = cells[2]
    }
  }
  return h
}

// Section headers: optional leading whitespace, then the dotted class name, then an
// optional free-text suffix. Perf grammar uses ",,," / ";,;," trailer runs — those must
// NOT confuse the parser; CLASS_RE anchors on the dotted prefix, SUPPORT rows require
// yes/no in cell 2 regardless of separator mixture.
const CLASS_RE = /^\s*javacardx?\.[a-z]+\.[A-Za-z0-9]+/

/** Section suffix ("KeyPair ALG_RSA on-card generation", "Cipher.getInstance(byte…") → bare class. */
function canonicalClass(section) {
  return (section ?? '')
    .trim()
    .replace(/\s+ALG_[A-Z0-9_]+\b.*$/i, '') // "KeyPair ALG_RSA (on-card generation)" → KeyPair
    .replace(/\s+(getInstance|possibly|on-card\s.+)$/i, '')
    .replace(/\.OneShot$/, '')
}

function jcaValue(className, constant) {
  return `jca:${canonicalClass(className)}.${constant}`
}

// jca: TAG POLICY (corpus census 0f031da, user-visible):
//   SKIP only the parametric getInstance/OneShot host sections — combinatorial noise:
//   Signature.getInstance=3864 and Cipher.getInstance=299 distinct corpus-wide; a single
//   run (jCardSim-3.0.5) emits 4317 such tags without this. LEGACY rows ARE kept:
//   legacy Signature (49 distinct: ECDSA-with-digest combos — the headline query
//   "cards supporting ALG_ECDSA_SHA_256"), legacy Cipher (32: AES/DES modes), KeyBuilder
//   (83 distinct matrix) — none of these restate KeyPair data.
//   AEADCipher / InitializedMessageDigest / javacardx.apdu: skipped (parametric-era or
//   structural sections with no legacy form). Everything else stays tagged.
// Emission order below is a DECLARED query priority; if >63+atr tags remain, trailing
// classes are dropped in that order and EVERY drop is printed at build time (visible,
// never silent).
const JCA_PRIORITY = [
  'javacard.security.KeyPair',
  'javacard.security.MessageDigest',
  'javacard.crypto.Signature',
  'javacardx.crypto.Cipher',
  'javacard.security.KeyAgreement',
  'javacard.security.RandomData',
  'javacard.security.Checksum',
  'javacard.security.KeyBuilder',
  'javacard.framework.OwnerPINBuilder',
]
const JCA_SKIP = /^(javacard\.security\.InitializedMessageDigest|javacardx\.crypto\.AEADCipher|javacardx\.apdu\.)/

function supportOf(lines) {
  // canonical class → { legacy: [], parametric: [] } — the ORIGIN is recorded at parse
  // time because parametric getInstance/OneShot host sections are the tag-space noise
  // source (JCA policy above), while content keeps both.
  const supported = {}
  let cls, parametric = false, tested = 0, ok = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (CLASS_RE.test(line)) {
      parametric = /getInstance|OneShot/i.test(line)
      cls = canonicalClass(clean(line.replace(/,/g, ';').split(';')[0]) ?? cls)
      supported[cls] ??= { legacy: [], parametric: [] }
      continue
    }
    if (!cls || (!line.includes(';') && !line.includes(',')) || line.startsWith('algorithm_name')) continue
    const cells = line.replace(/,/g, ';').split(';').map((c) => c.trim())
    const [constant, verdict] = cells
    if (!constant || (verdict !== 'yes' && verdict !== 'no')) continue
    tested++
    if (verdict === 'yes') { ok++; supported[cls][parametric ? 'parametric' : 'legacy'].push(constant) }
  }
  const byClass = {}
  for (const [c, entry] of Object.entries(supported)) {
    const merged = [...entry.legacy, ...entry.parametric]
    if (merged.length > 0) byClass[c] = { ...entry, all: merged }
  }
  return { byClass, tested, ok }
}

function statsRow(line) {
  const nums = line.split(';').map((c) => c.trim()).filter((c) => /^\d+(\.\d+)?$/.test(c)).map(Number)
  return nums.length >= 3 ? { avg: nums[0], min: nums[1], max: nums[2] } : undefined
}

// Corpus-consensus TOP ops — DERIVED FROM jcalgtest_results itself (user ruling: the
// dataset is the authority; top-functions.html is stale and its promised ECC extension
// never landed). Selection rule, applied to the 46 DATAFIXED runs @0f031da: per crypto
// family, the ops measured on the most runs, cutoff ≥ 39% (18/46) coverage — the set
// that makes cross-card comparison meaningful. Family order: RNG, digest, AES, DES3,
// software AES, util, RSA gen, RSA cipher, EC gen/sign/verify, ECDH. `fastest` below
// stays a pure speed ranking — asymmetric ops can never win it; `top` is the
// comparability surface. Positive-only: only measured entries appear per card.
// (Regenerate with the one-liner in README 'how this list was computed'.)
const TOP_FUNCTIONS = [
  'ALG_SECURE_RANDOM RandomData_generateData()',          // 45/46
  'ALG_PSEUDO_RANDOM RandomData_generateData()',          // 41/46
  'ALG_SHA MessageDigest_doFinal()',                      // 46/46
  'ALG_SHA_256 MessageDigest_doFinal()',                  // 40/46
  'TYPE_AES LENGTH_AES_128 ALG_AES_BLOCK_128_CBC_NOPAD Cipher_doFinal()', // 39
  'TYPE_AES LENGTH_AES_256 ALG_AES_BLOCK_128_CBC_NOPAD Cipher_doFinal()', // 39
  'TYPE_AES LENGTH_AES_128 setKey()',                     // 39
  'TYPE_AES LENGTH_AES_256 setKey()',                     // 39
  'TYPE_DES LENGTH_DES3_3KEY ALG_DES_CBC_NOPAD Cipher_doFinal()', // 44
  'SWALGS SWAlgs_AES()',                                  // 42
  'SWALGS SWAlgs_xor()',                                  // 44 (SW baseline reference)
  'UTIL Util_arrayCopyNonAtomic_RAM()',                   // 40
  'UTIL Util_arrayCopyNonAtomic_EEPROM()',                // 40
  'ALG_RSA LENGTH_RSA_1024 KeyPair_genKeyPair()',         // 41
  'ALG_RSA LENGTH_RSA_2048 KeyPair_genKeyPair()',         // 41
  'ALG_RSA_CRT LENGTH_RSA_1024 KeyPair_genKeyPair()',     // 41
  'ALG_RSA_CRT LENGTH_RSA_2048 KeyPair_genKeyPair()',     // 41
  'TYPE_RSA_PRIVATE LENGTH_RSA_1024 ALG_RSA_NOPAD Cipher_doFinal()',      // 34
  'TYPE_RSA_PUBLIC LENGTH_RSA_1024 ALG_RSA_NOPAD Cipher_doFinal()',       // 34
  'TYPE_RSA_PRIVATE LENGTH_RSA_2048 ALG_RSA_NOPAD Cipher_doFinal()',      // 34
  'TYPE_RSA_PUBLIC LENGTH_RSA_2048 ALG_RSA_NOPAD Cipher_doFinal()',       // 34
  'TYPE_RSA_CRT_PRIVATE LENGTH_RSA_1024 ALG_RSA_NOPAD Cipher_doFinal()',  // 35
  'TYPE_RSA_CRT_PUBLIC LENGTH_RSA_1024 ALG_RSA_NOPAD Cipher_doFinal()',   // 34
  'TYPE_RSA_CRT_PRIVATE LENGTH_RSA_2048 ALG_RSA_NOPAD Cipher_doFinal()',  // 34
  'TYPE_RSA_CRT_PUBLIC LENGTH_RSA_2048 ALG_RSA_NOPAD Cipher_doFinal()',   // 34
  'ALG_EC_FP LENGTH_EC_FP_192 KeyPair_genKeyPair()',      // 23
  'ALG_EC_FP LENGTH_EC_FP_256 KeyPair_genKeyPair()',      // 21
  'KeyPair_ALG_EC_FP KeyBuilder_LENGTH_EC_FP_256 ALG_ECDSA_SHA_256 Signature()', // 18 fam
  'ALG_EC_FP LENGTH_EC_FP_256 ALG_EC_SVDP_DH KeyAgreement_generateSecret()', // 19
]

// Perf rows use BOTH separators in the corpus ("atoms;with;semicolons" and "atoms,with,
// commas"); method names contain spaces/parens but never either separator, so a
// separator-normalized parse is safe. `no_such_algorithm + method name:` where the next
// data row says `ALG_X NOT SUPPORTED` is the corpus's notation for unsupported results —
// we ONLY count rows whose stats rows measured real numbers.
function perfOf(lines) {
  const stats = []
  const sections = []
  let method = '', unsupported = 0, totalSeconds
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const flat = line.replace(/,/g, ';')
    if (
      /^[A-Z][A-Z0-9 _&]{2,}\s*[A-Z0-9 _&]*$/.test(line) &&
      !flat.includes(';') &&
      !/NO_SUCH_ALGORITHM|ILLEGAL_VALUE|NOT SUPPORTED|UNSUPPORTED|CANT_BE_MEASURED|^SW_/.test(line) &&
      !line.startsWith('method name:')
    ) {
      if (!line.endsWith('- END') && !sections.includes(line)) sections.push(line)
      continue
    }
    if (flat.startsWith('method name:')) { method = clean(flat.slice(flat.indexOf(';') + 1)) ?? ''; continue }
    if (
      /NO_SUCH_ALGORITHM|CANT_BE_MEASURED|NOT SUPPORTED|ILLEGAL_USE|ALG_NOT_SUPPORTED/i.test(line) &&
      !flat.startsWith('baseline') && !flat.startsWith('operation')
    ) { unsupported++; continue }
    if (flat.startsWith('operation stats')) {
      const s = statsRow(flat)
      if (s && method) stats.push({ method, ...s })
      continue
    }
    const m = /([\d.]+)\s*seconds/.exec(line)
    if (/total test time/i.test(line) && m) totalSeconds = Number(m[1])
  }
  const fastest = [...stats].sort((a, b) => a.avg - b.avg || a.method.localeCompare(b.method)).slice(0, 8)
  const top = TOP_FUNCTIONS.map((m) => stats.find((s) => s.method === m)).filter((s) => s !== undefined)
  // EC op timings (genKeyPair/ECDSA sign-verify/ECDH/getW) — needed for the
  // "fastest ECDSA card" query; these never survive a speed-ranked top-8.
  const ec = stats.filter((s) => /EC_FP|EC_F2M|ECDSA/.test(s.method))
  return { sections, measured: stats.length, unsupported, totalSeconds, fastest, top, ec }
}

// jcAIDScan grammar, three sections with distinct meaning (verified against corpus):
//   PACKAGE AID; MAJOR VERSION; MINOR VERSION; PACKAGE NAME; … — static version map
//   FULL PACKAGE AID; IS SUPPORTED?; …                        — per-AID probe results
//   Applet 1/2/… AID; …                                       — on-card applet tables
// Tag space answers "what is installed": supported full-package AIDs + applet AIDs,
// deduped; the static PACKAGE AID version map is content-only.
function aidScanOf(lines) {
  const packages = []
  const fullPackages = []
  const applets = []
  let section
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^FULL PACKAGE AID/i.test(line)) { section = 'full'; continue }
    if (/^PACKAGE AID/i.test(line)) { section = 'pkg'; continue }
    if (/^Applet\s+\d+\s+AID/i.test(line) || /^APPLET AID/i.test(line)) { section = 'applet'; continue }
    if (/^[A-Z][^;]*;[^;]*;[^;]*;/.test(line) === false && section === 'applet' && /AID/i.test(line)) continue
    if (!section) continue
    const cells = line.split(';').map((c) => c.trim())
    const aid = hexOf(cells[0])
    if (!aid || aid.length < 10) continue
    if (section === 'pkg') packages.push(cells[3] ? { aid, name: cells[3] } : { aid })
    else if (section === 'full') fullPackages.push({ aid, supported: /^y(es)?$/i.test(cells[1] ?? '') })
    else if (!applets.includes(aid)) applets.push(aid)
  }
  return { packages, fullPackages, applets }
}

/** TPM-AlgTest header: Manufacturer/Vendor string/Firmware version/Execution date lines. */
function tpmHeaderOf(text) {
  const h = {}
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(';')
    if (i <= 0) {
      if (/^TPM2_|^Quicktest_/.test(raw.trim())) break
      continue
    }
    const key = raw.slice(0, i).trim()
    const val = clean(raw.slice(i + 1))
    if (val === undefined) continue
    if (key === 'Manufacturer') h.manufacturer = val
    else if (key === 'Vendor string') h.vendor = val
    else if (key === 'Firmware version') h.firmware = val
    else if (key === 'Execution date/time') h.executionDate = val
    else if (key === 'Tested and provided by') h.provider = val
    else if (key === 'Image tag') h.imageTag = val
  }
  return h
}

/**
 * TPM support body → named lists. `Quicktest_algorithms`/`Quicktest_commands` hold raw
 * hex TPM2 IDs (TPMA_ALG / TPM_CC registry values, TCG-canonical); TPM_PT_* property
 * sections are the chip's capability declaration. All positive-only by construction.
 */
function tpmSupportOf(lines) {
  const sections = {}
  let section
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const sec = /^Quicktest_(.+)$/.exec(line)
    if (sec) { section = sec[1]; sections[section] ??= []; continue }
    if (!section) continue
    if (/^(TPM2|TPMA)/.test(line)) {
      const [cmd] = line.split(';').map((c) => c.trim())
      if (cmd) sections[section].push(cmd)
      continue
    }
    if (/^0x[0-9a-fA-F]+$/.test(line)) { sections[section].push(line.toLowerCase()); continue }
    if (line.startsWith('TPM_PT')) {
      const [prop, val] = line.split(';').map((c) => c.trim())
      if (prop && val !== undefined) sections[section].push(`${prop}=${val.replace(/\s+/g, ' ')}`)
    }
  }
  return sections
}

/** TPM perf body → command → per-parameter stats (positive measured rows only). */
function tpmPerfOf(lines) {
  const commands = {}
  let command
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const cmd = /^TPM2_[A-Za-z_]+$/.exec(line)
    if (cmd) { command = line; commands[command] ??= []; continue }
    if (!command || !line.includes(';')) continue
    const [key, rest] = [line.slice(0, line.indexOf(';')).trim(), line.slice(line.indexOf(';') + 1)]
    if (key === 'Key parameters:') { commands[command].push({ params: clean(rest) ?? '' }); continue }
    if (key === 'operation stats (ms/op):') {
      const nums = rest.split(';').map((c) => c.trim()).filter((c) => /^\d+(\.\d+)?$/.test(c)).map(Number)
      const last = commands[command][commands[command].length - 1]
      if (last) last.ms = { avg: nums[0], min: nums[1], max: nums[2] }
    }
  }
  return commands
}

function cplcTxtOf(text) {
  const cplc = {}
  let atr
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^CPLC:\s*/, '')
    const am = /^ATR\s*=\s*(.+)$/.exec(line)
    if (am) { atr = hexOf(am[1]); continue }
    const kv = /^([A-Za-z]+)\s*=\s*([0-9A-Fa-f]+)/.exec(line)
    if (kv) cplc[kv[1]] = kv[2].toLowerCase()
  }
  return { atr, cplc }
}

// ------------------------------------------------------------ catalog build

const createdBase = Number(opt('--created-base') ?? DEFAULT_CREATED_BASE)
const files = []
for (const abs of walk(root)) {
  const rel = path.relative(root, abs).split(path.sep).join('/')
  const kind = classify(rel, path.basename(abs))
  if (!kind) continue
  const text = readFileSync(abs, 'utf8')
  const isTpm = kind.startsWith('tpm-')
  const h = kind === 'cplc' ? { atr: cplcTxtOf(text).atr } : isTpm ? tpmHeaderOf(text) : headerOf(text)
  files.push({
    rel, kind, text,
    sha256: sha256File(abs),
    size: statSync(abs).size,
    // TPM product identity = manufacturer + firmware version (results+perf file pairs
    // share it; vendor string is unreliable — empty in some results files, filled in
    // their perf twins, which would split one product into two).
    cardName: isTpm ? `${h.manufacturer ?? ''} TPM ${h.firmware ?? ''}`.replace(/\s+/g, ' ').trim() : h.cardName,
    atr: h.atr,
    atrOk: usableAtr(h.atr),
    serial: h.cplc?.ICSerialNumber,
    fab: h.cplc?.ICFabricationDate,
    fabricator: h.fabricator,
    tpm: isTpm ? h : undefined,
    header: kind === 'cplc' || isTpm ? undefined : h,
  })
}
files.sort((a, b) => a.rel.localeCompare(b.rel))
console.log(`catalog: ${files.length} artifacts @ ${commit}`)

// --------------------------------------------- model grouping (manifest IO)

const manifestPath = opt('--manifest')
function modelKeyOf(f) {
  const raw = f.cardName ?? path.basename(f.rel)
  const base = raw
    .replace(/\.csv(_|\.csv)?$/i, '').replace(/_+ICFabDat(?:e)?_\d{4}(_\d{3})?/gi, '')
    .replace(/_ALGSUPPORT_*/gi, '').replace(/_AIDSUPPORT.*/i, '').replace(/_PERFORMANCE_.*/i, '')
    .replace(/_\(provided[^)]*\)$/i, '').replace(/_+/g, ' ').trim()
  // ATR-set variant marker keeps interface/config copies (NFC vs USB) distinct.
  return base
}

const groups = new Map()
for (const f of files) {
  const key = modelKeyOf(f)
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(f)
}

let manifest
if (manifestPath) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} else {
  manifest = { commit, createdBase, models: {} }
  let idx = 0
  for (const [name, runs] of [...groups.entries()].sort()) {
    const atrs = [...new Set(runs.filter((r) => r.atrOk).map((r) => r.atr))].sort()
    const serials = [...new Set(runs.map((r) => r.serial).filter(Boolean))]
    manifest.models[name] = { atrs, unitCount: serials.length || runs.length, runs: runs.map((r) => ({ rel: r.rel, kind: r.kind, createdAt: createdBase + ++idx })) }
  }
}
if (flag('--write-manifest') || !manifestPath) {
  mkdirSync('manifest', { recursive: true })
  writeFileSync('manifest/manifest.draft.json', JSON.stringify(manifest, null, 2))
  console.log(`manifest draft → manifest/manifest.draft.json (${Object.keys(manifest.models).length} models) — review, then re-run with --manifest`)
  if (!manifestPath) { console.log('stopping before build until the manifest is reviewed'); process.exit(0) }
}

// ---------------------------------------------------------- event assembly

const unsigned = flag('--unsigned')
const testTags = flag('--test')

// --key-file overrides SCRUTINY_NSEC_HEX. mocnpub format: a line reading
// "Secret key (hex): <64 hex>" (CRLF/extra whitespace tolerated). A present but
// unparseable key file is a loud failure — never silently fall back.
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
if (!unsigned) {
  const hex = secretKeyHex()
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) die('SCRUTINY_NSEC_HEX must hold a 64-char hex secret (or pass --unsigned for a dry run, or --key-file <path>)')
  skBytes = hexToBytes(hex)
  pubkey = bytesToHex(schnorr.getPublicKey(skBytes))
}

// --test: full-mirror quarantine namespace. Every `t`-tag value starting
// `scrutiny-` gains a `-test` suffix (fabric/v0.8.1/product/metadata/binding/patch).
// Applied to the UNSIGNED template inside sign() — sweep covers products, metadata
// and bindings — so ids/sigs are computed over the swapped tags (swap BEFORE id).
// i/k/atr/jc/jca/jcrun/imeta/e tags are untouched.
const testSwap = (tag) =>
  testTags && tag[0] === 't' && typeof tag[1] === 'string' && tag[1].startsWith('scrutiny-') && !tag[1].endsWith('-test')
    ? ['t', `${tag[1]}-test`]
    : tag

// Serialization-consensus scrub (same rule as the sec-certs sibling): C0 control
// chars outside \n\t\r and U+2028/2029 serialize differently across JSON encoders
// (JS literal vs Go escaped) and fork event ids across relay implementations —
// the CSV-era data this port consumes is exactly where such bytes come from.
const UNSAFE_FOR_ID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u2028\u2029]/g
const scrub = (v) => (typeof v === 'string' ? v.replace(UNSAFE_FOR_ID, ' ') : v)

const sign = (template) => {
  const staged0 = testTags ? { ...template, tags: template.tags.map(testSwap) } : template
  const staged = { ...staged0, content: scrub(staged0.content), tags: staged0.tags.map((t) => t.map(scrub)) }
  if (unsigned) return staged
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, staged.created_at, staged.kind, staged.tags, staged.content]))))
  return { ...staged, id, pubkey, sig: bytesToHex(schnorr.sign(hexToBytes(id), skBytes)) }
}

const jblock = (obj) => '\n\n```json\n' + JSON.stringify(obj) + '\n```'
const imetaCsvTag = (f, alt) => ['imeta', `url ${RAW}/${commit}/${f.rel.split('/').map(encodeURIComponent).join('/')}`, 'm text/csv', `x ${f.sha256}`, `size ${f.size}`, `alt ${alt}`]

const events = []
const productIds = {}
const runIds = {}

for (const [name, model] of Object.entries(manifest.models)) {
  const indexers = (model.atrs ?? []).map((a) => `atr:${a}`)
  const isCplcOnly = model.runs.every((r) => r.kind === 'cplc')
  const productContent = isCplcOnly
    ? `${name} — CPLC profile collected with JCAlgTest tooling.` + jblock({ $schema: 'jcalgtest/product@1', model: name, atrs: model.atrs })
    : `${name} — JavaCard smartcard profiled by JCAlgTest (${model.unitCount} unit(s), ${model.runs.length} run artifact(s)).` +
      jblock({ $schema: 'jcalgtest/product@1', model: name, ...(model.atrs?.length ? { atrs: model.atrs } : {}), unitCount: model.unitCount, source: 'https://github.com/crocs-muni/jcalgtest_results' })
  const created = Math.min(...model.runs.map((r) => r.createdAt)) - 1
  const { template } = buildProduct(productContent, created, indexers)
  const signed = sign(template)
  productIds[name] = signed.id ?? '(unsigned)'
  events.push(signed)
}

const earliest = Math.min(...Object.values(manifest.models).flatMap((m) => m.runs.map((r) => r.createdAt)))
const prov = (h) => [h?.client && `client ${h.client}`, h?.applet && `applet ${h.applet}`, h?.reader && `reader ${h.reader}`].filter(Boolean).join(', ')

for (const [name, model] of Object.entries(manifest.models)) {
  for (const run of model.runs) {
    const f = files.find((x) => x.rel === run.rel)
    if (!f) die(`manifest/corpus desync: ${run.rel} not found under ${root}`)
    const lines = f.text.split(/\r?\n/)
    const h = f.header ?? {}
    const indexers = f.atrOk ? [`atr:${f.atr}`] : []
    // jc: platform-version indexer on every run report with a JCSystem version
    // (normalized from corpus debris: "2. 2", "2.2;,", bare "3" — anything that
    // doesn't reduce to digits-and-dots stays content-only). jcrun: marks the run kind
    // so relay fetch of the perf subset is one `{"#i":["jcrun:perf-fixed"]}` filter;
    // intersections (jc range × kind × algorithm) are client-side narrowing by design
    // (NIP-01 same-letter filters are OR-only).
    const jcv = (h.javaCard ?? '').replace(/[^0-9.]/g, '')
    if (/^\d+(\.\d+)+$/.test(jcv)) indexers.push(`jc:${jcv}`)
    indexers.push(`jcrun:${f.kind}`)
    const json = {
      $schema: 'jcalgtest/run-report@1', kind: f.kind, model: name,
      ...(h.executionDate ? { executed: h.executionDate } : {}),
      ...(h.provider ? { provider: h.provider } : {}),
      ...(f.atr ? { atr: f.atr } : {}),
      ...(f.serial ? { cplcSerial: f.serial } : {}),
      ...(f.fab ? { fabDate: f.fab } : {}),
      ...(f.fabricator ? { fabricator: f.fabricator } : {}),
      ...(prov(h) ? { provenance: prov(h) } : {}),
      ...(h.javaCard ? { javaCard: h.javaCard } : {}),
      ...(h.protocol ? { protocol: h.protocol } : {}),
      ...(h.memPersistent ? { memoryPersistent: h.memPersistent } : {}),
      cplc: h.cplc && Object.keys(h.cplc).length > 0 ? h.cplc : undefined,
    }
    let lead = `JCAlgTest ${f.kind} run of ${name}${h.executionDate ? `, executed ${h.executionDate}` : ''}.`
    if (f.kind === 'support') {
      const s = supportOf(lines)
      // Tag emission: legacy sections only (parametric getInstance/OneShot hosts are
      // combinatorial — census: Signature≈3864, Cipher≈299 distinct corpus-wide), minus
      // structural classes (JCA_SKIP), in DECLARED JCA_PRIORITY order. Overflow beyond
      // MD-2's 64 drops the LEAST-queried classes first and prints every drop.
      const classes = Object.keys(s.byClass)
        .filter((c) => !JCA_SKIP.test(c))
        .sort((a, b) => (JCA_PRIORITY.indexOf(a) === -1 ? 99 : JCA_PRIORITY.indexOf(a)) - (JCA_PRIORITY.indexOf(b) === -1 ? 99 : JCA_PRIORITY.indexOf(b)))
      const cap = 64 - (f.atrOk ? 1 : 0)
      let jca = []
      const dropped = []
      for (const cls of classes) {
        for (const c of s.byClass[cls].legacy) {
          if (jca.length < cap) jca.push(jcaValue(cls, c))
          else { if (!dropped.includes(cls)) dropped.push(cls) }
        }
      }
      if (dropped.length > 0) console.log(`  tag-trim @ ${f.rel}: dropped classes ${dropped.join(', ')} (over MD-2 64-cap)`)
      indexers.push(...jca)
      // Positive-only claims (user ruling): counts are about what WAS measured/found;
      // yes-lists only; no "unsupported" field exists anywhere.
      json.support = {
        tested: s.tested,
        ok: s.ok,
        byClass: Object.fromEntries(Object.entries(s.byClass).map(([c, e]) => [c, e.all])),
        ...(Object.values(s.byClass).some((e) => e.parametric.length > 0)
          ? { parametric: Object.fromEntries(Object.entries(s.byClass).filter(([, e]) => e.parametric.length > 0).map(([c, e]) => [c, e.parametric])) }
          : {}),
      }
      if (Buffer.byteLength(JSON.stringify(json.support)) > 40_000) {
        json.support = { tested: s.tested, ok: s.ok, note: 'full matrix in imeta CSV', byClass: Object.fromEntries(Object.entries(s.byClass).slice(0, 8).map(([c, e]) => [c, e.all])) }
      }
    } else if (f.kind === 'perf-fixed' || f.kind === 'perf-variable') {
      const p = perfOf(lines)
      // ECDSA capability as relay-visible tags (jca: canonical constant family) — with
      // jc: above, "fastest ECDSA on JC ≤3.0.5" becomes: relay-filter #i jc:<range> +
      // #i jca:Signature.ALG_ECDSA_*, then LOCAL sort over the ec[] timings (numeric
      // ranking is §8.3 processing, relay is the candidate-fetcher).
      for (const digest of new Set(p.ec.map((t) => /ALG_ECDSA_(SHA[0-9_]*)/.exec(t.method)?.[1]).filter(Boolean))) {
        indexers.push(`jca:javacard.crypto.Signature.ALG_ECDSA_${digest}`)
      }
      // Positive-only claims (user ruling): absence is NEVER asserted. An
      // "unsupported: N" count would claim "this card lacks N things" off one
      // measurement occasion — misleading when contributors/coverage differ.
      json.performance = {
        sections: p.sections,
        measured: p.measured,
        ...(p.totalSeconds ? { totalTestSeconds: p.totalSeconds } : {}),
        top: p.top.map((t) => ({ method: t.method, avgOpMs: t.avg, minOpMs: t.min, maxOpMs: t.max })),
        ec: p.ec.map((t) => ({ method: t.method, avgOpMs: t.avg, minOpMs: t.min, maxOpMs: t.max })),
        fastest: p.fastest.map((t) => ({ method: t.method, avgOpMs: t.avg, minOpMs: t.min, maxOpMs: t.max })),
      }
    } else if (f.kind === 'aid') {
      const a = aidScanOf(lines)
      // MD-2 caps at 64 tags (minus the ATR): supported full-package AIDs first —
      // every applet on a card shares its package's RID basis — then applets within
      // headroom. Deduped: package version rows enumerate the same AID repeatedly.
      // AID GRAMMAR (pinned for the registry issue): FULL PACKAGE AID rows carry
      // version-prefixed probe values (e.g. 0001|07|a0000000620001). The TAG indexes
      // the BARE package AID when the probed value suffix-matches a PACKAGE AID row in
      // the same file — version-independent identity is what "cards hosting package X"
      // means; the version-prefixed probe form stays in content JSON.
      const pkgAids = a.packages.map((p) => p.aid)
      const bareOf = (v) => pkgAids.find((p) => v.length > p.length && v.endsWith(p)) ?? v
      const supported = [...new Set(a.fullPackages.filter((p) => p.supported).map((p) => bareOf(p.aid)))]
      const room = Math.max(0, 63 - supported.length)
      indexers.push(...supported.map((aid) => `aid:${aid}`), ...a.applets.slice(0, room).map((ap) => `aid:${ap}`))
      // Positive-only (user ruling): drop the IS SUPPORTED? no-rows entirely — a probe
      // that returned "no" on one occasion is not evidence a card lacks the package.
      json.aids = { packages: a.packages, fullPackages: a.fullPackages.filter((p) => p.supported), applets: a.applets }
    } else if (f.kind === 'tpm-support') {
      const t = f.tpm ?? {}
      const support = tpmSupportOf(lines)
      lead = `TPM-AlgTest support run of ${name}${t.executionDate ? `, executed ${t.executionDate}` : ''}.`
      json.tpm = {
        ...(t.manufacturer ? { manufacturer: t.manufacturer } : {}),
        ...(t.vendor ? { vendor: t.vendor } : {}),
        ...(t.firmware ? { firmware: t.firmware } : {}),
        sections: support,
      }
    } else if (f.kind === 'tpm-perf') {
      const t = f.tpm ?? {}
      const commands = tpmPerfOf(lines)
      const measured = Object.entries(commands)
        .flatMap(([cmd, rows]) => rows.filter((r) => r.ms !== undefined).map((r) => ({ method: `${cmd}(${r.params})`, avg: r.ms.avg, min: r.ms.min, max: r.ms.max })))
        .sort((a, b) => a.avg - b.avg)
      lead = `TPM-AlgTest performance run of ${name}${t.executionDate ? `, executed ${t.executionDate}` : ''}.`
      json.tpm = {
        ...(t.manufacturer ? { manufacturer: t.manufacturer } : {}),
        ...(t.firmware ? { firmware: t.firmware } : {}),
        commands: Object.keys(commands),
        measured: measured.length,
        fastest: measured.slice(0, 8).map((r) => ({ method: r.method, avgOpMs: r.avg, minOpMs: r.min, maxOpMs: r.max })),
      }
    } else if (f.kind === 'cplc') {
      const { atr, cplc } = cplcTxtOf(f.text)
      lead = `CPLC dump for ${name}, extracted with JCAlgTest tooling.`
      json.cplc = cplc
      if (atr) json.atr = atr
    }
    const { template } = buildMetadata(lead + jblock(Object.fromEntries(Object.entries(json).filter(([, v]) => v !== undefined))), run.createdAt + (run.createdAt - earliest + 1), indexers)
    const signed = sign({ ...template, tags: [...template.tags, f.kind === 'cplc'
      ? ['imeta', `url ${RAW}/${commit}/${f.rel.split('/').map(encodeURIComponent).join('/')}`, 'm text/plain', `x ${f.sha256}`, `size ${f.size}`, `alt CPLC dump for ${name}`]
      : imetaCsvTag(f, `JCAlgTest ${f.kind} raw results for ${name}`)] })
    runIds[f.rel] = signed.id ?? '(unsigned)'
    events.push(signed)

    const binding = buildBinding({ id: productIds[name] }, { id: runIds[f.rel] }, `JCAlgTest ${f.kind} run bound to ${name}.`, run.createdAt * 2 - earliest + 2)
    events.push(sign(binding.template))
  }
}

// ------------------------------------------------------------- ROCA edge
// Query target: "ROCA vuln." — one cve:-indexed vulnerability metadata bound to every
// model with Infineon silicon evidence (CPLC.ICFabricator decoded name). Test-data rule,
// deterministic and stated in the event content; ROCA's true affected set is
// Infineon 2009–2016 firmware, refined by future patch/foreign metadata.
const rocaCreated = Math.max(...events.map((e) => e.created_at)) + 1
const infineonModels = Object.entries(manifest.models)
  .filter(([, m]) => m.runs.some((r) => (files.find((x) => x.rel === r.rel)?.fabricator ?? '').toLowerCase().includes('infineon')))
  .map(([n]) => n)
{
  const roca = buildMetadata(
    'CVE-2017-15361 (ROCA): predictable RSA key generation in Infineon smartcard chips (2009–2016). ' +
      'Bound here to every JCAlgTest-profiled model with Infineon-silicon evidence (CPLC ICFabricator). ' +
      'Dataset rule — inspect CPLC fabrication date before acting on an individual unit.\n\n' +
      '```json\n' + JSON.stringify({
        $schema: 'jcalgtest/vuln@1',
        cve: 'CVE-2017-15361',
        nickname: 'ROCA',
        rule: 'bind iff any bound-model run decodes CPLC.ICFabricator as Infineon',
        upstream: 'https://crocs.fi.muni.cz/public/papers/rsa_ccs17',
      }) + '\n```',
    rocaCreated,
    ['cve:CVE-2017-15361'],
  ).template
  const rocaSigned = sign(roca)
  events.push(rocaSigned)
  for (const [name] of Object.entries(manifest.models).filter(([n]) => infineonModels.includes(n))) {
    if (!productIds[name]) continue
    events.push(sign(buildBinding(
      { id: productIds[name] },
      { id: rocaSigned.id },
      `ROCA evidence edge: ${name} runs on Infineon silicon (CPLC).`,
      rocaCreated + 1,
    ).template))
  }
  console.log(`roca: metadata + ${infineonModels.length} Infineon-silicon bindings`)
}

// ------------------------------------------------------------- aggregate

const pngs = []
for (const name of SITE_PICS) {
  const res = await fetch(`${SITE}/pics/${name}`)
  if (!res.ok) die(`failed to fetch site PNG ${name}: http ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  pngs.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength })
}

const top = Math.max(...events.map((e) => e.created_at)) + 1
const corpusProduct = sign(buildProduct(
  'JCAlgTest corpus — the public JavaCard algorithm-test dataset (cards, runs, comparisons) maintained by CRoCS, bootstrapped into SCRUTINY Fabric.' +
  jblock({ $schema: 'jcalgtest/product@1', model: 'JCAlgTest corpus', synthetic: true, source: 'https://github.com/crocs-muni/jcalgtest_results' }),
  top, []).template)
events.push(corpusProduct)

const aggregate = buildMetadata(
  'JCAlgTest corpus aggregate — cross-card comparison tables and site graphics for the public JCAlgTest dataset (support matrix, performance comparison, similarity table, scalability graphs).\n\n' +
  pngs.map((p) => `![${p.name}](${SITE}/pics/${p.name})`).join('\n') +
  jblock({ $schema: 'jcalgtest/aggregate@1', site: SITE, corpusRepo: 'https://github.com/crocs-muni/jcalgtest_results', attachedImages: pngs.map((p) => p.name) }),
  top + 1, []).template
const aggregateSigned = sign({
  ...aggregate,
  tags: [...aggregate.tags, ...pngs.map((p) => ['imeta', `url ${SITE}/pics/${p.name}`, 'm image/png', `x ${p.sha256}`, `size ${p.size}`, `alt ${p.name.replace('.png', '')}`])],
})
events.push(aggregateSigned)
events.push(sign(buildBinding({ id: corpusProduct.id ?? '0'.repeat(64) }, { id: aggregateSigned.id ?? '0'.repeat(64) }, 'Aggregate report bound to the JCAlgTest corpus.', top + 2).template))

// -------------------------------------------------------- verification

const verifyEvent = (e) => {
  if (unsigned) return true
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))))
  return id === e.id && schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey))
}

if (!unsigned) {
  const store = createStore({ verify: verifyEvent })
  const batch = await store.add(events)
  if (batch.rejected.length + batch.pending.length > 0) {
    for (const r of batch.rejected) console.error(`  rejected: ${r.event.tags.find((t) => t[0] === 't')?.[1]} ${r.event.id?.slice(0, 12)}`)
    die(`${batch.rejected.length + batch.pending.length}/${events.length} events failed admission — nothing written`)
  }
}

const outPath = opt('--out') ?? 'events.ndjson'
const emit = (e) => unsigned ? { kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content } : e
writeFileSync(outPath, events.map((e) => JSON.stringify(emit(e))).join('\n') + '\n')
const TYPE_T_RE = /^scrutiny-(product|metadata|binding|patch)(-test)?$/
const counts = {}
for (const e of events) {
  const t = e.tags.find((x) => x[0] === 't' && TYPE_T_RE.test(x[1]))?.[1] ?? 'unknown'
  counts[t] = (counts[t] ?? 0) + 1
}
console.log(`built: ${events.length} events ${JSON.stringify(counts)} → ${outPath}${unsigned ? ' (UNSIGNED)' : ''}`)

// ------------------------------------------------------------ broadcast

const relays = (opt('--relays') ?? '').split(',').map((r) => r.trim()).filter(Boolean)
if (relays.length === 0) { console.log('no --relays given — dry run complete'); process.exit(0) }
if (unsigned) die('refusing to publish unsigned events')

async function preflight(relay) {
  try {
    const res = await fetch(relay.replace(/^ws(s?):/, 'http$1:'), { headers: { accept: 'application/nostr+json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return `preflight: http ${res.status}`
    const doc = await res.json()
    const pow = doc?.limitation?.min_pow_difficulty
    return pow ? `preflight: ok, min_pow=${pow}` : 'preflight: ok'
  } catch (err) { return `preflight failed: ${err.message}` }
}

async function publish(relay) {
  const ws = new WebSocket(relay)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 15_000)
    ws.onopen = () => { clearTimeout(t); resolve() }
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('websocket error')) }
  })
  const pending = new Map()
  ws.onmessage = (frame) => {
    let msg
    try { msg = JSON.parse(String(frame.data)) } catch { return }
    if (!Array.isArray(msg) || msg[0] !== 'OK') return
    const [, id, accepted, message] = msg
    const settle = pending.get(id)
    if (settle) { pending.delete(id); settle({ id, accepted: accepted === true, message: String(message ?? '') }) }
  }
  const results = []
  for (const e of events) {
    results.push(await new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(e.id); resolve({ id: e.id, accepted: false, message: 'ack timeout' }) }, 15_000)
      pending.set(e.id, (r) => { clearTimeout(t); resolve(r) })
      ws.send(JSON.stringify(['EVENT', e]))
    }))
    await new Promise((r) => setTimeout(r, 25))
  }
  ws.close()
  return results
}

for (const relay of relays) {
  console.log(`→ ${relay} (${await preflight(relay)})`)
  try {
    const results = await publish(relay)
    const ok = results.filter((r) => r.accepted).length
    const dup = results.filter((r) => r.message.startsWith('duplicate')).length
    console.log(`  ${ok} ok, ${dup} duplicate, ${results.length - ok - dup} failed`)
    writeFileSync(`publish-${relay.replace(/[^a-z0-9]/gi, '_')}.json`, JSON.stringify(results, null, 2))
  } catch (err) {
    console.error(`  relay error: ${err.message}`)
  }
}
console.log('done.')
