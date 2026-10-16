/**
 * `@scrutiny-fabric/mirror` — public surface (README §"Package features").
 *
 * One import reaches every unit:
 *   loaders/  stage 0 — source records (this package's entry: {@link loadJcalgtest})
 *   emit/     stage 1 — records → signed events + NDJSON artifacts
 *   gate/     stage 2 — batch verification + rule-2a self-consume
 *   publish/  stage 3 — relay probe + paced NIP-42 publish (NIP-20 into the ledger)
 *   ledger/   bun:sqlite state (schema in `ledger/schema.ts`)
 *   cli.ts    `build:jcalgtest`, `gate`, `probe`, `publish` (exported as {@link cliMain})
 *
 * Contracts are frozen in `types.ts`; consumers should import from here, never from
 * individual modules, so the layout can move without breaking callers.
 */

// ---- frozen contracts ------------------------------------------------------
export * from './types'

// ---- stage 1: emit (barrel curated by the emit unit) -----------------------
export * from './emit/index'

/**
 * Emit internals that consumers (cli self-tests, gate fixtures, tests) use.
 * `gate/selfConsume` defines its own copy of the record-card label and is
 * deliberately not star-exported.
 */
export {
  baseTags,
  iTags,
  kTagsFor,
  composeContent,
  recordCardLine,
  lostFacts,
  assertRule2a,
  assertEventShape,
  FAMILY_LABELS,
  familyList,
  vendorSlug,
  normalizeAtr,
  spacedHex,
  atrIsMasked,
  jcverBuckets,
  JCVER_CUT_POINTS,
} from './emit/content'
export type { EventType } from './emit/content'
export {
  buildBinding,
  buildRunBinding,
  buildCrosslinkBinding,
  buildCorpusBinding,
} from './emit/binding'
export type { BindingSpec } from './emit/binding'
export { buildCardProduct, runLabelsFor } from './emit/cardProduct'
export type { CardProductInput } from './emit/cardProduct'
export { buildCorpusProduct } from './emit/corpusProduct'
export type { CorpusProductInput } from './emit/corpusProduct'
export { buildLeaderboard } from './emit/leaderboard'
export type { LeaderboardInput } from './emit/leaderboard'
export { buildRunMetadata } from './emit/runMetadata'
export type { RunMetadataInput } from './emit/runMetadata'
export { buildSnapshot } from './emit/snapshot'
export type { SnapshotInput } from './emit/snapshot'
export {
  ROCA_CVE,
  ROCA_CHIP_CERT_ID,
  SPINE_CERTS,
  SPINE_CROSSLINKS,
  ROCA_REACHABLE_DGSTS,
  buildSpineNodes,
  buildSpineBindings,
  buildSpineCrosslinkBinding,
} from './emit/advisorySpine'
export type { SpineCert, SpineCrosslink, SpineIndex } from './emit/advisorySpine'

// ---- stage 0: loaders (this unit) ------------------------------------------
export { loadGroundTruth } from './loaders/groundTruth'
export type {
  CrosslinkCandidate,
  CrosslinkCardProfile,
  CrosslinkConfidence,
  CrosslinkEvidenceRow,
  CrosslinkMatrix,
  GroundTruth,
  JcardRow,
  JcardRunFile,
  JcardTable,
  MetricCanonicalization,
  MetricCanonicalKey,
  MetricFileEntry,
  RunTimeline,
  TimelineCard,
  TimelineNewestRun,
  VendorCensusRow,
  VendorTables,
} from './loaders/groundTruth'
export { loadJcalgtest } from './loaders/jcalgtest'
export type { CardMatchLeg, LoadJcalgtestOptions } from './loaders/jcalgtest'

// ---- stage 2: gate ---------------------------------------------------------
export { gateBatch, gateEvents } from './gate/index'
export type { GateBatchOptions, GateBatchResult, GateEventsResult } from './gate/index'
export * from './gate/verify'
export * from './gate/scorer'
export { selfConsume } from './gate/selfConsume'
export type { LostFact, SelfConsumeResult } from './gate/selfConsume'

// ---- stage 3: ledger + publish ---------------------------------------------
export * from './ledger/index'
export { rowToRecord, rowToPublishLog, rowToRelay } from './ledger/schema'
export type { RecordDbRow, PublishLogDbRow, RelayDbRow } from './ledger/schema'
export * from './publish/index'
export * from './publish/auth'
export * from './publish/probe'

// ---- CLI (same entry points as `bun src/cli.ts …`) -------------------------
export { main as cliMain } from './cli'
