# `store` — reducer, ports, epochs

Phase 5 mini-spec. Written before any code, as Phases 2–4 were.

Governing text: §4.3 (Binding pending-endpoint lifecycle, BD-6/7), §6 (trust & admission — consumed,
not re-derived), §7.1 (RC-3/4 recomputation), §7.6 (unresolved references, UR-1…3), §10 (kind 5,
DEL-8/9), §5.4 (RL-2/3, configured as opposed to enforced here). Decisions: D15 (reducer + port,
never a class), D18 (`verify` required, no default), D19 (verification status travels with ingest,
unskippable by default), D20 (dedup only after verification), D24 (three independent epochs), D25/D29
(the pure functions stay the oracle), D26 (overlay-cache key has no trust component), D28 (lazy
per-position content — a `resolve()`-internal concern; store's own memo is a *different*, cross-call
cache), D37 (in-memory tier for v0.1), D38 (cache raw events, never resolved content). Rules owned:
UR-1…3, RC-3/4, BD-6/7, DEL-8/9, RL-2/3, SIG-1 (enforcement half).

---

## 0. Scope and shape

`store` answers one question: **given a stream of events arriving in any order, from any number of
sources, what is the current observed set, and how do I get a `resolve()`/`admit()` answer for a
root without re-deriving it from scratch on every tick?**

It does not reimplement chain resolution or admission. `resolve` and `admit` are retained as-is —
pure, trust-blind (`resolve`) or storage-free (`admit`) functions — and are the conformance oracle
(D29) every incremental path here must agree with. `store`'s entire job is bookkeeping *around*
them: knowing when a cached answer is still good, knowing which root(s) a newly-arrived event could
affect, and gating what's allowed to reach either function in the first place (verification, dedup).

```ts
export function createStore(options: CreateStoreOptions): Store
```

