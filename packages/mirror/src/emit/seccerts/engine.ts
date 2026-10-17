/**
 * engine.ts — sec-certs sync engine: `DesiredState` ⇄ ledger v1 (update-semantics.md §2/§5).
 *
 * The engine is a pure diff/classify step: it reads the ledger (`rootsByCorpus`,
 * `relationsByCorpus`, `knownSourceIds`) and returns the signed delta plus the ledger rows the
 * publisher applies alongside its publish acks (`rootRows`, `relationRows`) — it never mutates
 * the ledger itself. Every classification degenerates to "new" against an empty ledger, so run
 * 0 (the initial backfill) and every weekly sync share this one code path.
 *
 * Roots (C1–C5, amended 2026-10-11): C1 absent → sign root; C2 i-set ∪ imeta ∪ content all
 * equal → nothing (bookkeeping refresh only); C3 i-set ∪ imeta equal, content differs →
 * root-author patch against the stored tip; C4 i-set or imeta differs (IX-3: `i`/`imeta` are
 * immutable after publication) → new root with `["e", <old>, "", "supersedes"]`, kind-5 the
 * old root, and re-point every live relation anchored to it; C5 record gone → retire ledger
 * rows only (no relay event, Q1). A re-rooted root carries the engine's supersede notice; the
 * notice is not part of the plan's projection, so C2/C3 compare and patch modulo it (the
 * stored notice is re-attached to the desired body) — a re-root is therefore C2-stable on the
 * very next run instead of costing a cleanup patch.
 * Relations (R1–R5): R1 new binding; R2 fingerprint equal and anchors live → nothing; R3
 * fingerprint differs → kind-5 + new binding (BD-9); R4 absent from the projection → kind-5
 * against the stored `event_id`; R5 anchor re-rooted → kind-5 + re-emit against the new
 * anchors (same logical relation id / fingerprint when only anchors moved — fingerprints
 * cover logical keys, not event ids).
 *
 * Fork guard (§6.4): two root-author patches sharing a parent would be a root self-fork (SF-1).
 * The ledger tracks one tip per root and the publisher dedupes event ids, so within a batch the
 * only way to fork is a duplicated logical key or a patch + re-root collision — both abort the
 * second operation with a loud warning instead of publishing.
 *
 * Event order (update-semantics §5): corpus products → pp → cc → eucc → fips → advisories →
 * snapshots, then new relations, then patches, then re-rooted roots (each immediately followed
 * by its re-pointed relations), then every kind-5 deletion last — deletions never precede the
 * replacement that makes them safe.
 *
 * Duplicate `i`-set comparison is exact (emission order is the diff key); imeta likewise.
 */

import { sha256Hex } from '../../hashing.js'
import type {
  RelationRow,
  RootRow,
  RootUpsertRow,
  SecCertsLedger,
} from '../../ledger/seccertsLedger.js'
import { SECCERTS_GEN_VERSION } from '../../ledger/seccertsLedger.js'
import type {
  DesiredRelation,
  DesiredRoot,
  DesiredState,
  EngineResult,
} from '../../loaders/seccerts-types.js'
import type { SignedEvent } from '../../types.js'
import { buildBinding } from '../binding.js'
import {
  type EventType,
  FABRIC_VERSION_TAG,
  RECORD_CARD_LABEL,
  assertEventShape,
  assertRule2a,
  baseTags,
  iTags,
  kTagsFor,
} from '../content.js'
import { buildDeletion } from '../deletion.js'
import { type Signer, createClock } from '../keys.js'
import { createPatch, wrapPatchEventPayload } from './patch.js'

/** NIP-01 kind-1 root type by ledger role (leaderboard = derived Metadata, design §2.7). */
const ROOT_TYPE_BY_ROLE: Readonly<Record<string, EventType>> = {
  product: 'scrutiny-product',
  corpus: 'scrutiny-product',
  metadata: 'scrutiny-metadata',
  advisory: 'scrutiny-metadata',
  snapshot: 'scrutiny-metadata',
  leaderboard: 'scrutiny-metadata',
}

