# `overlayAwaiting` — the fourth reducer index (D24/C5 fix)

Mini-spec for mandate item 3 (`PLAN-2026-08-01-rewrite-mandate.md` §3, "Resolve-memo staleness fix
(D24/C5)"). Written before any code, in `STORE.md`'s own style and at its own level of rigor, since
this is an amendment to `store.ts`'s reducer, not a new module.

Governing text: `AUDIT-2026-07-31.md` §2's **P1** finding (the reproduced bug), `DECISIONS-2026-07-27.md`
**C5** (the D29-violation finding P1 documents), **D24** (the three epochs — amended here), **D26**
(overlay-cache key has no trust component — cited as unbroken precedent, not touched), **D29** (the
oracle property — this is its repair), **D38** (cache raw events only — this index stores ids, nothing
else). `STORE.md` §§1–3 (state shape, the pending-reference buffer precedent, the epoch dispatch
table) and §6 (the resolution memo) are this document's direct predecessor and are extended, not
restated, below.

**Final call, already settled by the mandate:** build the permanent reverse index. **Rejected**
alternatives, per the mandate's own reasoning: the read-time patch (cheaper, but "breaks
reference-stability on cache hits" — a `Resolution` object returned from a cache hit would need to be
mutated or rebuilt per read, breaking the `===` comparison consumers may reasonably make against a
memoized value); keying the memo on `observedEpoch` whenever a resolution contains an orphaned overlay
(`AUDIT-2026-07-31.md` §2's cheapest option — superseded, see §6 below); dropping the α/β distinction
from the memoized value and computing it at read time (§2's third option — "splits `Resolution` into
cached and live halves," rejected for the same shape of reason as the read-time patch).

---

## 1. The bug, restated precisely

`overlayState` (`resolve.ts:519`) decides an overlay's DEL-7 α/β degradation from `byId.has(targetId)`
— membership in the **whole observed set**, not membership in the root's own chain. `chainEpochTargets`
(`store.ts:189`) has no row that fires when an arbitrary observed event's *own* arrival is the thing
some other root's cached resolution depends on: its four rows are keyed by what the *arriving* event
declares about itself (its own id if it's a root-eligible type, its own `e root` if it's a Patch, its
`e`-tagged targets if it's a kind 5) — never by "does some other root have an overlay whose `e reply`
names me."

Concretely: root `R` (a Product or Metadata), foreign overlay `O` with `e root = R` and `e reply = X`,
where `X` is some event with no `e root = R` of its own — it might be unrelated to `R` entirely, or the
root/tip of a different chain, or simply not yet observed by anyone. `O`'s own arrival already bumps
`chainEpoch[R]` correctly (the existing Patch row: `rootTarget(O) = R`). But `X`'s arrival bumps only
`chainEpoch[X]` (if `X` is root-eligible) or nothing at all (if `X` is some other Patch's target,
bumping a third root entirely) — never `chainEpoch[R]`, even though `R`'s own resolution reads
`byId.has(X)` to classify `O`. `resolveRoot` then serves the stale memo entry for `R` forever, because
its cached `epoch` still matches `state.chainEpoch[R]`.

Reproduced in `AUDIT-2026-07-31.md` §2:

```
memoised store, target absent  : orphaned/beta
memoised store, target present : orphaned/beta
fresh store over same final set: orphaned/alpha
MISMATCH — memo says orphaned/beta, recompute says orphaned/alpha
```

This is D29 violated (`DECISIONS-2026-07-27.md` C5) and RC-3 violated (stale bytes served when fresh
inputs are locally available) and a UR-1 confluence failure in effect (arrival order changes the
answer a consumer sees). The fix closes exactly this gap: a reverse index from "target id" to "root
ids whose resolution depends on that target's observedness," consulted on every event's own arrival
*or* removal, for every event type — not just the four rows `chainEpochTargets` already has, an
additive fifth signal layered on top of them.

---

## 2. State shape and the `replyTarget` hoist

```ts
export interface StoreState {
  readonly admit: AdmitState
  readonly rejectedBindings: readonly string[]
  readonly chainMembership: Readonly<Record<string, string>>
  readonly bindingsAwaiting: Readonly<Record<string, readonly string[]>>
  /** Overlay-reply target id -> root id(s) whose resolution reads that target's observedness.
   *  See §3/§4 below. Never cleared, in either direction — §4. */
  readonly overlayAwaiting: Readonly<Record<string, readonly string[]>>
  readonly trustEpoch: number
  readonly observedEpoch: number
  readonly chainEpoch: Readonly<Record<string, number>>
}

export const EMPTY_STORE_STATE: StoreState = Object.freeze({
  admit: EMPTY_ADMIT_STATE,
  rejectedBindings: Object.freeze([]),
  chainMembership: Object.freeze({}),
  bindingsAwaiting: Object.freeze({}),
  overlayAwaiting: Object.freeze({}),
  trustEpoch: 0,
  observedEpoch: 0,
  chainEpoch: Object.freeze({}),
})
```

**Forward reference.** `rejectedBindings`/`bindingsAwaiting` above are `overlayAwaiting`'s *pre-Phase-14*
neighbours — the names as they stand before `VALIDATION-WIRING.md` lands. `IMPLEMENTATION-PLAN.md`
sequences Phase 14 (validation wiring) before Phase 15 (this document), specifically so this index
arrives as an additive sibling rather than a second reinvention of the same reverse-index shape
(`VALIDATION-WIRING.md` §5 makes the same point in the other direction). By the time this section's
code is actually written, `rejectedBindings` will already be `invalidIds` and `bindingsAwaiting` will
already be `pendingAwaiting`, per `VALIDATION-WIRING.md` §2 — add `overlayAwaiting` alongside *those*
names, not the ones shown here.

Shape-identical to `bindingsAwaiting` (`Record<id, id[]>`), not to `chainMembership` (`Record<id, id>`)
— deliberately, because a single target id can be awaited by more than one root at once (two
unrelated overlays, on two unrelated roots, both replying to the same widely-cited event), the same
multiplicity `bindingsAwaiting` already has to handle (one endpoint awaited by several Bindings). This
shape choice is what drives §4's answer below.

**The hoist.** `resolve.ts:169-170` currently defines a private helper:

```ts
const replyTarget = (event: NostrEvent): string | undefined =>
  eTagsWithMarker(event, 'reply')[0]?.id
```

Move this, verbatim, into `events.ts` as an exported function, immediately after `rootTarget`
(`events.ts:119-122`), with the same one-line doc-comment style:

```ts
/** The id an event's `e reply` marker points at, if any. Shared by `resolve.ts` and `store.ts`. */
export function replyTarget(event: NostrEvent): string | undefined {
  return eTagsWithMarker(event, 'reply')[0]?.id
}
```

`resolve.ts` drops its private definition and imports `replyTarget` from `./events.js` alongside its
existing `rootTarget` import — every one of its five call sites (`resolve.ts:211,285,296,342`, plus the
`cascade` helper) is unaffected, since the hoisted function is byte-identical in behavior. `store.ts`
adds `replyTarget` to its existing `events.js` import line (`store.ts:24`, which already imports
`rootTarget` from the same module) — no new import path, no new dependency edge.

---

## 3. Population rule

**Rule:** whenever a Patch event is observed, if both `replyTarget(event)` and `rootTarget(event)` are
defined, `overlayAwaiting[replyTarget(event)]` gains `rootTarget(event)` — added to a `Set`, exactly as
`bindingsAwaiting` gains an entry via the existing generic `addAwaiting(awaiting, key, value)` helper
(`store.ts:99-107`). No new primitive is introduced: `addAwaiting(overlayAwaiting, target, root)` is
the identical function already used for `bindingsAwaiting`, called with different arguments.

This is **unconditional for every observed Patch** — root-author or foreign, valid or not, whether or
not the root itself has even been observed yet — mirroring `chainMembership`'s own precedent exactly
(`STORE.md` §2: "populated the moment a patch (root-author or foreign — the map doesn't care) is
observed"). Both guard conditions (`replyTarget` defined, `rootTarget` defined) are the same shape of
guard `chainMembership`'s own population already has (`store.ts:222-224`: `if (root !== undefined)
chainMembership.set(...)`) — nothing new is being invented, an existing pattern is being extended to a
second field read off the same event.

**Why unconditional-and-blind-to-authorship is safe under UR-1, given `store.ts` does no V-layer
validation at this stage (mandate item 6 is a separate, later change):**

1. `overlayAwaiting` feeds **only** invalidation timing — whether `resolveRoot` recomputes — never the
   *content* of what `resolve()` returns. `resolve.ts` is untouched by this fix in every respect beyond
   being the target of a (possibly unnecessary) extra call. Its own purity and order-independence
   (UR-1) are exactly as they were before this fix; nothing here reads or writes anything `resolve()`
   consumes beyond the same `events` array it always received.
2. The two failure directions are not symmetric, and `STORE.md` §3 already commits to the side that
   costs less: bumping `chainEpoch[R]` when `R`'s resolution did not in fact depend on the arriving
   event costs one wasted memo miss (a `resolve()` call that returns byte-identical output to the
   cached one). *Not* bumping it when `R`'s resolution *did* depend on the event serves stale bytes,
   which RC-3 forbids outright. Populating `overlayAwaiting` from a malformed, self-referential, or
   otherwise garbage Patch can only produce the first, cheaper failure mode — an entry that later
   causes a spurious-but-harmless recompute for some root — never the second.
3. Concretely: a garbage Patch masquerading with a bogus `e reply`/`e root` pair cannot cause `resolve
   (R, events)` to *apply* it as a chain link or *classify* it as an overlay unless `resolve.ts`'s own
   filtering (by `rootTarget(event) === rootId`, then by authorship, then by BD-9/PT-5/PT-6) admits it
   on the merits — filtering this index has no influence over. The worst a garbage entry can do is make
   some root's memo entry look dirty when it is not.
4. This is the same reasoning `STORE.md` §3 already uses to justify the kind-5 row's own
   unconditional half (`targets.push(ref.id)` regardless of whether `ref.id` turns out to be a root) —
   this fix does not introduce a new safety argument, it reuses the one already on record for exactly
   this kind of over-approximating reverse index.

**Design clarification, found while writing this section.** The mandate's sketch says only "keyed by
its own `e reply` target," without stating the `rootTarget(event)` guard. Read literally, a Patch with
a `reply` marker but no `root` marker (malformed — PT-2 requires both, but PT-2 is a V rule store.ts
does not enforce yet) would have nothing meaningful to register: there is no root id to place in the
array. The guard is not a new restriction invented here; it is required by the field's own type
(`Record<targetId, rootId[]>` cannot hold an entry with no root id) and is the direct analogue of
`chainMembership`'s existing `root !== undefined` guard. Recorded explicitly so a later reader does not
mistake the omission in the mandate's one-line sketch for a deliberate difference from `chainMembership`.

---

## 4. What happens to a Patch's contribution when that Patch is unobserved

**Answer: nothing. `overlayAwaiting` is never mutated during `unobserve` at all**, in either
direction — not the target-keyed entry (the mandate's own explicit rule) and not a single contributing
root removed from an existing entry's array either. The whole structure grows monotonically for the
life of the store; `unobserve` only *reads* it (via `chainEpochTargets`, §5), never writes it.

**Reasoning, weighing `chainMembership`'s "stale-but-still-correct entries left in place" precedent
against `bindingsAwaiting`'s active-cleanup precedent, as the task requires:**

`bindingsAwaiting` *does* call `removeAwaiting` on unobserve (`store.ts:322-328`), but that cleanup is
keyed by **exact identity**: the value being removed is the very Binding id that is being unobserved,
removed from exactly the two endpoint keys (`endpoints.rootId`, `endpoints.linkId`) that Binding itself
registered. There is no multiplicity hazard, because the thing being removed and the thing that
triggered the removal are the same id — a Binding can only ever be waiting on its own two endpoints,
under its own id, so removing "this Binding's own entries" cannot accidentally remove another Binding's
still-live entry.

`overlayAwaiting` cannot offer the same guarantee, because of the type the mandate itself specifies:
`Record<targetId, rootId[]>`, not `Record<targetId, patchId[]>`. The array holds **root ids**, a
coarser, non-unique value: two distinct Patches — from the same root replying to the same target, or
from two different roots that happen to both cite the same widely-referenced event — can each be the
reason a given root id sits in a given target's array. If Patch `P1` (root `R`, reply target `X`) is
unobserved, removing `R` from `overlayAwaiting[X]` would be correct only if no *other* still-observed
Patch on root `R` also replies to `X`. Detecting that safely would require refcounting by the
contributing Patch's own id — a `Record<targetId, patchId[]>` shape, which is not what the mandate
specifies and which `chainMembership`'s "the map doesn't care about authorship" precedent gives no
reason to build. Removing without that refcount risks deleting a still-live dependency and silently
reintroducing exactly C5's shape of bug one level down: a root whose resolution still depends on `X`'s
observedness, with no index entry left to say so.

Given §3's asymmetric-cost argument (over-invalidation costs a wasted recompute; under-invalidation
serves stale bytes), and given that correctly narrowing the removal would require a data shape the
mandate does not call for, the only removal-side option that cannot regress into C5's own failure mode
is **not removing at all** — which is also the literal reading of `chainMembership`'s own precedent
("stale-but-still-correct entries left in place") extended to a second dimension of the same field
(here: the *source* side, versus the mandate's own explicit rule about the *target* side).

**Confirming this costs nothing beyond what the field already spends.** Because `overlayAwaiting` is
never mutated on `unobserve`, the `'unobserve'` case of `applyStoreDelta` needs no `recordToSetMap`/
`setMapToSortedRecord` round-trip for it at all — it reads `state.overlayAwaiting[event.id]` directly
(exactly the way the existing code already reads `state.chainMembership[refId]` directly, `store.ts:332`)
and returns `overlayAwaiting: state.overlayAwaiting` unchanged in the new state (exactly the way
`chainMembership: state.chainMembership` is already returned unchanged, `store.ts:345`). This is a
strictly simpler code path than `bindingsAwaiting`'s, not a more complex one — the "never mutate on
unobserve" answer is also the answer that adds the least code.

**What correctness this still delivers, restated for the exact case the mandate calls out:** a root `R`
whose overlay targets `X`, where `X` is later unobserved (having been resolved/present), must be able
to flip back from α to β. Since `overlayAwaiting[X]` is never deleted (mandate's own rule, §1 and §5
below) and `R`'s own contribution to it is never removed either (this section's conclusion), the
unobserve of `X` still finds `R` in `overlayAwaiting[X]` and bumps `chainEpoch[R]`, exactly as it must.

---

## 5. The bump dispatch

`chainEpochTargets` (`store.ts:189-209`) is restructured from an early-returning if/else-if chain into
an additive builder, so the new row can layer on top of the four existing ones rather than replace any
of them:

```ts
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
  } else if (event.kind === 5) {
    for (const ref of eTags(event)) {
      const owningRoot = lookupOwningRoot(ref.id)
      if (owningRoot !== undefined) targets.push(owningRoot)
      targets.push(ref.id) // unconditional — DEL-4, unchanged
    }
  }
  // New row — unconditional, every event type, keyed by the arriving/departing event's OWN id.
  for (const root of lookupOverlayAwaiting(event.id) ?? []) targets.push(root)

  return targets
}
```

Duplicate entries in the returned array (e.g. a kind-5 event that is *also* a registered overlay target)
are harmless and deliberately not deduplicated — `STORE.md` §3's own design correction already
established that the exact `chainEpoch` count is not part of any contract, only whether it changes.

**Updated dispatch table** (extends `STORE.md` §3's table with one new, always-applicable row):

| observed/removed event is a… | epochs bumped |
|---|---|
| Product / Metadata | `chainEpoch[event.id]` |
| Patch | `chainEpoch[rootTarget(event)]` (unchanged) |
| kind 5 (deletion) | `chainEpoch[chainMembership[target]]` per resolving target, and `chainEpoch[target]` unconditionally (unchanged) |
| Binding | none (unchanged) |
| **any of the above** | **additionally, `chainEpoch[r]` for every `r` in `overlayAwaiting[event.id]`** |

**New population table** (§3's rule, tabulated the same way `STORE.md` §3 tabulates the bump table):

| observed event is a… | `overlayAwaiting` update |
|---|---|
| Patch, `replyTarget` and `rootTarget` both defined | `overlayAwaiting[replyTarget(event)]` gains `rootTarget(event)` |
| anything else | none |

**Both call sites, updated:**

`processObservedEvent` (`store.ts:212-243`, the `observe`-side helper) gains an `overlayAwaiting:
Map<string, Set<string>>` parameter. Immediately alongside its existing `type === 'patch'` branch
(which sets `chainMembership`), it adds:

```ts
if (type === 'patch') {
  const root = rootTarget(event)
  if (root !== undefined) chainMembership.set(event.id, root)
  const target = replyTarget(event)
  if (target !== undefined && root !== undefined) addAwaiting(overlayAwaiting, target, root)
}
```

and its existing bump loop becomes:

```ts
for (const id of chainEpochTargets(
  event,
  (refId) => chainMembership.get(refId),
  (id) => overlayAwaiting.get(id),
)) {
  bump(chainEpoch, id)
}
```

The `'observe'` case of `applyStoreDelta` (`store.ts:271-308`) gains, alongside its existing
`recordToMap`/`recordToSetMap` setup lines: `const overlayAwaiting = recordToSetMap(state.overlayAwaiting)`,
threads it through to every `processObservedEvent` call, and returns `overlayAwaiting:
setMapToSortedRecord(overlayAwaiting)` in the new state — the identical treatment `bindingsAwaiting`
already receives on this path, reusing both existing helper functions verbatim.

The `'unobserve'` case (`store.ts:310-351`) needs no new working copy (§4) — its existing loop gains a
second lookup argument, reading the field directly off the unmodified `state`:

```ts
for (const target of chainEpochTargets(
  event,
  (refId) => state.chainMembership[refId],
  (id) => state.overlayAwaiting[id],
)) {
  bump(chainEpoch, target)
}
```

and the returned state gains `overlayAwaiting: state.overlayAwaiting` (unchanged reference, matching
`chainMembership`'s existing line immediately above it).

A degenerate case worth naming rather than leaving for a future reader to rediscover: a self-referential
overlay (`replyTarget(event) === event.id`) registers itself into `overlayAwaiting[event.id]` and is
then immediately visible to that same event's own bump-dispatch call within the same `processObservedEvent`
invocation (population happens before the bump loop reads it). This produces one redundant bump of a
root that is already being bumped by the ordinary Patch row — harmless, per the same "epoch count is
not the contract" argument above, and not a case worth special-casing out.

---

## 6. Why `STORE.md` §6's memo key does not need to change

`AUDIT-2026-07-31.md` §2 proposed, as its cheapest option: "Include `observedEpoch` in the memo key for
resolutions that contain any `orphaned` overlay." That option is superseded, not merely unnecessary,
once `overlayAwaiting` exists:

1. **It would require the memo to branch on its own cached content** to decide which key shape applies
   ("does this cached `Resolution` contain an orphaned overlay?" is a question about the *value already
   in the cache*, not about the request), which is exactly the kind of value/cache-shape coupling
   `STORE.md` §6's existing design (`(rootId, chainEpoch[rootId], optionsKey)`, uniform for every root
   regardless of what its last resolution contained) was written to avoid.
2. **It would reintroduce coarse invalidation for the one case it's needed**, the opposite of D24's
   whole point: `observedEpoch` bumps on *every* `observe`/`unobserve` call, so keying any root's memo
   on it — even conditionally — means every ingest anywhere invalidates every root that happens to carry
   an orphaned overlay, not just the roots whose specific orphaned target actually changed. That is the
   identical "seconds of diff re-application" shape D24 already rejected for the trust/observed merge,
   recurring inside the observed epoch itself.
3. **The reverse index makes `chainEpoch[rootId]` alone sufficient again**, which is what §6 already
   promises. The audit's option (1) was a way to route around `chainEpoch` not being precise enough for
   this one case; the mandate's chosen fix repairs `chainEpoch`'s precision directly, at the point the
   imprecision was introduced (`chainEpochTargets`'s row coverage), rather than compensating for it one
   layer up at the memo. Once §5's dispatch table is complete, "epoch unchanged" and "nothing this root's
   resolution depends on has changed" are the same statement again — exactly the invariant `resolveRoot`
   (`store.ts:413-436`) was written to rely on, and needed no further code change.

`STORE.md` §6's `MemoEntry`/`resolveRoot` text stands **completely unedited** by this fix. No new field,
no new key component, no new branch in the lookup. This is worth stating explicitly because it is the
one place a reader familiar with the audit's own proposed options might expect a change and not find one.

---

## 7. Worked trace of the P1 scenario

Root `R` — a Product, pubkey `PA`, `content: "v1"`. No patches on `R` yet.

**Step 1 — `R` observed.** `chainEpochTargets(R, …)`: `type === 'product'` → `[R]`. `chainEpoch =
{R: 1}`. `overlayAwaiting = {}` (nothing to register; `R` is not a Patch).

**Step 2 — foreign overlay `O` observed**, `e root = R`, `e reply = X` (`X` not yet observed anywhere,
and unrelated to `R`'s own chain — it will never carry `e root = R` itself).
- `processObservedEvent(O, …)`: `type === 'patch'` → `chainMembership[O] = R` (existing rule).
  New: `replyTarget(O) = X`, `rootTarget(O) = R`, both defined → `overlayAwaiting[X]` gains `R`.
  `overlayAwaiting = {X: [R]}`.
- Bump dispatch for `O`: Patch row → `[R]`; new row → `overlayAwaiting[O.id]` is empty (nothing
  awaits `O` itself) → nothing added. `chainEpoch = {R: 2}`.

**Step 3 — a consumer calls `resolveRoot(state, R, memo)`.** `epoch = 2`, no cached entry → fresh
`resolve(R, [R, O])`. `O` is foreign, `replyTarget(O) = X`, `byId.has(X)` is `false` (never observed) →
`overlayState` returns `orphaned/beta`. Memo caches `{epoch: 2, resolution: orphaned/beta}`.

**Step 4 — `X` is observed** (say, an unrelated Metadata event; its own type does not matter to this
trace).
- Bump dispatch for `X`: `type === 'metadata'` row → `[X]`. New row: `overlayAwaiting[X.id]` looks up
  the *value* `X`, i.e. `overlayAwaiting["X"] = [R]` from Step 2 → `[R]` is added too.
  `chainEpoch = {R: 3, X: 1}`.

  *Without this fix* (current shipped `chainEpochTargets`, four rows only): the Metadata row contributes
  only `[X]`; `chainEpoch[R]` stays at `2`. The next `resolveRoot(state, R, memo)` finds
  `cached.epoch === 2 === state.chainEpoch[R]` and returns the **stale** `orphaned/beta` resolution
  forever — the exact `memoised store, target present : orphaned/beta` line from the audit's
  reproduction.

**Step 5 — with the fix, `resolveRoot(state, R, memo)` is called again.** `epoch = 3 ≠ cached.epoch (2)`
→ recompute `resolve(R, [R, O, X])`. `byId.has(X)` is now `true` → `overlayState` returns
`orphaned/alpha` (still not part of `R`'s canonical chain positions — DEL-7's α/β is about
observedness, not chain membership — but now correctly α, "obtainable," per §10's audit preservation).
This is exactly `fresh store over same final set: orphaned/alpha` from the audit — memoized and fresh
paths now agree, restoring D29.

---

## 8. Consequences for `STORE.md` §8 (coverage) and §9 (the gate)

Described here, in this file's own closing section, per the task's instruction — **not** edited into
`STORE.md` directly.

**§8 (rule-coverage expectations).** `overlayAwaiting` emits no `Issue` and cites no new rule id — like
`chainMembership`, it is pure bookkeeping, not a disposition. No new coverage-table row is owed. Two
existing rows' stated coverage needs strengthening, not retagging:

- **RC-3** (`STORE.md` §8: "covered by a regression asserting a bumped `chainEpoch` always produces a
  fresh `resolve()` call") needs a second regression specifically exercising the cross-root path: an
  event `X` with no relationship to root `R` in any of the four original dispatch rows, arriving *after*
  an overlay on `R` names it as a reply target, must still bump `chainEpoch[R]`. Every regression this
  project has accumulated to date (`STORE.md` §10, `AUDIT-2026-07-31.md` §11) has been added at the exact
  point a gap was found; this is that point for RC-3.
- **UR-1** (SG1, below) needs its generator biased to actually produce the P1 shape, or the new row can
  regress silently under a green gate — see SG5 below.

**§9 (the gate).**

- **`StoreView`/`toStoreView`** (`store.ts:77-89`) must exclude `overlayAwaiting` from the confluence
  projection, for the identical reason `chainMembership`/`bindingsAwaiting` are already excluded
  (`STORE.md` §3's correction, §9): its exact contents are arrival-order-dependent bookkeeping, and
  comparing it directly would fail SG1 over a difference that was never part of UR-1's contract. The
  three-field exclusion list becomes a four-field one; no other change to SG1's own statement.
- **SG2** (epoch cost / reference identity after a `trust`/`untrust` delta) extends its assertion list
  to include `overlayAwaiting`, alongside `chainEpoch` and the memo. This should pass trivially today —
  the `'trust'`/`'untrust'` cases of `applyStoreDelta` (`store.ts:353-369`) spread `...state` and touch
  only `trustEpoch`/`admit`, so `overlayAwaiting` is carried through by reference untouched — but SG2
  exists precisely to catch a *future* refactor that recomputes the same value and happens to match, so
  the assertion should name the field explicitly rather than rely on it passing by omission.
- **SG5** (generator bias) gains one new bias clause: generate a Patch shaped as an overlay (`e root`
  on one root, `e reply` naming an event carrying no relationship — no `e root` — to that same root),
  delivered in both arrival orders relative to its reply target (target-before-overlay and
  target-after-overlay), across both single-event-delta and batched-`observe` shapes (mirroring SG1's
  own existing requirement to exercise both shapes). None of SG5's presently-stated biases (Binding
  endpoints split across `add()` calls; a `trustEpoch` bump immediately followed by a chain-affecting
  event; the SG3 dedup race) would organically generate this shape — it is a fifth, independent bias,
  not a variant of an existing one.
- **A new permanent regression case**, per the project's own "every counterexample becomes a permanent
  regression case" rule (`STORE.md` §9's closing line): §7's worked trace, verbatim, as a fixed test —
  memoized-store-vs-fresh-store agreement for an overlay whose reply target arrives strictly after the
  overlay itself, anchored at a root with no chain relationship to that target.

No change is owed to SG3 (dedup-after-verification) or SG4 (the coverage-table mechanism itself) — this
fix touches neither.

---

## 9. Decisions touched

- **D24** — amended. The mandate's own draft Corrections text (`PLAN-2026-08-01-rewrite-mandate.md` §3)
  is essentially right; this document adds two refinements the spec-and-plan pass's Corrections-drafting
  step should fold in: (a) the "never cleared" clause covers *both* dimensions of the field — the
  target-keyed entry (the mandate's own explicit statement) and each entry's *contributing root ids*
  (§4 above, which the mandate's one-line sketch left silent) — not just the former; (b) the consulted
  signal is not scoped to Patches on the read side — `chainEpochTargets`'s new row fires for the
  arriving/departing event's own id regardless of that event's type (§5), Patches are only where the
  index is *populated*.
- **D29** — this is C5's repair. C5 remains on record as a correct historical finding (append-only); this
  fix is the "own phase" C5 said the gap needed, and it closes with §7's confluence restored.
- **D26** — untouched, cited only as unbroken precedent (`STORE.md` §6): the memo key still has no trust
  component, and nothing here adds one. Overlay classification itself (`resolve.ts`'s `overlayState`)
  is not touched by this fix at all — only the invalidation signal that decides when to recompute it.
- **D38** — unbroken: `overlayAwaiting` stores ids only (`Record<targetId, rootId[]>`), never event
  content, resolved bytes, or anything else `D38` reserves for raw-event caching.
- **D15/D43** — unbroken: `overlayAwaiting` is plain data (a `Readonly<Record<string, readonly
  string[]>>`, same shape discipline as every other `StoreState` field), and the reducer stays pure and
  synchronous.

**Needs, before code lands:** a new dated Corrections entry in `DECISIONS-2026-07-27.md` amending D24,
per the mandate's own instruction — refined per the two points above. Not written here; append-only
edits to that file are a later stage's job per this session's own constraints.

---

## 10. Open questions for the spec-and-plan pass

1. **Real fan-in, unmeasured.** The mandate's own open item: how many roots can one popular event's
   arrival invalidate at once, in the real sec-certs corpus. `overlayAwaiting`'s cost is proportional to
   fan-in at bump time (one `bump()` call per listed root), not at population time, so a pathological
   fan-in (many roots' overlays all replying to one hub event) costs a proportionally larger single
   `observe()` call, never a correctness problem — but it is worth measuring before committing to any
   future optimization of the bump loop itself.
2. **Identity-comparison grep**, per the mandate: confirm nothing outside this fix depends on
   `resolveRoot`'s return value being reference-stable *across* an epoch bump for the same root — this
   fix does not change that contract (a bumped epoch always recomputes, exactly as before), but the
   mandate asked for the grep as a sanity check given the option that was rejected specifically to avoid
   breaking it.
3. **Whether the self-referential degenerate case (§5, closing paragraph) is reachable from a validator
   that will eventually reject it.** Once mandate item 6 (validation wiring) lands, a Patch whose
   `e reply` equals its own id is presumably invalid under some existing or future V rule; this document
   does not depend on that landing, since the degenerate case is already harmless under §3's
   over-approximation argument regardless of validity.
