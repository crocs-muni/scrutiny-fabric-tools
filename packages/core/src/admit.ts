/**
 * §6 trust & admission, §7.3 overlay visibility (OV-7), §10 default-view retraction (DEL-4/DEL-5).
 *
 * `admit` decides whether the user is shown an event, never what an event says — that is
 * `resolve`'s job, and D25/TR-7 forbid this module from feeding trust into it. Two independent
 * mechanisms live here:
 *
 * 1. **Admission** (TR-2…7) — reachability through trust: direct authorship trust, or trust in a
 *    Binding that vouches for the event. Refcounted (D23), because more than one live reason can
 *    hold at once and losing one must not lose the others.
 * 2. **Default-view retraction** (DEL-4, DEL-5) — a kind 5 deletion hiding something from the
 *    default view. Orthogonal to admission, with one exception: deleting a Binding also revokes
 *    the admission it conferred, which folds into mechanism 1's bookkeeping.
 *
 * The design, including why root-chain propagation cannot reuse `resolve.ts`'s canonical-chain
 * walk and why a foreign patch's reason set is provably a singleton, is in `docs/ADMIT.md`.
 */

import {
  DELETION_KIND,
  type NostrEvent,
  dedupeById,
  eTags,
  eTagsWithMarker,
  rootTarget,
  scrutinyEventType,
} from './events.js'
import type { TrustProvider } from './interfaces.js'
import type { Overlay } from './resolve.js'

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why an event is admitted (D23). A template-literal union so two `Reason` values naming the same
 * binding or root are `===`-equal without a custom equality function — required for
 * {@link AdmissionIndex} to support plain deep equality (§0 of `docs/ADMIT.md`).
 */
export type Reason = 'direct-trust' | `binding:${string}` | `root-chain:${string}`

export const bindingReason = (bindingId: string): `binding:${string}` => `binding:${bindingId}`
export const rootChainReason = (rootId: string): `root-chain:${string}` => `root-chain:${rootId}`

export function reasonKind(r: Reason): 'direct-trust' | 'binding' | 'root-chain' {
  if (r === 'direct-trust') return 'direct-trust'
  return r.startsWith('binding:') ? 'binding' : 'root-chain'
}

// ---------------------------------------------------------------------------
// AdmissionIndex
// ---------------------------------------------------------------------------

/**
 * Plain data, no methods, no closures — same discipline as `Resolution` (D43's precedent). The
 * gate compares an incrementally-updated index against a from-scratch recompute with deep
 * equality; a method- or closure-bearing type would compare by reference and the property would
 * be vacuous.
 *
 * An absent key and a key mapped to `[]` both mean "not admitted"; the implementation never
 * produces the second form.
 */
export interface AdmissionIndex {
  readonly reasons: Readonly<Record<string, readonly Reason[]>>
}

export const isAdmitted = (index: AdmissionIndex, eventId: string): boolean =>
  (index.reasons[eventId]?.length ?? 0) > 0

// ---------------------------------------------------------------------------
// Shared predicates (BD-3/BD-4 reachability, NIP-09 honouring)
// ---------------------------------------------------------------------------

/**
 * A Binding's two endpoint ids, or `undefined` if it does not carry exactly one of each marker.
 *
 * Depends on BD-3/BD-4 holding — a Binding connects exactly one Product (`e root`) and one
 * Metadata (`e link`), which is what makes admission's reachability step non-transitive and
 * non-recursive. If §11's Metadata↔Metadata bindings ever land, this function's two-endpoint
 * assumption breaks and the refcount model below needs revisiting.
 *
 * A malformed Binding (zero or several `root`/`link` markers) is a BD-2/BD-10 validity concern —
 * rejecting it is `validate.ts`'s job, and `admit` deliberately does not re-derive that rejection.
 * But `admit` is reachable directly (D21's public entry, outside the wired `store.add()` pipeline),
 * so the typing rule's consequence is guarded locally: a Binding whose *observed* endpoints fail
 * BD-3/BD-4 credits nothing (`bindingEndpointsWellTyped`, added after the 2026-08-08
 * audit's S3-22 finding).
 *
 * Exported (not just `BindingEndpoints`) because `store.ts` needs the identical extraction for its
 * own BD-7 typing check — unlike `resolve.ts`'s independence from `admit.ts` (D29's oracle-vs-
 * incremental split), `store` already depends on this module directly, so there is no independence
 * to protect by restating this logic a second time.
 */
