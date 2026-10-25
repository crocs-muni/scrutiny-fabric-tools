/**
 * emit/runMetadata.ts — JCAlgTest measurement-run Metadata (design §2.5, §4.3.6–§4.3.9).
 *
 * One Metadata per run CSV (ALGSUPPORT / DATAFIXED / DATADEPEND / AIDSUPPORT),
 * bound to the card Product by the caller. The raw CSV bytes are attached via
 * `imeta` (upstream raw.githubusercontent.com URL + our sha256 + size) and every
 * machine fact (counts, versions, families, selected scalars) is repeated in prose
 * per rule 2a.
 */

import type { CardIdentity, RunRecord, SignedEvent } from '../types.js'
import {
  assertEventShape,
  assertRule2a,
  baseTags,
  composeContent,
  familyList,
  iTags,
  jcverBuckets,
  kTagsFor,
  normalizeAtr,
} from './content.js'
import type { Signer } from './keys.js'

/** Readable labels + units for the canonical metric keys (design §4.3.6 style). */
const SELECTED_LABELS: Readonly<Record<string, { label: string; unit: string }>> = {
  ecdsa_sha256_sign_s: { label: 'ALG_ECDSA_SHA_256 Signature_sign()', unit: 's/op' },
  ecdsa_sha_sign_s: { label: 'ALG_ECDSA_SHA Signature_sign()', unit: 's/op' },
  rsa2048_crt_keygen_s: { label: 'RSA-2048 CRT key generation', unit: 's' },
  sha256_digest_s: { label: 'SHA-256 MessageDigest_doFinal()', unit: 's/op' },
  ecfp256_keygen_s: { label: 'EC FP-256 key generation', unit: 's' },
}

const MODE_TEXT: Readonly<Record<RunRecord['kind'], string>> = {
  ALGSUPPORT: 'ALG_SUPPORT_EXTENDED (algorithm support plus per-op timing)',
  DATAFIXED:
    'ALG_PERFORMANCE_STATIC (fixed data length; the AlgTest client already subtracted the baseline average — never subtract it twice)',
  DATADEPEND: 'ALG_PERFORMANCE_VARIABLE (measurement blocks repeated per covered data length)',
  AIDSUPPORT: 'AIDSUPPORT (installed package AID scan)',
}

const RECORD_CARD_TYPE: Readonly<Record<RunRecord['kind'], string>> = {
  ALGSUPPORT: 'jcalgtest-algsupport@1',
  DATAFIXED: 'jcalgtest-perf-datfixed@1',
  DATADEPEND: 'jcalgtest-perf-datadepend@1',
  AIDSUPPORT: 'jcalgtest-aidsupport@1',
}

export interface RunMetadataInput {
  run: RunRecord
  card: CardIdentity
  /** Import snapshot date (ISO). */
  snapshot: string
  /** True when the card is cross-linked to a ROCA-affected certificate (adds `t roca`). */
  roca?: boolean
}

function renderMetrics(selected: Readonly<Record<string, number | null>>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(selected)) {
    const known = SELECTED_LABELS[key]
    const name = known === undefined ? key : known.label
    const unit = known === undefined ? '' : ` ${known.unit}`
    parts.push(
      value === null
        ? `${name}: not measurable in this run (operation failed; no metric)`
        : `${name} ${value}${unit}`,
    )
  }
  return parts.length === 0 ? 'none recorded' : parts.join('; ')
}

