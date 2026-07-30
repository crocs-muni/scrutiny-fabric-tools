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
 * found and fixed before any code existed, is in `docs/STORE.md`.
 */

import {
  type AdmissionIndex,
  type AdmitState,
  EMPTY_ADMIT_STATE,
  applyDelta as applyAdmitDelta,
  bindingEndpoints,
  toIndex,
} from './admit.js'
import { type Issue, issue } from './errors.js'
import { type NostrEvent, eTags, rootTarget, scrutinyEventType, tagValues } from './events.js'
import type { EventFilter, EventStorage } from './interfaces.js'
import { storageSymbol } from './interfaces.js'
import type { ApplyOptions } from './patch.js'
import { type Resolution, type ResolveOptions, resolve } from './resolve.js'

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

  /** BD-7's permanent rejection cache. Sorted, for deep-equality-friendly plain data. */
  readonly rejectedBindings: readonly string[]

  /** Patch/overlay event id -> the root id it declared via `e root`. See STORE.md §2. */
  readonly chainMembership: Readonly<Record<string, string>>
  /** Endpoint event id -> ids of Bindings still missing that endpoint. See STORE.md §2. */
  readonly bindingsAwaiting: Readonly<Record<string, readonly string[]>>

  readonly trustEpoch: number
  readonly observedEpoch: number
  /** Per-root chain epoch. Bump count is arrival-order-dependent by design — STORE.md §3/§10. */
  readonly chainEpoch: Readonly<Record<string, number>>
}

export const EMPTY_STORE_STATE: StoreState = Object.freeze({
  admit: EMPTY_ADMIT_STATE,
  rejectedBindings: Object.freeze([]),
  chainMembership: Object.freeze({}),
  bindingsAwaiting: Object.freeze({}),
  trustEpoch: 0,
  observedEpoch: 0,
  chainEpoch: Object.freeze({}),
})

/**
 * The confluence-tested projection (STORE.md §3/§9). Excludes `chainEpoch`/`chainMembership`/
 * `bindingsAwaiting`, whose exact values are legitimately arrival-order-dependent cache bookkeeping
 * — the same move `admit.ts`'s own `toIndex` makes over `AdmitState`'s order-sensitive
 * `liveBindings`.
 */
export interface StoreView {
  readonly observedIds: readonly string[]
  readonly admission: AdmissionIndex
  readonly rejectedBindings: readonly string[]
}

export function toStoreView(state: StoreState): StoreView {
  return {
    observedIds: Object.keys(state.admit.observedById).sort(),
    admission: toIndex(state.admit),
    rejectedBindings: state.rejectedBindings,
  }
}

// ---------------------------------------------------------------------------
// BD-3/BD-4/BD-7 — Binding endpoint typing
// ---------------------------------------------------------------------------

// `bindingEndpoints`/`BindingEndpoints` come from admit.ts (see its own comment on why this is
// imported rather than restated — store already depends on admit directly, unlike resolve.ts's
// deliberate independence from it).

function addAwaiting(
  awaiting: Map<string, Set<string>>,
  endpointId: string,
  bindingId: string,
): void {
  const set = awaiting.get(endpointId)
  if (set) set.add(bindingId)
  else awaiting.set(endpointId, new Set([bindingId]))
}

function removeAwaiting(
  awaiting: Map<string, Set<string>>,
  endpointId: string,
  bindingId: string,
): void {
  const set = awaiting.get(endpointId)
  if (set === undefined) return
  set.delete(bindingId)
  if (set.size === 0) awaiting.delete(endpointId)
}

/**
 * BD-6/BD-7 — the pending/permanent-rejection lifecycle. Called when a Binding is first observed
 * and again whenever one of its awaited endpoints arrives (STORE.md §2). Both endpoints observed is
 * a final verdict either way, so `bindingsAwaiting` is always cleaned up on that branch; neither
 * observed yet leaves (or re-registers) the missing one(s) for a future arrival to retrigger.
 */
function checkBindingTyping(
  binding: NostrEvent,
  observedById: Readonly<Record<string, NostrEvent>>,
  bindingsAwaiting: Map<string, Set<string>>,
  rejectedBindings: Set<string>,
): void {
  const endpoints = bindingEndpoints(binding)
  if (endpoints === undefined) return

  const rootEvent = observedById[endpoints.rootId]
  const linkEvent = observedById[endpoints.linkId]

  if (rootEvent === undefined || linkEvent === undefined) {
    if (rootEvent === undefined) addAwaiting(bindingsAwaiting, endpoints.rootId, binding.id)
    if (linkEvent === undefined) addAwaiting(bindingsAwaiting, endpoints.linkId, binding.id)
    return
  }

  removeAwaiting(bindingsAwaiting, endpoints.rootId, binding.id)
  removeAwaiting(bindingsAwaiting, endpoints.linkId, binding.id)

  if (scrutinyEventType(rootEvent) === 'product' && scrutinyEventType(linkEvent) === 'metadata') {
    return
  }
  rejectedBindings.add(binding.id)
}

