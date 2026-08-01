# `store`'s trust-filtered view — closing the mandate's one open item

Spec-and-plan pass mini-spec, written before code, resolving `PLAN-2026-08-01-rewrite-mandate.md`'s
"Not yet resolved" section verbatim: *"Trust-filtered view ergonomics... the exact shape — a method on
`Store`, a constructor option accepting a `TrustProvider`, or a standalone composition helper — is a
real interface-design decision... Design this properly during the spec-and-plan pass; do not decide it
by assertion."* The finding this resolves is `AUDIT-2026-07-31.md` §10.1 verbatim, quoted in full in §0.

Governing text: §6 (trust & admission, TR-2…7), §7.3 (OV-7 overlay visibility), §6.1 (trust mechanism
out of scope of the specification). Decisions touched: D15 (`Store` is a factory of bound methods,
never a class), D21 (`TrustProvider` — synchronous predicate, "no trust package"), D22 (views, not a
bypass flag), D24 (three independent epochs; admission ≈1000× cheaper than chain resolution), D25/TR-7
(trust never reaches `resolve`), D26 (the resolve memo's key has no trust component), D29 (pure
functions retained as conformance oracle). This document adds no new rule-owning code — like
`interfaces.ts` (`ADMIT.md` §1), it is architecture, not a rule-bearing module, and is not part of any
coverage partition.

---

## 0. The gap, restated precisely

`AUDIT-2026-07-31.md` §10.1, in full:

> There is no way to get a trust-filtered view out of a `Store`. `CreateStoreOptions` does not take a
> `TrustProvider`. Rendering overlays under OV-7 — the commonest client operation — requires
> `visibleOverlays(res.overlays, trustedView(toIndex(store.getState().admit)))`: four imports from a
> second module, routed through `getState().admit`, a field whose own doc comment calls it internal
> cache plumbing. Meanwhile `computeAdmission(events, trust)` is the *only* consumer of `TrustProvider`
> in the package and is unreachable from the store path — so D21's interface requires implementing
> `version` and `deltaSince`, which nothing calls, to use a function the store never calls. Two
> parallel trust mechanisms, neither documented as the recommended one.

Verified directly against `store.ts` and `admit.ts` (read in full for this pass): the finding is
exactly right, and one thing under it needs to be said more sharply than the audit had scope for.
**These are not two mechanisms of equal standing that happen to be undocumented — they are a live,
incrementally-maintained one (`Store.trust`/`untrust` → `admit.applyDelta`'s `Set`-guarded refcounting,
D23) and a from-scratch oracle (`computeAdmission` over a `TrustProvider`) that D29 already designates
as *the thing the incremental path must agree with*, never as a thing a consumer calls directly.**
`store.ts` never imports `computeAdmission` or references `TrustProvider` anywhere — confirmed by
reading its full import list (`./admit.js`'s imports are `AdmissionIndex`, `AdmitState`,
`EMPTY_ADMIT_STATE`, `applyDelta`, `bindingEndpoints`, `toIndex`; no `computeAdmission`, no
`TrustProvider`). `TrustProvider.version`/`deltaSince` are therefore not merely "not called in Phase 4"
(`ADMIT.md` §1's stated expectation that this was deferred to "Phase 5's incremental-recompute wiring
against `trustEpoch`") — Phase 5 shipped and chose a different, simpler incremental design (§1 below),
so those two members are unconsumed by every production code path in the package, permanently, not
provisionally. §6 makes this explicit rather than leaving it an accident of sequencing.

---

## 1. Why the two mechanisms already agree, and why only one is reachable

`Store`'s own `trust(pubkeys)`/`untrust(pubkeys)` feed `admit.applyDelta({kind: 'trust'|'untrust',
pubkeys})`, which folds into `AdmitState.trusted: readonly string[]` — a plain, `Set`-backed allowlist
maintained incrementally, refcounted per D23, exposed as `AdmissionIndex` via the free function
`toIndex(state.admit)`. `computeAdmission(events, trust: TrustProvider)` is a full, unscoped,
from-scratch recompute over the *whole* observed set that needs an injected predicate because it has no
state of its own to consult. AG1 (`ADMIT.md` §10) already asserts these two produce identical
`AdmissionIndex` values for every generated delta sequence — that is D29's oracle property, and it is
why "which one is correct" is not the open question here. The open question is purely **which one a
`Store` consumer should be pointed at**, and the answer the incremental path's own existence already
implies: `Store` tracks trust itself precisely so a consumer does not have to hand-roll a
`TrustProvider` (implementing `version`/`deltaSince` for what is, for this path, just "is this pubkey in
my set") to answer a question `Store` can already answer for free from state it already threads through
every `observe`/`unobserve`/`trust`/`untrust` call.

---

## 2. Candidate (a) — new methods on `Store`

Two small methods, not one, because the audit's four-import chain decomposes into two independently
useful primitives once named: "give me the current trust view" and "give me a root's resolution with
that view already applied to its overlays."

```ts
export interface Store {
  add(events: readonly NostrEvent[], meta?: IngestMeta): Promise<AddResult>
  unobserve(eventIds: readonly string[]): Promise<void>
  trust(pubkeys: readonly string[]): void
  untrust(pubkeys: readonly string[]): void
  resolveRoot(rootId: string, options?: ResolveOptions): Resolution   // UNCHANGED — see §2.1
  /** NEW */
  admissionView(): AdmissionView
  /** NEW */
  viewRoot(rootId: string, options?: ViewRootOptions): Resolution
  getState(): StoreState
}