export interface BindingEndpoints {
  readonly rootId: string
  readonly linkId: string
}

export function bindingEndpoints(binding: NostrEvent): BindingEndpoints | undefined {
  const roots = eTagsWithMarker(binding, 'root')
  const links = eTagsWithMarker(binding, 'link')
  if (roots.length !== 1 || links.length !== 1) return undefined
  const rootRef = roots[0]
  const linkRef = links[0]
  if (rootRef === undefined || linkRef === undefined) return undefined
  return { rootId: rootRef.id, linkId: linkRef.id }
}

/**
 * BD-3/BD-4's consequence at the admission seam: a Binding whose *observed* endpoints fail the
 * typing rule credits nothing through this module. Endpoints not yet observed stay creditable —
 * BD-5's typing applies "once observed", and a reason credited to an unobserved id admits nothing
 * visible until the event arrives. V-invalidating the Binding itself is `validate.ts`'s job, not
 * re-derived here; this guard exists because `admit` is reachable directly, outside the wired
 * `store.add()` pipeline (2026-08-08 audit, S3-22).
 */
function bindingEndpointsWellTyped(
  endpoints: BindingEndpoints,
  byId: ReadonlyMap<string, NostrEvent>,
): boolean {
  const root = byId.get(endpoints.rootId)
  if (root !== undefined && scrutinyEventType(root) !== 'product') return false
  const link = byId.get(endpoints.linkId)
  if (link !== undefined && scrutinyEventType(link) !== 'metadata') return false
  return true
}

/** NIP-09's own pubkey check (DEL-1), restated locally so `admit` does not depend on `resolve.ts`. */
function isHonouredDeletion(
  targetId: string,
  targetPubkey: string,
  deletions: readonly NostrEvent[],
): boolean {
  return deletions.some(
    (d) => d.pubkey === targetPubkey && eTags(d).some((ref) => ref.id === targetId),
  )
}

/** DEL-4/DEL-3's shared test: is `event` hidden from the default view by its own author's kind 5? */
export function isDefaultViewRetracted(
  event: NostrEvent,
  deletions: readonly NostrEvent[],
): boolean {
  return isHonouredDeletion(event.id, event.pubkey, deletions)
}

/**
 * TR-5's reachable set for `root` — every root-author patch and every root-author kind-5 event
 * targeting the root or one of those patches. Deliberately not `resolve.ts`'s canonical-chain
 * walk: that walk stops at the first self-fork and does not extend past a HALT, but TR-5 admits
 * root-author patches unconditionally — a self-fork's second branch and a post-HALT patch must
 * still be admitted, or the client could never render the very warnings SF-3/H2 require. See
 * `docs/ADMIT.md` §4.
 *
 * Two flat filter passes, not an iterated fixed point: "root-author patch of root R" and
 * "root-author kind-5 targeting one of those" are each computed directly from `root`, never from
 * each other transitively, so there is nothing to iterate.
 */
function rootChainMembers(
  root: NostrEvent,
  patches: readonly NostrEvent[],
  kind5s: readonly NostrEvent[],
): ReadonlySet<string> {
  const candidatePatches = patches.filter(
    (p) => p.pubkey === root.pubkey && rootTarget(p) === root.id,
  )
  const patchIds = new Set(candidatePatches.map((p) => p.id))
  const candidateDeletions = kind5s.filter(
    (d) =>
      d.pubkey === root.pubkey &&
      eTags(d).some((ref) => ref.id === root.id || patchIds.has(ref.id)),
  )
  return new Set([...patchIds, ...candidateDeletions.map((d) => d.id)])
}

const isRoot = (e: NostrEvent): boolean => {
  const t = scrutinyEventType(e)
  return t === 'product' || t === 'metadata'
}

// ---------------------------------------------------------------------------
// computeAdmission — the oracle (D29)
// ---------------------------------------------------------------------------

/**
 * Full recompute over the whole observed set, spanning every root, Binding, and patch at once —
 * unscoped by root, unlike `resolve`, because a Binding's endpoints can be anywhere in the graph.
 *
 * `events` is an array for the same reason `resolve`'s parameter is: admission must be confluent
 * (order-independent) too, and a `Set` parameter would hide that hazard rather than remove it.
 *
 * Written independently of {@link applyDelta}'s incremental bookkeeping — sharing the fold
 * structure would let a refcount bug replicate identically into the thing meant to catch it
 * (D29). It shares only the pure spec predicates above, which state *what* is admitted, not *how*
 * to update an existing answer.
 */
