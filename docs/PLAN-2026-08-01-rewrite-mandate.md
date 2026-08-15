# Rewrite mandate — 2026-08-01

Neither `protocol-spec.md` (sibling repo, read-only) nor `@scrutiny-fabric/core` has a real consumer
yet. This changes the cost-benefit of every open decision the Phase 8 audit left unresolved
(`AUDIT-2026-07-31.md` §12) and every ergonomics gap it found but didn't scope
(`AUDIT-2026-07-31.md` §10): **"how much does this break" is zero for all fourteen items below.**
Optimize for correctness, elegance, ecosystem compatibility, and modularity instead — a smaller
diff is not a virtue here, and a deferred-but-known fix is exactly what "technical debt" means
under this mandate.

This document is a decision record, not a spec. It supersedes the *hedging* in AUDIT-2026-07-31.md
§12 and the original (pre-mandate) options-and-tradeoffs pass for these fourteen items — it does
not supersede any dated entry in `DECISIONS-2026-07-27.md` itself, which stays append-only per its
own rule. Four of these decisions require a new Corrections entry there before their code lands
(marked below). Two are spec-amendment proposals for the sibling repo and must go through
`SPEC-FEEDBACK-v0.6.0.md`, batched, never a direct edit (D2) — also marked below.

**What this document is for:** input to a spec-and-plan pass — write the mini-specs this project's
own convention requires before code (as `RESOLVE.md`, `ADMIT.md`, `STORE.md`, `PATCH-MATCHER.md`,
`QUERY-BUILD.md` already did for their modules), then fold the result into a revised
`IMPLEMENTATION-PLAN.md` phase breakdown. That pass is scoped to run as its own workflow, in a
fresh session — this document is written to be a complete, standalone starting point for it.

---

## 1. EventFilter reshape

**Final call:** flat `type` alias, real NIP-01 keys, **arrays stay `readonly`** — not the ecosystem's
mutable convention.

**Why:** TypeScript's structural typing already makes this fully compatible with nostr-tools/NDK/
nostrify without copying their mutability — a value typed against their `Filter` is assignable to
ours the moment the shape matches, no dependency needed either direction. Copying mutability would
buy nothing and break this project's own readonly-everywhere convention (every other plain-data type
— `StoreState`, `AdmissionIndex`, `Resolution` — is readonly) for no reason.

**Sketch:**

```ts
export type EventFilter = {
  readonly ids?: readonly string[]
  readonly authors?: readonly string[]
  readonly kinds?: readonly number[]
  readonly since?: number
  readonly until?: number
  readonly limit?: number
  readonly search?: string
} & { readonly [key: `#${string}`]: readonly string[] }
```

Repoint `store.ts`'s `matchesFilter` (currently reads `filter.tags`, ~L567-580) to read the flat
`#`-prefixed keys directly. Bundle the limit tie-break fix in the same pass (same function, same
confluence-leak class): `.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))`.

**Test oracle:** write a hand-rolled NIP-01 matcher from the spec text (this project stays its own
reference implementation for matching, not just for validation/patching/resolution), *and*
cross-check it once against `nostr-tools` as a devDependency — free, since it never touches the
runtime dependency graph. Flag `nostr-protocol/nips#650` (the `since`/`until` boundary ambiguity) in
the test file wherever it's exercised, regardless of which reading is chosen.

**Open for the spec-and-plan pass:** confirm no other package in the monorepo already constructs
`EventFilter` objects using the current nested shape before landing.

---

## 2. Export internal patch.ts types

**Final call:** extract `HaltReason`, `LimitKind`, `ApplyOptions`, **and `HaltRule`** into a
dedicated `packages/core/src/patch-types.ts` (types only, no functions). `patch.ts` imports them
back rather than defining them. Re-export from `index.ts`'s root barrel; no new `package.json`
exports-map entry (D17 — a subpath here would be organisation, not graph-exclusion).