/** leg-1's `EventType` union predates patches (v0.8.1 shipped roots + bindings only). */
const PATCH_TYPE = 'scrutiny-patch' as unknown as EventType

/**
 * Ledger roots roles scanned for C5 known-source ids. C5 means "record gone from the dataset"
 * (update-semantics §2) — only roots carrying a source record's identity retire: corpus
 * Products persist, snapshots are kept forever (§4), and an advisory whose last binding is
 * retracted stays live (§6.5), so those roles are out of scope by policy.
 */
const C5_RECORD_ROLES = ['product', 'metadata'] as const

/** §5 run grouping: corpus products → pp → cc → eucc → fips → advisories → snapshots. */
const ROOT_GROUP_RANK: Readonly<Record<string, number>> = {
  'seccerts/pp': 1,
  'seccerts/cc': 2,
  'seccerts/eucc': 3,
  'seccerts/fips': 4,
  'seccerts/global': 5,
}

function rootKeyOf(corpus: string, sourceId: string, role: string): string {
  return `${corpus}\u0000${sourceId}\u0000${role}`
}

function rootGroupRank(root: DesiredRoot): number {
  if (root.role === 'corpus') return 0
  if (root.role === 'snapshot') return 6
  return ROOT_GROUP_RANK[root.corpus] ?? 7
}

/** Bounded prose list for supersede summaries (i-sets cap at 64; keep the line readable). */
function formatList(values: readonly string[]): string {
  if (values.length === 0) return 'none'
  const head = values.slice(0, 8).join(', ')
  return values.length > 8 ? `${head} (+${values.length - 8} more)` : head
}

/** Human summary of what moved between the stored root row and the desired root (C4 reason). */
function supersedeParts(root: DesiredRoot, row: RootRow): string {
  const added = root.iSet.filter((value) => !row.iSet.includes(value))
  const removed = row.iSet.filter((value) => !root.iSet.includes(value))
  const parts: string[] = []
  if (added.length > 0 || removed.length > 0) {
    parts.push(`i-set updated: added ${formatList(added)}; removed ${formatList(removed)}`)
  }
  if (JSON.stringify(root.imeta) !== JSON.stringify(row.imeta)) {
    parts.push('imeta updated: pinned artifacts changed')
  }
  if (row.genVersion !== SECCERTS_GEN_VERSION) {
    parts.push(`regenerated under template ${SECCERTS_GEN_VERSION}`)
  }
  if (parts.length === 0) parts.push('i-set and imeta unchanged') // defensive; C4 implies a move
  return parts.join('; ')
}

/** Insert the supersedes sentence after the Links block, keeping the record card last (rule 8c). */
function insertSupersedesLine(content: string, sentence: string): string {
  const lines = content.split('\n')
  const cardIndex = lines.findIndex((line) => line.trimStart().startsWith(RECORD_CARD_LABEL))
  if (cardIndex === -1) return [...lines, '', sentence].join('\n')
  const before = lines.slice(0, cardIndex)
  while (before.length > 0 && before[before.length - 1] === '') before.pop()
  return [...before, '', sentence, '', ...lines.slice(cardIndex)].join('\n')
}

/** Engine-generated supersede sentence: `This event supersedes <64hex> (<summary>).` */
const SUPERSEEDES_NOTICE_RE = /^This event supersedes [0-9a-f]{64} \(.*\)\.$/u

/**
 * Inverse of `insertSupersedesLine`: split emitted content into the plan-projection body and
 * the engine's own supersede notice (`null` when absent). The notice is an audit artifact of
 * the re-root — NOT part of the desired projection — so diffs must compare/patch modulo it.
 */
