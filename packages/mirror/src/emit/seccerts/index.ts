/**
 * emit/seccerts/index.ts — leg-2 entrypoint: SecCertsBundle → plan → engine.
 *
 * `planBundle` lives in the parallel slice `./plan.js`; it is imported dynamically with a
 * local structural signature so this module typechecks (and ships) independently of its
 * arrival, and so a future plan signature change surfaces as a runtime error, not a build break.
 *
 * The ledger rows the engine emits (`rootRows`/`relationRows`) are applied HERE at build time
 * (update-semantics.md §1: the sqlite ids mirror the NDJSON ids — a crashed publish resumes from
 * the artifacts file + publish_log, never from un-applied engine output; a re-run of `build`
 * without publishing is still a clean no-op diff because the ledger matches what was signed).
 * The sqlite handle is closed before returning (Windows file-lock hygiene).
 */

import { existsSync } from 'node:fs'

import { sha256Hex } from '../../hashing.js'
import { openLedger } from '../../ledger/index.js'
import { SecCertsLedger } from '../../ledger/seccertsLedger.js'
import type { DesiredState, EngineResult, SecCertsBundle } from '../../loaders/seccerts-types.js'
import { readNdjson } from '../../ndjson.js'
import type { Manifest, SignedEvent } from '../../types.js'
import { countByType } from '../content.js'
import type { Signer } from '../keys.js'
import { runEngine } from './engine.js'
import { planBundle } from './plan.js'
import { crosslinkFingerprintOf, crosslinkRelationId } from './relations.js'

export { writeArtifacts } from '../ndjson.js'

export interface EmitSeccertsOptions {
  signer: Signer
  /** sqlite path for the v1 ledger (`:memory:` supported for tests). */
  ledgerPath: string
  /** Fixed unix-seconds base for deterministic batches (tests/replays). */
  createdAtBase?: number
  /**
   * Leg-1 published artifacts file (default `artifacts/jcalgtest.ndjson`): feeding the ledger
   * seed of card Products + the 4 live demo cross-link bindings (decision 2026-10-11).
   * Pass an absent path in tests to disable seeding.
   */
  leg1NdjsonPath?: string
}

export interface EmitSeccertsResult {
  events: SignedEvent[]
  manifest: Manifest
  engine: EngineResult
}

/** Max corpus snapshot stamp (ISO dates sort lexicographically); '' when the bundle is empty. */
function maxCorpusSnapshot(bundle: unknown): string {
  const corp = (bundle as { corp?: Array<{ snapshot?: unknown }> } | null)?.corp
  if (!Array.isArray(corp)) return ''
  let max = ''
  for (const doc of corp) {
    const snapshot = doc?.snapshot
    if (typeof snapshot === 'string' && snapshot > max) max = snapshot
  }
  return max
}

/** Minimal view of leg-1 jcalgtest card products + already-published cross-link bindings. */
interface Leg1CardRow {
  cardKey: string
  content: string
  iSet: string[]
  rootEventId: string
}

/**
 * Seed the ledger from leg 1's published artifacts (decision 2026-10-11, update-semantics §1):
 *  - `roots` rows (`corpus='jcalgtest'`, role 'product') for every `jcalgtest-card@1` product,
 *    keyed exactly like leg-1's `cardKeyOf` cascade — `jcard:<id>`, else `atr:<hex>`, else
 *    `name:<lower>` — so this leg's cross-link relations resolve their `e root` endpoint
 *    WITHOUT relay queries;
 *  - `relations` rows (`corpus='seccerts/cc'`, kind 'crosslink') for the 4 demo pairs already
 *    live on the relay, with fingerprints computed by the SAME function the plan uses, so the
 *    plan's identical relations classify R2-unchanged (never re-emitted).
 * Seed is idempotent: upserts rewrite identical rows on each build.
 */
