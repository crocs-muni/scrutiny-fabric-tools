/**
 * emit/index.ts — stage-1 emit layer: `SourceBundle` → signed SCRUTINY events.
 *
 * Deterministic publication order (README §Pipeline; design §8.3 "endpoints before
 * bindings"):
 *   corpus Product → card Products → advisory spine nodes → measurement runs →
 *   leaderboard → snapshot → all Bindings (spine edges, cross-links, card↔run,
 *   corpus→derived).
 *
 * All record shapes come from `../types.js` — this layer adds no parallel model.
 * Every event is signed with the batch clock (`created_at` = publish time, never
 * backdated) and checked for rule-2a / tag-shape violations before it leaves.
 */

import type {
  CardIdentity,
  CrosslinkRecord,
  Manifest,
  RunRecord,
  SignedEvent,
  SourceBundle,
} from '../types.js'
import {
  ROCA_REACHABLE_DGSTS,
  SPINE_CROSSLINKS,
  buildSpineBindings,
  buildSpineCrosslinkBinding,
  buildSpineNodes,
} from './advisorySpine.js'
import { buildCorpusBinding, buildCrosslinkBinding, buildRunBinding } from './binding.js'
import { buildCardProduct } from './cardProduct.js'
import { countByType, normalizeAtr } from './content.js'
import { buildCorpusProduct } from './corpusProduct.js'
import { type Signer, createClock } from './keys.js'
import { buildLeaderboard } from './leaderboard.js'
import { buildRunMetadata } from './runMetadata.js'
import { buildSnapshot } from './snapshot.js'

export { createClock, loadKey, secretKeyFromString, signerFromSecretKey } from './keys.js'
export type { Clock, LoadKeyOptions, Signer, UnsignedEventTemplate } from './keys.js'
export { serializeNdjson, writeArtifacts } from './ndjson.js'
export type { WriteArtifactsOptions, WrittenArtifacts } from './ndjson.js'
export { EmitRuleError, EmitShapeError } from './content.js'

/** Corpus slug → human label for corpus Product headlines. */
const CORPUS_LABELS: Readonly<Record<string, string>> = {
  jcalgtest: 'JCAlgTest card corpus',
}

export interface EmitOptions {
  /** Publisher key (see `loadKey`). */
  signer: Signer
  /** Fixed unix-seconds base for deterministic batches (tests/replays). */
  createdAtBase?: number
  /** Event id of the leaderboard edition this import supersedes (ledger-supplied). */
  supersedesLeaderboard?: string | null
  /** ISO timestamp recorded in the manifest (default: now). */
  producedAt?: string
}

export interface EmitResult {
  /** Signed events in publication order (as serialized to NDJSON). */
  events: SignedEvent[]
  /** Frozen `Manifest` shape for `artifacts/manifest.json`. */
  manifest: Manifest
  /** Non-fatal import findings (skipped cross-links, runs without a card, …). */
  warnings: string[]
}

function cardKeyOf(card: CardIdentity): string {
  if (card.jcard !== null) return `jcard:${card.jcard}`
  const atr = normalizeAtr(card.atr)
  if (atr !== null) return `atr:${atr}`
  return `name:${card.name.toLowerCase()}`
}

function isRocaCert(dgst: string): boolean {
  return ROCA_REACHABLE_DGSTS[dgst] === true
}