function stripSupersedesNotice(content: string): { body: string; notice: string | null } {
  const lines = content.split('\n')
  const index = lines.findIndex((line) => SUPERSEEDES_NOTICE_RE.test(line))
  if (index === -1) return { body: content, notice: null }
  const notice = lines[index] ?? ''
  const before = lines.slice(0, index)
  const after = lines.slice(index + 1)
  while (before.length > 0 && before[before.length - 1] === '') before.pop()
  while (after.length > 0 && after[0] === '') after.shift()
  if (after.length === 0) return { body: before.join('\n'), notice }
  return { body: [...before, '', ...after].join('\n'), notice }
}

function buildRootEvent(
  root: DesiredRoot,
  content: string,
  supersedesId: string | null,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const label = `root:${root.corpus}:${root.sourceId}:${root.role}`
  const type = ROOT_TYPE_BY_ROLE[root.role]
  if (type === undefined) throw new Error(`${label}: unknown root role '${root.role}'`)
  const iRows = iTags(root.iSet)
  const tags: string[][] = [
    ...baseTags(type, root.facets),
    ...iRows,
    ...kTagsFor(iRows),
    ...root.imeta.map((row) => [...row]),
    ...(supersedesId === null ? [] : [['e', supersedesId, '', 'supersedes']]),
  ]
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}

/**
 * C3 root-author patch: kind 1, reply to the stored tip (NIP-10 `e root` + `e reply`), content
 * = one prose line + the fenced diff payload. Not run through leg-1's `assertEventShape`/
 * rule-2a checks: those are root-oriented (a patch carries no `i` tags of its own and its
 * fenced payload may legitimately quote card-shaped lines), so the patch shape is asserted
 * directly instead (PT-1/PT-2/PT-3).
 */
function buildPatchEvent(
  root: DesiredRoot,
  rootEventId: string,
  tipEventId: string,
  diff: string,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const label = `patch:${root.corpus}:${root.sourceId}:${root.role}`
  const content = `content update for ${root.sourceId} (i-set unchanged)\n\n${wrapPatchEventPayload(diff)}`
  const tags: string[][] = [
    ...baseTags(PATCH_TYPE, root.facets),
    ['e', rootEventId, '', 'root', signer.pubkey],
    ['e', tipEventId, '', 'reply', signer.pubkey],
  ]
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  const marker = (value: string): number =>
    event.tags.filter((tag) => tag[0] === 't' && tag[1] === value).length
  const eRoots = event.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'root').length
  const eReplies = event.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'reply').length
  if (
    event.kind !== 1 ||
    eRoots !== 1 ||
    eReplies !== 1 ||
    marker('scrutiny-patch') !== 1 ||
    marker('scrutiny-fabric') !== 1 ||
    marker(FABRIC_VERSION_TAG) !== 1
  ) {
    throw new Error(
      `${label}: malformed patch event (kind ${event.kind}, e-root ${eRoots}, e-reply ${eReplies})`,
    )
  }
  return event
}

/** One binding event from a planned relation with its endpoints resolved to current roots. */
function buildRelationBinding(
  relation: DesiredRelation,
  rootEventId: string,
  linkEventId: string,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  return buildBinding(
    {
      root: { id: rootEventId, label: relation.rootRef.label },
      link: { id: linkEventId, label: relation.linkRef.label },
      facets: relation.facets,
      headline: relation.headline,
      bullets: relation.bullets,
      links: relation.links,
    },
    createdAt,
    signer,
    `binding:${relation.corpus}:${relation.relationId}`,
  )
}