export function computeAdmission(
  events: readonly NostrEvent[],
  trust: TrustProvider,
): AdmissionIndex {
  const deduped = dedupeById(events)
  const all = [...deduped.values()]
  const byId = deduped

  const kind5s = all.filter((e) => e.kind === DELETION_KIND)
  const bindingEvents = all.filter((e) => scrutinyEventType(e) === 'binding')
  const patches = all.filter((e) => scrutinyEventType(e) === 'patch')
  const roots = all.filter(isRoot)

  const reasons = new Map<string, Set<Reason>>()
  const credit = (id: string, reason: Reason): void => {
    const set = reasons.get(id)
    if (set) set.add(reason)
    else reasons.set(id, new Set([reason]))
  }

  // TR-2 — every observed event by a trusted pubkey, regardless of type.
  for (const event of all) if (trust.isTrusted(event.pubkey)) credit(event.id, 'direct-trust')

  // TR-3/TR-4 — a Binding admitted only by direct trust in its own pubkey (never transitively)
  // credits both endpoints, unless it has itself been retracted (DEL-5; see docs/ADMIT.md §8 —
  // retraction and revoked trust collapse to the same "not live" test deliberately).
  for (const bindingEvent of bindingEvents) {
    const endpoints = bindingEndpoints(bindingEvent)
    if (endpoints === undefined) continue
    if (!bindingEndpointsWellTyped(endpoints, byId)) continue
    if (!(reasons.get(bindingEvent.id)?.has('direct-trust') ?? false)) continue
    if (isHonouredDeletion(bindingEvent.id, bindingEvent.pubkey, kind5s)) continue
    credit(endpoints.rootId, bindingReason(bindingEvent.id))
    credit(endpoints.linkId, bindingReason(bindingEvent.id))
  }

  // TR-5 — a root's own admission, from either reason above, extends to its root-chain.
  for (const root of roots) {
    if ((reasons.get(root.id)?.size ?? 0) === 0) continue
    for (const memberId of rootChainMembers(root, patches, kind5s)) {
      credit(memberId, rootChainReason(root.id))
    }
  }

  const out = collectToRecord(
    [...reasons].flatMap(([id, set]) => (set.size > 0 ? [[id, [...set].sort()] as const] : [])),
  )
  return { reasons: out }
}

// ---------------------------------------------------------------------------
// Views (D22)
// ---------------------------------------------------------------------------

export interface AdmissionView {
  isAdmitted(eventId: string): boolean
}

export function trustedView(index: AdmissionIndex): AdmissionView {
  return { isAdmitted: (id) => isAdmitted(index, id) }
}

/**
 * "Show everything" as a separate implementation, not a bypass flag (D22). Under trust-everything
 * the admitted set *is* the set of all observed V-valid events, so there is nothing left to
 * compute — no `events`, no `trust`, no `trustEpoch` bump. `OpenView ⊇ TrustedView` is therefore
 * structural: any id `trustedView` admits, this admits too, because this admits everything.
 */
export const openView: AdmissionView = { isAdmitted: () => true }

// ---------------------------------------------------------------------------
// Overlay visibility (OV-7)
// ---------------------------------------------------------------------------

/**
 * OV-7 — a foreign patch is visible only if its `pubkey` is trusted. By BD-3/BD-4, a Patch can
 * never be a Binding endpoint, and by TR-6 (root-chain requires `pubkey = root.pubkey`, which
 * "foreign" contradicts by definition) it can never receive `root-chain:*` either — so a foreign
 * patch's reason set is always a subset of `{'direct-trust'}`, and `isAdmitted` on its own id
 * answers exactly the question OV-7 asks. See `docs/ADMIT.md` §7.
 *
 * Called *after* `resolve` has already produced `overlays`, never before — `resolve` itself never
 * receives a view or a `TrustProvider`, so there is no parameter through which trust could reach
 * chain construction even by accident (TR-7).
 */
export function visibleOverlays(
  overlays: readonly Overlay[],
  view: AdmissionView,
): readonly Overlay[] {
  return overlays.filter((o) => view.isAdmitted(o.id))
}