**Why:** D32 ("`./patch` is internal... do not publish a footgun") is scoped to the subpath/exports-map
and the applier *function*, not to type names — confirmed by reading D32 verbatim. The dedicated-file
option is the more modular, self-documenting boundary and scales if more patch-adjacent public types
appear. `HaltRule` has the identical shape of problem and was flagged as a known follow-up in the
original decision packet; fixing it now, since nothing stops it, avoids a half-finished cleanup.

**Needs:** a new dated entry in `DECISIONS-2026-07-27.md` (append-only) clarifying that D32 covers
the applier function and its exports-map subpath, not the inert result/option vocabulary — this is a
clarification, not a reversal, so it does not touch D32's own text.

---

## 3. Resolve-memo staleness fix (D24/C5)

**Final call:** build the **permanent reverse index** — not the cheaper read-time patch.

**Why:** The read-time-patch option was cheaper but breaks reference-stability on cache hits (a real,
if narrow, gotcha a future contributor could trip on silently). The reverse index costs one more
permanent piece of reducer state, but it's the same shape this project already has twice
(`chainMembership`, `bindingsAwaiting`), invalidates proactively at write time instead of patching at
read time, and leaves nothing for a future session to "eventually get right."

**Sketch:**

```ts
// StoreState gains:
readonly overlayAwaiting: Readonly<Record<string, readonly string[]>>  // targetId -> rootId[]

// Populated whenever a Patch event is observed, keyed by its own `e reply` target
// (needs replyTarget hoisted from resolve.ts's private helper into a shared events.ts export).

// chainEpochTargets consults this unconditionally by the ARRIVING event's own id,
// for every event type, and bumps every listed root's chain epoch.
```

The index must **not** be cleared once a target is observed — `unobserve()` of a resolved target must
still be able to flip alpha back to beta later, which only works if the mapping is retained.

**Needs:** a new dated Corrections entry in `DECISIONS-2026-07-27.md` before the code lands (touches
D24). Draft:

> **Cn (2026-08-01) — D24 amended: a fourth reducer index drives chain-epoch invalidation for overlay
> targets.** C5 showed `chainEpoch` never bumps for a root R whose overlay targets an event outside
> R's own chain. Amendment: `StoreState` gains `overlayAwaiting: Record<targetId, rootId[]>`, built
> from every Patch's own `e reply`/`e root` tags at observe time, consulted unconditionally by
> `chainEpochTargets` for the arriving event's own id. Permanent, not cleared on first match, to keep
> alpha/beta correct across a later `unobserve`.

**Open for the spec-and-plan pass:** measure real fan-in (how many roots can one popular event's
arrival invalidate at once) before committing to the exact bump strategy; grep for any `===` identity
comparison against a `resolveRoot()` return value to confirm nothing currently depends on it (this
option preserves reference stability, so this is a sanity check, not a blocker).

---

## 4. RelayTransport interface (D16's fourth interface)

**Final call:** unchanged from the original design pass — this was already the most
ecosystem-compatible shape on offer.

```ts
export const transportSymbol = Symbol.for('@scrutiny-fabric/transport')

export interface RelayTransport {
  readonly [transportSymbol]: true

  request(
    relays: readonly string[],
    filters: readonly EventFilter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: (relay: string) => void,
  ): () => void

  publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly ok: boolean; readonly reason?: string }>>

  count?(
    relays: readonly string[],
    filters: readonly EventFilter[],
  ): Promise<ReadonlyMap<string, number | undefined>>
}
```

Callback + explicit unsubscribe (matches what nostr-tools/NDK/applesauce/nostrify all expose
internally — a thin pass-through per adapter, not a push-to-pull bridge). `count()` optional, not
required-and-throwing (NIP-45 is genuinely optional). `publish()` returns a per-relay outcome map
mirroring NIP-01's OK message exactly, never a collapsed boolean.

**Sequencing:** finalize after item 1 (EventFilter) lands, so `request()`/`count()` consume the real
flat NIP-01 shape from day one — the interface text itself doesn't depend on item 1, but building the
Phase 7 adapters against it should wait.

