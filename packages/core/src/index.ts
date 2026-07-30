/**
 * `@scrutiny-fabric/core` — reference implementation of the SCRUTINY Fabric protocol.
 *
 * Target specification: **v0.6.1** (`scrutiny-v061`), 139 normative rules.
 *
 * This root barrel is the primary documented import (D5). Subpath exports exist only where they buy
 * a consumer graph exclusion, never as organisation.
 *
 * Two structural properties of this package, both load-bearing:
 *
 * - It contains no cryptography and never handles a secret key (D12). Where a hash is needed the
 *   caller injects it — see {@link eventIdMatches}.
 * - It performs no IO. Relay access, storage, and signing are the caller's, behind interfaces.
 */

export { SPEC_VERSION, VERSION_TAG } from './version.js'

export {
  EVENT_TYPE_TAGS,
  FABRIC_TAG,
  INDEXER_PREFIX_PATTERN,
  SCRUTINY_KIND,
  VERSION_TAG_PATTERN,
  compareVersionTags,
  derivedIndexerKinds,
  eTags,
  eTagsWithMarker,
  indexerKinds,
  indexers,
  isScrutinyEvent,
  parseIndexer,
  parseVersionTag,
  scrutinyEventType,
  tTags,
  tagValues,
  versionTag,
  versionTags,
  type ETagRef,
  type Indexer,
  type IndexedEventType,
  type NostrEvent,
  type ProtocolVersion,
  type ScrutinyEventType,
  type UnsignedEvent,
} from './events.js'

export { computeEventId, eventIdMatches, serializeForId, type Sha256Hex } from './id.js'

export {
  findFencedBlocks,
  findPatchPayload,
  validateEvent,
  type ValidateOptions,
  type Validity,
} from './validate.js'

/**
 * Chain resolution. Note the applier itself (`patch.ts`) is deliberately **not** exported (D32) —
 * exposing it invites callers to bypass the T1/T2/T3 determinism gate §5.3 requires. `resolve` is
 * the supported way to reach patched content.
 */
export {
  resolve,
  type Annotation,
  type ChainState,
  type ForkBranch,
  type Overlay,
  type OverlayState,
  type ResolveOptions,
  type Resolution,
} from './resolve.js'

export { hasError, issue, ruleOf, type Issue, type Severity } from './errors.js'

/**
 * Trust admission — reason sets, refcounting, and the `TrustedView`/`OpenView` distinction (D22).
 * `TrustProvider` (D21) is re-exported here rather than from its own subpath: it is one of D16's
 * four extension interfaces, not a rule-bearing module, so it has no `exports` entry of its own.
 */
export {
  EMPTY_ADMIT_STATE,
  applyDelta,
  bindingReason,
  computeAdmission,
  invertDelta,
  isAdmitted,
  isDefaultViewRetracted,
  openView,
  reasonKind,
  rootChainReason,
  toIndex,
  trustedView,
  visibleOverlays,
  type AdmissionDelta,
  type AdmissionIndex,
  type AdmissionView,
  type AdmitState,
  type ForwardDelta,
  type Reason,
} from './admit.js'

export {
  storageSymbol,
  trustSymbol,
  type EventFilter,
  type EventStorage,
  type TrustProvider,
} from './interfaces.js'

/**
 * Reducer + `EventStorage` port + epoch bookkeeping (D15) — the fifth module, tying `patch`,
 * `resolve`, and `admit` together. `createStore` is the ergonomic entry point; `applyStoreDelta` is
 * the pure reducer underneath it that SG1/SG2's gates exercise directly.
 */
export {
  EMPTY_STORE_STATE,
  applyStoreDelta,
  bindingRejectionIssue,
  createInMemoryEventStorage,
  createResolveMemo,
  createStore,
  resolveRoot,
  sig1RejectionIssue,
  toStoreView,
  type AddResult,
  type CreateStoreOptions,
  type IngestMeta,
  type RejectedEvent,
  type ResolveMemo,
  type Store,
  type StoreDelta,
  type StoreState,
  type StoreView,
} from './store.js'

export {
  RULES,
  RULE_IDS,
  isRuleId,
  type Rule,
  type RuleId,
  type RuleLayer,
} from './rules.js'

/**
 * §8 discovery/traversal filter builders and result classifiers (D34 partition: `docs/QUERY-BUILD.md`
 * §4). Plain NIP-01 `EventFilter` objects out, no relay I/O, no async.
 */
export {
  bindingsReferencing,
  classifyByRole,
  deletionsFor,
  fullScanFilter,
  indexerFilter,
  searchFilter,
  type RoleMatch,
} from './query.js'

/**
 * Unsigned event templates (D13) — `id`/`pubkey`/`sig` are the injected signer's job, never this
 * module's.
 */
export {
  buildBinding,
  buildMetadata,
  buildPatch,
  buildProduct,
  fenceLength,
  fencePatchPayload,
  type BuildResult,
  type EndpointRef,
} from './build.js'
