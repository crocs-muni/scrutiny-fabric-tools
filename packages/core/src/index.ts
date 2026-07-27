/**
 * `@scrutiny-fabric/core` — reference implementation of the SCRUTINY Fabric protocol.
 *
 * Target specification: **v0.6.0** (`scrutiny-v060`), 134 normative rules.
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

export { hasError, issue, ruleOf, type Issue, type Severity } from './errors.js'

export {
  RULES,
  RULE_IDS,
  isRuleId,
  type Rule,
  type RuleId,
  type RuleLayer,
} from './rules.js'
