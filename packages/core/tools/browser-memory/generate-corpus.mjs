#!/usr/bin/env node
/**
 * Browser-memory investigation (issue #30, hazard #4) — corpus generator.
 *
 * Maps the real sec-certs corpus (`investigations/sec-certs-mapping/data/main-dataset.json`,
 * 6,737 certs) to a full SCRUTINY event corpus following
 * `investigations/sec-certs-mapping/REPORT.md`'s mapping table, at spec v0.8.0 shape (BD-3:
 * binding root endpoint is a product; BD-4: link endpoint is a metadata).
 *
 * Output: `investigations/browser-memory/events-full.json` — one JSON array of NostrEvent-shaped
 * objects, PP hub products first, then cert-major ordering, so any prefix slice is
 * referentially closed at cert granularity below the cut. Deterministic: event ids, pubkeys,
 * and sigs derive from sha256 of semantic keys, so re-runs produce byte-identical output.
 *
 * Also prints per-type counts, cumulative event counts per cert (for size-point selection), and
 * Product content-byte quantiles (expected median ≈ 287 B per AUDIT-2026-07-31 §4 — a fidelity
 * check on the generator).
 *
 * Usage:
 *   node --max-old-space-size=4096 tools/browser-memory/generate-corpus.mjs
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_TYPE_TAGS, FABRIC_TAG, SCRUTINY_KIND, VERSION_TAG } from '../../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')
const DATA = resolve(repo, 'investigations/sec-certs-mapping/data/main-dataset.json')
const OUT_DIR = resolve(repo, 'investigations/browser-memory')
const OUT = resolve(OUT_DIR, 'events-full.json')

const hex = (key) => createHash('sha256').update(key).digest('hex')
const IMPORTER_PK = hex('bm:importer-pubkey')
const BASE_TS = 1785542400 // 2026-08-01T00:00:00Z — recent, CA-1-safe
const els = (set) => set?.elements ?? []

const events = []
let seq = 0
function emit(type, key, tags, content) {
  const id = hex(`bm:${key}`)
  events.push({
    id,
    pubkey: IMPORTER_PK,
    sig: hex(`bm:sig:${id}`) + hex(`bm:sig2:${id}`),
    kind: SCRUTINY_KIND,
    created_at: BASE_TS + seq++,
    tags,
    content,
  })
  return id
}

const typeTags = (type) => [
  ['t', FABRIC_TAG],
  ['t', EVENT_TYPE_TAGS[type]],
  ['t', VERSION_TAG],
]
const eRef = (id, marker) => ['e', id, '', marker, IMPORTER_PK]
const imeta = (url, kind, hash) => {
  const filename = decodeURIComponent(url.split('/').pop() ?? url)
  const fields = ['imeta', `url ${url}`, 'm application/pdf']
  if (hash) fields.push(`x ${hash}`)
  fields.push(`alt ${kind}: ${filename}`)
  return fields
}

console.log('Loading main-dataset.json…')
const certs = JSON.parse(readFileSync(DATA, 'utf8')).certs
console.log(`  ${certs.length} certs`)

// ── PP hub products first (D39's shared hubs: ~281 unique PP documents) ─────
const ppIds = new Map() // url -> product event id
const ppUrlSet = new Set()
for (const c of certs) for (const url of els(c.protection_profile_links)) ppUrlSet.add(url)
for (const url of [...ppUrlSet].sort()) {
  const stem = decodeURIComponent(url.split('/').pop() ?? url).replace(/\.pdf$/i, '')
  ppIds.set(
    url,
    emit(
      'product',
      `pp:${url}`,
      [...typeTags('product'), ['i', `cc-pp:${stem}`], ['k', 'cc-pp']],
      `Protection Profile: ${stem}\nSource: ${url}`,
    ),
  )
}

// cert_id -> product id, for cross-reference resolutions
const productByDgst = new Map()
const productByCertId = new Map()
for (const c of certs) productByDgst.set(c.dgst, hex(`bm:cert:${c.dgst}`))
for (const c of certs) if (c.heuristics.cert_id) productByCertId.set(c.heuristics.cert_id, hex(`bm:cert:${c.dgst}`))

// ── Per-cert events, cert-major order ───────────────────────────────────────
const cumAtCert = [] // cumulative event count after each cert
const contentBytes = []
const byType = { product: 0, metadata: 0, binding: 0, patch: 0 }

function productContent(c) {
  const h = c.heuristics
  const lines = [
    c.name,
    `Manufacturer: ${c.manufacturer ?? '(unknown)'}`,
    `Manufacturer-web: ${c.manufacturer_web ?? ''}`,
    `Category: ${c.category}`,
    `Scheme: ${c.scheme}`,
    `Validity: ${c.not_valid_before ?? '?'} → ${c.not_valid_after ?? '?'}`,
    `Security level: ${els(c.security_level).join(', ') || '(unspecified)'}`,
    `Status: ${c.status}`,
  ]
  const versions = els(h.extracted_versions)
  if (versions.length > 0) lines.push(`Versions: ${versions.join(', ')}`)
  if (h.cert_lab) lines.push(`Lab: ${h.cert_lab}`)
  return lines.join('\n')
}

for (const c of certs) {
  const h = c.heuristics
  const archived = c.status === 'archived'

  // E1 — Product
  const tags = [...typeTags('product')]
  if (h.cert_id) tags.push(['i', `cc-cert-id:${h.cert_id}`], ['k', 'cc-cert-id'])
  tags.push(['i', `cc-scheme:${c.scheme}`], ['k', 'cc-scheme'])
  if (h.eal) tags.push(['i', `cc-eal:${h.eal}`], ['k', 'cc-eal'])
  for (const cpe of els(h.verified_cpe_matches ?? h.cpe_matches)) tags.push(['i', cpe], ['k', 'cpe'])
  for (const kind of ['report', 'st', 'cert']) {
    const st = c.state[kind]
    if (st?.download_ok && st.pdf_hash && c[`${kind}_link`]) {
      tags.push(imeta(c[`${kind}_link`], kind, st.pdf_hash))
    }
  }
  const content = productContent(c)
  contentBytes.push(content.length)
  const pid = emit('product', `cert:${c.dgst}`, tags, content)
  byType.product++

  // E4 — status-change Patch on archived certs (flips the fixed line 8: "Status: …")
  if (archived) {
    const payload = [
      'diff --git a/content b/content',
      '--- a/content',
      '+++ b/content',
      '@@ -8 +8 @@',
      '-Status: active',
      '+Status: archived',
    ].join('\n')
    emit(
      'patch',
      `patch:status:${c.dgst}`,
      [...typeTags('patch'), eRef(pid, 'root'), eRef(pid, 'reply')],
      `Cert expired; status archived.\n\n\`\`\`diff\n${payload}\n\`\`\``,
    )
    byType.patch++
  }

  // PP claims: 1 Metadata + 1 Binding each (REPORT worked example E2/E3)
  els(c.protection_profile_links).forEach((url, i) => {
    const stem = decodeURIComponent(url.split('/').pop() ?? url).replace(/\.pdf$/i, '')
    const mid = emit(
      'metadata',
      `ppmeta:${c.dgst}:${i}`,
      typeTags('metadata'),
      `Claims conformance to protection profile: ${stem}.`,
    )
    emit(
      'binding',
      `ppbind:${c.dgst}:${i}`,
      [...typeTags('binding'), eRef(ppIds.get(url), 'root'), eRef(mid, 'link')],
      'PP conformance edge.',
    )
    byType.metadata++
    byType.binding++
  })

  // CVEs: 1 Metadata + 1 Binding each (REPORT §4.3 shape)
  for (const cve of new Set(els(h.related_cves))) {
    const mid = emit(
      'metadata',
      `cvemeta:${c.dgst}:${cve}`,
      [...typeTags('metadata'), ['i', `cve:${cve}`], ['k', 'cve']],
      `CVE reference: ${cve}`,
    )
    emit(
      'binding',
      `cvebind:${c.dgst}:${cve}`,
      [...typeTags('binding'), eRef(pid, 'root'), eRef(mid, 'link')],
      'Related-CVE edge.',
    )
    byType.metadata++
    byType.binding++
  }
  for (const [kind2, list] of [
    ['direct', els(h.direct_transitive_cves)],
    ['indirect', els(h.indirect_transitive_cves)],
  ]) {
    for (const cve of new Set(list)) {
      const mid = emit(
        'metadata',
        `tcvemeta:${c.dgst}:${kind2}:${cve}`,
        [...typeTags('metadata'), ['i', `cve:${cve}`], ['k', 'cve']],
        `${kind2 === 'direct' ? 'Direct' : 'Indirect'} transitive CVE: ${cve}`,
      )
      emit(
        'binding',
        `tcvebind:${c.dgst}:${kind2}:${cve}`,
        [...typeTags('binding'), eRef(pid, 'root'), eRef(mid, 'link')],
        kind2 === 'direct'
          ? 'Direct transitive CVE edge.'
          : 'Indirect transitive CVE via a dependency component.',
      )
      byType.metadata++
      byType.binding++
    }
  }

  // SARs: one Metadata per cert (REPORT: no binding mentioned)
  const sars = els(h.extracted_sars)
  if (sars.length > 0) {
    const mtags = [...typeTags('metadata')]
    for (const s of new Set(sars.map((s) => `${s.family}.${s.level}`))) {
      mtags.push(['i', `cc-sar:${s}`])
    }
    mtags.push(['k', 'cc-sar'])
    emit(
      'metadata',
      `sar:${c.dgst}`,
      mtags,
      sars.map((s) => `SAR: ${s.family} level ${s.level}`).join('\n'),
    )
    byType.metadata++
  }

  // Scheme-registry view: one Metadata + one Binding
  if (h.scheme_data) {
    const mid = emit('metadata', `scheme:${c.dgst}`, typeTags('metadata'), JSON.stringify(h.scheme_data))
    emit(
      'binding',
      `schemebind:${c.dgst}`,
      [...typeTags('binding'), eRef(pid, 'root'), eRef(mid, 'link')],
      'Scheme-registry record edge.',
    )
    byType.metadata++
    byType.binding++
  }

  // Maintenance updates: 1 Metadata + 1 Binding each (REPORT Decision A)
  els(c.maintenance_updates).forEach((u, i) => {
    const mtags = [...typeTags('metadata')]
    if (u.maintenance_report_link) mtags.push(imeta(u.maintenance_report_link, 'report', null))
    if (u.maintenance_st_link) mtags.push(imeta(u.maintenance_st_link, 'st', null))
    const mid = emit(
      'metadata',
      `mu:${c.dgst}:${i}`,
      mtags,
      `Maintenance update: ${u.maintenance_title}\nmaintenance_date: ${u.maintenance_date}`,
    )
    emit(
      'binding',
      `mubind:${c.dgst}:${i}`,
      [...typeTags('binding'), eRef(pid, 'root'), eRef(mid, 'link')],
      'Maintenance update for parent CC certificate.',
    )
    byType.metadata++
    byType.binding++
  })

  // Cross-cert references: metadata carrier + binding (BD-4-conformant at v0.8.0)
  for (const [kind3, refs] of [
    ['st', h.st_references?.directly_referencing],
    ['report', h.report_references?.directly_referencing],
  ]) {
    for (const target of els(refs)) {
      const targetId = productByCertId.get(target)
      const mid = emit(
        'metadata',
        `refmeta:${c.dgst}:${kind3}:${target}`,
        targetId
          ? [...typeTags('metadata'), ['i', `cc-cert-id:${target}`], ['k', 'cc-cert-id']]
          : typeTags('metadata'),
        `Cross-reference (${kind3}): ${target}`,
      )
      emit(
        'binding',
        `refbind:${c.dgst}:${kind3}:${target}`,
        [...typeTags('binding'), eRef(pid, 'root'), eRef(mid, 'link')],
        `Cross-certificate ${kind3} reference edge.`,
      )
      byType.metadata++
      byType.binding++
    }
  }

  cumAtCert.push(events.length)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, JSON.stringify(events))

contentBytes.sort((a, b) => a - b)
const q = (p) => contentBytes[Math.floor(p * (contentBytes.length - 1))]
const bytes = JSON.stringify(events).length
console.log(
  JSON.stringify(
    {
      total: events.length,
      byType: { ...byType, product: byType.product + ppIds.size },
      ppHubs: ppIds.size,
      fileBytes: bytes,
      perEventKB: (bytes / events.length / 1024).toFixed(3),
      productContentBytes: { min: contentBytes[0], median: q(0.5), p95: q(0.95), max: contentBytes.at(-1) },
      cumulativeAfterCerts: { 2000: cumAtCert[1999], 4000: cumAtCert[3999], 6000: cumAtCert[5999], all: events.length },
    },
    null,
    2,
  ),
)
console.log(`wrote ${OUT}`)
const sizePoints = [30000, 60000, 110000].map((t) => {
  const idx = cumAtCert.findIndex((n) => n >= t)
  return `${t}→${cumAtCert[idx]} events after cert ${idx + 1}`
})
console.log(`size points (first cert boundary ≥ target): ${sizePoints.join(' | ')}`)