export function runEngine(
  state: DesiredState,
  opts: { signer: Signer; ledger: SecCertsLedger; createdAtBase?: number },
): EngineResult {
  const { signer, ledger } = opts
  const clock = createClock(opts.createdAtBase)
  const warnings: string[] = []
  const retractions: string[] = []
  const counts: EngineResult['counts'] = {
    newRoots: 0,
    patches: 0,
    reRoots: 0,
    newRelations: 0,
    retractedRelations: 0,
    replacedRelations: 0,
    unchanged: 0,
    disappeared: 0,
  }
  const rootRows: RootUpsertRow[] = []
  const relationRows: EngineResult['relationRows'] = []

  // ---- ledger snapshot (read-only) ---------------------------------------
  const rootCorpora = new Set<string>(Object.keys(state.sourceIdsByCorpus))
  for (const root of state.roots) rootCorpora.add(root.corpus)
  for (const relation of state.relations) {
    rootCorpora.add(relation.rootRef.corpus)
    rootCorpora.add(relation.linkRef.corpus)
  }
  const liveRootsByCorpus = new Map<string, Map<string, RootRow>>()
  for (const corpus of rootCorpora) {
    const rows = new Map<string, RootRow>()
    for (const row of ledger.rootsByCorpus(corpus)) {
      rows.set(rootKeyOf(row.corpus, row.sourceId, row.role), row)
    }
    liveRootsByCorpus.set(corpus, rows)
  }

  const relationCorpora = new Set<string>(Object.keys(state.sourceIdsByCorpus))
  for (const relation of state.relations) relationCorpora.add(relation.corpus)
  const ledgerRelationsByCorpus = new Map<string, Map<string, RelationRow>>()
  for (const corpus of relationCorpora) {
    const rows = new Map<string, RelationRow>()
    for (const row of ledger.relationsByCorpus(corpus)) rows.set(row.relationId, row)
    ledgerRelationsByCorpus.set(corpus, rows)
  }

  // Bindings anchor the current ROOT event (never the patch tip); ledger roots seed the map so
  // relation endpoints outside this batch still resolve.
  const rootEventIdByKey = new Map<string, string>()
  for (const rows of liveRootsByCorpus.values()) {
    for (const row of rows.values()) {
      rootEventIdByKey.set(rootKeyOf(row.corpus, row.sourceId, row.role), row.rootEventId)
    }
  }

  const newRootEvents: Array<{ root: DesiredRoot; event: SignedEvent }> = []
  const patchEvents: SignedEvent[] = []
  const reRootEntries: Array<{ event: SignedEvent; bindings: SignedEvent[] }> = []
  const reRootEntryByKey = new Map<string, number>()
  const reRootedKeys = new Set<string>()
  const deletionEvents: SignedEvent[] = []
  const patchParents = new Set<string>()
  const seenRootKeys = new Set<string>()

  const pushDeletion = (targetId: string, content: string): void => {
    const event = buildDeletion(targetId, content, clock.next(), signer)
    deletionEvents.push(event)
    retractions.push(event.id)
  }

  // ---- roots: C1–C5 -------------------------------------------------------
  for (const root of state.roots) {
    const label = `${root.corpus}:${root.sourceId}:${root.role}`
    const key = rootKeyOf(root.corpus, root.sourceId, root.role)
    if (seenRootKeys.has(key)) {
      warnings.push(
        `fork guard: duplicate desired root ${label} skipped (one root per key per run)`,
      )
      continue
    }
    seenRootKeys.add(key)
    const row = liveRootsByCorpus.get(root.corpus)?.get(key)
    if (row === undefined) {
      // C1 — new logical root.
      const event = buildRootEvent(root, root.content, null, clock.next(), signer)
      newRootEvents.push({ root, event })
      rootRows.push({
        corpus: root.corpus,
        sourceId: root.sourceId,
        role: root.role,
        rootEventId: event.id,
        tipEventId: event.id,
        tipContent: root.content,
        contentHash: sha256Hex(root.content),
        iSet: [...root.iSet],
        imeta: root.imeta,
        sourceHash: root.sourceHash,
        genVersion: SECCERTS_GEN_VERSION,
        state: 'live',
      })
      rootEventIdByKey.set(key, event.id)
      counts.newRoots += 1
      continue
    }

    const iSetEqual = JSON.stringify(row.iSet) === JSON.stringify(root.iSet)
    const imetaEqual = JSON.stringify(row.imeta) === JSON.stringify(root.imeta)
    const storedSplit = stripSupersedesNotice(row.tipContent)
    // The engine's supersede notice is rendered onto a re-rooted root, not part of the plan's
    // projection: re-attach the stored notice to the desired content so (a) the render is the
    // exact canonical bytes and (b) content patches carry the notice forward instead of
    // diffing it away one run later.
    const desiredSplit = stripSupersedesNotice(root.content)
    const effectiveContent =
      desiredSplit.notice !== null || storedSplit.notice === null
        ? root.content
        : insertSupersedesLine(root.content, storedSplit.notice)
    if (iSetEqual && imetaEqual && row.tipContent === effectiveContent) {
      // C2 — projection-stable. Two ledger behaviors per the amended syncer table:
      //  - gen stamp current: refresh bookkeeping (sourceHash drift) — nothing emitted.
      //  - gen stamp stale (template bump): emit NOTHING (byte-identical content would
      //    duplicate) and refresh NOTHING (a gen refresh is earned by a delta, not a rerun).
      counts.unchanged += 1
      if (row.genVersion === SECCERTS_GEN_VERSION && row.sourceHash !== root.sourceHash) {
        rootRows.push({
          corpus: row.corpus,
          sourceId: row.sourceId,
          role: row.role,
          rootEventId: row.rootEventId,
          tipEventId: row.tipEventId,
          tipContent: row.tipContent,
          contentHash: row.contentHash,
          iSet: [...row.iSet],
          imeta: row.imeta,
          sourceHash: root.sourceHash,
          genVersion: SECCERTS_GEN_VERSION,
          state: 'live',
        })
      }
      continue
    }

    if (iSetEqual && imetaEqual && row.genVersion === SECCERTS_GEN_VERSION) {
      // C3 — content-only change under the same generator → root-author patch against the
      // stored tip. A gen mismatch with a content-improving template is C4 (re-root) per the
      // amended syncer table (2026-10-11 second revision), so it never reaches this branch.
      if (patchParents.has(row.tipEventId)) {
        warnings.push(
          `fork guard: patch aborted for ${label} — tip ${row.tipEventId} already has a root-author patch child in this batch`,
        )
        continue
      }
      const diff = createPatch(row.tipContent, effectiveContent)
      if (diff.length === 0) {
        throw new Error(`engine: ${label} content differs but the diff is empty (byte mismatch?)`)
      }
      const event = buildPatchEvent(
        root,
        row.rootEventId,
        row.tipEventId,
        diff,
        clock.next(),
        signer,
      )
      patchEvents.push(event)
      patchParents.add(row.tipEventId)
      rootRows.push({
        corpus: root.corpus,
        sourceId: root.sourceId,
        role: root.role,
        rootEventId: row.rootEventId,
        tipEventId: event.id,
        tipContent: effectiveContent,
        contentHash: sha256Hex(effectiveContent),
        iSet: [...root.iSet],
        imeta: root.imeta,
        sourceHash: root.sourceHash,
        genVersion: SECCERTS_GEN_VERSION,
        state: 'live',
      })
      counts.patches += 1
      continue
    }

    // C4 — i-set or imeta moved (IX-3) → re-root + kind-5 + relation re-points.
    if (patchParents.has(row.tipEventId)) {
      warnings.push(
        `fork guard: re-root aborted for ${label} — tip ${row.tipEventId} already has a root-author patch child in this batch`,
      )
      continue
    }
    if (root.supersedes !== undefined && root.supersedes !== row.rootEventId) {
      warnings.push(
        `re-root ${label}: desired supersedes ${root.supersedes} != ledger root ${row.rootEventId}; using the ledger root`,
      )
    }
    const parts = supersedeParts(root, row)
    const content = insertSupersedesLine(
      desiredSplit.body,
      `This event supersedes ${row.rootEventId} (${parts}).`,
    )
    const event = buildRootEvent(root, content, row.rootEventId, clock.next(), signer)
    reRootEntryByKey.set(key, reRootEntries.length)
    reRootEntries.push({ event, bindings: [] })
    reRootedKeys.add(key)
    pushDeletion(row.rootEventId, `Superseded by ${event.id} (${parts}).`)
    rootRows.push({
      corpus: root.corpus,
      sourceId: root.sourceId,
      role: root.role,
      rootEventId: event.id,
      tipEventId: event.id,
      tipContent: content,
      contentHash: sha256Hex(content),
      iSet: [...root.iSet],
      imeta: root.imeta,
      sourceHash: root.sourceHash,
      genVersion: SECCERTS_GEN_VERSION,
      state: 'live',
    })
    rootEventIdByKey.set(key, event.id)
    counts.reRoots += 1
  }

  // ---- C5: sources gone from the dataset (retire rows; never a relay event) --------------
  for (const [corpus, desiredSourceIds] of Object.entries(state.sourceIdsByCorpus)) {
    const rows = liveRootsByCorpus.get(corpus)
    if (rows === undefined) continue
    const desired = new Set(desiredSourceIds)
    const known = new Set<string>()
    for (const role of C5_RECORD_ROLES) {
      for (const sourceId of ledger.knownSourceIds(corpus, role)) known.add(sourceId)
    }
    const liveBySource = new Map<string, RootRow[]>()
    for (const row of rows.values()) {
      const list = liveBySource.get(row.sourceId) ?? []
      list.push(row)
      liveBySource.set(row.sourceId, list)
    }
    for (const sourceId of known) {
      if (desired.has(sourceId)) continue
      const gone = liveBySource.get(sourceId) ?? []
      if (gone.length === 0) continue
      for (const row of gone) {
        rootRows.push({
          corpus: row.corpus,
          sourceId: row.sourceId,
          role: row.role,
          rootEventId: row.rootEventId,
          tipEventId: row.tipEventId,
          tipContent: row.tipContent,
          contentHash: row.contentHash,
          iSet: [...row.iSet],
          imeta: row.imeta,
          sourceHash: row.sourceHash,
          genVersion: row.genVersion,
          state: 'retired',
        })
        rootEventIdByKey.delete(rootKeyOf(corpus, sourceId, row.role))
      }
      counts.disappeared += 1
      warnings.push(
        `C5: ${corpus} source ${sourceId} disappeared from the dataset (roles ${gone
          .map((row) => row.role)
          .join(', ')}); ledger rows retired — no relay event`,
      )
    }
  }

  // ---- relations: R1–R5 ---------------------------------------------------
  const desiredRelationIds = new Map<string, Set<string>>()
  for (const relation of state.relations) {
    const ids = desiredRelationIds.get(relation.corpus) ?? new Set<string>()
    ids.add(relation.relationId)
    desiredRelationIds.set(relation.corpus, ids)
  }

  const newRelationEvents: SignedEvent[] = []
  const seenRelationKeys = new Set<string>()

  for (const relation of state.relations) {
    const label = `${relation.corpus}:${relation.relationId}`
    const seenKey = `${relation.corpus}\u0000${relation.relationId}`
    if (seenRelationKeys.has(seenKey)) {
      warnings.push(`duplicate desired relation ${label} skipped (one binding per relation id)`)
      continue
    }
    seenRelationKeys.add(seenKey)
    const rootAnchorKey = rootKeyOf(
      relation.rootRef.corpus,
      relation.rootRef.sourceId,
      relation.rootRef.role,
    )
    const linkAnchorKey = rootKeyOf(
      relation.linkRef.corpus,
      relation.linkRef.sourceId,
      relation.linkRef.role,
    )
    const rootEventId = rootEventIdByKey.get(rootAnchorKey)
    const linkEventId = rootEventIdByKey.get(linkAnchorKey)
    if (rootEventId === undefined || linkEventId === undefined) {
      warnings.push(`relation skipped (endpoint not in batch+ledger): ${label}`)
      continue
    }
    const row = ledgerRelationsByCorpus.get(relation.corpus)?.get(relation.relationId)
    let reRootEntryIndex: number | undefined
    if (reRootedKeys.has(rootAnchorKey)) reRootEntryIndex = reRootEntryByKey.get(rootAnchorKey)
    else if (reRootedKeys.has(linkAnchorKey)) reRootEntryIndex = reRootEntryByKey.get(linkAnchorKey)
    const place = (event: SignedEvent): void => {
      const entry = reRootEntryIndex === undefined ? undefined : reRootEntries[reRootEntryIndex]
      if (entry === undefined) newRelationEvents.push(event)
      else entry.bindings.push(event)
    }
    const rowOf = (
      eventId: string,
      rowState: 'live' | 'retracted',
    ): EngineResult['relationRows'][number] => ({
      corpus: relation.corpus,
      relationId: relation.relationId,
      kind: relation.kind,
      subjectId: relation.rootRef.sourceId,
      objectKey: relation.linkRef.sourceId,
      fingerprint: relation.fingerprint,
      eventId,
      state: rowState,
    })

    if (row === undefined || row.state === 'retracted') {
      // R1 — new binding (a previously retracted row is re-asserted as a fresh event).
      const event = buildRelationBinding(relation, rootEventId, linkEventId, clock.next(), signer)
      place(event)
      relationRows.push(rowOf(event.id, 'live'))
      counts.newRelations += 1
      continue
    }

    const fingerprintEqual = row.fingerprint === relation.fingerprint
    if (fingerprintEqual && reRootEntryIndex === undefined) {
      // R2 — assertion-stable and anchors live.
      counts.unchanged += 1
      continue
    }

    // R3/R5 — bindings are assertion-immutable (BD-9): kind-5 the stored event, emit successor.
    const reason =
      reRootEntryIndex !== undefined
        ? fingerprintEqual
          ? 'anchor root re-rooted'
          : 'anchor root re-rooted and assertion updated'
        : 'assertion updated (fingerprint)'
    pushDeletion(row.eventId, `Replaced by a new binding for ${relation.relationId} (${reason}).`)
    const event = buildRelationBinding(relation, rootEventId, linkEventId, clock.next(), signer)
    place(event)
    relationRows.push(rowOf(event.id, 'live'))
    counts.replacedRelations += 1
  }

  // ---- R4: live relation rows absent from the projection → retraction --------------------
  for (const [corpus, rows] of ledgerRelationsByCorpus) {
    const desired = desiredRelationIds.get(corpus) ?? new Set<string>()
    for (const row of rows.values()) {
      if (row.state !== 'live' || desired.has(row.relationId)) continue
      pushDeletion(
        row.eventId,
        `Retracted: binding ${row.relationId} — relation absent from the current source projection.`,
      )
      relationRows.push({
        corpus: row.corpus,
        relationId: row.relationId,
        kind: row.kind,
        subjectId: row.subjectId,
        objectKey: row.objectKey,
        fingerprint: row.fingerprint,
        eventId: row.eventId,
        state: 'retracted',
      })
      counts.retractedRelations += 1
    }
  }

  // ---- assembly order (update-semantics §5; kind-5 deletions last) -----------------------
  const orderedNewRoots = [...newRootEvents].sort(
    (a, b) => rootGroupRank(a.root) - rootGroupRank(b.root),
  )
  const events: SignedEvent[] = [
    ...orderedNewRoots.map((entry) => entry.event),
    ...newRelationEvents,
    ...patchEvents,
    ...reRootEntries.flatMap((entry) => [entry.event, ...entry.bindings]),
    ...deletionEvents,
  ]

  return { events, rootRows, relationRows, retractions, counts, warnings }
}
