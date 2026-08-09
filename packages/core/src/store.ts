/**
 * §7.6/§4.3 ingestion, §10 deletion retention, §6 admission threading — the reducer, `EventStorage`
 * port, and epoch bookkeeping that ties `patch`, `resolve`, and `admit` together (D15).
 *
 * `store` does not reimplement chain resolution or admission; `resolve`/`admit` stay exactly as pure
 * as they are, and are the conformance oracle (D29) every incremental path here must agree with.
 * This module's entire job is: gating what reaches either function (verification, dedup), and
 * knowing when a cached answer is still good (the three D24 epochs).
 *
 * The design, including the pending-reference buffer's actual shape, the epoch data structure, why
 * BD-7's rejection cache and DEL-8/9's deletion cache cannot cross-contaminate, and a design gap
 * found and fixed before any code existed, is in `docs/STORE.md`. Phase 14
 * (`docs/VALIDATION-WIRING.md`) wires `validateEvent` into the observe path, generalizing the
 * Binding-only `rejectedBindings`/`bindingsAwaiting` fields into rule-agnostic `invalidIds`/
 * `pendingAwaiting` and excluding `invalidIds` from `resolveRoot`'s event feed. Phase 15
 * (`docs/OVERLAY-AWAITING.md`) adds the `overlayAwaiting` reverse index that closes the resolve-memo
 * staleness gap (D24/C10). Phase 16 (`docs/TRUST-VIEW.md`) adds `admissionView()`/`viewRoot()` — the
 * store's own trust-filtered overlay view, composing `resolveRoot` with `trustedView`/`visibleOverlays`.
 */

import {
  type AdmissionIndex,
  type AdmissionView,
  type AdmitState,
  EMPTY_ADMIT_STATE,
  applyDelta as applyAdmitDelta,
  toIndex,
  trustedView,
  visibleOverlays,
} from './admit.js'
import { type Issue, issue } from './errors.js'
import {
  DELETION_KIND,
  EVENT_TYPE_TAGS,
  type NostrEvent,
  eTags,
  replyTarget,
  rootTarget,
  scrutinyEventType,
  tagValues,
} from './events.js'
import type { EventFilter, EventStorage } from './interfaces.js'
import { storageSymbol } from './interfaces.js'
import type { ApplyOptions } from './patch-types.js'
import { toNullProtoRecord } from './records.js'
import { type Resolution, type ResolveOptions, resolve } from './resolve.js'
import { validateEvent } from './validate.js'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Plain data — no methods, no closures (D43's precedent, same discipline as `Resolution`/
 * `AdmissionIndex`). SG1 compares a projection of this (`StoreView`, below), not this type directly
 * — see `docs/STORE.md` §3's correction and §9.
 */
export interface StoreState {
  /**
   * admit.ts's own state, threaded through unmodified. Deliberately the *only* copy of the raw
   * event cache: `AdmitState.observedById` already is D38's "cache raw events, never resolved
   * content," so nothing here duplicates it.
   */
  readonly admit: AdmitState

  /**
   * Every id whose current V-verdict is `'invalid'` (VALIDATION-WIRING.md §3). Generalizes the
   * pre-Phase-14 `rejectedBindings` — BD-7 was never a special case, it was the only rejection rule
   * `store` happened to check before every V rule was wired through `validateEvent`. Sorted, for
   * deep-equality-friendly plain data. Monotone: no V rule re-examines an already-resolved
   * dependency and reverses course, so nothing is ever removed from this set on `unobserve` either
   * — "current" is therefore the verdict as of the event's lifetime in the observed set; the set
   * may contain ids no longer observed and is not a subset of `observedById`.
   */
  readonly invalidIds: readonly string[]

  /** Patch/overlay event id → the root id it declared via `e root`. See STORE.md §2. */
  readonly chainMembership: Readonly<Record<string, string>>
  /**
   * Awaited event id → ids of events whose V-verdict is still `'pending'` on it
   * (VALIDATION-WIRING.md §2). Generalizes the pre-Phase-14 `bindingsAwaiting` (Binding-endpoint-only)
   * into a rule-agnostic buffer driven entirely by `validateEvent`'s own `awaiting` field — BD-6's
   * two endpoints, UR-2's patch root, and PT-7's foreign-overlay reply target are three instances of
   * one mechanism, not three separate ones.
   */
  readonly pendingAwaiting: Readonly<Record<string, readonly string[]>>
  /**
   * Overlay-reply target id → root id(s) whose resolution reads that target's observedness.
   * See docs/OVERLAY-AWAITING.md §3/§4. Never cleared, in either direction.
   */
  readonly overlayAwaiting: Readonly<Record<string, readonly string[]>>

  readonly trustEpoch: number
  readonly observedEpoch: number
  /** Per-root chain epoch. Bump count is arrival-order-dependent by design — STORE.md §3/§10. */
  readonly chainEpoch: Readonly<Record<string, number>>
}