// ---------------------------------------------------------------------------
// Incremental state
// ---------------------------------------------------------------------------

/**
 * Plain data threaded through {@link applyDelta}. This is the correctness-oriented shape D24
 * ultimately wants an incremental path *for* — reasons accumulate against the guard tables below
 * rather than every delta re-deriving them from nothing — but `resync` (further down) re-derives
 * Binding liveness and root-chain membership over the *entire* observed set on every call, which
 * is not the scoped, cost-bounded invalidation D24's epochs describe. That is `store`'s (Phase 5)
 * to build; this phase only had to get the bookkeeping *correct* (AG1/AG2), never fast, and it
 * should not be read as delivering D24's promised cost reduction on its own.
 *
 * `liveBindings` is the D23 guard: a Binding's contribution to its endpoints is applied at most
 * once, no matter how many times the same live/dead transition is (redundantly) delivered — see
 * `docs/ADMIT.md` §5.
 */
export interface AdmitState {
  readonly reasons: Readonly<Record<string, readonly Reason[]>>
  readonly liveBindings: Readonly<Record<string, BindingEndpoints>>
  readonly trusted: readonly string[]
  readonly observedById: Readonly<Record<string, NostrEvent>>
}

export const EMPTY_ADMIT_STATE: AdmitState = Object.freeze({
  reasons: Object.freeze(Object.create(null) as Record<string, readonly Reason[]>),
  liveBindings: Object.freeze(Object.create(null) as Record<string, BindingEndpoints>),
  trusted: Object.freeze([] as readonly string[]),
  observedById: Object.freeze(Object.create(null) as Record<string, NostrEvent>),
})

export function toIndex(state: AdmitState): AdmissionIndex {
  return { reasons: state.reasons }
}

/**
 * Deltas that originate a sequence — the only ones {@link invertDelta} accepts.
 *
 * `untrust` is deliberately **not** a member, even though it is a perfectly real operation
 * `applyDelta` accepts (see {@link AdmissionDelta}). The asymmetry is load-bearing: `observe` and
 * `trust` each have a "no-op" case (re-observing an already-observed event, re-trusting an
 * already-trusted pubkey) that can only be *reached* by repeating a prior add — starting from
 * {@link EMPTY_ADMIT_STATE}, the first occurrence of either is always a real change, and every
 * later repeat pairs correctly with an earlier one under a LIFO undo. `untrust` has no such
 * guarantee: untrusting a pubkey that was never trusted is *also* a no-op, but it can be the very
 * first delta in a sequence, with no earlier "trust" for it to pair against. A syntactic inverse
 * of a standalone no-op `untrust` is not a no-op — it fabricates trust from nothing. This was
 * found by AG2's property test failing on the single-delta sequence `[untrust(pk)]`, not reasoned
 * out in advance; see `docs/ADMIT.md` §9.
 */
export type ForwardDelta =
  | { readonly kind: 'observe'; readonly events: readonly NostrEvent[] }
  | { readonly kind: 'trust'; readonly pubkeys: readonly string[] }

/**
 * `unobserve` and `untrust` have no *network*-protocol equivalent — Nostr does not let an event
 * un-arrive, though D39 notes that local storage may evict events under disk pressure, which is a
 * genuine local un-arrival `store` (Phase 5) may need this shape for. Both are valid inputs to
 * {@link applyDelta} — a real `TrustProvider.deltaSince` reports genuine revocations as `untrust`
 * — but neither is a valid input to {@link invertDelta}: inverting `unobserve` would need the
 * original event data the delta does not carry, and inverting `untrust` is unsound for the reason
 * given on {@link ForwardDelta}. `ForwardDelta` excludes both so a caller cannot construct either
 * ill-defined case.
 */
export type AdmissionDelta =
  | ForwardDelta
  | { readonly kind: 'unobserve'; readonly eventIds: readonly string[] }
  | { readonly kind: 'untrust'; readonly pubkeys: readonly string[] }

/** A pure syntactic swap. The actual work of undoing is {@link applyDelta}'s. */
export function invertDelta(delta: ForwardDelta): AdmissionDelta {
  switch (delta.kind) {
    case 'observe':
      return { kind: 'unobserve', eventIds: delta.events.map((e) => e.id) }
    case 'trust':
      return { kind: 'untrust', pubkeys: delta.pubkeys }
  }
}