**Open for the spec-and-plan pass:** does `onEvent` need a relay-of-origin parameter; documented
convention for a relay that silently times out on publish; does `onEose` fire once per relay or once
overall.

---

## 5. Spec: Patch endpoint-typing gap (§4.4 vs §4.3) — routes via SPEC-FEEDBACK

**Final call:** new rules mirroring the Binding pattern exactly.

- **PT-10:** "The event referenced by `e root` MUST be a `scrutiny-product` or `scrutiny-metadata`
  event."
- **PT-11:** "A Patch whose OBSERVED `e root` violates PT-10 is invalid and MUST NOT be admitted."
- `UR-2` already covers the pending case ("retained and re-evaluated on the root's arrival")
  unchanged — no new pending-case rule needed.

**Why:** Binding's endpoints have a full typing lifecycle (BD-3/4/5/6/7); Patch's `e root` has only
the pending half (UR-2), never the rejection half. Verified against `validate.ts`'s `checkPatch`
(~L339-404): it looks up the root event and only ever compares `pubkey` for authorship — never
`scrutinyEventType`. Verified this is *not* currently exploitable via `admit.ts`'s root-chain walk
(filtered to confirmed product/metadata roots via `isRoot`) or `resolve.ts` (independently checks
root type, citing BD-9) — but both guards are this codebase's own incidental hardening, not anything
the spec requires, so a different from-spec implementation would have exactly this hole.

**Process:** file to `SPEC-FEEDBACK-v0.6.0.md` (D2) — this is a proposal for the sibling read-only
spec repo, never a direct edit. The spec-and-plan pass should draft the actual feedback entry (with
line numbers against the current `protocol-spec.md`), not just cite this document.

---

## 6. Wiring validation into store.add()

**Final call:** admit every event to storage always (never silently discard for a *validator* bug);
exclude invalid events from the **resolved view** only. Generalize the existing `bindingsAwaiting`
reverse index into a rule-agnostic pending buffer. Three-bucket `AddResult`
(`accepted`/`rejected`/`pending`, `issues` pluralized). **Delete `store.ts`'s duplicate BD-3/4/7
check** (`checkBindingTyping`) in favor of calling `validate.ts`'s `checkBinding` — two independently
written implementations of the same rule pair is a live risk today, not a hypothetical.

**Why:** This protocol's own ethos is "never silently drop, preserve for audit" (DEL-4's entire
point for deletions). Permanently discarding an event because of a bug in this project's *own*
validator is the same mistake in a different rule, and it's unrecoverable — the "admit but hide"
answer is the only one that can never silently lose a real event to a bug in this codebase.

**Sketch (shape, not final code):**

```ts
interface AddResult {
  readonly accepted: readonly string[]
  readonly rejected: readonly RejectedEvent[]   // issues: readonly Issue[], pluralized
  readonly pending: readonly PendingEvent[]     // { event, awaiting: readonly string[], issues }
}
```

`resolveRoot()`'s event feed needs to exclude ids currently verdicted invalid — this is new plumbing
(`resolve.ts` currently assumes upstream V-filtering already happened and has no exclusion mechanism
of its own), comparable in size to `chainEpoch`'s own bookkeeping. Generalize `bindingsAwaiting` into
`Record<awaitedId, pendingEventId[]>` driven by `validateEvent`'s own `awaiting` field for any V rule,
not just Binding endpoints, reusing the existing `addAwaiting`/`removeAwaiting` primitives (already
fully generic).

**Needs:** confirm no runtime consumer relies on today's `store.add()` never invoking `validateEvent`
(none found, but worth a final grep sweep during the spec-and-plan pass — not a blocker, since the
package is unpublished).

---

## 7. Spec: version-tag digit ceiling — routes via SPEC-FEEDBACK

