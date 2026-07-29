# `admit` — trust admission, reason sets, refcounting, views

Phase 4 mini-spec. Written before any code, as Phases 2 and 3 were.

Governing text: §6 (trust & admission, TR-1…7), §7.3 (overlay visibility, OV-7), §10 (kind 5,
DEL-4/5). Decisions: D22 (views, not a bypass flag), D23 (refcounted reason sets), D24 (epochs —
Phase 5's concern, noted where it constrains this phase), D25 (trust never reaches `resolve`).
Rules owned: TR-2…7, OV-7, DEL-4, DEL-5.

---

## 0. Scope and shape

`admit` answers one question: **given the events I have observed and a trust predicate, which of
them are in the user's view, and why?**

It never decides *what an event says* — that is `resolve`'s job, and D25/TR-7 forbid this module
from feeding trust into it. It decides *whether the user is shown* a given event, and *which
foreign overlays* render. Two independent mechanisms live here, and keeping them independent is
the main discipline of this spec:

1. **Admission** (TR-2…7) — reachability through trust: direct authorship trust, or trust in a
   Binding that vouches for the event. Refcounted, because more than one live reason can hold at
   once and losing one must not lose the others (D23).
2. **Default-view retraction** (DEL-4, DEL-5) — a kind 5 deletion hiding something from the
   default view. Orthogonal to admission with one exception: deleting a *Binding* also revokes the
   admission it conferred (DEL-5's second clause), which folds into mechanism 1's bookkeeping
   rather than sitting beside it.

```ts
export function computeAdmission(
  events: readonly NostrEvent[],
  trust: TrustProvider,
): AdmissionIndex
```

Unscoped by root, unlike `resolve` — admission spans every Product, Metadata, Binding, and Patch
in the observed set at once, because a Binding's endpoints can be anywhere in the graph. `events`
is an array for the same reason `resolve`'s parameter is (§0 of `RESOLVE.md`): the gate's central
property permutes it, and an API that hides the ordering hazard behind a `Set` would remove
nothing.

`AdmissionIndex` is **plain data** — same discipline as `Resolution` (D43's precedent): the gate
compares an incrementally-updated index against a from-scratch recompute with deep equality, and a
method-bearing or closure-bearing type would compare by reference and the property would be
vacuous.

---

## 1. Where `interfaces.ts` comes from

D16/D21 describe four branded extension interfaces, and the plan's package-layout table already
lists `interfaces.ts` as its own file — it has just never been created, because no module before
this one needed one. `admit` is `TrustProvider`'s first real consumer, so this phase creates:

```ts
export const trustSymbol = Symbol.for('@scrutiny-fabric/trust')

export interface TrustProvider {
  readonly [trustSymbol]: true
  isTrusted(pubkey: string): boolean
  readonly version: number
  deltaSince(v: number): { added: readonly string[]; removed: readonly string[] } | null
}
```

`isTrusted` **must** be synchronous (D21) — admission traverses the graph in one pass, and an
async predicate consulted mid-walk gives torn reads, the same hazard NDK's own async validation
had. `deltaSince` is declared here because `TrustProvider` needs it to exist as a type, but nothing
in Phase 4 calls it — that is Phase 5's incremental-recompute wiring against `trustEpoch` (D24).
`version` is unused by `admit` for the same reason. This file carries no rule IDs of its own; it is
architecture, not a spec rule, so it is not part of §9's coverage partition.

**Not created here:** `RelayTransport`, `EventStorage`, `ScrutinySigner`. They belong to whichever
module first needs them (`query`/`store`/`build`, respectively) and are out of scope for "this
module only."

---

## 2. The reason model

```ts
export type Reason = 'direct-trust' | `binding:${string}` | `root-chain:${string}`
```

A template-literal union rather than a discriminated object: reasons live inside a `Set`-like
structure keyed by string equality, and encoding the parameter *in* the string means two `Reason`
values with the same binding or root id are `===`-equal without a custom equality function — which
matters because `AdmissionIndex` must support deep equality out of the box (§0).

```ts
export function bindingReason(bindingId: string): `binding:${string}`
export function rootChainReason(rootId: string): `root-chain:${string}`
export function reasonKind(r: Reason): 'direct-trust' | 'binding' | 'root-chain'
```

Small parsing helpers, not exported beyond what tests need — `reasonKind` exists so a test can
assert "this event's *only* reason is direct-trust" without string-matching a template literal by
hand.

```ts
export interface AdmissionIndex {
  /** Every event id with ≥1 live reason, mapped to its reasons, sorted for determinism. */
  readonly reasons: Readonly<Record<string, readonly Reason[]>>
}

export const isAdmitted = (index: AdmissionIndex, eventId: string): boolean =>
  (index.reasons[eventId]?.length ?? 0) > 0
```

An absent key and a key mapped to `[]` are both "not admitted" — the implementation never produces
the second form, but a plain `Record` cannot forbid it structurally the way `resolve`'s tagged
union variants forbid an invalid `ChainState`. Noted as an accepted looseness rather than solved,
because closing it means a branded non-empty-array type that buys nothing here.

**Why `Reason` per event id, not per pubkey.** TR-2's admission test *reads* as being about
pubkeys ("is its `pubkey` trusted"), which invites keying the index by pubkey. Two things forbid
that: a `binding:<id>` reason is conferred on a specific *event* (the Binding's declared endpoint
id), not on a pubkey — a trusted Binding admits one Product and one Metadata by id, regardless of
who authored them; and `root-chain:<rootId>` is likewise per-event, since two patches by the same
pubkey against different roots do not share admission just because they share an author. Keying by
event id is the only shape that represents both correctly.

---

## 3. Binding admission and the bipartite reachability step

TR-3: a Binding is admitted **only** by direct trust in its own `pubkey` — never by anything else.
Consequence, worth stating as a standing invariant because §5's refcounting depends on it:

> **A Binding's reason set is always a subset of `{'direct-trust'}`.** It can never contain a
> `binding:*` or `root-chain:*` reason.

TR-4 then says an admitted Binding admits its two endpoints (`e root`, `e link`) with reason
`binding:<bindingId>`, for as long as the Binding is not retracted (DEL-5). This is D23's bipartite
reachability step, isolated to one function per the decision's own instruction, so the BD-3/BD-4
dependency is visible and not accidentally leaned on elsewhere:

```ts
/**
 * A Binding's two endpoint ids, or `undefined` if it does not carry exactly one of each marker.
 *
 * Depends on BD-3/BD-4 holding — a Binding connects exactly one Product (`e root`) and one
 * Metadata (`e link`), which is what makes admission's reachability step non-transitive and
 * non-recursive. If §11's Metadata↔Metadata bindings ever land, this function's two-endpoint
 * assumption breaks and the refcount model in §5 needs revisiting.
 */
function bindingEndpoints(binding: NostrEvent): { rootId: string; linkId: string } | undefined
```

A malformed Binding (zero or several `root`/`link` markers) is already a BD-2/BD-10 validity
concern; `admit` treats `undefined` here as "confers nothing" rather than re-deriving that
rejection, since it operates on `NostrEvent`s wholesale and does not re-run `validate.ts`.

---

## 4. Root-chain propagation — and why it cannot reuse `resolve`'s walk

TR-5: when a root Product/Metadata is admitted, its root-author patches and the root-author kind 5
events targeting them are admitted with it, "for as long as the root's own admission survives."

The tempting implementation calls `resolve`'s chain walk to find "the chain" and admits exactly
that. It is wrong, for a reason specific to admission rather than to chain semantics: `resolve`'s
walk **stops at the first self-fork** (SF-1) and does not extend past a HALT. If admission followed
it, a root self-fork's second branch — the sibling patch SF-3 requires surfacing "with event IDs of
both branches" — would never be admitted into the user's view, so the client could not render the
very warning the spec requires. The same argument applies past a HALT: TR-5 says root-author
patches are admitted, not "root-author patches that successfully apply."

So `admit` computes its own, simpler, two-pass reachable set — no linear walk, no fork-stopping,
no cycle guard needed because the two passes below cannot cycle:

```
candidatePatches(root) = { p : scrutinyEventType(p) = 'patch'
                                ∧ rootTarget(p) = root.id
                                ∧ p.pubkey = root.pubkey }

candidateDeletions(root) = { d : d.kind = 5
                                  ∧ d.pubkey = root.pubkey
                                  ∧ ∃ ref ∈ eTags(d): ref.id ∈ {root.id} ∪ ids(candidatePatches(root)) }
```

Every event in `candidatePatches(root) ∪ candidateDeletions(root)` gets reason
`root-chain:<root.id>` once `root` itself holds ≥1 reason — regardless of whether `resolve` would
ever apply it, exclude it as PT-6/OV-8's "reply to a foreign patch," or freeze the chain before
reaching it. Admission and chain validity are different questions; TR-5 is answering the first one.

**One-level, not iterative.** Unlike DEL-2/CHN-2's fixed-point cascade in `resolve.ts` (which must
iterate because a deleted patch's descendants can themselves have descendants), this reachability
step is two flat filter passes: build the candidate patch set once, then build the candidate
deletion set by referencing it. No iteration is needed because "root-author patch of root R" and
"root-author kind-5 targeting one of those" are each computed directly from `root`, not from each
other transitively.

---

## 5. Refcounting, and the sticky-admission trap

An event's admission is `reasons.length > 0` after summing three independent contributions. Two of
the three are naturally idempotent `Set` bits — a pubkey is trusted or it is not (`direct-trust`),
and a given root is admitted or it is not, so `root-chain:<rootId>` is added or removed as a whole,
never partially. The dangerous one is `binding:<bindingId>`, because **the same Binding must not be
allowed to contribute twice.**

D23 names the failure mode precisely: "a redundant no-op delta pushes a count to 2, so a later
un-trust leaves it at 1." This happens if a Binding's contribution is applied as a bare
`refcount++`/`refcount--` pair without checking whether it was already counted — a duplicate
"Binding B is now live" delta (plausible under at-least-once ingestion, or a store that has not yet
deduplicated by id) double-increments, and the matching single "B is now dead" delta only
undoes half of it.

**The guard is a side table, not a smarter counter.** `liveBindings: Record<string, { rootId:
string; linkId: string }>` records, for each Binding id currently believed to confer admission,
which two endpoints it credited. Applying "B is live" is a no-op if `B ∈ liveBindings` already;
applying "B is dead" is a no-op if `B ∉ liveBindings`. Only a state *transition* touches the
refcount:

```
B becomes live   ∧ B ∉ liveBindings  →  liveBindings[B] := endpoints; endpoints each get +1 credit
B becomes dead    ∧ B ∈ liveBindings  →  endpoints each get −1 credit; delete liveBindings[B]
```

This is what D23 calls "a counter guarded by `liveBindings` membership" — the guard makes each
Binding's net contribution to any endpoint exactly 0 or 1 no matter how many times the same
transition is (redundantly) delivered, which is the property that makes revocation exact rather
than sticky.

**BD-6 — the credit table holds ids that have not arrived.** If a trusted Binding's endpoints are
not yet in the observed set, `liveBindings[B]` still records them, and the credit they represent
exists independent of whether an event with that id has been seen. When the endpoint event
eventually arrives, its admission is already `> 0` from the credit already on file — no rescan, no
special "arrived after its Binding" path. This is why credits are keyed by id rather than only
attached to observed `NostrEvent` objects.

**Full recompute (the oracle, D29) does not need `liveBindings` at all** — it is a from-scratch
fold over the whole array with no state to guard, since there is nothing to double-apply. The guard
matters only on the incremental path (§7), which is exactly where D23's bug lives and exactly what
the gate's first property exists to catch.

**A Binding id can never be republished with different endpoints.** Nostr ids are content
hashes (D18), so two occurrences of the same id are byte-identical events — "first observed wins"
and "any observed wins" produce the same `{rootId, linkId}`. `liveBindings[B] := endpoints` on
activation is therefore never asked to overwrite a live entry with different values; it only ever
writes an entry once per distinct id.

---

## 6. `TrustedView` and `OpenView` (D22)

Not a predicate, not a bypass flag — a second implementation of the same tiny interface, so that
"show everything" is a pointer swap with no computation and no `trustEpoch` bump:

```ts
export interface AdmissionView {
  isAdmitted(eventId: string): boolean
}

export function trustedView(index: AdmissionIndex): AdmissionView {
  return { isAdmitted: (id) => isAdmitted(index, id) }
}

export const openView: AdmissionView = { isAdmitted: () => true }
```

`openView` takes no arguments and inspects nothing — under trust-everything the admitted set *is*
the set of all observed V-valid events, which is exactly what `resolve` and every other module
already operate over, so there is nothing left to compute. `OpenView ⊇ TrustedView` is therefore
structural (any id `trustedView` admits, `openView` admits, because `openView` admits everything)
rather than a property that needs its own test — though the gate still asserts it once, cheaply, as
a sanity check rather than as load-bearing coverage.

---

## 7. Overlay visibility (OV-7) — reusing admission, not a separate check

OV-7: a foreign patch is visible only if its `pubkey` is trusted. The literal reading is a pubkey
check independent of the reason-set machinery above. It does not need to be implemented that way,
because of a structural fact worth stating as its own claim:

> **A foreign patch's reason set is always a subset of `{'direct-trust'}`.** By BD-3/BD-4, only a
> Product or Metadata event can be a Binding endpoint, so a Patch can never receive a
> `binding:*` reason. By TR-6 (root-chain requires `pubkey = root.pubkey`, and "foreign" means
> `pubkey ≠ root.pubkey` by definition), a foreign patch can never receive a `root-chain:*` reason
> either. Its only possible path to admission is direct trust in its own author.

So `isAdmitted(index, overlay.id)` for a foreign patch answers exactly the same question OV-7
asks, with no separate pubkey-keyed lookup:

```ts
export function visibleOverlays(
  overlays: readonly Overlay[],
  view: AdmissionView,
): readonly Overlay[] {
  return overlays.filter((o) => view.isAdmitted(o.id))
}
```

Under `openView` every overlay passes, consistent with "show everything" meaning everything. This
is the one place TR-7 becomes an executable shape rather than a design note: `visibleOverlays` is
called *after* `resolve` has already produced `Overlay[]`, never before, and `resolve` itself never
receives `view` or `trust` as an argument — there is no parameter through which trust could leak
upstream even by accident.

---

## 8. Default-view retraction (DEL-4, DEL-5) — orthogonal, with one exception

**DEL-4 — root retraction does not revoke admission.** A kind 5 on a Product/Metadata hides it from
default rendering, but the spec is explicit that the chain, overlays, and Bindings referencing it
"are preserved for audit" and "MUST NOT silently drop." Nothing in TR-2…7 lists root retraction as a
reason admission is lost, and DEL-5's revocation clause is written for *Bindings specifically* —
its absence here is meaningful, not an oversight to route around. `admit` therefore exposes
retraction as an independent, non-mutating predicate that a presentation layer combines with
admission rather than folding into it:

```ts
export function isDefaultViewRetracted(
  event: NostrEvent,
  deletions: readonly NostrEvent[],
): boolean
```

True when some `deletion.pubkey === event.pubkey` targets `event.id` via an `e` tag (DEL-1's own
pubkey check, restated locally rather than imported from `resolve.ts`, since `admit` does not
depend on `resolve` — see §4). A caller building "what does the default view show" combines both
axes: `view.isAdmitted(id) && !isDefaultViewRetracted(event, deletions)`; an audit view drops the
second clause and keeps the first, since retraction never touches admission.

**DEL-5 — Binding retraction *does* revoke admission, and it is not a separate code path.** "Kind 5
deletion of a Binding" is not a new kind of input to this module — a kind 5 event is an ordinary
`NostrEvent`, and the moment it is folded into `computeAdmission`'s single pass (or, incrementally,
applied as a delta), it makes the deleted Binding's own reason set empty (a kind-5-deleted event is
never itself re-admitted by this module — deletion of the Binding does not delete the Binding's
*admission*-conferring status by a special rule, it is simply that a retracted Binding is excluded
from the "which Bindings are live" scan the same way an untrusted one is). Concretely: the pass
that decides `liveBindings` membership (§5) treats a Binding as live iff it is admitted **and** not
kind-5-retracted by its own author. A Binding losing liveness for either reason runs the identical
`B becomes dead` transition. This is why §5's guard is phrased as "B becomes live/dead," not
"B becomes trusted/untrusted" — retraction and revoked trust are two different *causes* of the same
transition, and the transition itself does not need to know which one fired.

---

## 9. Incremental application, and the invertibility the gate demands

`computeAdmission` (§0) is the oracle — a full fold with no history. The incremental path exists so
a future `store` (Phase 5) has correctness-oriented bookkeeping (the guard tables in §5, and the
delta shape below) to build a *scoped* rescan against — D24's actual cost target (zero `applyPatch`
calls on a `trustEpoch` bump, by the same logic no full admission rescan either) is not delivered by
this phase. `resync` (§5) re-derives Binding liveness and root-chain membership over the *entire*
observed set on every `applyDelta` call, which the property gate (AG1/AG2) never measures cost on —
only correctness. Getting the refcount arithmetic right first, and leaving real cost-scoping
(indices from root → members, binding → kind5s, per-epoch dirty-tracking) to Phase 5, is a
deliberate sequencing, not an oversight — but it means Phase 5 inherits no performance head start
from this shape, only a correctness-verified one.