function seedLeg1(
  seccerts: SecCertsLedger,
  bundle: SecCertsBundle,
  leg1NdjsonPath: string,
): { rootsSeeded: number; relationsSeeded: number; warnings: string[] } {
  if (!existsSync(leg1NdjsonPath)) {
    return {
      rootsSeeded: 0,
      relationsSeeded: 0,
      warnings: [`leg-1 seed skipped: ${leg1NdjsonPath} not found`],
    }
  }
  const warnings: string[] = []
  const events = readNdjson(leg1NdjsonPath)
  const cardByEventId = new Map<string, Leg1CardRow>()
  const metaDgstByEventId = new Map<string, string>()
  for (const e of events) {
    const m = /Record card \(JSON\): (.+)/.exec(e.content)
    if (m === null) continue
    let card: unknown
    try {
      card = JSON.parse(m[1] ?? 'null')
    } catch {
      continue
    }
    if (typeof card !== 'object' || card === null) continue
    const rec = card as Record<string, unknown>
    if (rec['type'] === 'jcalgtest-card@1') {
      const jcard = typeof rec['jcard'] === 'string' ? rec['jcard'] : null
      const atr = typeof rec['atr'] === 'string' && rec['atr'] !== '' ? rec['atr'] : null
      const name = typeof rec['name'] === 'string' ? rec['name'] : ''
      const cardKey =
        jcard !== null
          ? `jcard:${jcard}`
          : atr !== null
            ? `atr:${atr.trim().toLowerCase()}`
            : name !== ''
              ? `name:${name.trim().toLowerCase()}`
              : null
      if (cardKey !== null) {
        cardByEventId.set(e.id, {
          cardKey,
          content: e.content,
          iSet: e.tags.filter((t) => t[0] === 'i').map((t) => t[1] ?? ''),
          rootEventId: e.id,
        })
      }
    } else if (rec['type'] === 'sec-certs-cc-record@1' && typeof rec['dgst'] === 'string') {
      metaDgstByEventId.set(e.id, rec['dgst'])
    }
  }
  // upsert roots rows for every leg-1 card product
  seccerts.upsertRoots(
    [...cardByEventId.values()].map((row) => ({
      corpus: 'jcalgtest',
      sourceId: row.cardKey,
      role: 'product',
      rootEventId: row.rootEventId,
      tipEventId: row.rootEventId,
      tipContent: row.content,
      contentHash: sha256Hex(row.content),
      iSet: row.iSet,
      imeta: [],
      sourceHash: 'leg1-seed',
      genVersion: 'seccerts-v1',
      state: 'live' as const,
    })),
  )

  // seed relation rows for the leg-1 cross-link bindings (the 4 demo pairs)
  const demoByKey = new Map(bundle.crosslinks.map((pair) => [crosslinkRelationId(pair), pair]))
  let relationsSeeded = 0
  for (const e of events) {
    const isBinding = e.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-binding')
    if (!isBinding) continue
    const rootId = e.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1]
    const linkId = e.tags.find((t) => t[0] === 'e' && t[3] === 'link')?.[1]
    if (rootId === undefined || linkId === undefined) continue
    const certDgst = metaDgstByEventId.get(linkId)
    if (certDgst === undefined) continue // not a cross-link binding (cert-meta endpoint)
    const card = cardByEventId.get(rootId)
    if (card === undefined) continue
    const relationId = `xlink:${card.cardKey}:${certDgst}`
    const pair = demoByKey.get(relationId)
    if (pair === undefined) {
      warnings.push(
        `leg-1 binding ${e.id.slice(0, 12)}… links ${card.cardKey} ↔ ${certDgst} — pair absent from this matrix revision; seeded with its own fingerprint only`,
      )
    }
    seccerts.upsertRelations([
      {
        corpus: 'seccerts/cc',
        relationId,
        kind: 'crosslink',
        subjectId: card.cardKey,
        objectKey: certDgst,
        fingerprint:
          pair === undefined
            ? sha256Hex(`${relationId}|${card.cardKey}|${certDgst}|leg1-seed`)
            : crosslinkFingerprintOf(pair),
        eventId: e.id,
        state: 'live',
      },
    ])
    relationsSeeded += 1
  }
  return { rootsSeeded: cardByEventId.size, relationsSeeded, warnings }
}

export async function emitSeccertsBundle(
  bundle: unknown,
  opts: EmitSeccertsOptions,
): Promise<EmitSeccertsResult> {
  const state = planBundle(bundle as SecCertsBundle)

  const ledger = openLedger(opts.ledgerPath)
  try {
    const seccerts = new SecCertsLedger(ledger.db)
    const seed = seedLeg1(
      seccerts,
      bundle as SecCertsBundle,
      opts.leg1NdjsonPath ?? 'artifacts/jcalgtest.ndjson',
    )
    const engine = runEngine(state, {
      signer: opts.signer,
      ledger: seccerts,
      ...(opts.createdAtBase === undefined ? {} : { createdAtBase: opts.createdAtBase }),
    })
    engine.warnings.unshift(
      `leg-1 seed: ${seed.rootsSeeded} card roots, ${seed.relationsSeeded} cross-link relation rows`,
      ...seed.warnings,
    )
    // Build-time ledger apply (see header): rows mirror the signed batch; relay acks live
    // separately in publish_log per the README pipeline's stage 3.
    seccerts.upsertRoots(engine.rootRows)
    seccerts.upsertRelations(engine.relationRows)
    const manifest: Manifest = {
      corpus: 'seccerts',
      snapshot: maxCorpusSnapshot(bundle),
      producedAt: new Date().toISOString(),
      counts: countByType(engine.events),
      ledgerPreview: engine.rootRows.length + engine.relationRows.length,
      files: { ndjson: 'artifacts/seccerts.ndjson' },
    }
    return { events: engine.events, manifest, engine }
  } finally {
    ledger.close()
  }
}