export const EMPTY_STORE_STATE: StoreState = Object.freeze({
  admit: EMPTY_ADMIT_STATE,
  invalidIds: Object.freeze([]),
  chainMembership: Object.freeze(Object.create(null) as Record<string, string>),
  pendingAwaiting: Object.freeze(Object.create(null) as Record<string, readonly string[]>),
  overlayAwaiting: Object.freeze(Object.create(null) as Record<string, readonly string[]>),
  trustEpoch: 0,
  observedEpoch: 0,
  chainEpoch: Object.freeze(Object.create(null) as Record<string, number>),
})

/**
 * The confluence-tested projection (STORE.md §3/§9). Excludes `chainEpoch`/`chainMembership`/
 * `pendingAwaiting`/`overlayAwaiting`, whose exact values are legitimately arrival-order-dependent
 * cache bookkeeping — the same move `admit.ts`'s own `toIndex` makes over `AdmitState`'s order-sensitive
 * `liveBindings`.
 */
export interface StoreView {
  readonly observedIds: readonly string[]
  readonly admission: AdmissionIndex
  readonly invalidIds: readonly string[]
}

export function toStoreView(state: StoreState): StoreView {
  return {
    observedIds: Object.keys(state.admit.observedById).sort(),
    admission: toIndex(state.admit),
    invalidIds: state.invalidIds,
  }
}

// ---------------------------------------------------------------------------
// The pending-reference buffer (VALIDATION-WIRING.md §2) — rule-agnostic, driven by
// `validateEvent`'s own `awaiting` field for any V rule that produces one.
// ---------------------------------------------------------------------------

function addAwaiting(awaiting: Map<string, Set<string>>, awaitedId: string, eventId: string): void {
  const set = awaiting.get(awaitedId)
  if (set) set.add(eventId)
  else awaiting.set(awaitedId, new Set([eventId]))
}

function removeAwaiting(
  awaiting: Map<string, Set<string>>,
  awaitedId: string,
  eventId: string,
): void {
  const set = awaiting.get(awaitedId)
  if (set === undefined) return
  set.delete(eventId)
  if (set.size === 0) awaiting.delete(awaitedId)
}

/**
 * Runs `validateEvent` once and folds the verdict into `invalidIds`/`pendingAwaiting`
 * (VALIDATION-WIRING.md §2/§3) — the single place this reducer decides what the V layer currently
 * says about an event. `checkBindingTyping`'s hand-rolled BD-3/BD-4/BD-7 comparison is gone: this
 * calls the public `validateEvent`, which dispatches to `checkBinding` (and every other per-type
 * checker) internally, so there is exactly one implementation of each rule, not two.
 */
function applyVerdict(
  event: NostrEvent,
  observedById: Readonly<Record<string, NostrEvent>>,
  pendingAwaiting: Map<string, Set<string>>,
  invalidIds: Set<string>,
): void {
  const verdict = validateEvent(event, { lookupEvent: (id) => observedById[id] })
  if (verdict.status === 'invalid') {
    invalidIds.add(event.id)
  } else if (verdict.status === 'pending') {
    for (const id of verdict.awaiting) addAwaiting(pendingAwaiting, id, event.id)
  }
}

// ---------------------------------------------------------------------------
// The pure reducer
// ---------------------------------------------------------------------------

/**
 * Deltas that have already passed the verification/dedup gate (§5's job, in `createStore`'s `add`) —
 * this reducer assumes every event in an `observe` delta is admissible content, and only handles
 * *idempotent re-delivery*, never verification. Mirrors `admit.ts`'s `AdmissionDelta` shape.
 */
export type StoreDelta =
  | { readonly kind: 'observe'; readonly events: readonly NostrEvent[] }
  | { readonly kind: 'unobserve'; readonly eventIds: readonly string[] }
  | { readonly kind: 'trust'; readonly pubkeys: readonly string[] }
  | { readonly kind: 'untrust'; readonly pubkeys: readonly string[] }

function bump(epochs: Map<string, number>, id: string): void {
  epochs.set(id, (epochs.get(id) ?? 0) + 1)
}

/**
 * STORE.md §3's per-event chain-epoch table: which root id(s) does this event's own arrival *or*
 * removal affect. Shared by `processObservedEvent` (observe) and the `unobserve` loop below, which
 * previously hand-duplicated this dispatch — the one real asymmetry between the two callers is
 * *how* a kind-5 deletion's target resolves to an owning root (a live `chainMembership` Map being
 * built during observe vs. the frozen `state.chainMembership` snapshot during unobserve), which is
 * why that lookup is the one thing parameterised rather than shared outright. Phase 15
 * (docs/OVERLAY-AWAITING.md) adds a third parameter for the overlay-awaiting reverse index.
 */
