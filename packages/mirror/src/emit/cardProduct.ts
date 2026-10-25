/**
 * emit/cardProduct.ts — JCAlgTest card Product (design §2.5, §4.3.5).
 *
 * One Product per physical card identity: `jcard:cNNN` when the frozen table
 * matches (else no jcard tag), plus `atr:`, `cplc:`, `vendor:`, `jcver:` /
 * `jcver-lte:` buckets and the family-level capability summary (the union of the
 * card's ALGSUPPORT runs). Variant-level API constants are never indexers (§2.5).
 */

import type { CardIdentity, RunRecord, SignedEvent } from '../types.js'
import {
  FAMILY_LABELS,
  assertEventShape,
  assertRule2a,
  atrIsMasked,
  baseTags,
  composeContent,
  familyList,
  iTags,
  jcverBuckets,
  kTagsFor,
  normalizeAtr,
  spacedHex,
  vendorSlug,
} from './content.js'
import type { Signer } from './keys.js'

/** CPLC fabricator → vendor name, for cards whose only vendor signal is the CPLC. */
const CARD_VENDOR_BY_FAB: Readonly<Record<string, string>> = {
  '4790': 'NXP Semiconductors',
  '4090': 'Infineon Technologies AG',
}

const MAX_CARD_I_TAGS = 15

export interface CardProductInput {
  card: CardIdentity
  /** The card's measurement runs (feed `source_runs`; empty when only identity is known). */
  runs: readonly RunRecord[]
  /** Import snapshot date (ISO). */
  snapshot: string
  /** True when the card is cross-linked to a ROCA-affected certificate (adds `t roca`). */
  roca?: boolean
  /** Optional cross-dataset evidence note (card ↔ certificate, §2.6). */
  crosslinkNote?: string
}

/** `ALGSUPPORT 2019-09-18` — one label per bound run (date verbatim from the run). */
export function runLabelsFor(runs: readonly RunRecord[]): string[] {
  return runs.map((run) => `${run.kind} ${run.run.date ?? '(no date)'}`)
}

/** Build the card Product event. */
export function buildCardProduct(
  input: CardProductInput,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const card = input.card
  const label = `card-product:${card.jcard ?? card.name}`
  const atr = normalizeAtr(card.atr)
  const atrMasked = atr === null && atrIsMasked(card.atr)
  const vendorRaw =
    card.vendorRaw ?? (card.cplc === null ? null : CARD_VENDOR_BY_FAB[card.cplc.fab])
  const vendor = vendorSlug(vendorRaw)
  const cplc =
    card.cplc === null ? null : `${card.cplc.fab.toLowerCase()}-${card.cplc.ictype.toLowerCase()}`
  const buckets = jcverBuckets(card.jcver)
  const families = card.familiesSupported
  const runLabels = runLabelsFor(input.runs)

  const identity: Array<string | null> = [
    card.jcard === null ? null : `jcard:${card.jcard}`,
    atr === null ? null : `atr:${atr}`,
    cplc === null ? null : `cplc:${cplc}`,
    vendor === null ? null : `vendor:${vendor}`,
    card.jcver === null ? null : `jcver:${card.jcver}`,
    ...buckets,
  ]
  const iList = iTags([...identity, ...families.map((f) => `alg:${f}`)].slice(0, MAX_CARD_I_TAGS))

  const atrLine =
    atr === null
      ? atrMasked
        ? 'ATR masked in the source table (no usable bytes) — no atr indexer emitted.'
        : 'ATR not reported in the source run logs — no atr indexer emitted.'
      : `ATR ${spacedHex(atr)} (continuous lowercase hex ${atr}).`
  const fabName = card.cplc === null ? undefined : CARD_VENDOR_BY_FAB[card.cplc.fab.toLowerCase()]
  const cplcLine =
    card.cplc === null || cplc === null
      ? 'CPLC not reported in the source runs.'
      : `CPLC fabricator ${card.cplc.fab.toLowerCase()}${fabName === undefined ? '' : ` (${fabName})`}, ICType ${card.cplc.ictype.toLowerCase()}${card.cplc.osid === undefined ? '' : `, OS ID ${card.cplc.osid.toLowerCase()}`} → chip-line key ${cplc}.`
  const versionLine =
    card.jcver === null
      ? "Declared JavaCard support version: none in the card's runs → no jcver or jcver-lte indexer (no inference from major.minor, §9 Q10)."
      : `Declared JavaCard support version: ${card.jcver} (exact, from the card's ALGSUPPORT runs) → cohort buckets ${buckets.length === 0 ? 'none' : buckets.join(', ')} of the frozen cut points 3.0.4 / 3.0.5 / 3.1.`
  const familyLine =
    families.length === 0
      ? 'Algorithm families supported: none recorded from ALGSUPPORT runs imported so far (family-level summary, §2.5).'
      : `Algorithm families supported (family-level summary — union over the card's ALGSUPPORT runs): ${familyList(families)}. Variant-level API constants stay in the run content and raw CSVs, never in indexers.`
  const runsLine =
    runLabels.length === 0
      ? 'Imported runs bound to this card: none yet — identity only.'
      : `Imported runs bound to this card (kinds and run dates verbatim): ${runLabels.join('; ')}.`

  const headline = `${card.name}${card.jcver === null ? '' : ` — JavaCard ${card.jcver}`} smart card${card.jcard === null ? '' : ` (JCAlgTest profile ${card.jcard})`}.`
  const secondLine =
    atr === null
      ? `Card identity: ${card.name}${cplc === null ? '' : `; chip-line key ${cplc}`}; snapshot ${input.snapshot}.`
      : `Card identity: ATR ${spacedHex(atr)}${cplc === null ? '' : `; chip-line key ${cplc}`}; snapshot ${input.snapshot}.`

  const content = composeContent({
    headline: `${headline}\n${secondLine}`,
    bullets: [
      atrLine,
      cplcLine,
      versionLine,
      familyLine,
      runsLine,
      ...(input.crosslinkNote === undefined ? [] : [`Cross-dataset: ${input.crosslinkNote}`]),
      `Snapshot: ${input.snapshot}; jcard index resolved from the frozen site table (ground-truth/jcard-table.json).`,
    ],
    links: [
      'Dataset: https://github.com/crocs-muni/jcalgtest_results',
      'Support matrix: https://www.fi.muni.cz/~xsvenda/jcalgtest/table.html',
      "Mirrored by scrutiny-mirror from jcalgtest_results; values are the contributors' measurements, reproduced verbatim.",
    ],
    card: {
      type: 'jcalgtest-card@1',
      jcard: card.jcard,
      name: card.name,
      vendor,
      atr,
      ...(atrMasked ? { atr_masked: true } : {}),
      cplc,
      jcver: card.jcver,
      algs: [...families],
      source_runs: runLabels,
      snapshot: input.snapshot,
    },
  })

  const facets = input.roca === true ? ['jcalgtest', 'roca'] : ['jcalgtest']
  const tags = [...baseTags('scrutiny-product', facets), ...iList, ...kTagsFor(iList)]
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}
