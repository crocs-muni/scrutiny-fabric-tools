# `VALIDATION-WIRING` — wiring `validateEvent` into `store.add()`

Mini-spec for item 6 of `PLAN-2026-08-01-rewrite-mandate.md` (§6, "Wiring validation into
`store.add()`"), written before any code exists, at the rigor `STORE.md` already established for the
module this amends. Fixes `AUDIT-2026-07-31.md` P5 ("`createStore` never calls `validateEvent` at
all") and closes the specific gap in D29's oracle property that P5 names — distinct from, and not to
be landed alongside, the C5/P1 overlay-degradation gap that item 3 (`overlayAwaiting`) fixes; see §5.

**The mandate's final call, verbatim:** "admit every event to storage always (never silently discard
for a *validator* bug); exclude invalid events from the resolved view only. Generalize the existing
`bindingsAwaiting` reverse index into a rule-agnostic pending buffer. Three-bucket `AddResult`
(`accepted`/`rejected`/`pending`, `issues` pluralized). Delete `store.ts`'s duplicate BD-3/4/7 check
(`checkBindingTyping`) in favor of calling `validate.ts`'s `checkBinding`."

Governing text carried over from `STORE.md`: §4.3 (BD-6/7 pending lifecycle), §6.0 (V-layer
disposition, TR-1), §7.6 (UR-1…3). Decisions: D15, D18, D19, D20, D24, D29, D34, D38 — each checked
against this design in §6. Rules newly reachable through the public entry point once this lands: every
error- and warning-severity rule `validate.ts` can emit (TAG-1…4, VER-3, PR-1…4, MD-1…4, IR-1,
BD-1…7/10/12, PT-1/2/3/7, E1/3/6/7, C1, P2/3) — today only SIG-1 and, incidentally, BD-7 are reachable
via `store`; every other V/A/D rule `validate.ts` owns is invisible to a consumer using the documented
ergonomic entry point (D15) until this lands, which is P5's exact complaint.

---

## 0. Why "admit always, exclude from the view" is the only sound answer

`store.ts`'s own file comment already states the discipline this generalizes: `resolve`/`admit` are
retained as pure functions and are "the conformance oracle (D29) every incremental path here must agree
with." A store that *dropped* an event because `validateEvent` — this project's own code, not the
network's — judged it invalid would make a validator bug indistinguishable from a real protocol
violation, and unlike a rejected Binding (BD-7, cacheable because endpoint typing is immutable once
observed) a validator bug is not guaranteed permanent: fixing the bug in a later release must be able to
recover the event without re-ingesting it from the network. DEL-4's entire point for kind-5 deletions —
"never silently drop, preserve for audit" — is the identical argument applied to a different failure
mode, which is exactly the mandate's own "Why" for this item. Storage and the resolved view are
therefore two different questions from here on: `admit.observedById` (already, per D38, "cache raw
events, never resolved content") answers "did this ever arrive," and a new exclusion set answers "should
`resolveRoot` currently treat this id as present."

**Rejected: a fourth AddResult outcome for D-layer warnings on an otherwise-`valid` event.** The
mandate's own sketch names three buckets, not four. A `valid` verdict carrying only warnings (e.g. a
Product's PR-2 64-`i`-tag advisory) is reported in `accepted` and nowhere else — identical to today's
silence, since `store.add()` today surfaces no `Issue` at all for a passing event. This is a real,
un-closed ergonomics gap (a caller wanting producer-side D-layer advisories back from `add()` still has
none), but it is out of scope for the three-bucket final call already settled here; flagging it rather
than quietly enlarging the shape.

---

## 1. `AddResult`'s new shape, and which buckets an id can occupy at once

```ts
export interface PendingEvent {
  readonly event: NostrEvent
  /** Event ids whose arrival would resolve the verdict — validateEvent's own `awaiting`, verbatim. */
  readonly awaiting: readonly string[]
  readonly issues: readonly Issue[]
}

export interface RejectedEvent {
  readonly event: NostrEvent
  readonly issues: readonly Issue[]   // was `issue: Issue` — pluralized per the mandate
}

export interface AddResult {
  readonly accepted: readonly string[]
  readonly rejected: readonly RejectedEvent[]
  readonly pending: readonly PendingEvent[]
}
```

**`accepted` answers "did this id get folded into `applyStoreDelta`'s `observe` case" — a storage
question, not a validity one.** Every event that passes the SIG-1 gate is accepted, full stop,
regardless of what `validateEvent` later says about it. `rejected` and `pending` answer "what does the
V layer currently say about this id," and are populated by calling `validateEvent(event, {lookupEvent:
(id) => state.admit.observedById[id]})` on every accepted event, after it has been folded into the
reducer (so `lookupEvent` can already see sibling events from the same batch — the existing `add()` code
already needs this ordering for BD-7, §3 below).

**Overlap, reasoned from the existing BD-7 precedent (`store.ts:469-475`) and `validateEvent`'s own
control flow (`validate.ts:101-107`):**

| pair | overlap? | why |
|---|---|---|
| `accepted` ∩ `rejected` | **yes, always possible** | Any event whose verdict is `'invalid'` is still folded into storage — this is the direct generalization the mandate calls for: BD-7 was never a special case, it was the *only* rejection rule store.ts happened to check before this item, so it was the only one visibly exhibiting the overlap. Every error-severity V rule now exhibits it identically: a TAG-1-violating event, a PT-7-violating foreign patch, a malformed patch payload (C1) — all accepted into storage and reported rejected. |
| `accepted` ∩ `pending` | **yes, always possible** | Symmetric: a `'pending'` verdict (BD-6 endpoint, UR-2 root, PT-7's target lookup) is still folded into storage — it must be, or `lookupEvent` could never find it later when the awaited id arrives. |
| `rejected` ∩ `pending` | **never, structurally** | `validateEvent` checks `hasError(issues)` *before* checking `awaiting.length > 0` (`validate.ts:101-106`): an event with any error-severity issue returns `{status: 'invalid'}` immediately and never reaches the `awaiting.length` branch. A single `validateEvent` call cannot report both for the same event — this is a guarantee `store.ts` inherits for free, not one it must separately enforce. |
| `accepted` alone (no `rejected`/`pending` entry) | the common case | `'valid'` and `'not-scrutiny'` verdicts. `not-scrutiny` is treated exactly as today: an ordinary Nostr event, outside V's domain by §3, admitted and left alone. |
| **not** in `accepted` | SIG-1 failures only | The one bucket this generalization does *not* extend to. A forged event never reaches `applyStoreDelta` (D20's ordering, unchanged — §6), so its id is never in `admit.observedById`, `validateEvent` is never called on it (there is nothing for `lookupEvent` to answer about it either), and it is reported in `rejected` alone. This is the sole remaining case where `rejected` does not imply `accepted`. |

So: an id can appear in exactly one of `{accepted-only, accepted+rejected, accepted+pending,
rejected-only}` per `add()` call — never `accepted+rejected+pending` and never `rejected+pending`
without `accepted`.

---

## 2. `StoreState`'s generalized pending buffer

```ts
export interface StoreState {
  readonly admit: AdmitState
  /** Generalizes `rejectedBindings` — see §3. Every id whose current V-verdict is 'invalid'. */
  readonly invalidIds: readonly string[]
  readonly chainMembership: Readonly<Record<string, string>>
  /** Generalizes `bindingsAwaiting` (was Binding-endpoint-only) — awaited id -> pending event ids. */
  readonly pendingAwaiting: Readonly<Record<string, readonly string[]>>
  readonly trustEpoch: number
  readonly observedEpoch: number
  readonly chainEpoch: Readonly<Record<string, number>>
}
```

`bindingsAwaiting: Record<endpointId, bindingId[]>` becomes `pendingAwaiting: Record<awaitedId,
pendingEventId[]>` — same shape, wider domain. It is driven entirely by `validateEvent`'s own `awaiting`
array, for *any* V rule that produces one (today: BD-6's two endpoints, UR-2's patch root, PT-7's reply
target), not just Binding endpoints. `addAwaiting`/`removeAwaiting` (`store.ts:99-118`) are reused
unmodified — the mandate's own note that they are "already fully generic" is correct: both operate on a
bare `Map<string, Set<string>>` with no Binding-specific type in their signature.

**Population, at first observation.** `processObservedEvent` (`store.ts:211-243`) drops its
`checkBindingTyping` branch entirely (§3) and instead calls `validateEvent` once for *every* newly
observed event, regardless of type:

```ts
const verdict = validateEvent(event, { lookupEvent: (id) => observedById[id] })
if (verdict.status === 'invalid') invalidIds.add(event.id)
if (verdict.status === 'pending') {
  for (const id of verdict.awaiting) addAwaiting(pendingAwaiting, id, event.id)
}
```

**Draining, on a later arrival.** The existing "this event's own id may be an endpoint some other
Binding is awaiting" loop (`store.ts:233-242`) generalizes to: look up `pendingAwaiting[arrivedId]`: for
each pending event id registered there, remove *only that one* resolved slot
(`removeAwaiting(pendingAwaiting, arrivedId, pendingId)`) and re-run `validateEvent` on the pending event
against the now-larger `observedById`. Three outcomes, mirroring `STORE.md` §2's existing three-outcome
description of the Binding-only case exactly, now generalized:

- **still pending** (a *different* awaited id remains unresolved, e.g. a Binding missing both endpoints
  when only one arrived, or a foreign Patch whose root just arrived but whose reply target has not):
  register the freshly-reported `verdict.awaiting` entries via `addAwaiting`. No entries are pruned
  beyond the one slot the caller already removed — nothing in `checkBinding`/`checkPatch`'s structure can
  make a *previously*-reported awaited id reappear once resolved, so there is nothing else to reconcile.
- **resolves to `invalid`**: `invalidIds.add(pendingId)`; do not re-add any awaiting entry for it. If
  some *other*, still-unresolved awaited id was left registered for this pending id from an earlier
  partial check, it is harmlessly consumed (and immediately re-derives the same `invalid` verdict,
  idempotently) the one time that id itself eventually arrives — a bounded, self-cleaning cost, not a
  leak, since each event can arrive at most once.
- **resolves to `valid`**: same cleanup as `invalid`, no cache write needed — absence from `invalidIds`
  already means "not currently invalid," which for an id known to be `accepted` and not `invalidIds`
  means valid (or not-scrutiny).

**Design correction, found while writing this section.** `STORE.md` §2 argues UR-2 "needs no new
bookkeeping at all... it reduces to §3's per-root chain epoch" — true under today's Binding-only
`bindingsAwaiting`, where a Patch's pending-root case was never tracked by that index at all. Once the
buffer is generalized to be rule-agnostic (as this item requires), UR-2's patches enter it automatically
— not by new design effort aimed at UR-2, but as a structural side effect of making the existing
mechanism generic. This does not contradict `STORE.md` §2 (a Patch's pending verdict genuinely still
does not need *resolve-level* tracking of its own — `resolve()` still recomputes `pending` on every call
per `RESOLVE.md` §1, unchanged), but it does mean `STORE.md` §2's claim "no new bookkeeping" is narrower
than its own prose suggests once read against this item; §7 below records exactly what `STORE.md` needs
to say instead.

---

## 3. `invalidIds` — BD-7's cache, generalized

`rejectedBindings` becomes `invalidIds: readonly string[]` (sorted, same reasoning as today: deep-
equality-friendly plain data). It is now populated directly from `validateEvent`'s own returned
`Validity`, not from a hand-rolled type comparison:

```ts
const verdict = validateEvent(event, { lookupEvent })
if (verdict.status === 'invalid') invalidIds.add(event.id)
```

**Design correction, found while writing this section.** The mandate's literal text says "in favor of
calling `validate.ts`'s `checkBinding`" — but `checkBinding` is a module-private function in
`validate.ts` (`validate.ts:258`, not exported, not re-exported from the barrel); only `validateEvent`
is public. `store.ts` calling `checkBinding` directly would require either exporting an internal
per-type checker (breaking `validate.ts`'s own stated shape — "pure: one event in, a verdict... out,"
`validate.ts:1-6` — which is deliberately one function, not four) or reimplementing the
type-dispatch switch `validateEvent` already does (`validate.ts:88-98`), which is precisely the
"two independently written implementations of the same rule pair" risk this item exists to remove.
The design that actually satisfies the mandate's intent — one source of truth for BD-3/4/5/7, called
from `store.ts` rather than duplicated in it — is calling the *public* `validateEvent`, which dispatches
to `checkBinding` internally for a Binding-typed event. Recorded here rather than silently substituted,
since the mandate's own sketch named the wrong function.

**Does this preserve BD-7's emitted coverage?** Yes, exactly. `checkBinding` still pushes three issues
on a typing contradiction once both endpoints are observed (`validate.ts:298-309`): the specific
`BD-3`/`BD-4` error, the `BD-5` error, and the `BD-7` warning — all three end up in the same
`verdict.issues` array `validateEvent` returns, because `hasError` is true and `{status: 'invalid',
issues}` carries the whole accumulated list (`validate.ts:101-102`). `store.ts` no longer constructs its
own `bindingRejectionIssue()` (`store.ts:153-160`) — that helper is deleted, and the `RejectedEvent`'s
`issues` array is simply `verdict.issues` from the call that produced `invalid`. `STORE.md` §8's
"BD-7 — emitted" row (`STORE.md:398`) stays accurate in substance ("the one real rejection disposition"
framing becomes inaccurate in degree, since every error rule is now a rejection disposition through this
path — see §7) but the *emission* itself is unchanged: same rule id, same severity, same triggering
condition, same permanence (UR-3 — an observed endpoint's type cannot change, so `invalidIds` membership
for a BD-7 case is exactly as permanent as `rejectedBindings` membership was).

---

## 4. `resolveRoot`'s exclusion plumbing

`resolve.ts` assumes upstream V-filtering already happened and has no exclusion mechanism of its own —
confirmed by reading `resolve(rootId, events, options)` (`resolve.ts:233`): it takes a flat event array
and has no notion of "this id is invalid, ignore it." `resolveRoot` (`store.ts:413-436`) currently
builds that array unconditionally: `memo.eventsCache.events = Object.values(state.admit.observedById)`
— every observed event, valid or not.

**New field: none needed beyond `invalidIds` itself** (§3) — no *second* piece of state, because the
exclusion set is exactly `invalidIds`, already required for `AddResult.rejected`. The plumbing is a
filter step inserted where the events array is materialized:

```ts
if (memo.eventsCache?.observedById !== state.admit.observedById) {
  const invalid = new Set(state.invalidIds)
  memo.eventsCache = {
    observedById: state.admit.observedById,
    events: Object.values(state.admit.observedById).filter((e) => !invalid.has(e.id)),
  }
}
```

**Why no separate cache key is needed for `invalidIds`.** `eventsCache` is invalidated today by
reference-comparing `state.admit.observedById` (`store.ts:427`) — correct because `applyStoreDelta`
always produces a fresh `admit` object per delta (`store.ts:299-307`, never mutated in place).
`invalidIds` only ever changes *within* the same `observe` delta that also produces a fresh
`observedById` (either because the newly observed event's own first verdict is `invalid`, or because
some already-pending event's re-verdict flips to `invalid` on this same batch's arrival) — there is no
code path that changes `invalidIds` without also changing `observedById` in the same delta. So the
existing reference check already correctly triggers a re-filter whenever `invalidIds` could have
changed; adding `invalidIds` to the cache key would be redundant, not incorrect.

**Interaction with `chainEpoch` — this is the piece that actually gates re-resolution.** Filtering
`eventsCache.events` alone is not sufficient: `resolveRoot` still serves the *memoized* `Resolution` for
a root whose `chainEpoch[rootId]` has not moved (`store.ts:423-425`), so a Patch that flips from `valid`
to `invalid` (or the reverse, `pending` to `valid`) must bump its owning root's `chainEpoch`, or the
stale (pre-invalidation) `Resolution` keeps being served — exactly the D29/RC-3 failure shape C5 already
found for a different trigger. The revalidation step in §2 must therefore call the *same*
`chainEpochTargets`/`bump` machinery `processObservedEvent` already uses for a first-time observation,
for the pending event that just changed verdict:

```ts
if (scrutinyEventType(pendingEvent) !== 'binding') {
  for (const root of chainEpochTargets(pendingEvent, (id) => chainMembership[id])) {
    bump(chainEpoch, root)
  }
}
```

The `!== 'binding'` guard preserves BD-9 exactly as `STORE.md` §3's table already states it ("Binding |
none — Bindings are not part of `resolve()`'s domain") — a Binding's pending→invalid transition changes
`invalidIds` (and thus `AddResult` on a *future* re-check, though a Binding's own AddResult entry from
its original `add()` call already reported it correctly) but must never touch `chainEpoch`, since
`resolve()` never reads Bindings at all.

**Does `invalidIds` ever need entries removed?** No — reasoned from `Validity`'s own shape
(`validate.ts:54-68`), not asserted. Every error-producing check in `checkTags`/`checkRootEvent`/
`checkBinding`/`checkPatch`/`checkPatchPayload` depends only on (a) the event's own immutable
content/tags, or (b) another *already-observed* event's `scrutinyEventType`/`pubkey`, both of which are
fixed the instant that other event is itself observed (the same immutability `STORE.md` §2 already
invokes for BD-7: "the typing of an observed endpoint cannot change on further observation"). No V rule
re-examines an already-resolved dependency and reverses course. `invalidIds` is therefore monotone,
exactly as `rejectedBindings` already was (D24: "BD-7's rejection cache is monotone, unlike the other
two") — this item's generalization inherits that property rather than introducing a new one, and
`unobserve()` need not touch `invalidIds` at all (unlike `chainMembership`, which `STORE.md`'s own
`unobserve` case deliberately leaves "stale-but-still-correct... in place," `invalidIds` has nothing
that becomes *incorrect* on unobservation — an id judged invalid while observed is not un-judged by its
own removal, it simply also leaves `observedById`, at which point the filter step in `resolveRoot`
above is moot for it either way since it is no longer in the array being filtered).

**Interaction with UR-1 confluence.** `invalidIds`'s *final* value, as a set, converges identically
regardless of arrival order for the same eventual observed set, by the same monotonicity argument: each
id's invalid/valid/pending classification is a pure function of the current observed set (via
`lookupEvent`), and once `invalid` is reached it is permanent, so no permutation of arrivals can produce
a different final membership — only a different *order* of when each id entered the set, which UR-1 does
not constrain (exactly as it does not constrain `chainEpoch`'s absolute count, `STORE.md` §3's
correction). `invalidIds` therefore belongs in the confluence-tested `StoreView` projection (replacing
`rejectedBindings` there, unchanged in kind — both are sorted monotone sets); `pendingAwaiting` does
not, for the same reason `bindingsAwaiting` already did not (its exact bucket contents are legitimately
arrival-order-dependent bookkeeping, per `STORE.md` §3/§9's existing argument, which transfers unchanged
to the generalized field).

---

## 5. Overlap with item 3 (`overlayAwaiting`) and a clean landing order

Both items touch the same two surfaces: `processObservedEvent`/`chainEpochTargets` (the per-event
dispatch that decides which root(s) to bump), and `resolveRoot`'s event-feed construction. The overlap
is textual and structural, not a logical conflict — the two new indices are keyed differently
(`overlayAwaiting: targetId -> rootId[]`, populated from a Patch's own `e reply`/`e root` tags at observe
time; `pendingAwaiting: awaitedId -> pendingEventId[]`, populated from `validateEvent`'s `awaiting`
field) and neither reads the other. But:

1. **Both add a branch to `chainEpochTargets`'s dispatch, or to what consults it.** Item 3's sketch
   (`PLAN §3`) has `chainEpochTargets` consult `overlayAwaiting` "unconditionally... for every event
   type," i.e. in addition to its existing per-type switch. Item 6 needs the *inverse* shape: not "the
   arriving event's own id looked up in a table," but "the arriving event's id looked up in
   `pendingAwaiting`, and for each match, a *different* event (the pending one) gets re-validated and
   *that* event's own `chainEpochTargets` result gets bumped." These are two distinct control-flow
   insertions into the same function's neighborhood, and writing both in one commit risks either
   tangling them into one bespoke conditional or silently duplicating the "look up a reverse index keyed
   by the arriving id, act on what's found" shape twice.
2. **Both touch `resolveRoot`'s event-feed construction.** Item 3 does not change *which* events are fed
   to `resolve()` (it only affects *when* the memo is invalidated, via `chainEpoch`); item 6 changes the
   array itself (§4's filter). These are independent edits to code that sits right next to each other,
   which is exactly the "comparable in size to `chainEpoch`'s own bookkeeping" scope the mandate already
   flags for item 6.

**Recommended order: land item 6 first.** It already generalizes the "event `X` arrives → look up a
reverse-index keyed by `X` → re-run a check against an event registered there → maybe bump that event's
owning root's `chainEpoch`" shape (today exercised only by Binding endpoints, via `checkBindingTyping`).
Item 3's `overlayAwaiting` is a second instance of the *identical* shape (arrival of `X` → look up a
table keyed by `X` → bump some root's `chainEpoch`), just without the "re-run a check" step in the
middle (an overlay's classification is decided at read time in `resolve.ts`, not cached in `store.ts`).
Landing item 6 first means item 3 arrives as an additive sibling lookup next to `pendingAwaiting`'s
already-generalized one, rather than the two independently reinventing "a reverse index that bumps
`chainEpoch` on arrival" and needing to be reconciled in whichever one lands second.

**This is a diff-hygiene preference, not a correctness dependency in either direction — worth stating
explicitly, since it is easy to mis-derive one.** A first pass at §4's `chainEpoch`-bump step might
reach for "bump the root(s) the *arriving* awaited event (`T`) itself affects," via `T`'s own
`chainEpochTargets` result — and then notice that if `T` belongs to a different root than the pending
Patch `P`'s own root `R` (nothing in `checkPatch`'s `targetIsRootAuthorPatch` test requires `T`'s root to
be `R`, only that `T` is a root-author patch of *some* root), `T`'s own `chainEpochTargets` never
mentions `R` at all — which looks exactly like the gap item 3 exists to close for overlay degradation,
and would wrongly suggest item 6 needs `overlayAwaiting` as a dependency. §4's actual design does not
have this problem, because it never keys off `T`'s root at all: it calls `chainEpochTargets(pendingEvent,
…)` — i.e. `chainEpochTargets(P, …)`, using `P`'s *own* declared `e root` tag, which is available
directly off `P` itself regardless of what `T` is or which root `T` belongs to. And the connection from
"`T` arrived" to "re-validate `P`" is made through `pendingAwaiting[T.id]` — a direct id-keyed lookup
populated when `P` was first found pending — not through any root-based table. So the bump is correct
and self-contained without `overlayAwaiting`, and the ordering above can be revisited purely on
diff-size/reviewability grounds, never on a correctness one.

**What the first-landed commit must preserve for the second to land cleanly:**
- `chainEpochTargets`'s existing per-event-type table stays a pure function of `(event,
  lookupOwningRoot)` with no side effects and no new parameters threaded in for item 6's sake — item 3's
  unconditional `overlayAwaiting` consultation must be addable as a second, independent call site (in
  `processObservedEvent`) without changing this function's signature.
- `pendingAwaiting` and (once it lands) `overlayAwaiting` stay two structurally separate
  `Record<string, readonly string[]>` fields, each populated/drained solely by `addAwaiting`/
  `removeAwaiting`. **Rejected: merging them into one reverse-index table keyed by a tagged union of
  "awaiting a pending-verdict" vs. "awaiting an overlay target."** That would recreate, in reverse-index
  bookkeeping, the exact "two independently written implementations of the same rule pair" risk this
  item's own mandate text warns against for BD-3/4/7 — except this time both halves would be genuinely
  needed and forced to share one data structure for no reason, making a future reader determine from a
  tag which of two unrelated invalidation stories a given entry belongs to.
- The `!== 'binding'` guard in §4's `chainEpochTargets` call (BD-9) must stay a per-call decision at the
  *pending-event's* type, not folded into `chainEpochTargets` itself — `chainEpochTargets` already
  returns `[]` for a Binding (`store.ts:194`, the `type === 'product' || type === 'metadata'` /
  `type === 'patch'` / `kind === 5` cases all fall through to `return []` for anything else), so the
  guard in §2/§4 is in fact redundant with `chainEpochTargets`'s own existing behavior and can be
  dropped — flagged here only so a reviewer confirms this before landing rather than rediscovering it
  during item 3's own work on the same function.

---

## 6. Standing decisions this design touches

| Decision | Touched? | Verdict |
|---|---|---|
| **D15** (reducer + `EventStorage` port, never a class) | Yes, incidentally | **Satisfied unchanged.** `applyStoreDelta` stays pure/sync; `createStore` stays a factory of bound methods. No new class, no new port. |
| **D18** (`verify` required, no default, fail closed) | No | **Satisfied unchanged.** The SIG-1 gate is untouched; `validateEvent` only ever runs on events that already passed it. |
| **D19** (verification status travels with ingest; `{source, verified}`) | No | **Satisfied unchanged.** `validateEvent` runs regardless of `verified`/`trustUnverified` — V-layer structure and SIG-1 authenticity are orthogonal axes, and this item does not change the gate shape D19 specifies. |
| **D20** (dedup only after verification) | No | **Satisfied unchanged.** `lookupEvent` reads `admit.observedById`, which by construction (§3, §4) only ever contains events that already passed SIG-1; nothing here writes to it earlier. |
| **D24** (three independent epochs) | Yes | **Satisfied unchanged, no Corrections entry.** This item adds a *new trigger* for an existing epoch (`chainEpoch` bumps when a pending Patch's verdict resolves, §4) but does not add a fourth epoch or change what any of the three mean. D24 describes each epoch's *scope*, not an exhaustive trigger list; a new trigger consistent with `chainEpoch`'s stated charter ("bump the root(s) a given event could affect") is an implementation detail, not a reversal. |
| **D29** (pure functions are the conformance oracle) | **Yes — needs a new Corrections entry** | AUDIT-2026-07-31 §2 already names this exact gap as P5 and calls it a D29 violation in effect ("a consumer... ingests and resolves malformed Bindings, mis-tagged events, and PT-7-violating overlays"), but §8 of that same audit lists Corrections only for C2–C6 plus the D6/D7 confirmation — **P5 was never given its own dated entry**, unlike its sibling gap C5 (which covers a *different* D29 violation, the `overlayAwaiting`/chain-epoch-target gap item 3 fixes). This design is the fix for P5's gap specifically; the fix belongs on the record the same way C5 did. Draft text: *"Cn (date TBD) — D29's oracle property was also violated via a second, independent gap: `store.add()` never called `validateEvent` at all (P5), so an incremental `resolveRoot` answer could disagree with a from-scratch validate-then-resolve pipeline for any V-invalid or V-pending event, not only for the overlay-degradation shape C5 already covers. Fixed by wiring `validateEvent` into the observe path and excluding `invalidIds` from `resolveRoot`'s event feed (`VALIDATION-WIRING.md`)."* — left as a draft for the spec-and-plan pass to date and land, per this document's own instruction not to edit `DECISIONS-2026-07-27.md` directly. |
| **D34** (coverage by observed emission, generated closure gate) | Yes, incidentally | **Satisfied unchanged.** Every rule newly *reachable* through `store.add()` was already counted as "emitted" by `v-coverage.test.ts`, which exercises `validateEvent` directly (D34 measures emission, not which call site triggers it). What changes is `_a-store-coverage.ts`'s own table (§7) — a documentation/coverage-table update, not a D34 principle violation. |
| **D38** (cache raw events, never resolved content) | Yes, incidentally | **Satisfied unchanged.** `invalidIds`/`pendingAwaiting` cache *validity verdicts* (a classification derived from raw events), not resolved/patched content — the same category `rejectedBindings`/`bindingsAwaiting` already occupied without ever being flagged against D38. This item generalizes an already-accepted shape; it does not introduce a new kind of cache. |

Briefly, for completeness, on decisions not in the required list: **D22/D23/D25/D26** are untouched
(this item is entirely V-layer/pending bookkeeping, never trust- or admission-related). **D43**
("plain data, no methods, no closures") constrains `AddResult`/`RejectedEvent`/`PendingEvent` exactly as
it already constrains `Resolution`/`AdmissionIndex` — all three new/changed types above are plain
interfaces with no methods, satisfying it by construction.

---

## 7. What `STORE.md` needs to change

Out of scope to edit directly here (a later stage owns it), but the exact deltas this item requires:

**§1 (State shape).** Replace `rejectedBindings`/`bindingsAwaiting` with `invalidIds`/`pendingAwaiting`
in both the interface listing and `EMPTY_STORE_STATE`; update the one-line field comments to the
generalized wording in §2/§3 above.

**§2 (pending-reference buffer).** The "BD-6 half needs no new bookkeeping... generalize into
`bindingsAwaiting`" framing is superseded by this item making the buffer real for every V rule, not
Binding endpoints specifically — rewrite to describe `pendingAwaiting` as rule-agnostic from the start,
driven by `validateEvent`'s `awaiting` field, with BD-6/UR-2/PT-7 as three instances of one mechanism
rather than BD-6 as the sole motivating case. Add the §2 design-correction note above verbatim: UR-2
patches now populate the same buffer as a structural side effect, which narrows §2's original "no new
bookkeeping for UR-2" claim.

**§3 (the three epochs).** Add a row (or a sentence) to the "observed event is a…" table
(`STORE.md:188-193`) for "a previously-pending event whose verdict resolves on this arrival" —
distinct from the existing rows because it dispatches on the *pending event's* type via
`chainEpochTargets`, not on the arriving event's own type, triggered from `pendingAwaiting` rather than
from the arriving event's own shape.

**§4 (BD-7/DEL-8/9 non-contamination).** Generalize "BD-7 is... a real, permanent, monotone verdict
about a Binding's own endpoint types" to cover every V-layer `invalid` verdict, all sharing
`invalidIds`; the disjointness argument (different fields, different branches, no shared epoch) still
holds and does not need to change, only its scope.

**§6 (the Resolution memo).** Note the new filter step in `resolveRoot`'s `eventsCache` construction
(§4 above) and that it needs no separate cache key, reasoned exactly as §4 above does.

**§8 (rule-coverage table).** The single largest change. Today's table (`STORE.md:390-403`) lists BD-7
as "the one real rejection disposition" store owns; that framing is no longer accurate in degree — every
error-severity V rule is now surfaced (not *emitted* — emission ownership stays with `validate.ts` per
D34, unchanged above) through `store.add()`'s `AddResult.rejected`, and every rule that can produce an
`awaiting` array is surfaced through `AddResult.pending`. The table needs a new column or a prefacing
note distinguishing "emits" (validate.ts's job, unchanged) from "surfaces via `AddResult`" (store's new
job), so a future reader does not mistake this for `store` re-claiming ownership of rules it merely
relays — precisely the range-notation over-claim shape `AUDIT-2026-07-31.md` §3/C6 already found once
in the module-ownership table and warned against repeating.

**§9 (the gate).** `SG1`'s `StoreView` (`STORE.md:419-425`) renames `rejectedBindings` to `invalidIds`
in place, unchanged in kind. `SG4` needs its expected-emission set widened to match §8's new table. `SG5`
needs new generator bias: an event simultaneously `accepted`+`rejected` for a non-Binding rule (not just
BD-7); a pending event whose awaited id arrival flips it to `invalid` rather than `valid`, exercising the
`pendingAwaiting`-driven `chainEpoch` bump path (§4); and a new gate item — call it **SG6** — asserting
`resolveRoot`'s output for a root with a since-invalidated member agrees with a fresh `resolve()` call
over the observed set with that member's id removed, the direct D29-oracle check for this item's own
exclusion plumbing, parallel to what C5 already showed was missing for `overlayAwaiting`'s shape.

---

## 8. Design correction: a related but out-of-scope gap in `admit.ts`

Independent of everything above — not caused by this item, not fixed by it, but surfaced by tracing
`invalidIds`' would-be consumers while designing §3/§4 — `admit.ts` itself never checks BD-3/BD-4 endpoint
typing before granting admission credit, and this item's `invalidIds` does not reach it.

`checkBinding`'s own text, quoted verbatim in §3 above, is unambiguous that BD-5 is an admission rule:
`issue('BD-5', 'error', 'Binding endpoints violate the typing rule; not admitted')`. But
`admit.ts`'s `activateBinding`/`bindingIsLive` (`admit.ts:388-399`) and the equivalent inline pass inside
`computeAdmission` (`admit.ts:198-205`) grant `binding:<id>` credit to both endpoints based only on
`bindingEndpoints(binding)` succeeding (one `e root`, one `e link` tag present), the Binding's own
`pubkey` being trusted, and the Binding not being default-view-retracted — **never** checking that the
`e root` target is actually a Product or the `e link` target actually a Metadata. `admit.ts`'s own
top-of-file comment asserts the opposite is already true: "a malformed Binding … is already a … BD-5
validity concern enforced by `validate.ts` **before an event would ever reach this module** in a real
pipeline; `admit` does not re-derive that rejection" (`admit.ts:81-83`). That assumption is exactly what
P5 found false, and this item does not make it true: `store.ts`'s `applyStoreDelta` folds every accepted
event into `applyAdmitDelta` (`store.ts:279`, unconditionally) *before* — and independent of — computing
its `Validity` verdict, today and after this design lands, since nothing in §2's design gates what is
fed to `admit`'s delta on the verdict.

Concretely: a Binding whose `e root` points at a Metadata event and `e link` at a Product — BD-3/BD-4
violated, correctly landing in `invalidIds` per §3 — still credits `binding:<id>` to both of those
wrongly-typed endpoints in `AdmissionIndex`, so they render as **admitted** in a trusted view purely on
the strength of an invalid Binding. This is **not** a D29 oracle-vs-incremental disagreement:
`computeAdmission` (the oracle) has the identical gap, so oracle and incremental agree with each other —
on a spec-incorrect answer. D29's defense is built to catch *disagreement* between the two paths, and was
structurally never going to catch a bug both paths share identically. Worth naming precisely so a future
reader does not file this as "another C5" — it is a different failure shape entirely.

**Why this item does not, and should not, fix it.** Closing it needs `admit.ts`'s `computeAdmission`/
`applyDelta` to consult a validity verdict per Binding — either a new parameter on a currently
trust-only public function (`computeAdmission(events, trust)` → a third argument), or a pre-filter of
`bindingEvents` performed by `store.ts` before folding into `admit`'s delta (which would reorder today's
"admit into `admit` first, validate second" sequence this document's own §1/§2 rely on). Either is a real
signature or ordering change to a *different* module's public surface than this decision scopes, and,
per D23's own caution about refcounting changes, deserves its own reasoning pass rather than riding along
inside an already-large `store.ts` diff. Recorded here, not fixed, per the mandate's own instruction not
to silently paper over a gap found while speccing this out — it needs its own decision and, once fixed,
its own Corrections entry (touches D23's admission mechanism, not this item's D29/D24 surface).

---

## 9. Open questions

1. **§8's `admit.ts` gap** needs its own decision before it is fixed. Whoever picks it up should weigh a
   new `computeAdmission`/`applyDelta` parameter against a `store.ts`-side pre-filter (§8's own two
   options) against real call-site ergonomics, not settle it by default here.
2. Should `PendingEvent`/`RejectedEvent` also carry `type` (`ScrutinyEventType`), matching `Validity`'s
   own `pending`/`valid` variants carry it? The mandate's literal sketch (`PLAN §6`) omits it
   (`{ event, awaiting, issues }`); this document followed the sketch exactly. A consumer wanting to
   dispatch on Binding-vs-Patch pending events without a second `scrutinyEventType()` call might want it
   inlined — left for the implementation phase to decide against real call-site ergonomics.
3. §7's proposed `SG6` (oracle-agreement check for the exclusion plumbing itself) should be scoped
   during implementation to decide whether it needs its own fresh-`resolve()`-per-root comparison on
   every gate run (expensive, but the most direct D29 check available) or can instead assert only on the
   generator's own known-invalid ids (cheaper, narrower).