interface Working {
  readonly reasons: Map<string, Set<Reason>>
  readonly liveBindings: Map<string, BindingEndpoints>
  readonly trusted: Set<string>
  readonly observedById: Map<string, NostrEvent>
}

function fromState(state: AdmitState): Working {
  const reasons = new Map<string, Set<Reason>>()
  for (const [id, list] of Object.entries(state.reasons)) reasons.set(id, new Set(list))
  const liveBindings = new Map<string, BindingEndpoints>()
  for (const [id, endpoints] of Object.entries(state.liveBindings)) liveBindings.set(id, endpoints)
  return {
    reasons,
    liveBindings,
    trusted: new Set(state.trusted),
    observedById: new Map(Object.entries(state.observedById)),
  }
}

/**
 * Shape an output record copied from mutable working state. Null-prototype by deliberate choice:
 * record keys here are event ids — attacker-reachable strings before SIG-1 has run — and
 * `'__proto__'` as a key on a plain `{}` would target the output's prototype chain instead of an
 * own entry, silently diverging the incremental path from the oracle (2026-08-08 audit, S3-26).
 */
function collectToRecord<V>(entries: Iterable<readonly [string, V]>): Record<string, V> {
  const out: Record<string, V> = Object.create(null) as Record<string, V>
  for (const [k, v] of entries) out[k] = v
  return out
}

function toState(w: Working): AdmitState {
  const reasons = collectToRecord(
    [...w.reasons].flatMap(([id, set]) => (set.size > 0 ? [[id, [...set].sort()] as const] : [])),
  )
  return {
    reasons,
    liveBindings: collectToRecord(w.liveBindings),
    trusted: [...w.trusted].sort(),
    observedById: collectToRecord(w.observedById),
  }
}

function credit(w: Working, id: string, reason: Reason): void {
  const set = w.reasons.get(id)
  if (set) set.add(reason)
  else w.reasons.set(id, new Set([reason]))
}

function uncredit(w: Working, id: string, reason: Reason): void {
  w.reasons.get(id)?.delete(reason)
}

function isAdmittedIn(w: Working, id: string): boolean {
  return (w.reasons.get(id)?.size ?? 0) > 0
}

function bindingIsLive(w: Working, binding: NostrEvent, kind5s: readonly NostrEvent[]): boolean {
  if (!w.reasons.get(binding.id)?.has('direct-trust')) return false
  const endpoints = bindingEndpoints(binding)
  if (endpoints === undefined || !bindingEndpointsWellTyped(endpoints, w.observedById)) return false
  return !isHonouredDeletion(binding.id, binding.pubkey, kind5s)
}

function activateBinding(w: Working, binding: NostrEvent): void {
  const endpoints = bindingEndpoints(binding)
  if (endpoints === undefined) return
  w.liveBindings.set(binding.id, endpoints)
  credit(w, endpoints.rootId, bindingReason(binding.id))
  credit(w, endpoints.linkId, bindingReason(binding.id))
}

function deactivateBinding(w: Working, bindingId: string): void {
  const endpoints = w.liveBindings.get(bindingId)
  if (endpoints === undefined) return
  w.liveBindings.delete(bindingId)
  uncredit(w, endpoints.rootId, bindingReason(bindingId))
  uncredit(w, endpoints.linkId, bindingReason(bindingId))
}

/**
 * The D23 guard: activating an already-live binding, or deactivating one that is not live, is a
 * no-op — so redelivering the same "binding is live" fact never double-credits, and the matching
 * single "binding is dead" transition undoes exactly what one activation credited.
 */
function resyncBinding(w: Working, binding: NostrEvent, kind5s: readonly NostrEvent[]): void {
  const shouldBeLive = bindingIsLive(w, binding, kind5s)
  const isLive = w.liveBindings.has(binding.id)
  if (shouldBeLive && !isLive) activateBinding(w, binding)
  else if (!shouldBeLive && isLive) deactivateBinding(w, binding.id)
}

/**
 * Re-credits or un-credits `root-chain:<root.id>` across every current member. Safe to call every
 * delta for every observed root: `credit`/`uncredit` on a `Set` are idempotent, so this is not a
 * counter that can be double-applied — unlike a Binding's contribution, a root's own admission is
 * a Set bit, and re-affirming it changes nothing for members already credited while still
 * picking up members newly observed since the last call.
 */