function chainEpochTargets(
  event: NostrEvent,
  lookupOwningRoot: (id: string) => string | undefined,
  lookupOverlayAwaiting: (id: string) => Iterable<string> | undefined,
): readonly string[] {
  const targets: string[] = []
  const type = scrutinyEventType(event)

  if (type === 'product' || type === 'metadata') {
    targets.push(event.id)
  } else if (type === 'patch') {
    const root = rootTarget(event)
    if (root !== undefined) targets.push(root)
  } else if (event.kind === DELETION_KIND) {
    for (const ref of eTags(event)) {
      const owningRoot = lookupOwningRoot(ref.id)
      if (owningRoot !== undefined) targets.push(owningRoot)
      targets.push(ref.id) // unconditional — covers target-is-itself-a-root (DEL-4)
    }
  }
  // New row from Phase 15 — unconditional, every event type, keyed by the arriving/departing event's OWN id.
  for (const root of lookupOverlayAwaiting(event.id) ?? []) targets.push(root)

  return targets
}

/**
 * The per-event chainMembership/chainEpoch bookkeeping in STORE.md §3, plus the V-layer verdict
 * wiring (VALIDATION-WIRING.md §2) that populates/drains `invalidIds`/`pendingAwaiting`. Phase 15
 * (docs/OVERLAY-AWAITING.md) adds `overlayAwaiting` population and lookup.
 */
function processObservedEvent(
  event: NostrEvent,
  observedById: Readonly<Record<string, NostrEvent>>,
  chainMembership: Map<string, string>,
  pendingAwaiting: Map<string, Set<string>>,
  chainEpoch: Map<string, number>,
  invalidIds: Set<string>,
  overlayAwaiting: Map<string, Set<string>>,
): void {
  const type = scrutinyEventType(event)

  if (type === 'patch') {
    const root = rootTarget(event)
    if (root !== undefined) chainMembership.set(event.id, root)
    const target = replyTarget(event)
    if (target !== undefined && root !== undefined) addAwaiting(overlayAwaiting, target, root)
  }

  for (const id of chainEpochTargets(
    event,
    (refId) => chainMembership.get(refId),
    (id) => overlayAwaiting.get(id),
  )) {
    bump(chainEpoch, id)
  }

  applyVerdict(event, observedById, pendingAwaiting, invalidIds)

  // This event's own id may be an id some other, already-observed event's V-verdict is still
  // awaiting (BD-6's two endpoints, UR-2's patch root, PT-7's foreign-overlay reply target).
  const waiting = pendingAwaiting.get(event.id)
  if (waiting !== undefined) {
    for (const pendingId of [...waiting]) {
      // Remove only this one resolved slot (VALIDATION-WIRING.md §2) — a still-unresolved awaited
      // id from an earlier partial check is re-derived, not pruned, by the re-validation below.
      removeAwaiting(pendingAwaiting, event.id, pendingId)
      const pendingEvent = observedById[pendingId]
      if (pendingEvent === undefined) continue
      applyVerdict(pendingEvent, observedById, pendingAwaiting, invalidIds)
      // A previously-pending event's verdict resolving on this arrival can itself change a root's
      // resolve() output — the same chain-epoch bump a first-time observation already gets.
      // Bindings need no special-case guard here (BD-9): chainEpochTargets already returns `[]` for
      // one, so this is provably a no-op for them, not a case requiring its own branch.
      for (const root of chainEpochTargets(
        pendingEvent,
        (refId) => chainMembership.get(refId),
        (id) => overlayAwaiting.get(id),
      )) {
        bump(chainEpoch, root)
      }
    }
  }
}

function recordToMap<T>(record: Readonly<Record<string, T>>): Map<string, T> {
  return new Map(Object.entries(record))
}

function recordToSetMap(
  record: Readonly<Record<string, readonly string[]>>,
): Map<string, Set<string>> {
  return new Map(Object.entries(record).map(([k, v]) => [k, new Set(v)]))
}