export interface ViewRootOptions extends ResolveOptions {
  /**
   * Filters `Resolution.overlays` (OV-7). Defaults to `admissionView()` — this Store's own current
   * trust state. Pass `openView` (re-exported from the barrel already, D22) explicitly for the
   * "show everything" audit case. There is no boolean escape hatch: D22 rules out a bypass flag for
   * exactly this reason, and that rule applies one layer up here as much as it did inside `admit.ts`.
   */
  readonly admission?: AdmissionView
}
```

Implementation, inside `createStore` — composes `resolveRoot` (the already-memoized bound method),
`toIndex(getState().admit)`, and `trustedView`/`visibleOverlays`, exactly as the audit's finding
describes, but internally:

```ts
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
```

(`resolveOptions` is built the same conditional way `resolveRootBound` already builds its own default
— passing `{ apply: undefined }` unconditionally would shadow `CreateStoreOptions.applyOptions`'s
existing default-merge, since `resolveRootBound` only applies that default when its own `resolveOptions`
argument is `undefined`, not merely apply-less.)

**Return type is `Resolution`, not a new nominal wrapper.** Considered and rejected: a distinct
`TrustedResolution`/`ViewedResolution` interface, on D43's precedent of making a specific mistake
structurally unrepresentable (`ChainState`'s forked variant has no `tipId` field). It does not apply
here the way it does there: TypeScript's structural typing (already the operative argument for decision
1's `EventFilter`, this same pass) means a same-shape sibling interface is not actually distinguishable
from `Resolution` at the type level — nothing would stop a raw `Resolution` from being passed where the
new type is expected, so the wrapper would document an intent without enforcing it, at the cost of a
second name for what is structurally the same four fields. `resolveRoot`'s own existing doc comment
already establishes the convention this follows: "apply `admit.visibleOverlays` to `resolution.overlays`
at read time if a trust-filtered view is wanted" — the transformation is defined as overlays-in,
overlays-out, same type, and D26 already establishes that trust is never part of `Resolution`'s own
identity (the resolve memo's cache key has no trust component) — so a `Resolution` was never "trust-blind
or trust-aware" as a matter of its own type in the first place; it is a plain projection either way, and
whether its `overlays` happen to be everyone's or only the admitted ones is a fact about *how it was
produced*, tracked by which `Store` method a caller called, not by its shape.

**`chain`/`pending`/`annotations` are untouched — only `overlays` is filtered.** This is not an
oversight scoped narrowly to match the audit's own wording; it is required by D25/TR-7: trust-filtering
before chain construction is the highest-severity bug D25 documents (a root admitted only via a trusted
Binding may have patches by an untrusted pubkey, so gating chain content on trust would mask a real
self-fork or HALT). `viewRoot` therefore never gates *whether* a root's canonical chain is computed or
returned — only OV-7's specific question (which *foreign* overlays render) is answered by the admission
view. Whether the root itself should be shown at all (i.e. `isAdmitted(admissionIndex, rootId)`) is a
different, prior question a client answers before ever calling `resolveRoot`/`viewRoot` — typically
because `rootId` came from a query already scoped to admitted roots — and stays outside this method's
job exactly as the audit's own wording scoped it ("rendering overlays," not "deciding which roots
render"). Not a design correction to make here; restating it is meant to head off exactly the kind of
scope-creep a future reader might otherwise fold into `viewRoot`.

**`admissionView()` is exposed publicly, not folded away as a private detail of `viewRoot`.** The
narrower fix — ship `viewRoot` alone, keep the AdmissionView-construction step private — was considered
and rejected: it would resolve the overlay-rendering instance of the ergonomics gap while leaving the
general one (any consumer wanting `isAdmitted` for an arbitrary id — a Binding in an audit UI, a root
before deciding whether to call `viewRoot` at all) exactly as painful as before, back to `toIndex`
+ `trustedView` + reaching into `getState().admit`. The cost of exposing it is one line on the
interface and one line of implementation — no new state, no new decision about how trust is tracked,
just naming a value `createStore` already computes on demand from state it already owns.

**How a caller gets the raw, unfiltered form:** unchanged — `store.resolveRoot(rootId, options)`. Its
contract (`overlays` is every overlay in the observed set) is not touched by this document; `viewRoot`
is additive.

**How a caller gets the explicit "show everything" audit view:** `store.viewRoot(rootId, { admission:
openView })`, where `openView` is the existing barrel export (D22) — no new API surface needed for this
half, since `openView` is already a fixed constant independent of any `Store`'s state.

---

## 3. Candidate (b) — a standalone barrel helper, independent of `Store`

Sketched concretely, as the mandate requires, before being rejected:

```ts
export function viewResolution(resolution: Resolution, view: AdmissionView): Resolution {
  return { ...resolution, overlays: visibleOverlays(resolution.overlays, view) }
}
```

**Ergonomics.** For a consumer who already has a `Resolution` (from `store.resolveRoot`, or from calling
bare `resolve()` without a `Store` at all) and an `AdmissionView` (from `trustedView(computeAdmission(...))`
or `store.admissionView()`), this saves exactly one line — the object spread — over calling
`visibleOverlays(resolution.overlays, view)` directly and building the spread inline. It does not touch
the audit's actual complaint at all: reaching into `getState().admit` was the pain, and a consumer using
bare `resolve()` was never reaching into any `Store` internal to begin with, so this helper solves a
problem the audited consumer did not have.

**Tree-shaking (D9), argued honestly rather than waved away.** The two candidates are not equivalent
here, and it is worth being precise about the direction of the difference even though it does not change
the outcome. `viewRoot`/`admissionView`'s implementation bodies live inside `createStore`'s own closure
(§2) — every consumer who imports `createStore` (D15's documented entry point; near-universal) pays for
the handful of bytes those two closures cost, whether or not `viewRoot`/`admissionView` are ever called,
because they are constructed unconditionally on every `createStore()` invocation. A standalone
`viewResolution` export, by contrast, is genuinely eliminated by `sideEffects: false` when unimported —
zero bytes for a consumer who filters overlays by hand. This is a real cost asymmetry in (b)'s favor, not
a wash — but it is a two-line-function's worth of bytes, nowhere near the class of pathology D9's own
citation (matrix-js-sdk's 8.89 MB from a flattened lazy `import()`) exists to prevent, so it is not
weighed as decisive.

**Rejected**, on a different ground than tree-shaking: shipping `viewResolution` alongside `viewRoot`
would mean two documented, barrel-exported ways to reach the same one-line transformation — precisely
the "two mechanisms, neither documented as the recommended one" shape this whole document exists to
retire, just relocated from *which trust source* to *which function filters overlays*. `visibleOverlays`
is already exported and already does this in one call with the spread written out at the call site; a
named wrapper around a one-line spread over an existing, already-minimal primitive is organisation, not
graph exclusion or genuine ergonomic gain — the same test D5/D17 already apply to subpath exports,
applied here to a function export. **Not exported.** A raw-`resolve()` consumer who wants this exact
shape writes the one-line spread themselves, using primitives (`visibleOverlays`, `trustedView`,
`computeAdmission`, `openView`) that already exist and are already exported.

---

## 4. Candidate (c) — `CreateStoreOptions` accepts a `TrustProvider`

Sketched, then rejected on the strongest ground the task asked this pass to be willing to use — that it
resolves nothing and creates a third mechanism:

```ts
export interface CreateStoreOptions {
  readonly verify: (event: NostrEvent) => boolean
  readonly storage?: EventStorage
  readonly applyOptions?: ApplyOptions
  readonly trustProvider?: TrustProvider   // hypothetical — not adopted
}
```

Two readings, both bad:

**(c1) `trustProvider` replaces `trust`/`untrust`.** Admission would then have to be computed by calling
`computeAdmission(allObservedEvents, trustProvider)` fresh — unscoped by root, over the *entire*
observed set — on every `viewRoot`/`admissionView()` call, because nothing else would exist to consult.
This throws away D24's entire measured argument for the incremental path: full admission recompute at
100k events is ≈9 ms against a ≈0.4 ms trust-list swap via the incremental route — a ~20× regression on
every read for the sake of accepting a more general predicate interface that the Store path never
actually needed a predicate for (see §1). It would also remove `trust`/`untrust` from `Store`'s public
surface, a breaking change to the one part of this interface that already works and that this whole
document exists to make *more* reachable, not less.

**(c2) `trustProvider` sits alongside `trust`/`untrust`.** Now there are genuinely two independent trust
sources a `Store` instance would carry at once, and admission would have to be *some* combination of
them (union? provider-wins? Store-wins on conflict?) that this document would have to invent and that
nothing today needs — no real caller has both an allowlist pushed via `trust()`/`untrust()` *and* a
separate live `TrustProvider` for the same `Store` instance, because whatever the provider computes can
already be pushed into `trust()`/`untrust()` directly (below). A caller who forgot to keep the two in
sync — called `store.trust(pk)` but the injected provider's `isTrusted(pk)` still says `false`, or the
reverse — gets silently inconsistent admission with no error and no test that would catch it, which is
exactly the audit's own "two parallel trust mechanisms, neither documented as the recommended one"
finding, except now built into the constructor rather than emerging from a consumer's confusion about
which import chain to use.

**The bridge (c) would have provided already exists without it.** A caller with a genuine external
`TrustProvider` (a real web-of-trust computation, a live NIP-51 subscription) has two ways to use it with
`Store` today, neither requiring a new option: (i) diff it into `Store`'s own mechanism —
`const { added, removed } = provider.deltaSince(lastVersion) ?? computeFullDiff(); store.trust(added);
store.untrust(removed)` — or (ii) bypass `Store`'s admission machinery entirely and call
`computeAdmission(Object.values(store.getState().admit.observedById), provider)` directly, using `Store`
purely as an event cache and chain-resolution engine while doing admission themselves against the oracle.
Both are expressible today, in userland, with the exports that already exist. **Rejected in full: no
trust-related field is added to `CreateStoreOptions`.**

---

## 5. Final call

**`Store` gains `admissionView(): AdmissionView` and `viewRoot(rootId: string, options?:
ViewRootOptions): Resolution`, exactly as sketched in §2. `resolveRoot` is unchanged. `CreateStoreOptions`
gains nothing (§4 rejected in full). No new barrel export beyond the two new `Store`-interface members
and the `ViewRootOptions` type (§3 rejected in full).**

Exact signatures, for the implementation phase to build against with no further judgment call:

```ts
// store.ts