function resyncRootChain(
  w: Working,
  root: NostrEvent,
  patches: readonly NostrEvent[],
  kind5s: readonly NostrEvent[],
): void {
  const admitted = isAdmittedIn(w, root.id)
  for (const memberId of rootChainMembers(root, patches, kind5s)) {
    if (admitted) credit(w, memberId, rootChainReason(root.id))
    else uncredit(w, memberId, rootChainReason(root.id))
  }
}

/**
 * `patches`/`kind5s` are computed once here and threaded through, rather than each of
 * `resyncBinding`/`resyncRootChain` re-filtering `observedById` for every binding/root in scope —
 * the same two arrays `computeAdmission` (the oracle) already computes once per call.
 */
function resync(w: Working): void {
  const all = [...w.observedById.values()]
  const patches = all.filter((e) => scrutinyEventType(e) === 'patch')
  const kind5s = all.filter((e) => e.kind === DELETION_KIND)
  for (const e of all) if (scrutinyEventType(e) === 'binding') resyncBinding(w, e, kind5s)
  for (const e of all) if (isRoot(e)) resyncRootChain(w, e, patches, kind5s)
}

/**
 * Apply one delta to `state`, returning the new state.
 *
 * Every primitive mutation below is a guarded transition (already-observed ids are skipped,
 * already-(un)trusted pubkeys are skipped), and `resync` re-derives Binding liveness and
 * root-chain membership from the guard tables rather than from a running counter — see
 * `docs/ADMIT.md` §5 for why that is what actually prevents D23's sticky-admission bug, and §9 for
 * why `unobserve` un-cascades a removed root's membership *before* deleting it (its members are
 * still-observed patches; only the root object itself is about to disappear).
 */
export function applyDelta(state: AdmitState, delta: AdmissionDelta): AdmitState {
  const w = fromState(state)

  switch (delta.kind) {
    case 'observe':
      for (const e of delta.events) {
        if (w.observedById.has(e.id)) continue
        w.observedById.set(e.id, e)
        if (w.trusted.has(e.pubkey)) credit(w, e.id, 'direct-trust')
      }
      break

    case 'unobserve': {
      // Snapshotted once for the whole delta, not per id: an uncredit against a member already
      // removed by an earlier id in this same delta is a harmless no-op (nothing left to delete),
      // so a slightly stale snapshot costs nothing and saves re-filtering `observedById` per id.
      const patches = [...w.observedById.values()].filter((x) => scrutinyEventType(x) === 'patch')
      const kind5s = [...w.observedById.values()].filter((x) => x.kind === DELETION_KIND)
      for (const id of delta.eventIds) {
        const e = w.observedById.get(id)
        if (e === undefined) continue
        if (w.liveBindings.has(id)) deactivateBinding(w, id)
        if (isRoot(e) && isAdmittedIn(w, id)) {
          // un-cascade the membership *this* root conferred on others, while it can still be
          // computed (rootChainMembers needs the root object, about to disappear below).
          for (const memberId of rootChainMembers(e, patches, kind5s)) {
            uncredit(w, memberId, rootChainReason(id))
          }
        }
        // Strip every reason that depends on `id` itself being observed: direct-trust, and any
        // root-chain credit *this* event was receiving (not conferring — that case is the
        // cascade above). A binding:* credit is conferred by a still-observed Binding
        // independent of this id's own presence (BD-6) and must survive unobservation the same
        // way it survives never having arrived; `resync` cannot re-derive this cleanup on its
        // own, because once `id` leaves observedById it is no longer a candidate resync visits.
        for (const r of [...(w.reasons.get(id) ?? [])]) {
          if (r === 'direct-trust' || reasonKind(r) === 'root-chain') uncredit(w, id, r)
        }
        w.observedById.delete(id)
      }
      break
    }

    case 'trust': {
      const newly = delta.pubkeys.filter((pk) => !w.trusted.has(pk))
      for (const pk of newly) w.trusted.add(pk)
      for (const e of w.observedById.values())
        if (newly.includes(e.pubkey)) credit(w, e.id, 'direct-trust')
      break
    }

    case 'untrust': {
      const newly = delta.pubkeys.filter((pk) => w.trusted.has(pk))
      for (const pk of newly) w.trusted.delete(pk)
      for (const e of w.observedById.values())
        if (newly.includes(e.pubkey)) uncredit(w, e.id, 'direct-trust')
      break
    }
  }

  resync(w)
  return toState(w)
}