```ts
export interface AdmitState {
  readonly reasons: Readonly<Record<string, readonly Reason[]>>
  readonly liveBindings: Readonly<Record<string, { rootId: string; linkId: string }>>
  readonly trusted: readonly string[]        // sorted, for deep-equality-friendly plain data
  readonly observedById: Readonly<Record<string, NostrEvent>>
}

export type ForwardDelta =
  | { readonly kind: 'observe'; readonly events: readonly NostrEvent[] }
  | { readonly kind: 'trust'; readonly pubkeys: readonly string[] }

export type AdmissionDelta =
  | ForwardDelta
  | { readonly kind: 'unobserve'; readonly eventIds: readonly string[] }
  | { readonly kind: 'untrust'; readonly pubkeys: readonly string[] }

export function applyDelta(state: AdmitState, delta: AdmissionDelta): AdmitState
export function invertDelta(delta: ForwardDelta): AdmissionDelta
export function toIndex(state: AdmitState): AdmissionIndex
```

**`ForwardDelta` is `observe | trust` only — `untrust` is deliberately excluded, and this was
found by the gate, not reasoned out in advance.** The first working draft of this section put
`untrust` in `ForwardDelta` too, on the assumption that it mirrors `trust` the way `unobserve`
mirrors `observe`. AG2's property test disproved that on a two-delta counterexample: a *standalone*
`untrust(pk)` for a pubkey that was never trusted is a legitimate no-op (the guard in §5 sees
nothing to remove), but syntactically inverting it produces `trust(pk)` — which is *not* a no-op,
since nothing established `pk`'s trust in the first place. The asymmetry with `observe`/`trust`
matters: their own no-op case (re-observing an already-observed event, re-trusting an
already-trusted pubkey) can only be *reached* by repeating a prior real add, starting from
{@link EMPTY_ADMIT_STATE}` where nothing is observed or trusted — so every no-op repetition has an
earlier real occurrence to pair against under a LIFO undo. `untrust` has no such guarantee; it can
be the very first delta in a sequence. `unobserve`/`untrust` have no protocol-level equivalent at
the *network* layer — Nostr does not let an event un-arrive there — but `unobserve` is not purely
test scaffolding: D39 notes that IndexedDB storage is best-effort and events may be evicted under
disk pressure, which is a genuine *local* un-arrival, and a real `TrustProvider.deltaSince` reports
genuine revocations as `untrust` too. Both remain valid inputs to `applyDelta`; neither is a valid
input to `invertDelta`, and typing `ForwardDelta` narrowly makes constructing that ill-defined case
a compile error rather than a runtime one.

`invertDelta` is a pure syntactic swap (`observe` ↔ `unobserve`, `trust` ↔ `untrust`, same payload)
over the narrowed type — the actual work of undoing is `applyDelta`'s, and AG2's property is
exactly that running both directions returns to the starting `AdmitState`.

`toIndex` projects the public, comparable shape out of the internal bookkeeping — `AdmitState`
itself is allowed to carry the guard tables §5 needs and is not required to be the thing compared
against a full recompute; `AdmissionIndex` is.

**Three invariants the incremental path must maintain, stated explicitly because they are the kind
of thing a correct-looking diff can quietly violate — the first two were written down before the
gate ran; the third was found by the gate itself:**

1. **A reasons entry is deleted, never set to `[]`, when its last reason is removed.** §2
   commits `AdmissionIndex` to never producing a present-but-empty entry; `applyDelta` must match
   that on every remove path (untrust, Binding death, unobserve, a root losing its last reason) or
   AG1's deep-equality check fails for reasons unrelated to whether admission is actually correct —
   the equality check would then be tempted to loosen instead of the real bug getting fixed.
   Implementation-wise this falls out for free if the internal working state uses `Set` deletion
   (`set.delete(reason)`) and the *serialisation* step to the public record filters
   `set.size === 0` rather than ever writing an empty array.
2. **Root-chain revocation has no side table of its own, unlike `liveBindings`.** When a root's
   last reason disappears (`untrust`, or the root itself is `unobserve`d), every member of
   `candidatePatches(root) ∪ candidateDeletions(root)` (§4) must lose `root-chain:<root.id>`.
   There is no reverse index from root to members to maintain — recomputing that member set fresh
   from `observedById` is correct without one (§4's reachability step is a flat filter, not a
   traversal, so there is nothing to get wrong by recomputing rather than indexing). "Cheap" here
   means "cheap enough not to need the index for Phase 4's own gate," not "as cheap as a real
   scoped invalidation would be" — `resync` still re-filters the whole observed set once per call
   rather than touching only what a specific delta could have affected; that gap is Phase 5's to
   close, not this one's. Recomputing the member set fresh is nonetheless what makes
   this safe to do unconditionally on every delta rather than only on a detected flip: recomputing
   membership for a root that is *still* admitted is a no-op (`credit`/`uncredit` on a `Set` are
   idempotent), so there is nothing to gate the way §5 gates a Binding's counter. `unobserve` of a
   root specifically must recompute this member set *before* deleting the root from
   `observedById`, since the root object (not just its id) is what the reachability step needs.
3. **`unobserve` of a *member* (not the root itself) must also strip that member's own
   `root-chain:*` reason — not just its `direct-trust`.** Once the member leaves `observedById`,
   nothing else will ever revisit it: `resync` only iterates currently-observed events, so a
   `root-chain:*` reason left on an unobserved id is permanently stranded — invariant 1 alone does
   not prevent this, because the entry is not empty, it is merely wrong. AG1 caught this on a
   three-delta counterexample (`trust(pk)`, `observe(root)`, `observe(patch)`, then undo): the
   patch's `root-chain:*` reason survived its own `unobserve` because only `direct-trust` was being
   stripped. The rule this settles on: on `unobserve(id)`, remove `direct-trust` and any
   `root-chain:*` reason **from `id`'s own entry**, but leave any `binding:*` reason on `id`
   untouched — a binding credit is conferred by a still-observed Binding independent of `id`'s own
   presence (BD-6), while `direct-trust` and `root-chain:*` both depend on `id` itself being an
   observed candidate.

---

## 10. The gate

Restates the substitute gate agreed in place of the plan's `discovery.json` (still unwritten, per
`IMPLEMENTATION-PLAN.md`'s running note that each phase has had to define its own substitute).

**AG1 — incremental ≡ full recompute, for every trust set.** For a generated event set `E` and a
sequence of deltas `d₁…dₙ` built from `E` (observations interleaved with trust changes, replaying
what a real ingest order could produce):

```
toIndex(foldl(applyDelta, initialState, [d₁, …, dₙ])) ≡ computeAdmission(observedSoFar, trustSoFar)
```

checked **after every prefix**, not only at the end — D23's sticky-admission bug is specifically a
bug that appears after a *revocation following a redundant re-application*, so the property must be
checked at a point in the sequence where that has already happened, not only once at the end where
an over-count might coincidentally have been fixed by a later event. Include, explicitly among the
generated shapes: the same Binding delivered twice before ever being revoked (redundant `observe`),
a Binding trusted, retracted, and re-published under a new id targeting the same endpoints, and a
root losing its only admission reason while mid-chain patches are still being delivered.

**AG2 — apply-then-invert ≡ exact initial state.** For any generated delta sequence
`d₁…dₙ`:

```
foldl(applyDelta, s, [d₁,…,dₙ, invertDelta(dₙ),…,invertDelta(d₁)]) ≡ s
```

Inverting in **reverse order** — this is the property that would fail first if a Binding's two
endpoint credits were ever decremented independently (one path decrementing `rootId` twice and
`linkId` zero times, say), which is the "duplicate-endpoint decrement" bug the plan's testing
strategy names by that description.

**AG3 — rule-coverage partition.** Same discipline, same machinery (D34), reusing `test/_coverage.ts`
with a new `test/_a-admit-coverage.ts`. The working expectation, stated before code exists exactly as
`RESOLVE.md` §9 did:

| rule | expected disposition |
|---|---|
| TR-2 | not-covered — definitional; the admission test *is* the behavioural coverage |
| TR-3 | not-covered — a prohibition (§3's standing invariant); covered by asserting a Binding's reason set is never a superset of `{direct-trust}` |
| TR-4 | not-covered — the binding cascade mechanism; covered behaviourally by the endpoint-credit tests |
| TR-5 | not-covered — the root-chain reachability step; covered behaviourally, including the self-fork-sibling and past-HALT cases §4 argues for |
| TR-6 | not-covered — a prohibition; covered by asserting a foreign patch's reason set is never a superset of `{direct-trust}` (§7's claim, tested directly) |
| TR-7 | not-covered — an ordering constraint on the *implementation*, not on any event; covered by asserting `resolve`'s output is identical whether wrapped in `trustedView` or `openView` before it is ever computed — i.e., that admission is applied only as a post-hoc filter |
| OV-7 | not-covered — reduces to §7's admission check; covered by the visibility test directly |
| DEL-4 | not-covered — a non-effect (retraction MUST NOT revoke admission); covered by asserting admission survives a root's own kind-5 deletion |
| DEL-5 | not-covered — this is the one rule with real failure modes (the sticky-admission and double-decrement bugs), but its failure mode is a *wrong count*, not an issue code; covered by AG1/AG2 directly, which is a stronger claim than a single fixture could make |

No rule here is expected to land in the `emitted` bucket — §6.0's own text says D rules "are not
admission criteria for the event itself," and this module never rejects or annotates an event, only
computes visibility. An all-`not-covered` partition is not a weaker gate than Phase 3's 3/32: each
entry cites the behavioural test that substitutes, per D34's own instruction that intent is not
evidence.

**AG4 — generator bias and floors.** Phase 2 and Phase 3's shared lesson: a property is only as
strong as what its generator actually reaches. Bias toward: a Binding observed before either
endpoint (BD-6), the same delta redelivered adjacently and non-adjacently in a sequence, a pubkey
trusted then untrusted then retrusted within one sequence, two Bindings crediting the same endpoint
and only one revoked, a root that loses its last reason while its patches are still arriving, and a
self-fork where only one sibling's author is independently trusted. Log the outcome mix (admitted /
not-admitted, by reason kind) and assert a floor under multi-reason overlap and under
revoke-after-redundant-observe, so neither can silently stop being exercised.

Every counterexample becomes a permanent regression case, as `test/patch-regressions.ts` and Phase
3's fork/halt fixtures are.

---

## 11. Open questions for review

1. ~~**`interfaces.ts` scope (§1).**~~ Resolved — created, minimal to `TrustProvider`, exactly as
   proposed.
2. **`AdmitState`'s public/internal boundary (§9).** `liveBindings` is exposed on `AdmitState` (not
   private) because the gate needs to construct/inspect intermediate states in tests. If that reads
   as leaking an implementation detail into the public surface, an alternative is an opaque state
   with a separate debug-only accessor — more machinery for arguably no real benefit.
3. **DEL-4's `isDefaultViewRetracted` return shape.** A bare `boolean` today. `query`/`store`
   (later phases) may want the retracting event's id for an audit trail; adding it now is
   speculative ahead of a real caller, so left minimal per house style — flagging in case you'd
   rather decide the richer shape now while the rule is fresh.