**Final call:** dedicated single-letter `v` tag, following the exact precedent the spec already sets
for `i`/`k` (NIP-73-style, single-letter, outside the `t` namespace, still relay-indexable).
**No grandfather clause** — retire the 3-digit `scrutiny-vMMP` `t`-tag form outright. TAG-2 rewritten
to require exactly one `v` tag; comparator becomes a real per-field numeric tuple comparison, not
lexicographic string comparison.

**Why:** §3's `^scrutiny-v\d{3}$` is exactly one digit per MAJOR/MINOR/PATCH — this project's own
history already hit the ceiling once (v0.5.9 forced a MINOR bump purely to reset the PATCH digit). A
dedicated `v` tag removes the ceiling permanently without the indexing regression a full-word tag
(`["version", "0.6.1"]`) would cause. Because there is no real corpus yet, every other option's
"old-form-or-new-form" disjunction simply isn't required — this is a straight simplification the
mandate unlocks, not just a bolder version of the original fix.

**Process:** file to `SPEC-FEEDBACK-v0.6.0.md` (D2). Draft amendment text needed:

- New rule replacing TAG-2: exactly one `v` tag, value an unpadded `MAJOR.MINOR.PATCH` string.
- VER-1 rewritten: ordering is per-field numeric tuple comparison, explicitly retracting the
  "lexicographic because zero-padded" claim (the live reference implementation's `compareVersionTags`
  — currently a raw string `<`/`>` — is concrete proof this isn't cosmetic).
- No dual-path/grandfather text needed anywhere, since no real corpus exists to preserve.

**Open for the spec-and-plan pass:** does the new format also widen room for MAJOR, or is single-digit
MAJOR acceptable indefinitely.

---

## 8. Module-ownership table codegen

**Final call:** unchanged — generate `IMPLEMENTATION-PLAN.md`'s module-ownership table from the six
per-module coverage tables (`_a-validate-coverage.ts`, etc.) plus `_unowned.ts`, the same set
`rule-closure.test.ts` already closes over the full rule registry. **Do not** adopt `@owns` JSDoc
annotations as an alternative source — D35 already rejected annotation-based coverage on the record
for this exact reason; doing so now without a new Corrections entry would silently overturn D35 by
rewrite rather than by append, which the project's own append-only rule forbids.

**Open for the spec-and-plan pass:** decide whether this is the same generator Phase 7's
`coverage.json`/`COVERAGE.md` already promised, or a narrower script scoped only to this table; where
the hand-written "why a module owns a rule" narrative prose relocates once the ID columns are
generated.

---

## 9. Producer-side context widening (build now, not deferred)

**Final call:** build it in this pass, using a hybrid strategy — keep `context=3` as the fast path
(covers ~99.7% of edits per the audit's own figures), escalate to widening only on ambiguity. Extract
a genuine shared internal matcher module (`occurrences()`/`reduceHunk()`, today private to
`patch.ts`) used by **both** `patch.ts`'s applier and `build.ts`'s new widening loop.

**Why:** this was previously scoped as backlog specifically because nothing was blocked by its
absence — a known, well-scoped, low-priority nicety. Under a zero-technical-debt mandate, a deferred
item you already know how to build correctly *is* the debt. It also unlocks a cleaner internal shape:
extracting the uniqueness scanner was rejected earlier as premature for one caller, but the widening
loop gives it a second real caller, which is exactly when that extraction stops being premature.

**Sketch:** on `T1` ambiguity at `context=3`, widen linearly (not binary-search — the monotonicity
argument for binary search near file boundaries needs its own property test before being trusted, and
the common case never reaches this path at all) up to full-file context. If full-file context still
can't disambiguate, degrade to the existing `P4` warning verbatim — no new rule citation, since
`RuleId` is a generated literal union from the spec and nothing there names a distinct "exhausted
widening" outcome.

**Open for the spec-and-plan pass:** does the widening search need its own resource ceiling
(analogous to `patch.ts`'s existing `maxWork`) to bound a pathological `before` content.

---

## 10. buildPatch's transposable parameters

**Final call:** replace the six positional parameters with a single named-fields options object.

**Why:** `root`/`reply` and `before`/`after` are same-typed positional pairs — swapping `before`/
`after` produces a plausible-looking *inverse* patch that still passes the P4 self-check, against the
wrong baseline. That's a silent-footgun shape no documentation fixes; named fields make the swap a
compile error instead of a runtime surprise. Free to fix now, expensive once anything calls it.

---

## 11. EndpointRef vs ETagRef field naming

**Final call:** unify to one canonical field name across both types (today: `authorPubkey` vs
`authorHint` for the identical concept, which silently renames a field on round-trip through
`eTags`).

---

## 12. resolveRoot naming collision

**Final call:** rename one of the two distinct public functions currently sharing this name. Small,
permanent tax on every future reader otherwise; free to fix before anyone's muscle memory depends on
either one.

---

## 13. A real signing/verify() helper

**Final call:** ship a documented, copy-paste reference implementation under `examples/signers/`
using `@noble/curves` + `@noble/hashes` — **never a published dependency of core**.

**Why:** today "hello world" can't compile until a newcomer independently discovers which Schnorr
library to use — `core` correctly refuses to default this (D12/D18: no crypto in core, `verify`
required with no default), but offers no worked example either. `@noble` is what nostr-tools and NDK
already standardize on, so this is the most ecosystem-compatible choice available, not an arbitrary
one. Copy-paste rather than a published package for the exact reason this project already settled for
relay adapters (D6): don't force one library's choice onto every consumer of `core`.

---

## 14. Default in-memory EventStorage's scope

**Final call:** build it properly. Real indexes by `kind` and by `#e`/`#i`/`#t`, replacing the current
single-`Map`-plus-full-scan default and its uncached deletion scan.

**Why:** the comparative audit already measured this as "the weakest store of the five" real Nostr
libraries ship — one `Map`, no indexes, full materialization per query. `EventStorage` stays a
swappable port either way (D15/D37 unchanged), but "zero technical debt" is being treated here as
covering the reference implementation itself, not just the public interfaces around it — the
batteries-included default should stop being a known weak point the moment anyone actually tries it,
at the corpus scale the audit measured (30k–110k events).

---

## Not yet resolved — its own interface-design decision, not asserted here

**Trust-filtered view ergonomics.** Today, getting a trust-filtered rendered view out of a `Store`
needs four imports and reaching into `getState().admit`, an internal field. The *direction* is
decided (fix it) but the exact shape — a method on `Store`, a constructor option accepting a
`TrustProvider`, or a standalone composition helper — is a real interface-design decision, the same
kind item 4 (`RelayTransport`) was. Design this properly during the spec-and-plan pass; do not decide
it by assertion in this document.

---

## What the spec-and-plan pass should produce

1. New or amended mini-specs, in the style already established by `RESOLVE.md`/`ADMIT.md`/
   `STORE.md`/`PATCH-MATCHER.md`/`QUERY-BUILD.md`, for at least: the `overlayAwaiting` reducer change
   (item 3), the validation-wiring redesign (item 6), the `RelayTransport` interface (item 4), the
   context-widening algorithm (item 9), and the trust-filtered-view interface (unresolved item above).
2. Two draft `SPEC-FEEDBACK-v0.6.0.md` entries (items 5 and 7), with real line numbers against the
   current `~/scrutiny-fabric/docs/protocol-spec.md`.
3. Draft Corrections-entry text for `DECISIONS-2026-07-27.md`, append-only, for items 2 and 3 (and
   any other item that turns out to touch a standing decision once specced in full).
4. A revised `IMPLEMENTATION-PLAN.md` phase breakdown sequencing all fourteen items plus the one
   unresolved interface decision, respecting the dependency this document already found: item 1
   (EventFilter) before item 4 (RelayTransport); item 3 (resolve-memo) and item 6 (validation wiring)
   touch overlapping `store.ts` surface and should not land in the same commit.