/** BD-7's rejection issue, constructed by diffing `rejectedBindings` before/after a delta — §8. */
export function bindingRejectionIssue(bindingId: string): Issue {
  return issue(
    'BD-7',
    'warning',
    `binding ${bindingId}: endpoint typing contradicts BD-3/BD-4 once both endpoints were observed; permanently rejected`,
  )
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
 * why that lookup is the one thing parameterised rather than shared outright.
 */
function chainEpochTargets(
  event: NostrEvent,
  lookupOwningRoot: (id: string) => string | undefined,
): readonly string[] {
  const type = scrutinyEventType(event)
  if (type === 'product' || type === 'metadata') return [event.id]
  if (type === 'patch') {
    const root = rootTarget(event)
    return root !== undefined ? [root] : []
  }
  if (event.kind === 5) {
    const targets: string[] = []
    for (const ref of eTags(event)) {
      const owningRoot = lookupOwningRoot(ref.id)
      if (owningRoot !== undefined) targets.push(owningRoot)
      targets.push(ref.id) // unconditional — covers target-is-itself-a-root (DEL-4)
    }
    return targets
  }
  return []
}

/** The per-event chainMembership/chainEpoch bookkeeping in STORE.md §3, plus BD-7's check. */
function processObservedEvent(
  event: NostrEvent,
  observedById: Readonly<Record<string, NostrEvent>>,
  chainMembership: Map<string, string>,
  bindingsAwaiting: Map<string, Set<string>>,
  chainEpoch: Map<string, number>,
  rejectedBindings: Set<string>,
): void {
  const type = scrutinyEventType(event)

  if (type === 'patch') {
    const root = rootTarget(event)
    if (root !== undefined) chainMembership.set(event.id, root)
  } else if (type === 'binding') {
    checkBindingTyping(event, observedById, bindingsAwaiting, rejectedBindings)
  }

  for (const id of chainEpochTargets(event, (refId) => chainMembership.get(refId))) {
    bump(chainEpoch, id)
  }

  // This event's own id may be an endpoint some other (already-observed) Binding is still awaiting.
  const waiting = bindingsAwaiting.get(event.id)
  if (waiting !== undefined) {
    for (const bindingId of [...waiting]) {
      const pendingBinding = observedById[bindingId]
      if (pendingBinding !== undefined) {
        checkBindingTyping(pendingBinding, observedById, bindingsAwaiting, rejectedBindings)
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

function mapToRecord<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries(map)
}

function setMapToSortedRecord(
  map: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, readonly string[]> {
  return Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort()]))
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
      const bindingsAwaiting = recordToSetMap(state.bindingsAwaiting)
      const chainEpoch = recordToMap(state.chainEpoch)
      const rejectedBindings = new Set(state.rejectedBindings)

      for (const event of delta.events) {
        if (Object.hasOwn(priorObserved, event.id) || newlySeen.has(event.id)) continue
        newlySeen.add(event.id)
        processObservedEvent(
          event,
          admitAfter.observedById,
          chainMembership,
          bindingsAwaiting,
          chainEpoch,
          rejectedBindings,
        )
      }

      return {
        admit: admitAfter,
        rejectedBindings: [...rejectedBindings].sort(),
        chainMembership: mapToRecord(chainMembership),
        bindingsAwaiting: setMapToSortedRecord(bindingsAwaiting),
        trustEpoch: state.trustEpoch,
        observedEpoch: state.observedEpoch + 1,
        chainEpoch: mapToRecord(chainEpoch),
      }
    }

    case 'unobserve': {
      if (delta.eventIds.length === 0) return state

      // Snapshot Binding endpoint memberships and chain membership BEFORE folding into admit, whose
      // observedById is about to lose these ids.
      const bindingsAwaiting = recordToSetMap(state.bindingsAwaiting)
      const chainEpoch = recordToMap(state.chainEpoch)

      for (const id of delta.eventIds) {
        const event = state.admit.observedById[id]
        if (event === undefined) continue

        if (scrutinyEventType(event) === 'binding') {
          const endpoints = bindingEndpoints(event)
          if (endpoints !== undefined) {
            removeAwaiting(bindingsAwaiting, endpoints.rootId, event.id)
            removeAwaiting(bindingsAwaiting, endpoints.linkId, event.id)
          }
        }

        // Symmetric to observe (STORE.md §3): removing an event can affect a root's resolve()
        // output too, so the same epoch(s) that would have been bumped on arrival bump on removal.
        for (const target of chainEpochTargets(event, (refId) => state.chainMembership[refId])) {
          bump(chainEpoch, target)
        }
      }

      const admitAfter = applyAdmitDelta(state.admit, {
        kind: 'unobserve',
        eventIds: delta.eventIds,
      })

      return {
        admit: admitAfter,
        rejectedBindings: state.rejectedBindings,
        chainMembership: state.chainMembership, // stale-but-still-correct entries left in place
        bindingsAwaiting: setMapToSortedRecord(bindingsAwaiting),
        trustEpoch: state.trustEpoch,
        observedEpoch: state.observedEpoch + 1,
        chainEpoch: mapToRecord(chainEpoch),
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
   * The materialised event array shares across every root as long as `observedById` hasn't changed
   * — `applyStoreDelta` always produces a fresh `admit`/`observedById` object per `observe`/
   * `unobserve` delta (never mutated in place), so identity comparison is exactly "has anything been
   * observed or unobserved since this array was built." Without this, resolving R roots after one
   * ingest batch would re-materialise the same, unchanged observed set R times over.
   */
  eventsCache?: {
    readonly observedById: Readonly<Record<string, NostrEvent>>
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
 * of the key or the cache at all (D26's precedent) — apply `admit.visibleOverlays` to
 * `resolution.overlays` at read time if a trust-filtered view is wanted.
 */
export function resolveRoot(
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

  if (memo.eventsCache?.observedById !== state.admit.observedById) {
    memo.eventsCache = {
      observedById: state.admit.observedById,
      events: Object.values(state.admit.observedById),
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
  readonly source?: string
  /** The caller already ran an equivalent verify() over this batch — skip re-running it (D19). */
  readonly verified?: boolean
  /** The actual bypass, named apart from `verified` so misuse is grep-able in review (D18/D19). */
  readonly trustUnverified?: boolean
}

export interface RejectedEvent {
  readonly event: NostrEvent
  readonly issue: Issue
}

export interface AddResult {
  readonly accepted: readonly string[]
  readonly rejected: readonly RejectedEvent[]
}

/**
 * SIG-1's enforcement-half rejection issue (§8's `emitted` entry). Exported alongside
 * {@link bindingRejectionIssue} for the same reason: SG4's coverage test constructs it directly over
 * a synchronous scenario rather than through `add()`'s async wrapper, and it is the identical
 * function `add()` itself calls, not a re-derivation of the same logic.
 */
export const sig1RejectionIssue = (event: NostrEvent): Issue =>
  issue(
    'SIG-1',
    'error',
    `event ${event.id}: failed signature/id verification and was not admitted`,
  )

export interface Store {
  add(events: readonly NostrEvent[], meta?: IngestMeta): Promise<AddResult>
  unobserve(eventIds: readonly string[]): Promise<void>
  trust(pubkeys: readonly string[]): void
  untrust(pubkeys: readonly string[]): void
  resolveRoot(rootId: string, options?: ResolveOptions): Resolution
  getState(): StoreState
}

/**
 * The in-memory default (D37) — exported so it's independently constructible (a consumer wiring an
 * app together explicitly, or a test exercising `query`/`get` directly) rather than reachable only
 * as `createStore`'s invisible fallback.
 */
export function createInMemoryEventStorage(): EventStorage {
  const byId = new Map<string, NostrEvent>()
  return {
    [storageSymbol]: true,
    put(events) {
      for (const e of events) byId.set(e.id, e)
    },
    query(filters) {
      if (filters.length === 0) return [...byId.values()]
      return [...byId.values()].filter((e) => filters.some((f) => matchesFilter(e, f)))
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
  if (filter.tags !== undefined) {
    for (const [tagName, values] of Object.entries(filter.tags)) {
      const letter = tagName.startsWith('#') ? tagName.slice(1) : tagName
      if (!tagValues(event, letter).some((v) => values.includes(v))) return false
    }
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

    for (const event of events) {
      const passes =
        meta.trustUnverified === true || meta.verified === true || options.verify(event)
      if (passes) accepted.push(event)
      else rejected.push({ event, issue: sig1RejectionIssue(event) })
    }

    if (accepted.length > 0) {
      // Persisting the raw batch and folding it into the reducer are independent (the reducer never
      // reads `storage`), so the storage adapter's I/O wait can overlap with the reducer step
      // instead of strictly preceding it — a real overlap once a genuinely async adapter is wired
      // in, and a same-tick no-op for the synchronous in-memory default.
      const putDone = storage.put(accepted)
      const beforeRejected = new Set(state.rejectedBindings)
      state = applyStoreDelta(state, { kind: 'observe', events: accepted })
      for (const id of state.rejectedBindings) {
        if (!beforeRejected.has(id)) rejected.push(bindingRejection(state, id))
      }
      await putDone
    }

    return { accepted: accepted.map((e) => e.id), rejected }
  }

  function bindingRejection(current: StoreState, bindingId: string): RejectedEvent {
    const event = current.admit.observedById[bindingId]
    if (event === undefined)
      throw new Error(`unreachable: rejected binding ${bindingId} not observed`)
    return { event, issue: bindingRejectionIssue(bindingId) }
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
    return resolveRoot(state, rootId, memo, effectiveOptions)
  }

  return {
    add,
    unobserve,
    trust,
    untrust,
    resolveRoot: resolveRootBound,
    getState: () => state,
  }
}