function setMapToSortedRecord(
  map: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, readonly string[]> {
  return toNullProtoRecord([...map].map(([k, v]) => [k, [...v].sort()] as const))
}

/**
 * Apply one delta to `state`, returning the new state. Pure and synchronous — no IO, matching
 * `admit.ts`'s `applyDelta` shape exactly, which is what makes SG1/SG2 directly testable in-process.
 */
export function applyStoreDelta(state: StoreState, delta: StoreDelta): StoreState {
  switch (delta.kind) {
    case 'observe': {
      if (delta.events.length === 0) return state
      const priorObserved = state.admit.observedById
      // Only tracks ids newly seen *within this batch* — membership against everything already
      // observed is a direct lookup on `priorObserved` instead of first materialising every prior
      // id into a Set, which would cost O(total observed) on every single call regardless of how
      // small the incoming batch is.
      const newlySeen = new Set<string>()
      const admitAfter = applyAdmitDelta(state.admit, { kind: 'observe', events: delta.events })

      const chainMembership = recordToMap(state.chainMembership)
      const pendingAwaiting = recordToSetMap(state.pendingAwaiting)
      const overlayAwaiting = recordToSetMap(state.overlayAwaiting)
      const chainEpoch = recordToMap(state.chainEpoch)
      const invalidIds = new Set(state.invalidIds)

      for (const event of delta.events) {
        if (Object.hasOwn(priorObserved, event.id) || newlySeen.has(event.id)) continue
        newlySeen.add(event.id)
        processObservedEvent(
          event,
          admitAfter.observedById,
          chainMembership,
          pendingAwaiting,
          chainEpoch,
          invalidIds,
          overlayAwaiting,
        )
      }

      return {
        admit: admitAfter,
        invalidIds: [...invalidIds].sort(),
        chainMembership: toNullProtoRecord(chainMembership),
        pendingAwaiting: setMapToSortedRecord(pendingAwaiting),
        overlayAwaiting: setMapToSortedRecord(overlayAwaiting),
        trustEpoch: state.trustEpoch,
        observedEpoch: state.observedEpoch + 1,
        chainEpoch: toNullProtoRecord(chainEpoch),
      }
    }

    case 'unobserve': {
      if (delta.eventIds.length === 0) return state

      // Snapshot pending-awaiting registrations and chain membership BEFORE folding into admit,
      // whose observedById is about to lose these ids.
      const pendingAwaiting = recordToSetMap(state.pendingAwaiting)
      const chainEpoch = recordToMap(state.chainEpoch)

      for (const id of delta.eventIds) {
        const event = state.admit.observedById[id]
        if (event === undefined) continue

        // If this event's own V-verdict was pending, stop waiting for whatever it awaited — it can
        // no longer resolve to anything once it leaves the observed set (VALIDATION-WIRING.md §2's
        // generalization of the pre-Phase-14 BD-6-only cleanup). `invalidIds` needs no equivalent
        // cleanup (VALIDATION-WIRING.md §4): a verdict already resolved to `invalid` is permanent —
        // no V rule re-examines an already-resolved dependency and reverses course — and it simply
        // also leaves `observedById`, at which point `resolveRoot`'s exclusion filter is moot for it.
        const verdict = validateEvent(event, {
          lookupEvent: (refId) => state.admit.observedById[refId],
        })
        if (verdict.status === 'pending') {
          for (const awaitedId of verdict.awaiting) removeAwaiting(pendingAwaiting, awaitedId, id)
        }

        // Symmetric to observe (STORE.md §3): removing an event can affect a root's resolve()
        // output too, so the same epoch(s) that would have been bumped on arrival bump on removal.
        // Phase 15 adds the overlayAwaiting lookup — never mutated on unobserve (docs/OVERLAY-AWAITING.md §4).
        for (const target of chainEpochTargets(
          event,
          (refId) => state.chainMembership[refId],
          (id) => state.overlayAwaiting[id],
        )) {
          bump(chainEpoch, target)
        }
      }

      const admitAfter = applyAdmitDelta(state.admit, {
        kind: 'unobserve',
        eventIds: delta.eventIds,
      })

      return {
        admit: admitAfter,
        invalidIds: state.invalidIds, // monotone — never touched on unobserve
        chainMembership: state.chainMembership, // stale-but-still-correct entries left in place
        pendingAwaiting: setMapToSortedRecord(pendingAwaiting),
        overlayAwaiting: state.overlayAwaiting, // never mutated on unobserve either dimension
        trustEpoch: state.trustEpoch,
        observedEpoch: state.observedEpoch + 1,
        chainEpoch: toNullProtoRecord(chainEpoch),
      }
    }

    case 'trust': {
      if (delta.pubkeys.length === 0) return state
      return {
        ...state,
        trustEpoch: state.trustEpoch + 1,
        admit: applyAdmitDelta(state.admit, { kind: 'trust', pubkeys: delta.pubkeys }),
      }
    }

    case 'untrust': {
      if (delta.pubkeys.length === 0) return state
      return {
        ...state,
        trustEpoch: state.trustEpoch + 1,
        admit: applyAdmitDelta(state.admit, { kind: 'untrust', pubkeys: delta.pubkeys }),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The Resolution memo (D28/D38) — beside StoreState, not inside it (STORE.md §6)
// ---------------------------------------------------------------------------

interface MemoEntry {
  readonly epoch: number
  readonly optionsKey: string
  readonly resolution: Resolution
}

/** Opaque to callers beyond `createResolveMemo`/`resolveRoot` — never compared for confluence. */
export interface ResolveMemo {
  readonly entries: Map<string, MemoEntry>
  /**
   * The materialised event array shares across every root as long as `observedEpoch` hasn't
   * moved. Gate on the epoch, not on `observedById` identity: `applyStoreDelta` produces a fresh
   * `observedById` object on *every* delta kind (including `trust`/`untrust`, which never touch
   * its content), so identity comparison cannot distinguish "observed set changed" from "any delta
   * happened" — `observedEpoch` bumps only on `observe`/`unobserve`. Without this cache,
   * resolving R roots after one ingest batch would re-materialise the same, unchanged observed
   * set R times over.
   */
  eventsCache?: {
    readonly observedEpoch: number
    readonly events: readonly NostrEvent[]
  }
}

export function createResolveMemo(): ResolveMemo {
  return { entries: new Map() }
}

function optionsKeyOf(options: ResolveOptions | undefined): string {
  return JSON.stringify(options?.apply ?? null)
}

/**
 * Reads a root through the epoch-gated memo, recomputing via `resolve()` only when absent or when
 * `chainEpoch[rootId]` has moved since the cached entry (STORE.md §6). Trust is deliberately not part
 * of the key or the cache at all (D26's precedent) — `overlays` here is every overlay in the observed
 * set, unfiltered. For a trust-filtered overlay view, use `Store.viewRoot` (or `admissionView()` +
 * `visibleOverlays`) — see docs/TRUST-VIEW.md.
 */
export function resolveRootMemoized(
  state: StoreState,
  rootId: string,
  memo: ResolveMemo,
  options?: ResolveOptions,
): Resolution {
  const epoch = state.chainEpoch[rootId] ?? 0
  const optionsKey = optionsKeyOf(options)
  const cached = memo.entries.get(rootId)

  if (cached !== undefined && cached.epoch === epoch && cached.optionsKey === optionsKey) {
    return cached.resolution
  }

  // Excludes `invalidIds` (VALIDATION-WIRING.md §4) — no separate cache key is needed for it: the
  // only way `invalidIds` changes is within an `observe` delta, and every `observe` delta bumps
  // `observedEpoch`, so the epoch gate below already re-filters exactly when `invalidIds` could
  // have changed.
  if (memo.eventsCache?.observedEpoch !== state.observedEpoch) {
    const invalid = new Set(state.invalidIds)
    memo.eventsCache = {
      observedEpoch: state.observedEpoch,
      events: Object.values(state.admit.observedById).filter((e) => !invalid.has(e.id)),
    }
  }
  const resolution = resolve(rootId, memo.eventsCache.events, options)
  memo.entries.set(rootId, { epoch, optionsKey, resolution })
  return resolution
}

// ---------------------------------------------------------------------------
// Verification and dedup (D18/D19/D20, SIG-1 enforcement) — STORE.md §5
// ---------------------------------------------------------------------------

export interface CreateStoreOptions {
  /** REQUIRED, no default (D18). Covers signature AND id recompute (SIG-1). */
  readonly verify: (event: NostrEvent) => boolean
  /** D37: in-memory default when omitted. */
  readonly storage?: EventStorage
  /** RL-2's configuration half — threaded to every internal `resolve()` call. */
  readonly applyOptions?: ApplyOptions
}

export interface IngestMeta {
  /**
   * Part of D19's mandated call shape (`store.add(events, {source, verified})`) — not yet read by
   * `add()` itself. Reserved for a future consumer (e.g. per-relay provenance/audit logging); the
   * field exists now so that shape doesn't become a breaking addition later.
   */
  readonly source?: string
  /** The caller already ran an equivalent verify() over this batch — skip re-running it (D19). */
  readonly verified?: boolean
  /** The actual bypass, named apart from `verified` so misuse is grep-able in review (D18/D19). */
  readonly trustUnverified?: boolean
}

export interface RejectedEvent {
  readonly event: NostrEvent
  readonly issues: readonly Issue[]
}

/** An event whose V-verdict is `pending` — `validateEvent`'s own `awaiting`, verbatim. */
export interface PendingEvent {
  readonly event: NostrEvent
  readonly awaiting: readonly string[]
  readonly issues: readonly Issue[]
}

/**
 * `accepted` answers "did this id get folded into `applyStoreDelta`'s `observe` case" — a storage
 * question, never a validity one (VALIDATION-WIRING.md §0/§1): every event that passes the SIG-1
 * gate is accepted, full stop, regardless of what `validateEvent` later says about it. A validator
 * bug must never be indistinguishable from a real protocol violation by silently discarding the
 * event — the DEL-4 "never silently drop, preserve for audit" argument, applied to this failure mode.
 *
 * `rejected`/`pending` answer "what does the V layer currently say about this id," and are NOT
 * mutually exclusive with `accepted`: an id whose verdict is `'invalid'` or `'pending'` is still
 * folded into storage, so it appears in `accepted` too. The one case `rejected` does not imply
 * `accepted`: a SIG-1 failure never reaches `applyStoreDelta` at all, so its id is `rejected`-only.
 * `rejected` and `pending` never overlap each other for the same id — `validateEvent` checks
 * `hasError` before checking `awaiting.length`, so a single verdict cannot be both.
 */
export interface AddResult {
  readonly accepted: readonly string[]
  readonly rejected: readonly RejectedEvent[]
  readonly pending: readonly PendingEvent[]
}

/**
 * SIG-1's enforcement-half rejection issue (§8's `emitted` entry). Exported so SG4's coverage test
 * can construct it directly over a synchronous scenario rather than through `add()`'s async wrapper
 * — it is the identical function `add()` itself calls, not a re-derivation of the same logic.
 */
export const sig1RejectionIssue = (event: NostrEvent): Issue =>
  issue(
    'SIG-1',
    'error',
    `event ${event.id}: failed signature/id verification and was not admitted`,
  )

export interface ViewRootOptions extends ResolveOptions {
  /**
   * Filters `Resolution.overlays` (OV-7). Defaults to `admissionView()` — this Store's own current
   * trust state. Pass `openView` (re-exported from the barrel already, D22) explicitly for the
   * "show everything" audit case. There is no boolean escape hatch: D22 rules out a bypass flag for
   * exactly this reason, and that rule applies one layer up here as much as it did inside `admit.ts`.
   */
  readonly admission?: AdmissionView
}

export interface Store {
  add(events: readonly NostrEvent[], meta?: IngestMeta): Promise<AddResult>
  unobserve(eventIds: readonly string[]): Promise<void>
  trust(pubkeys: readonly string[]): void
  untrust(pubkeys: readonly string[]): void
  resolveRoot(rootId: string, options?: ResolveOptions): Resolution
  /** The current trust view of this Store's admit state, for OV-7 overlay filtering (TRUST-VIEW.md §2). */
  admissionView(): AdmissionView
  /**
   * A trust-filtered resolution: `resolveRoot` followed by filtering ONLY `overlays` through
   * `visibleOverlays` with the given (or defaulted) admission view — D25/TR-7, so `chain`/
   * `pending`/`annotations` are never gated on trust (docs/TRUST-VIEW.md §2).
   */
  viewRoot(rootId: string, options?: ViewRootOptions): Resolution
  getState(): StoreState
}

/**
 * The in-memory default (D37) — exported so it's independently constructible (a consumer wiring an
 * app together explicitly, or a test exercising `query`/`get` directly) rather than reachable only
 * as `createStore`'s invisible fallback.
 */
/**
 * DEL-1 (pubkey must match the target's) / DEL-6 (a kind 5 cannot itself be deleted) — the same
 * raw predicate `resolve.ts`'s own `honouredDeletions` applies, kept local here rather than shared
 * since this is a storage-level, non-cascading check (STORE.md §7): "is this exact event targeted by
 * an honoured kind 5," never chain-topology-aware. DEL-2's canonical-descendant cascade stays
 * `resolve.ts`'s job — nothing here re-derives it.
 */
function honouredlyDeletedIds(byId: ReadonlyMap<string, NostrEvent>): Set<string> {
  const deleted = new Set<string>()
  for (const event of byId.values()) {
    if (event.kind !== DELETION_KIND) continue
    for (const ref of eTags(event)) {
      const target = byId.get(ref.id)
      if (target === undefined) continue // DEL-8 — not yet available, nothing to hide yet
      if (target.kind === DELETION_KIND) continue // DEL-6
      if (target.pubkey !== event.pubkey) continue // DEL-1
      deleted.add(ref.id)
    }
  }
  return deleted
}

/**
 * Phase 21 (mandate §14, `AUDIT-2026-07-31.md` §5): the default in-memory adapter gets real
 * indexes instead of one `Map` plus a full scan per filter — by `kind`, by exact `i`-tag value,
 * by `e`-tag reference, and by `t`-tag **restricted to the four event-type tags**. Applicable
 * indexes are *intersected* per filter, never welshman's fixed-priority-first-index-no-intersect
 * shape the audit measured (every `query.ts` filter carries both a `#t` and a `kinds` key, so a
 * tag-first index's commonest bucket holds every row). Non-discriminating `#t` values (the fabric
 * and version tags, 100%-of-rows keys) never prune; the full `matchesFilter` predicate still runs
 * on the pruned candidates, so pruning can only ever skip events that cannot match.
 *
 * Ordering is deliberately unchanged: candidate pruning narrows the *predicate* work, never the
 * iteration — output arrays remain byte-identical to the pre-index implementation, which the
 * differential property (`storage.test`-side) asserts rather than assumes. The deletion-hiding
 * scan is cached, and `put` invalidates it only on the three transitions that can change it — a
 * kind-5 arrival, a replacement of an already-stored id, or the late arrival of an honoured
 * deletion's own target — never on every write (2026-08-08 audit, S3-24).
 */
export function createInMemoryEventStorage(): EventStorage {
  const byId = new Map<string, NostrEvent>()
  const kindIdx = new Map<number, Set<string>>()
  const typeTagIdx = new Map<string, Set<string>>()
  const iTagIdx = new Map<string, Set<string>>()
  const eTagIdx = new Map<string, Set<string>>()
  let deletedCache: Set<string> | undefined

  const TYPE_TAG_VALUES = new Set<string>(Object.values(EVENT_TYPE_TAGS))

  const idxAdd = <K>(idx: Map<K, Set<string>>, key: K, id: string): void => {
    idx.get(key)?.add(id) ?? idx.set(key, new Set([id]))
  }
  const idxDrop = <K>(idx: Map<K, Set<string>>, key: K, id: string): void => {
    const set = idx.get(key)
    if (set === undefined) return
    set.delete(id)
    if (set.size === 0) idx.delete(key)
  }

  const indexEvent = (event: NostrEvent): void => {
    idxAdd(kindIdx, event.kind, event.id)
    for (const t of tagValues(event, 't')) {
      if (TYPE_TAG_VALUES.has(t)) idxAdd(typeTagIdx, t, event.id)
    }
    for (const i of tagValues(event, 'i')) idxAdd(iTagIdx, i, event.id)
    for (const ref of eTags(event)) idxAdd(eTagIdx, ref.id, event.id)
  }
  const unindexEvent = (event: NostrEvent): void => {
    idxDrop(kindIdx, event.kind, event.id)
    for (const t of tagValues(event, 't')) {
      if (TYPE_TAG_VALUES.has(t)) idxDrop(typeTagIdx, t, event.id)
    }
    for (const i of tagValues(event, 'i')) idxDrop(iTagIdx, i, event.id)
    for (const ref of eTags(event)) idxDrop(eTagIdx, ref.id, event.id)
  }

  /**
   * The id set a filter can safely be pruned to, or `undefined` when no index applies. Each
   * produced bucket is a superset of that key's true matches, so intersecting them loses nothing
   * `matchesFilter` would accept.
   */
  const candidateIds = (filter: EventFilter): ReadonlySet<string> | undefined => {
    const buckets: ReadonlySet<string>[] = []
    if (filter.ids !== undefined) buckets.push(new Set(filter.ids))
    if (filter.kinds !== undefined) {
      const s = new Set<string>()
      for (const k of filter.kinds) for (const id of kindIdx.get(k) ?? []) s.add(id)
      buckets.push(s)
    }
    const tagBucket = (
      key: '#t' | '#i' | '#e',
      idx: ReadonlyMap<string, ReadonlySet<string>>,
      discriminating: boolean,
    ): void => {
      const values = (filter as Readonly<Record<string, readonly string[] | undefined>>)[key]
      if (values === undefined) return
      if (discriminating) {
        // `#t` prunes only when EVERY listed value is a type tag: within a key NIP-01 is OR, so a
        // mixed list (type + fabric) could match via the uniform fabric tag — no safe pruning.
        if (values.length === 0 || !values.every((v) => TYPE_TAG_VALUES.has(v))) return
      }
      const s = new Set<string>()
      for (const v of values) for (const id of idx.get(v) ?? []) s.add(id)
      buckets.push(s)
    }
    tagBucket('#t', typeTagIdx, true)
    tagBucket('#i', iTagIdx, false)
    tagBucket('#e', eTagIdx, false)
    if (buckets.length === 0) return undefined

    // Intersect by iterating the smaller side of each pair. Buckets are superset-safe, so the
    // result is a superset of the true matches — never a subset of them.
    let result: ReadonlySet<string> = buckets[0] as ReadonlySet<string>
    for (const next of buckets.slice(1)) {
      const [small, big] = next.size < result.size ? [next, result] : [result, next]
      const pruned = new Set<string>()
      for (const id of small) if (big.has(id)) pruned.add(id)
      result = pruned
    }
    return result
  }

  return {
    [storageSymbol]: true,
    put(events) {
      for (const e of events) {
        const old = byId.get(e.id)
        if (old !== undefined) {
          unindexEvent(old)
          deletedCache = undefined
        } else if (e.kind === DELETION_KIND) {
          deletedCache = undefined
        } else {
          // A newly-arriving event can flip an already-stored kind-5 to *honoured* (DEL-1) when
          // the deletion was observed before its target.
          for (const referrerId of eTagIdx.get(e.id) ?? []) {
            const d = byId.get(referrerId)
            if (d !== undefined && d.kind === DELETION_KIND && d.pubkey === e.pubkey) {
              deletedCache = undefined
              break
            }
          }
        }
        byId.set(e.id, e)
        indexEvent(e)
      }
    },
    query(filters, options) {
      const includeDeleted = options?.includeDeleted ?? false
      if (!includeDeleted && deletedCache === undefined) {
        deletedCache = honouredlyDeletedIds(byId)
      }
      const deletedIds = includeDeleted ? undefined : deletedCache
      const visible = (e: NostrEvent): boolean => includeDeleted || !deletedIds?.has(e.id)

      if (filters.length === 0) return [...byId.values()].filter(visible)

      // Each filter's own `limit` applies to that filter's matches only, per NIP-01 — not to the
      // union across filters — so limiting happens per-filter, before the results are merged.
      const matched = new Map<string, NostrEvent>()
      for (const filter of filters) {
        const pruned = candidateIds(filter)
        let events: NostrEvent[] = []
        for (const e of byId.values()) {
          if (pruned !== undefined && !pruned.has(e.id)) continue
          if (visible(e) && matchesFilter(e, filter)) events.push(e)
        }
        if (filter.limit !== undefined) {
          // Tie-break by id (P6): `created_at` alone leaves ties in Map insertion/arrival order,
          // an arrival-order leak through this port the same confluence-leak class UR-1 forbids
          // elsewhere in this module.
          events = events
            .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
            .slice(0, filter.limit)
        }
        for (const e of events) matched.set(e.id, e)
      }
      return [...matched.values()]
    },
    get(ids) {
      const out = new Map<string, NostrEvent>()
      for (const id of ids) {
        const e = byId.get(id)
        if (e !== undefined) out.set(id, e)
      }
      return out
    },
  }
}

function matchesFilter(event: NostrEvent, filter: EventFilter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  // Flat `#`-prefixed keys (Phase 13) — the real NIP-01 shape, read directly rather than through a
  // nested `tags` field no relay ever recognised.
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue
    const values = (filter as Readonly<Record<string, readonly string[]>>)[key]
    if (values === undefined) continue
    if (!tagValues(event, key.slice(1)).some((v) => values.includes(v))) return false
  }
  return true
}

/**
 * The ergonomic entry point (D15) — a factory function returning a plain object of bound methods,
 * never a `class`. `EventStorage` is injected via config exactly as `automerge-repo` injects
 * `StorageAdapterInterface`; swapping the in-memory default for IndexedDB/SQLite later needs no
 * change to this signature.
 */
export function createStore(options: CreateStoreOptions): Store {
  const storage = options.storage ?? createInMemoryEventStorage()
  let state = EMPTY_STORE_STATE
  const memo = createResolveMemo()

  async function add(events: readonly NostrEvent[], meta: IngestMeta = {}): Promise<AddResult> {
    const accepted: NostrEvent[] = []
    const rejected: RejectedEvent[] = []
    const pending: PendingEvent[] = []

    for (const event of events) {
      const passes =
        meta.trustUnverified === true || meta.verified === true || options.verify(event)
      if (passes) accepted.push(event)
      else rejected.push({ event, issues: [sig1RejectionIssue(event)] })
    }

    if (accepted.length > 0) {
      // Persisting the raw batch and folding it into the reducer are independent (the reducer never
      // reads `storage`), so the storage adapter's I/O wait can overlap with the reducer step
      // instead of strictly preceding it — a real overlap once a genuinely async adapter is wired
      // in, and a same-tick no-op for the synchronous in-memory default.
      const putDone = storage.put(accepted)
      state = applyStoreDelta(state, { kind: 'observe', events: accepted })

      // Report this batch's own accepted events' current V-verdict (VALIDATION-WIRING.md §1) — a
      // second, cheap call to the same pure function the reducer already ran internally, not a
      // re-derivation of its logic. `lookupEvent` already sees every sibling in this batch, since
      // the reducer folded the whole batch before this loop runs.
      for (const event of accepted) {
        const verdict = validateEvent(event, {
          lookupEvent: (id) => state.admit.observedById[id],
        })
        if (verdict.status === 'invalid') {
          rejected.push({ event, issues: verdict.issues })
        } else if (verdict.status === 'pending') {
          pending.push({ event, awaiting: verdict.awaiting, issues: verdict.issues })
        }
      }

      await putDone
    }

    return { accepted: accepted.map((e) => e.id), rejected, pending }
  }

  async function unobserve(eventIds: readonly string[]): Promise<void> {
    state = applyStoreDelta(state, { kind: 'unobserve', eventIds })
  }

  function trust(pubkeys: readonly string[]): void {
    state = applyStoreDelta(state, { kind: 'trust', pubkeys })
  }

  function untrust(pubkeys: readonly string[]): void {
    state = applyStoreDelta(state, { kind: 'untrust', pubkeys })
  }

  function resolveRootBound(rootId: string, resolveOptions?: ResolveOptions): Resolution {
    const effectiveOptions: ResolveOptions =
      resolveOptions ?? (options.applyOptions ? { apply: options.applyOptions } : {})
    return resolveRootMemoized(state, rootId, memo, effectiveOptions)
  }

  function admissionView(): AdmissionView {
    return trustedView(toIndex(state.admit))
  }

  function viewRoot(rootId: string, options?: ViewRootOptions): Resolution {
    const resolveOptions: ResolveOptions | undefined =
      options?.apply !== undefined ? { apply: options.apply } : undefined
    const resolution = resolveRootBound(rootId, resolveOptions)
    const view = options?.admission ?? admissionView()
    return { ...resolution, overlays: visibleOverlays(resolution.overlays, view) }
  }

  return {
    add,
    unobserve,
    trust,
    untrust,
    resolveRoot: resolveRootBound,
    admissionView,
    viewRoot,
    getState: () => state,
  }
}