is the ergonomic entry point a real consumer uses. It is a **factory function returning a plain
object of bound methods, never a `class`** (D15) — there is no `new Store()`, no inheritance, no
prototype chain for a future IndexedDB/SQLite adapter to slot into. The port it is built from,
`EventStorage`, is injected via config exactly the way `automerge-repo` injects
`StorageAdapterInterface` (D15's own citation).

Underneath that factory sits the part every gate item actually exercises: a **pure, synchronous
reducer**,

```ts
export function applyStoreDelta(state: StoreState, delta: StoreDelta): StoreState
```

with no IO and no async — the same shape as `admit.ts`'s `applyDelta`, and for the same reason: SG1's
confluence property and SG2's epoch-cost regression need something to call directly, in-process, with
plain-data before/after states compared by deep equality. `createStore`'s `add()` is `async` (because
`EventStorage.put` may not be), but everything it does beyond awaiting the storage port is delegate to
this reducer. **`StoreState` is plain data — no methods, no closures — same discipline as
`Resolution`/`AdmissionIndex`** (D43's precedent): the confluence gate compares two states with deep
equality, and a closure-bearing type would compare by reference and the property would be vacuous.

---

## 1. State shape

```ts
export interface StoreState {
  /**
   * admit.ts's own state, threaded through unmodified — BD-6/TR-2…7/DEL-4/5 are already correct.
   * Deliberately the *single* copy of the raw event cache too: `AdmitState.observedById` already is
   * D38's "cache raw events, never resolved content," so `StoreState` does not duplicate it. Every
   * field below reads observed events via `state.admit.observedById`, never a second map.
   */
  readonly admit: AdmitState

  /** BD-7's permanent rejection cache. Sorted, for deep-equality-friendly plain data. */
  readonly rejectedBindings: readonly string[]

  /** §2's reverse indices — see that section for why each exists. */
  readonly chainMembership: Readonly<Record<string, string>>       // patch/overlay id -> root id
  readonly bindingsAwaiting: Readonly<Record<string, readonly string[]>> // endpoint id -> binding ids

  /** §3's three epochs. */
  readonly trustEpoch: number
  readonly observedEpoch: number
  readonly chainEpoch: Readonly<Record<string, number>>            // per root id
}

export const EMPTY_STORE_STATE: StoreState = Object.freeze({
  admit: EMPTY_ADMIT_STATE,
  rejectedBindings: [],
  chainMembership: {},
  bindingsAwaiting: {},
  trustEpoch: 0,
  observedEpoch: 0,
  chainEpoch: {},
})
```

Two things this state deliberately does **not** hold: a cached `Resolution` per root (§6 — that memo
lives beside `StoreState`, not inside it, so two logically-equal states are allowed to differ in what
happens to be memoized without breaking SG1) and a per-event verification flag (§5 — once an event is
in `admit.observedById` it has already passed the gate; there is nothing further to remember about
it). Dedup (§5) is therefore also not a separate table — `admit.observedById`'s own membership test
(shared with `admit.ts`'s own idempotent `observe` handling) is the dedup check.

---

## 2. The pending-reference buffer's lifecycle

The plan asks this settled concretely: what triggers re-evaluation when a dangling `e root` / `e
reply` / Binding endpoint arrives, without re-running `resolve`/`admit` from scratch on every ingest.

**The BD-6 half (pending Binding endpoints) needs no new bookkeeping at all.** `admit.ts` already
retains "the credit table holds ids that have not arrived" (its own §5 note) — a trusted Binding's
endpoint credits are recorded by id whether or not an event with that id has been observed, and when
the endpoint finally arrives its admission is already `> 0` from the credit on file. `store` gets this
for free by threading every `observe`/`unobserve`/`trust`/`untrust` through `admit.applyDelta`
unmodified. Nothing here re-derives what that module already gets right.

**The UR-2 half (patches whose root is unobserved) needs no new bookkeeping either, for a sharper
reason: it reduces to §3's per-root chain epoch.** `resolve(rootId, events)` already reports
`pending` patches on every call when the root is unobserved (§1 of `RESOLVE.md`) — there is nothing
to *track* about that fact independently, because there is nothing for the tracking to *do* that
recomputing on the next resolve() call doesn't already do. The only thing that must happen correctly
is: when the missing root arrives, some future `resolve(rootId, …)` call must see it. That is
guaranteed structurally, not by a buffer: a root event's own arrival always bumps
`chainEpoch[rootId]` (§3), so any memo entry for that root — if one exists at all — is invalidated,
and if no one has asked about that root yet there is nothing to invalidate and nothing to do. A
"pending buffer" that duplicated this would be state that could drift from the epoch map; not having
one is what prevents that drift.

**The one case that genuinely needs a new index is BD-7's typing check on a *not-yet-fully-observed*
Binding**, because unlike UR-2 (where the missing id is named directly, in the patch's own `e root`
tag) a kind 5 or a Binding's counterpart endpoint gives no advance signal of *which* Binding is
waiting on it. Two small reverse indices carry the whole mechanism:

```
chainMembership : patch/overlay event id  -> the root id it declared via e root
bindingsAwaiting: endpoint event id       -> ids of Bindings still missing that endpoint
```

**`chainMembership`** is populated the moment a patch (root-author or foreign — the map doesn't care)
is observed: `chainMembership[patch.id] = rootTarget(patch)`. It exists so a *kind 5 deletion*, whose
`e` tag names only the target's id and nothing about which root that target belongs to, can still
resolve the right `chainEpoch` entry to bump (§3) without a full scan of `observedById`.

**`bindingsAwaiting`** is populated only for a Binding whose endpoints are **not both already
observed** at the moment it arrives — if both are already present, BD-3/BD-4 typing is checked
immediately and the verdict (pass, or permanently rejected into `rejectedBindings`) is final; there is
nothing to await. Otherwise, for each missing endpoint id `e`, `bindingsAwaiting[e]` gains the
Binding's id. When any event with id `e` later arrives, `store` looks up `bindingsAwaiting[e]`, and
for each Binding named there re-runs the typing check against `observedById` — now that one more of
its endpoints is known. Three outcomes: still missing an endpoint (leave it in the index); both
present and typing holds (remove it — nothing more to check, ever, since endpoint types are
immutable); both present and typing contradicts (remove it, and add the Binding's id to
`rejectedBindings` — BD-7's permanent cache, populated exactly once per rejected Binding).

This is genuinely a *buffer* — an id can sit in `bindingsAwaiting` indefinitely if its endpoint never
arrives (the spec's own words: "If endpoints remain unobserved indefinitely, the Binding remains
pending" — §4.3) — which is why it is a real data structure and not, like UR-2, something that
reduces away.

---

## 3. The three epochs, concretely

D24 names three independent invalidation signals and this phase has to decide the data structure
that keeps a `trustEpoch` bump from ever touching chain resolution.

```
trustEpoch    : number                    — bumps on trust(pubkeys) / untrust(pubkeys) only
observedEpoch : number                    — bumps on every observe()/unobserve() call, coarse
chainEpoch    : Record<rootId, number>    — bumps only for the root(s) a given event could affect
```

**`trustEpoch` touches nothing but `admit`.** A `trust`/`untrust` delta in `applyStoreDelta` does
exactly two things: bump `state.trustEpoch`, and fold the delta into `state.admit` via
`admit.applyDelta`. It never writes `chainEpoch`, never writes `chainMembership`, never touches
`observedById`. This is the whole of SG2: assert that after a trust-only delta, `chainEpoch` (and the
Resolution memo, §6) are the *same reference* as before, not merely deep-equal — a reference check is
what catches a future refactor that recomputes chain epochs and happens to land on the same numbers.
`admit.ts`'s own `resync()` never calls anything in `resolve.ts` or `patch.ts` either (it has no
import of either), so "zero `applyPatch` calls on a trustEpoch bump" is not a property `store` has to
engineer — it falls out of `admit.ts`'s existing module boundary, and `store` only has to avoid
*adding* a resolve-triggering side effect to the trust path.

**`observedEpoch` is coarse on purpose** — it is the one signal that is not root-scoped, because
nothing about "some event arrived" names a root the way a patch's own `e root` tag does. Its only
consumer is a caller that wants "has anything changed since I last looked," e.g. a UI badge; nothing
in `resolve`/`admit`'s correctness depends on it.

**`chainEpoch` is what actually gates a root's cached `Resolution`.** `applyStoreDelta`'s `observe`
case bumps it per event, using `chainMembership` and the event's own shape to decide which key(s):

| observed event is a… | epochs bumped |
|---|---|
| Product / Metadata (root-eligible) | `chainEpoch[event.id]` |
| Patch | `chainEpoch[rootTarget(event)]` (created at 0 if the root is still unobserved — see §2) |
| kind 5 (deletion) | `chainEpoch[chainMembership[target]]` for each `e`-tagged target that resolves, **and** `chainEpoch[target]` unconditionally (harmless if `target` is not itself a root — see below) |
| Binding | none — Bindings are not part of `resolve()`'s domain (BD-9); only `admit`'s state changes |

The kind 5 row bumps **both** the mapped root (via `chainMembership`) and the raw target id directly.
The second bump is deliberately redundant when the target is a patch (its root is already covered by
the first) and is the only coverage at all when the target is itself a root being deleted (DEL-4) —
bumping an epoch that turns out not to matter costs one wasted memo miss; *not* bumping one that did
matter serves stale bytes, which RC-3 forbids outright. The asymmetry in that trade is why the
"unconditional" half is there.

**Design correction, found while writing this section, before code existed.** The table above means
a root's exact `chainEpoch` *count* is arrival-order-dependent: a deletion targeting patch `P1` bumps
`chainEpoch[R]` if `P1`'s root membership is already known (`P1` arrived first) but bumps only
`chainEpoch[P1]` if the deletion arrives *before* `P1` does (the owning-root lookup in
`chainMembership` simply misses). Two arrival orders of the *same eventual set* therefore reach
different absolute epoch numbers for `R`. A first draft of SG1 (below) asked for full `StoreState`
deep-equality across permutations, which this would fail — correctly bookkept, incorrectly specified.
The fix is not to make the bump order-independent (that would mean recomputing membership from
scratch per event, defeating the point of an incremental counter); it is to recognise that the exact
epoch *number* was never part of the contract — only whether it changes when something relevant does.
**SG1 compares a projection, `StoreView` (§9), that excludes `chainEpoch`/`chainMembership`/
`bindingsAwaiting` and keeps only what a real consumer can observe: the admitted set, the rejected-
binding set, and — checked separately, per root — that `resolveRoot` still agrees.** This is the same
move AG1 already makes by comparing `toIndex(AdmitState)` rather than the raw state with its own
order-sensitive `liveBindings` bookkeeping; nothing here is a new kind of looseness.

**Why a third, separate epoch was needed at all, restated concretely:** without `chainEpoch` scoped
per root, the only invalidation signal left would be `observedEpoch`, and using it to gate the
Resolution memo would mean *any* event anywhere invalidates *every* root's cached chain — exactly the
"seconds of diff re-application" D24 warns a merged signal produces, just moved from
trust-vs-observed into observed-vs-observed.

---

## 4. DEL-8/DEL-9 vs BD-7 — why they cannot cross-contaminate

Both caches are monotone, and the plan is right to flag that conflating their invalidation is D23's
refcounting bug wearing a different coat. They stay apart because they are answering different kinds
of question, backed by different mechanisms, with no shared trigger:

**DEL-8/DEL-9 need no cache of their own.** "Cache locally received kind 5 deletion events" (DEL-9)
is satisfied by the fact that `observedById` never evicts anything currently reachable from a live
root (§7), and "recompute retroactively when a deletion's target arrives" (DEL-8) is satisfied by
`resolve.ts`'s own purity: `honouredDeletions` re-evaluates the pubkey-and-membership test fresh on
*every* call over whatever events are handed to it (`RESOLVE.md` §2). There is no deletion-specific
cache to invalidate because there is no deletion-specific cache — the "cache" is `observedById` itself
plus the discipline of always passing every relevant kind 5 event into `resolve()`, deletion honoured
or not.

**BD-7 is the opposite shape: a real, permanent, monotone verdict about a *Binding's own endpoint
types***, which — unlike deletion honouring — can never be re-evaluated into a different answer once
made, because an event's `scrutinyEventType` cannot change after publication. `rejectedBindings` is
therefore append-only, keyed by Binding id, and nothing about a kind 5 deletion arriving anywhere ever
writes to it — a deletion changes *default-view visibility* (DEL-4/DEL-5, `admit`'s concern) or
*canonical chain membership* (DEL-2/DEL-6, `chainEpoch`'s concern), never an endpoint's type.

Concretely, the guard is structural rather than a runtime check: the two caches live in disjoint
fields of `StoreState` (`rejectedBindings` vs. the absence of any deletion-specific field at all), are
written by disjoint branches of `applyStoreDelta` (the Binding-endpoint-arrival path vs. the
kind-5-observe path), and neither reads the other. There is no shared epoch, no shared counter, and no
code path that touches both in service of a single event — which is what makes them independently
correct instead of correct-by-convention.

---

## 5. Verification and dedup (D18/D19/D20, SIG-1 enforcement)

```ts
export interface CreateStoreOptions {
  /** REQUIRED. Covers signature AND id recompute (SIG-1). No default — D18. */
  readonly verify: (event: NostrEvent) => boolean
  /** D37: in-memory default. */
  readonly storage?: EventStorage
  /** Threaded to every internal resolve() call — RL-2's configuration half. */
  readonly applyOptions?: ApplyOptions
}

export interface IngestMeta {
  readonly source?: string
  /**
   * The caller already ran an equivalent verify() over this whole batch (e.g. a relay adapter that
   * verifies on receipt) — skip re-running it here. Distinct from `trustUnverified`: this still
   * asserts genuine verification happened, just not redundantly (D19's ~50-100µs/event saving).
   */
  readonly verified?: boolean
  /**
   * Named apart from `verified` on purpose (D18/D19) — this is the actual bypass, and its distinct
   * name is what makes it grep-able in review. Admits events with NO verification claim at all.
   */
  readonly trustUnverified?: boolean
}
```

**The gate, per event, in `add()`:** if `trustUnverified` is set, admit unconditionally. Else if
`verified` is set, admit without calling `verify()` again. Else, call `options.verify(event)`; on
`false`, drop the event — it never reaches `applyStoreDelta`, never touches `admit.observedById`,
never touches `chainMembership`, and is reported back to the caller as rejected (citing SIG-1, §8)
rather than silently disappearing.

**D20's ordering is what this gate makes structural rather than aspirational.** The failure mode it
prevents — a relay pre-registering a genuine event's declared id with a forged copy, so the dedup
table already "knows" that id and silently drops the authentic copy arriving later — requires dedup
state to be touched *before* verification. Here there is exactly one place an id ever enters
`admit.observedById` (inside `applyStoreDelta`'s `observe` case, itself only reachable once an event
has passed the gate above), so a forged submission that fails `verify()` touches **no** field of
`StoreState` at all — not `admit`, not `chainMembership`, nothing. So there is nothing for a later,
genuine submission of the same declared id to collide with: membership in `admit.observedById` is only
ever `true` because a *verified* copy is already there, and content-addressing (D18's other
consequence — two
occurrences of the same id are byte-identical events) means "first verified wins" and "any verified
wins" agree. SG3 builds this race directly rather than trusting the ordering by inspection: submit a
forged event claiming id `X` (fails `verify`), then the genuine `X` from a second source, and assert
the genuine copy is present — and the reverse order, where it is trivially present regardless.

---

## 6. The Resolution memo (D28/D38) — beside the state, not inside it

```ts
interface MemoEntry {
  readonly epoch: number              // the chainEpoch[rootId] this was computed against
  readonly optionsKey: string         // a stable stringification of the ApplyOptions used
  readonly resolution: Resolution
}
```

Keyed by `rootId`, a `Map<string, MemoEntry>` living **alongside** `StoreState`, not as one of its
fields. Two reasons it stays out:

1. **D38's own wording** — "Resolutions are an in-memory memo... dropped on dirty" — describes a
   cache with an eviction policy, which is exactly the kind of thing D43's "plain data, no methods, no
   closures" discipline exists to keep *out* of a type compared by deep equality. Two `StoreState`s
   that are logically identical (same observed set, same trust set, same epochs) must compare equal
   under SG1 regardless of which roots happen to have a warm memo entry — a memo folded into the
   state would make the property sensitive to caching history, not just to content.
2. **The key deliberately excludes trust/view**, matching D26's overlay-cache precedent exactly: an
   entry is looked up by `(rootId, chainEpoch[rootId], optionsKey)` and is valid or it is not,
   independent of who is asking. Trust is applied *after* the lookup, via `admit.visibleOverlays`
   over the memoed `Resolution.overlays` — which is already O(overlays), so there is nothing to gain
   and real cost to lose (D24's whole argument) by keying the memo on a view as well.

Reading a root: compute `optionsKey` from the caller's requested `ApplyOptions` (or the store's
default), look up the memo entry, and recompute via `resolve()` only if absent or its `epoch` differs
from the current `chainEpoch[rootId]`. Writing the fresh result back with the current epoch is the
entire cache-fill step — there is no invalidation *code* to get wrong, only a comparison.

---

## 7. `EventStorage` — the port (D15/D16/D37)

```ts
export const storageSymbol = Symbol.for('@scrutiny-fabric/storage')

export interface EventStorage {
  readonly [storageSymbol]: true
  put(events: readonly NostrEvent[]): Promise<void> | void
  query(
    filters: readonly NostrFilter[],
    options?: { readonly includeDeleted?: boolean },
  ): Promise<readonly NostrEvent[]> | readonly NostrEvent[]
  get(ids: readonly string[]): Promise<ReadonlyMap<string, NostrEvent>> | ReadonlyMap<string, NostrEvent>
}
```

Sync-or-async return types on purpose: the in-memory default (v0.1, D37) resolves immediately, and a
future IndexedDB/SQLite adapter needs the same shape to be genuinely async without a breaking change
to callers, which is the entire point D15 is making. `createStore`'s `add()` is therefore `async`
regardless of which adapter is wired in — `await`ing a synchronous return is free.

`query`'s `includeDeleted` copies welshman's repository shape by design (per D37): `isDeleted()` as a
predicate over an always-retained event, never a removal from storage. This is what keeps DEL-4's "the
canonical chain, foreign overlays, and Bindings referencing a retracted root are preserved for audit"
achievable — nothing here ever calls `EventStorage` with an instruction to delete a kind-5-targeted
event, only kind 5 events themselves, stored like any other.

**In-memory default only for v0.1** (D37) — an object satisfying `EventStorage` over a `Map`, no
persistence across process restarts. IndexedDB and SQLite adapters are the app's problem.

---

## 8. Rule-coverage working expectations (SG4 draft)

Stated before code exists, as `RESOLVE.md` §9 and `ADMIT.md` §10 did.

| rule | expected disposition |
|---|---|
| UR-1 | not-covered — the property itself (confluence), not an emittable code. SG1 is the coverage. |
| UR-2 | not-covered — §2 argues this reduces to chain-epoch bumping; the failure mode is a stale answer, not an issue. Covered behaviourally: ingest a patch before its root, then the root, assert the patch is chain-linked once both are observed. |
| UR-3 | not-covered — a caching *discipline* ("must not cache while unobserved"), not a predicate on an event. `resolve.ts`/`validate.ts` already satisfy this by never caching authorship class internally; `store`'s memo key (§6) is scoped by `chainEpoch`, which changes the moment the root arrives, so there is no stale classification to serve. Covered behaviourally. |
| RC-3 | not-covered — an obligation on how a non-UI consumer *behaves* (recompute on change), satisfied structurally by the epoch-gated memo (§6) rather than by emitting anything when honoured. A violation would silently serve stale bytes, not raise a code. Covered by a regression asserting a bumped `chainEpoch` always produces a fresh `resolve()` call. |
| RC-4 | not-covered — as RC-3, a SHOULD rather than a MUST, same mechanism. |
| BD-6 | not-covered — `admit.ts` already implements this correctly (§2); `store` only threads deltas through. Covered behaviourally, biased by SG5. |
| **BD-7** | **emitted** — the one real rejection disposition in this table. When the reverse-index check (§2) finds a Binding's observed endpoints contradict BD-3/BD-4, `store` constructs `issue('BD-7', 'warning', …)` (D-layer, never `error` — TR-1) alongside adding the Binding's id to `rejectedBindings`. |
| DEL-8 | not-covered — §4 argues this is `resolve.ts`'s purity plus retention, not a `store`-owned code path. Covered behaviourally: a deletion observed before its target, then the target, assert the deletion is honoured once both are present. |
| DEL-9 | not-covered — a MUST-cache obligation satisfied by `observedById` never evicting a reachable kind 5 event; violating it is silent wrong content, not an issue. Covered behaviourally by asserting a kind 5 event survives an unrelated `unobserve` call. |
| RL-2 | not-covered — a configuration-surface obligation (`CreateStoreOptions.applyOptions`), not a predicate with a failure mode; the ceiling it configures is enforced (and emits) inside `patch.ts`/`resolve.ts`, which already own RL-3's emission. Covered behaviourally: a low ceiling configured at `createStore` time surfaces as an `aborted`/`limit` outcome on the next resolve. |
| RL-3 | not-covered *by this module* — `resolve.ts`/`patch.ts` already emit it; `store` neither adds nor removes that emission, only passes `ApplyOptions` through and surfaces the resulting `Resolution.annotations` unchanged. Listed here (per the plan's module table) because `store` is what makes RL-3 reachable *at all* through the public entry point; the code itself is not this module's to claim. |
| **SIG-1 (enforcement)** | **emitted** — §5's gate. An event failing `options.verify()` (outside `trustUnverified`) is reported to the caller with `issue('SIG-1', 'error', …)`. `error` is correct here, not a TR-1 violation: SIG-1 is the V rule *establishing* invalidity for an unverifiable event, not an A/D rule rejecting a V-valid one. |

Two emitting rules, ten not-covered — a smaller ratio than G4's 3/32 or AG3's 0/9, and that is
expected: most of what `store` owns is *bookkeeping obligations* (recompute on change, retain, don't
cache too eagerly) whose violation is silently wrong behaviour rather than a reportable condition.

---

## 9. The gate

**SG1 — confluence, store-level (UR-1).** For a generated event set `E`, generated interleaved with
zero or more trust deltas, and a permutation `π`: folding `π`'s ordering of the whole delta sequence
through `applyStoreDelta` from `EMPTY_STORE_STATE` reaches a **`StoreView`** — not a raw `StoreState`,
per §3's correction — deep-equal to folding the original order:

```ts
export interface StoreView {
  readonly observedIds: readonly string[]     // sorted — the observed SET, per UR-1's own wording
  readonly admission: AdmissionIndex           // toIndex(state.admit)
  readonly rejectedBindings: readonly string[] // already sorted in StoreState
}
export function toStoreView(state: StoreState): StoreView
```

`chainEpoch`/`chainMembership`/`bindingsAwaiting` are excluded because §3's correction found their
exact values legitimately arrival-order-dependent; comparing them would fail the gate over a
difference that was never part of UR-1's contract. **Separately**, for a sample of root ids the
generator touches, assert `resolveRoot(state, rootId)` (fresh memo each time, so the memo is not a
confound) agrees across every permutation too — this is what actually stands in for "confluence of
what a consumer can observe," since `StoreView` alone says nothing about chain content. Run both the
view comparison and the resolve comparison as **one delta per event** and as **all observed events
batched into a single `observe` delta**, since batching is a real code path (`add()` on a multi-event
array) that single-event folding cannot exercise on its own — a bug reachable only via the batched
branch is exactly the kind of thing a gate that only tries one shape would miss.

**SG2 — epoch cost (D24).** After any `trust`/`untrust` delta, `chainEpoch` and the Resolution memo
(§6) are the same *reference* as before the delta, not merely deep-equal-valued — asserting reference
identity is what would catch a future change that recomputes the same numbers by touching the map
anyway. Promoted from a single regression test to a numbered gate item so it gets a floor like AG4's,
run across a generated sequence of interleaved trust and observe deltas rather than one hand-written
case.

**SG3 — dedup-after-verification (D20).** The two-relay race from §5, built directly: a forged event
claiming a genuine event's declared id, delivered before and after the genuine copy, in both orders,
across two separate `add()` calls (not one, since batching within a single call never exercises the
cross-call dedup path SG1 additionally checks against a single-call baseline).

**SG4 — rule-coverage partition**, per §8, reusing `test/_coverage.ts` with a new
`test/_a-store-coverage.ts`.

**SG5 — generator bias and floors.** Bias toward: a Binding's two endpoints delivered in separate
`add()` calls rather than the same one (crossing the real module boundary `admit.ts`'s own AG4 could
not, since that phase's gate only ever called `applyDelta` directly); a `trustEpoch` bump immediately
followed, in the same generated sequence, by an event that bumps `chainEpoch` or `observedEpoch`, to
catch any coalescing between the two; and the SG3 two-relay race as one generator shape among several
rather than only its own dedicated test. Log the outcome mix (admitted / rejected-by-verify /
rejected-by-BD-7 / pending) and assert a floor under each, as every prior phase's G4/AG4 has.

Every counterexample becomes a permanent regression case, as every prior phase's has.

---

## 10. Open questions and regression cases

**Found while writing §3, before code existed: `chainEpoch`'s absolute value is arrival-order-
dependent.** Full detail and the fix are in §3's correction note and §9's `StoreView` definition. Kept
here too, as this section's own permanent record, because it is exactly the shape of trap this
section exists to catch — the analogue of AG2's `ForwardDelta` narrowing and RESOLVE.md's
fork-vs-HALT precedence, found by reasoning through the design rather than by a failing test, since
there was no code yet for a test to fail against. Restated compactly: **do not compare raw
`chainEpoch`/`chainMembership`/`bindingsAwaiting` across two states expected to be "the same" —
compare `StoreView` (and, where chain content is the question, `resolveRoot`'s own output) instead.**
Any future code touching SG1 that starts asserting on raw `StoreState` equality has reintroduced
this gap.

No other open questions yet — further entries land here as the gate items surface them, the way
`ADMIT.md` §9/§10 and `RESOLVE.md` §4/§9 grew theirs.