/** Build the measurement-run Metadata event. */
export function buildRunMetadata(
  input: RunMetadataInput,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const run = input.run
  const card = input.card
  const jcard = card.jcard
  const atr = normalizeAtr(run.atr)
  const buckets = jcverBuckets(run.jcver)
  const tool = run.run.clientVersion
  const date = run.run.date
  const label = `run:${run.kind}:${run.file}`

  const identity: Array<string | null> = [
    jcard === null ? null : `jcard:${jcard}`,
    atr === null ? null : `atr:${atr}`,
    ...(run.kind === 'AIDSUPPORT' ? [] : run.families.map((f) => `alg:${f}`)),
    run.jcver === null || run.kind === 'AIDSUPPORT' ? null : `jcver:${run.jcver}`,
    ...(run.kind === 'AIDSUPPORT' ? [] : buckets),
  ]
  const iList = iTags(identity)

  const headline =
    `${run.kind} — ${run.cardName}${jcard === null ? '' : ` (profile ${jcard})`}` +
    `${run.jcver === null ? '' : `, JavaCard ${run.jcver}`}; run ${date ?? '(no date)'}` +
    `${tool === null ? '' : `, AlgTest ${tool}`}.`
  const atrText =
    atr === null ? 'ATR not reported in this run' : `ATR (continuous lowercase hex) ${atr}`
  const familiesText =
    run.kind === 'AIDSUPPORT'
      ? 'indexers: jcard and atr only (an AID scan carries no algorithm-family tags, §2.5)'
      : `measured/supported algorithm families (family-level indexers only): ${familyList(run.families)}`
  const secondLine = `Card identity: ${atrText}; ${familiesText}; snapshot ${input.snapshot}.`

  const versionLine =
    run.jcver === null
      ? 'Declared "JavaCard support version" line: none in this run → no jcver or jcver-lte indexer (no inference from major.minor, §9 Q10).'
      : `Declared JavaCard support version: ${run.jcver} (verbatim from the run header) → cohort buckets ${buckets.length === 0 ? 'none' : buckets.join(', ')}.`

  const bullets: string[] = [
    `Mode: ${MODE_TEXT[run.kind]} (run kind ${run.kind}).`,
    `Card: ${run.cardName}; ${atrText}${jcard === null ? '' : `; JCAlgTest profile ${jcard}`}.`,
    versionLine,
  ]

  if (run.kind === 'ALGSUPPORT') {
    bullets.push(
      `Family support: ${familyList(run.families)} supported; variant-level constants and the full yes/no matrix stay in the raw CSV.`,
      `Selected measurements: ${renderMetrics(run.selected)}.`,
      `Row totals: ${run.measuredCount ?? 0} algorithm/keybuilder rows; ${run.supportedCount ?? 0} supported, ${run.unsupportedCount ?? 0} not supported (this run).`,
    )
  } else if (run.kind === 'DATAFIXED') {
    bullets.push(
      `Measured algorithm families: ${familyList(run.families)} (family-level indexers; per-op scalars below).`,
      `Selected fixed-length timings (avg op, baseline already subtracted by the client): ${renderMetrics(run.selected)}.`,
    )
  } else if (run.kind === 'DATADEPEND') {
    bullets.push(
      `Measured algorithm families: ${familyList(run.families)} (family-level indexers; scaling per covered length below).`,
      `Covered data lengths (bytes): ${(run.lengths ?? []).join(' / ')}.`,
      `Selected scaling values: ${renderMetrics(run.selected)}.`,
    )
  } else {
    bullets.push(
      `Scan: ${tool === null ? 'no tool version recorded' : `jcAIDScan ${tool}`}; packages ${run.packageCount ?? 0} package AIDs, ${run.measuredCount ?? 0} AID/version rows.`,
      'Package inventory detail (package AIDs, versions, supported/not supported rows) stays in the raw CSV attached below.',
    )
  }

  for (const highlight of run.highlights.slice(0, 6)) bullets.push(`Recorded fact: ${highlight}`)
  bullets.push(
    `Contributor: ${run.run.contributedBy ?? 'not recorded'}; upstream file ${run.file} (sha256 ${run.sha256}, ${run.sizeBytes} bytes) attached via imeta below.`,
  )

  const content = composeContent({
    headline: `${headline}\n${secondLine}`,
    bullets,
    links: [
      `Raw CSV: ${run.upstreamUrl}`,
      'Repository: https://github.com/crocs-muni/jcalgtest_results',
      "Mirrored by scrutiny-mirror from jcalgtest_results; run values are the contributor's measurement, reproduced verbatim.",
    ],
    card: {
      type: RECORD_CARD_TYPE[run.kind],
      jcard,
      atr,
      run: { epoch_ms: run.run.epochMs, date, tool },
      ...(run.kind === 'ALGSUPPORT'
        ? {
            measured: run.measuredCount ?? null,
            supported: run.supportedCount ?? null,
            unsupported: run.unsupportedCount ?? null,
          }
        : {}),
      ...(run.kind === 'AIDSUPPORT'
        ? {
            scan: { tool },
            packages: run.packageCount ?? null,
            full_rows: run.measuredCount ?? null,
          }
        : {}),
      ...(run.kind === 'DATADEPEND' ? { lengths: run.lengths ?? [] } : {}),
      selected: run.selected,
      snapshot: input.snapshot,
    },
  })

  const facets = input.roca === true ? ['jcalgtest', 'roca'] : ['jcalgtest']
  const tags = [
    ...baseTags('scrutiny-metadata', facets),
    ...iList,
    ...kTagsFor(iList),
    ['imeta', `url ${run.upstreamUrl}`, 'm text/csv', `x ${run.sha256}`, `size ${run.sizeBytes}`],
  ]
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}