/** Emit the full leg-1 batch for one import of one corpus. */
export function emitSourceBundle(bundle: SourceBundle, opts: EmitOptions): EmitResult {
  const { signer } = opts
  const clock = createClock(opts.createdAtBase)
  const snapshot = bundle.snapshot.snapshot
  const warnings: string[] = []
  const events: SignedEvent[] = []
  const bindings: SignedEvent[] = []

  // ---- 1. corpus Product ------------------------------------------------
  const corpusLabel = CORPUS_LABELS[bundle.snapshot.corpus] ?? `${bundle.snapshot.corpus} corpus`
  const corpusEvent = buildCorpusProduct(
    {
      corpus: bundle.snapshot.corpus,
      label: corpusLabel,
      snapshot,
      source: bundle.snapshot.source,
      counts: bundle.snapshot.counts,
    },
    clock.next(),
    signer,
  )
  events.push(corpusEvent)

  // ---- 2. card Products (runs and cross-links indexed by card identity) --
  const cardIdByKey = new Map<string, string>()
  const cardsByJcard = new Map<string, CardIdentity>()
  const cardsByAtr = new Map<string, CardIdentity>()
  const cardsByName = new Map<string, CardIdentity>()
  const rocaCardKeys = new Set<string>()

  const matchCard = (spec: { jcard: string | null; atr: string | null; name: string }):
    | CardIdentity
    | undefined => {
    if (spec.jcard !== null) {
      const byJcard = cardsByJcard.get(spec.jcard)
      if (byJcard !== undefined) return byJcard
    }
    const atr = normalizeAtr(spec.atr)
    if (atr !== null) {
      const byAtr = cardsByAtr.get(atr)
      if (byAtr !== undefined) return byAtr
    }
    return cardsByName.get(spec.name.toLowerCase())
  }

  const matchCrosslink = (cross: CrosslinkRecord): CardIdentity | undefined =>
    matchCard({ jcard: cross.cardJcard, atr: cross.cardAtr, name: cross.cardName })

  // Runs join their card by the exact source-file membership the loaders guarantee
  // (1:1: every run CSV belongs to exactly one CardIdentity); the ATR/name match is
  // only a fallback for hand-built bundles.
  const cardByRunFile = new Map<string, CardIdentity>()
  for (const card of bundle.cards) {
    for (const file of card.sourceRunFiles) cardByRunFile.set(file, card)
  }
  const matchRun = (run: RunRecord): CardIdentity | undefined =>
    cardByRunFile.get(run.file) ?? matchCard({ jcard: null, atr: run.atr, name: run.cardName })

  for (const card of bundle.cards) {
    const key = cardKeyOf(card)
    if (card.jcard !== null) cardsByJcard.set(card.jcard, card)
    const atr = normalizeAtr(card.atr)
    if (atr !== null) cardsByAtr.set(atr, card)
    cardsByName.set(card.name.toLowerCase(), card)
    const roca =
      (card.jcard !== null &&
        SPINE_CROSSLINKS.some((cross) => cross.jcard === card.jcard && cross.roca)) ||
      bundle.crosslinks.some(
        (cross) => matchCrosslink(cross) === card && isRocaCert(cross.certDgst),
      )
    if (roca) rocaCardKeys.add(key)
  }

  for (const card of bundle.cards) {
    const key = cardKeyOf(card)
    const roca = rocaCardKeys.has(key)
    const spineCross =
      card.jcard === null ? undefined : SPINE_CROSSLINKS.find((cross) => cross.jcard === card.jcard)
    const genericCross = bundle.crosslinks.find((cross) => matchCrosslink(cross) === card)
    const crosslinkNote =
      spineCross !== undefined
        ? `cross-linked to certificate record ${spineCross.certId} (${spineCross.certName}) — see the published card↔certificate Binding.`
        : genericCross !== undefined
          ? `cross-linked to certificate record ${genericCross.certId} (this card is a certified TOE) — see the published card↔certificate Binding.`
          : undefined
    const event = buildCardProduct(
      {
        card,
        runs: bundle.runs.filter((run) => matchRun(run) === card),
        snapshot,
        roca,
        ...(crosslinkNote === undefined ? {} : { crosslinkNote }),
      },
      clock.next(),
      signer,
    )
    events.push(event)
    cardIdByKey.set(key, event.id)
  }

  // ---- 3. advisory spine nodes (TOE Products, cert Metadatas, advisory) --
  const spine = buildSpineNodes(snapshot, clock, signer)
  events.push(...spine.events)

  // ---- 4. measurement-run Metadatas --------------------------------------
  const runMetaByRun = new Map<RunRecord, string>()
  for (const run of bundle.runs) {
    const card = matchRun(run)
    if (card === undefined) {
      warnings.push(`run without a card Product skipped: ${run.kind} ${run.file}`)
      continue
    }
    const key = cardKeyOf(card)
    const event = buildRunMetadata(
      { run, card, snapshot, roca: rocaCardKeys.has(key) },
      clock.next(),
      signer,
    )
    events.push(event)
    runMetaByRun.set(run, event.id)
  }

  // ---- 5. leaderboard + snapshot ----------------------------------------
  const leaderboardEvent = buildLeaderboard(
    { leaderboard: bundle.leaderboard, supersedes: opts.supersedesLeaderboard ?? null },
    clock.next(),
    signer,
  )
  events.push(leaderboardEvent)
  const snapshotEvent = buildSnapshot({ snapshot: bundle.snapshot }, clock.next(), signer)
  events.push(snapshotEvent)

  // ---- 6. bindings (endpoints already published) -------------------------
  bindings.push(...buildSpineBindings(spine.index, snapshot, clock, signer))

  const covered = new Set<string>()
  for (const cross of SPINE_CROSSLINKS) {
    covered.add(`${cross.jcard}|${cross.certDgst}`)
    const rootId = cardIdByKey.get(`jcard:${cross.jcard}`)
    const linkId = spine.index.certMetaByCert[cross.certId]
    if (rootId === undefined || linkId === undefined) {
      warnings.push(`spine cross-link skipped (missing endpoint): ${cross.jcard} ↔ ${cross.certId}`)
      continue
    }
    bindings.push(buildSpineCrosslinkBinding(cross, rootId, linkId, snapshot, clock, signer))
  }

  for (const cross of bundle.crosslinks) {
    const card = matchCrosslink(cross)
    const pairKey = `${cross.cardJcard === null ? (card === undefined ? `name:${cross.cardName.toLowerCase()}` : cardKeyOf(card)) : cross.cardJcard}|${cross.certDgst}`
    if (covered.has(pairKey)) continue
    if (card === undefined) {
      warnings.push(`cross-link skipped (no card Product for ${cross.cardName}): ${cross.certId}`)
      continue
    }
    const rootId = cardIdByKey.get(cardKeyOf(card))
    const linkId = spine.index.certMetaByCert[cross.certId]
    if (rootId === undefined) {
      warnings.push(
        `cross-link skipped (card Product not emitted for ${cross.cardName}): ${cross.certId}`,
      )
      continue
    }
    if (linkId === undefined) {
      // The certificate record is not mirrored in leg 1 (sec-certs leg publishes it);
      // emitting now would dangle the link endpoint, so the edge stays pending (BD-6).
      warnings.push(
        `cross-link pending (certificate record not mirrored in leg 1): ${cross.cardName} ↔ ${cross.certId}`,
      )
      continue
    }
    bindings.push(
      buildCrosslinkBinding(
        {
          cross,
          cardName: cross.cardName,
          cardId: rootId,
          certId: linkId,
          snapshot,
          roca: isRocaCert(cross.certDgst),
        },
        clock.next(),
        signer,
      ),
    )
  }

  for (const run of bundle.runs) {
    const runId = runMetaByRun.get(run)
    const card = matchRun(run)
    const cardId = card === undefined ? undefined : cardIdByKey.get(cardKeyOf(card))
    if (runId === undefined || card === undefined || cardId === undefined) continue
    bindings.push(
      buildRunBinding(
        {
          cardName: card.name,
          jcard: card.jcard,
          run,
          cardId,
          runId,
          snapshot,
          roca: rocaCardKeys.has(cardKeyOf(card)),
        },
        clock.next(),
        signer,
      ),
    )
  }

  bindings.push(
    buildCorpusBinding(
      {
        corpusEventId: corpusEvent.id,
        derivedId: snapshotEvent.id,
        derivedKind: 'dataset-snapshot',
        derivedLabel: `${bundle.snapshot.corpus} snapshot ${snapshot}`,
        snapshot,
        corpusLabel,
      },
      clock.next(),
      signer,
    ),
    buildCorpusBinding(
      {
        corpusEventId: corpusEvent.id,
        derivedId: leaderboardEvent.id,
        derivedKind: 'leaderboard',
        derivedLabel: `${bundle.leaderboard.metric} leaderboard ${snapshot}`,
        snapshot,
        corpusLabel,
      },
      clock.next(),
      signer,
    ),
  )

  const all = [...events, ...bindings]
  return {
    events: all,
    manifest: {
      corpus: bundle.snapshot.corpus,
      snapshot,
      producedAt: opts.producedAt ?? new Date().toISOString(),
      counts: countByType(all),
      ledgerPreview: all.length,
      files: { ndjson: `artifacts/${bundle.snapshot.corpus}.ndjson` },
    },
    warnings,
  }
}