export interface ViewRootOptions extends ResolveOptions {
  readonly admission?: AdmissionView
}

export interface Store {
  add(events: readonly NostrEvent[], meta?: IngestMeta): Promise<AddResult>
  unobserve(eventIds: readonly string[]): Promise<void>
  trust(pubkeys: readonly string[]): void
  untrust(pubkeys: readonly string[]): void
  resolveRoot(rootId: string, options?: ResolveOptions): Resolution
  admissionView(): AdmissionView
  viewRoot(rootId: string, options?: ViewRootOptions): Resolution
  getState(): StoreState
}
```

`createStore`'s body needs, in addition to its existing imports from `./admit.js` (already imports
`toIndex`): add `trustedView`, `visibleOverlays`, and `type AdmissionView` to that import list —
the last is needed because `ViewRootOptions.admission` and `admissionView()`'s return type both
name it, and `store.ts` does not otherwise import any type from `admit.js` today. Two new bound
functions,
implemented exactly as in §2, added to the object `createStore` returns alongside `add`, `unobserve`,
`trust`, `untrust`, `resolveRoot: resolveRootBound`, `getState`.

Barrel (`index.ts`): add `type ViewRootOptions` to the existing `store.js` export block. No change to
the `admit.js` export block — `openView`, `trustedView`, `visibleOverlays`, `toIndex`, `AdmissionView`,
`AdmissionIndex`, `computeAdmission`, `TrustProvider` are already exported there and stay exported,
unchanged, for the reasons in §6.

**Accepted, pre-existing looseness, not introduced here:** `viewRoot`'s `admission` parameter accepts
any `AdmissionView`, including one captured before a later `trust()`/`untrust()` call — `Store` cannot
validate an opaque `{isAdmitted(id): boolean}` value's provenance, and `visibleOverlays`'s existing
signature already has this property. Not a new risk this design adds.

---

## 6. `computeAdmission`/`TrustProvider`'s role — stated plainly

**Changes.** `computeAdmission`/`TrustProvider` are documented, from this point on, as the stateless
conformance oracle for admission — the exact role D29 already assigns the pure functions for
resolve/admit generally ("the pure functions are retained as a conformance oracle... every incremental
path must agree with a from-scratch recompute... the only real defence against the refcount bugs in
D23") — extended explicitly to cover `Store`'s own trust-facing surface, which was previously silent on
the question. They are **not**, and after §4's rejection will never become, `Store`'s own live trust
mechanism. `Store`'s sole live, incremental, recommended mechanism is `trust(pubkeys)`/`untrust(pubkeys)`
feeding `admit.applyDelta`'s `Set`-guarded refcounting (D23), read back via `admissionView()`/`viewRoot()`
(§2). `TrustProvider.version`/`deltaSince` remain permanently unconsumed by any production code path in
this package — `computeAdmission` is their only caller, and `computeAdmission`'s only caller is AG1's
gate. This was already true; this document is what makes it a stated architectural fact rather than an
artifact of Phase 5 having shipped a different design than `ADMIT.md` §1 anticipated.

---

## 7. Design correction, found while writing this section

**D21 says "Trust is a synchronous predicate, never a set. No `trust` package," and this document just
finished naming `Store`'s own `Set`-backed `trust(pubkeys)`/`untrust(pubkeys)` as the one, sole,
recommended mechanism — which reads, on the literal text, like exactly what D21 forbids.** This is not
introduced by this pass — `store.ts`'s `trust`/`untrust` already exist and already work this way — but
no prior document has had to state plainly that this *is* the recommended path, which is what surfaced
the tension: recommending it makes the apparent conflict with D21 load-bearing rather than incidental.

Read against D21's own rationale rather than its summary line, the conflict resolves: D21's "no `trust`
package" is scoped to a *policy*-computing mechanism — web-of-trust expansion, NIP-51 list fetching,
reputation scoring — which §6.1 puts out of scope of the specification, and which D21's own dependency
argument is about (NIP-51 fetching is relay IO; NIP-44 decryption needs a signer). `Store`'s
`trust`/`untrust` compute no such policy — they are a bookkeeping sink for a trust *decision* the caller
already made by whatever mechanism they chose, exactly the same way `IngestMeta.verified` is a
bookkeeping sink for a verification decision `store.add()` does not itself compute. The `Set` D21 rules
out is a `Set` used *as the mechanism for deciding who to trust*; the `Set` `AdmitState.trusted` holds is
storage for a decision already made elsewhere, which is a different claim than the one D21's rationale
argues against. Under this reading `trust`/`untrust` were always compatible with D21 — but D21's own
text does not make this distinction explicit, and a future reader citing D21's summary line in isolation
("no trust package... never a set") against `store.ts`'s existence would have a real point until this
paragraph exists somewhere append-only.

**Recommend:** a Corrections entry in `DECISIONS-2026-07-27.md` (owned by the later stage of this
pipeline, not written here) narrowing D21's text to state explicitly that "no trust package" governs the
*mechanism that decides trust* (out of scope, caller-owned) and does not forbid `store.ts`'s own minimal
allow/deny bookkeeping over a decision already made — the same distinction this section just argued.
Draft text for that later stage to adapt:

> **Cn — D21 clarified: "no trust package" governs the trust-deciding mechanism, not `store`'s
> bookkeeping over an already-made decision.** `TRUST-VIEW.md` §7 found that `store.ts`'s
> `trust(pubkeys)`/`untrust(pubkeys)`, which already existed and is now the documented recommended path
> for a `Store` consumer (`TRUST-VIEW.md` §5), reads as contradicting D21's summary line in isolation.
> Clarification, not a reversal: D21's rationale (§6.1 out-of-scope, the NIP-51/NIP-44 dependency
> argument) is about a package that *computes* who to trust; `store`'s `Set` is storage for a trust
> decision made entirely outside `core`, the same role `IngestMeta.verified` plays for a verification
> decision. `TrustProvider`'s synchronous-predicate requirement and `computeAdmission`'s status as the
> conformance oracle (D29) are unaffected.

---

## 8. Standing-decision checklist

- **D15** (factory of bound methods, never a class) — unaffected; `admissionView`/`viewRoot` are two
  more bound functions returned from the same factory closure, same shape as every existing method.
- **D21** (synchronous predicate; no trust package) — the interface itself is untouched (still required
  exactly as written); its *practical scope* is clarified, not reversed, per §7's proposed Corrections
  entry. Flagging this plainly per the task's instruction: **this narrows a plausible literal reading of
  D21's summary line and needs the Corrections entry drafted in §7 before this design's code lands.**
- **D22** ("show everything" is a view, never a bypass flag) — upheld, not just preserved:
  `ViewRootOptions.admission` takes an actual `AdmissionView` value; there is no boolean parameter, and
  passing `openView` explicitly is the only way to get the audit case, exactly as D22 requires one layer
  further out than `admit.ts` itself.
- **D24** (three independent epochs; admission ≈1000× cheaper than chain resolution) — unaffected.
  `admissionView()` reads `state.admit` fresh on every call rather than caching, which is correct because
  there is nothing expensive to cache (`toIndex` is a reference-preserving wrap, not a copy); no new
  epoch, no new invalidation code, and `viewRoot`'s admission-filtering step runs strictly *after*
  `resolveRoot`'s epoch-gated memo lookup, so a `trustEpoch` bump still touches zero `applyPatch` calls
  (SG2's own property), unchanged by this document.
- **D25/TR-7** (trust never reaches `resolve`) — unaffected and actively reinforced: §2 states explicitly
  that `viewRoot` filters only `overlays`, never `chain`/`pending`/`annotations`, and that admission-
  gating a root's *existence* in a view is a prior, separate client decision this method does not make.
- **D29** (pure functions as conformance oracle) — extended, not reversed: §6 states plainly that
  `computeAdmission`/`TrustProvider` take on, for `Store`'s trust surface specifically, the same
  oracle-only role D29 already established for resolve/admit generally. This is the intended completion
  of a framing D29 already set up, not a new claim about it.

No other DECISIONS entry is touched by this design.

---

## 9. Open questions for the implementation phase

1. Should `admissionView()`/`viewRoot()` be biased toward in an eventual SG-numbered property gate (e.g.
   "a `trust()` call is reflected in the very next `admissionView()`/`viewRoot()` call, with no
   intervening `resolveRoot`")? No gate item is proposed here — this document is architecture, not a
   rule-owning module (header note) — but whoever writes `store.ts`'s test suite next should decide
   whether this warrants its own SG item or rides along inside SG2's existing epoch-cost property.
2. `resolveRoot`'s own doc comment currently tells a reader to build the four-import chain by hand
   ("apply `admit.visibleOverlays` to `resolution.overlays` at read time if a trust-filtered view is
   wanted"). That comment should be updated, when this lands, to point at `viewRoot` as the recommended
   spelling of exactly that sentence — a documentation-only change alongside the code, not a new
   decision.
