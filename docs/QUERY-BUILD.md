# `query` and `build` — filter builders and unsigned templates

Phase 6 mini-spec. Written before any code, as Phases 2–5 were.

Governing text: §8 (Discovery & Queries — 8.0/8.1/8.2/8.3) for `query`; §5.2 (patch payload format,
envelope E1–E7, consumer grammar C1–C8, producer recommendation P1–P4) for `build`. Decisions: D13
(unsigned templates only, no `id`/`pubkey`/`sig`), D16 (the four branded interfaces — neither module
needs a new one), D17 (subpath names). Rules owned: `query` — DQ-1…4, BD-8. `build` — E4, P1…P4.

Both modules are pure and synchronous. Neither does relay I/O, neither is async, and neither holds
state across calls — the simplest shape in the package so far, which is also why this mini-spec is
shorter than `RESOLVE.md`/`ADMIT.md`/`STORE.md`: there is no reducer, no epoch, no pending buffer to
design around.

---

## 0. Why no vector file, again

`discovery.json` and `serialization.json` remain reserved and unpublished, exactly as they were at
Phases 4 and 5 (see the plan's own note at each phase). Phase 6 is a third module deep into that gap.
The substitute gate is §5 below, in the same spirit as `ADMIT.md` §10 and `STORE.md` §9 — except
scaled down to match the modules: no permutation property is meaningful over a pure function with no
internal state, so the gate is a mix of literal conformance against the spec's own worked examples
(§8.1/§8.2 show exact JSON) and a property test where one exists (E4's fence length).

---

## 1. `query.ts` — filter builders and result classifiers

### 1.1 `EventFilter` reuse (the interfaces.ts decision)

`interfaces.ts`'s `EventFilter` was deliberately kept minimal at Phase 5, with a comment flagging
that `query.ts` might need something richer. It doesn't: every shape in §8.1/§8.2 is `kinds` +
`tags` (`#t`/`#e`/`#i`) plus, for the NIP-50 fallback, a `search` string NIP-01 filters carry as a
sibling field. Rather than duplicating `EventFilter`'s shape under a new name — the exact drift the
original comment warned about — `search?: string` was added to the one existing type, and `query.ts`
imports and returns it unchanged. `EventStorage.query()` (local, in-memory) simply never receives a
filter with `search` set, since nothing local implements NIP-50 ranking; that is a fact about which
filters a given `EventStorage` implementation honours, not a reason to fork the type.

Tag filter keys use the `#`-prefixed NIP-01 wire form (`#t`, `#e`, `#i`), matching the one precedent
already in the test suite (`store.test.ts`'s `{ tags: { '#e': [r.id] } }`) and `store.ts`'s own
`matchesFilter`, which tolerates both forms — `#`-prefixed is the form that appears verbatim in every
one of §8.1/§8.2's own JSON examples, so building filters in that form makes a conformance test a
literal deep-equality check against the spec text rather than a translation.

### 1.2 Discovery — §8.1's degradation ladder

Four steps in the spec, three builder functions here — steps 1 and 2 (exact indexer, broader
indexer) are the same filter shape with different indexer specificity, which is a fact about the
*strings the caller passes*, not a second shape for this module to carry:

```ts
indexerFilter(indexer: string | readonly string[]): EventFilter
searchFilter(query: string): EventFilter                        // DQ-3, step 3
fullScanFilter(types?: readonly ('product' | 'metadata')[]): EventFilter  // step 4
```

`indexerFilter` always includes `#t: ['scrutiny-fabric']` (DQ-1) and accepts one or several `#i`
values — §8.1 step 2's own text: "clients MAY also query multiple specificity levels in a single REQ
(Nostr treats `#i` values with OR logic)" is multiple *values in one tag*, not multiple filter
objects, which is why the parameter is `readonly string[]`, not `readonly EventFilter[]`.

`fullScanFilter` defaults to both `scrutiny-product` and `scrutiny-metadata` when no `types` are
given, narrowing to whichever subset the caller names otherwise — §8.1's own text: "Narrow the filter
... when the target type is known. Bindings and patches are excluded — they do not carry `i` tags."
The type is restricted to `'product' | 'metadata'` rather than the full `ScrutinyEventType`, because
that exclusion is the point of this specific filter, not an oversight a caller should be able to work
around by passing `'binding'`.

`searchFilter` builds the filter only. §8.1 step 3's second sentence — "Client MUST verify returned
events carry valid `scrutiny-fabric` tags and match the user's intent" — is a check over *results*,
which this module never sees (no I/O), and "match the user's intent" has no formal definition at all.
`isScrutinyEvent`/`scrutinyEventType` (`events.ts`, already exported from the root barrel) are the
tool a consumer already has for the tag half; this module does not wrap them a second time.

### 1.3 Traversal — §8.2

```ts
bindingsReferencing(eventId: string): EventFilter        // Product↔Metadata, either direction
deletionsFor(eventId: string): EventFilter                // DQ-2
classifyByRole(events, anchorId, expectedType?): RoleMatch[]   // DQ-4
```

**`bindingsReferencing`** is one function, not two, because §8.2's "Product → Bound Metadata" and
"Metadata → Products" examples are byte-identical filter shapes (`{"kinds":[1], "#t":
["scrutiny-binding"], "#e": [<id>]}`) — the direction is a property of which marker the caller
inspects afterward on the results, which is exactly `classifyByRole`'s job, not a second filter
shape.

**`deletionsFor`** omits `#t` entirely, per DQ-1's own carve-out ("except for kind 5 lookups, which
do not carry `scrutiny-fabric` tags") and §3.2's inherited-semantics table ("Kind 5 events typically
do not carry a `scrutiny-fabric` `t` tag"). Getting this wrong — including `#t` on a kind-5 filter —
would silently return zero deletions from any relay that honours the filter literally, which is a
strictly worse failure than an unfiltered result a consumer has to sift.

**`classifyByRole`** is intentionally general rather than Binding-specific: DQ-4's text ("results MUST
be filtered for the expected `scrutiny-*` event-type `t` tag, and the `e` tag markers ... MUST be
inspected") is stated once, for "traversing `e`-tag references" generally, and the same shape applies
to a Patch's `root`/`reply` markers as much as a Binding's `root`/`link`. It filters by an optional
`expectedType` (the `#t` half DQ-4 asks for — filtering by *type*, not merely by kind, since kind 1
alone does not distinguish a Binding from a Patch) and reports, per matching event, which marker its
`e` tag naming `anchorId` carries (the role half). A result with a marker of `undefined` (an unmarked
`e` tag happening to name the anchor) is excluded — DQ-4 asks for a *role*, and an unmarked tag
carries none.

### 1.4 Rules not enforceable structurally here

**BD-8 (relay-hint fallback)** — the task brief's own framing is exactly right: this module can only
*enable* the discipline, never enforce it, because a plain `EventFilter` carries no relay field at
all (relay selection is `RelayTransport`'s job, not the filter's). `deletionsFor`/`bindingsReferencing`
build filters that are relay-agnostic by construction — nothing here ever encodes "only ask relay X,"
which is the necessary condition for a caller's own fallback-to-full-relay-set logic to be possible at
all. Declared **not-covered** with that reasoning; the alternative (declaring it "covered" by the
absence of a relay field) would be exactly the kind of vacuous pass D34 exists to prevent.

**DQ-3's verification half** — as §1.2 states, building the filter is this module's; verifying
results against the consumer's own tags/intent is not, because there are no results here to verify.
Declared **not-covered**, same shape as BD-8.

All five rules this module owns (DQ-1…4, BD-8) are **D-layer** — §6.0's "not admission criteria for
the event itself" — so an all-not-covered partition is exactly what `admit.ts`'s AG3 already
established as a legitimate outcome (0/9 emitted, all D-layer), not a gap. `query.ts` never calls
`issue()` at all: it has nothing to reject, and nothing to annotate — only filters to build and
results to classify.

---

## 2. `build.ts` — unsigned templates

### 2.1 Shape

Every builder returns

```ts
export interface BuildResult {
  readonly template: UnsignedEvent
  readonly issues: readonly Issue[]
}
```

— `issues` always present, always empty except for `buildPatch`'s P4 self-check (§2.4), mirroring
`patch.ts`'s own `PatchApplied`/`PatchNoop`'s "issues: always empty; present on every variant so a
caller need not switch on status" discipline (`patch.ts`'s own doc comment). `template` never carries
`id`, `pubkey`, or `sig` (D13) — those three are the injected signer's job.

```ts
buildProduct(content: string, createdAt: number, indexers?: readonly string[]): BuildResult
buildMetadata(content: string, createdAt: number, indexers?: readonly string[]): BuildResult
buildBinding(root: EndpointRef, link: EndpointRef, content: string, createdAt: number): BuildResult
buildPatch(root: EndpointRef, reply: EndpointRef, before: string, after: string, createdAt: number, context?: number): BuildResult
```

Both optional trailing parameters are plain positional defaults, not options objects — each builder
has exactly one optional knob, and `patch.ts`'s own `makePatch(before, after, context = 3)` is already
the precedent for that shape in this codebase; an options object would only add a destructuring layer
for no gain.

`createdAt` is a required parameter, not computed internally (no `Date.now()` anywhere in `core`,
matching every other module's purity) — CA-1's own warning that backdating `created_at` to a
historical fact silently loses events to a relay's timestamp window is exactly the failure mode a
caller, not this module, is positioned to get right; `build.ts` just refuses to guess.

`indexers` accepts raw `i`-tag values (`"cpe:2.3:h:..."`) and *derives* the `k` tags via
`parseIndexer` (already in `events.ts`) rather than accepting a second, separately-specified `k`
list — MD-4/PR-4 ask for "at minimum one entry per distinct `i` prefix kind," which a derived set
satisfies by construction and a hand-supplied second list could drift from. `imeta` attachments are
deliberately absent: IM-1…IM-5 are not owned by any Phase 6 module (deferred with `artifacts`, D7,
"possibly never" per the plan's scope section) and are out of scope here.

`EndpointRef` is the `e`-tag shape §4.3's own worked examples use:

```ts
export interface EndpointRef {
  readonly id: string
  readonly relay?: string          // BD-8: advisory hint; omitted ⇒ ""
  readonly authorPubkey?: string   // NIP-10 author hint (BD-12); omitted ⇒ ""
}
```

### 2.2 The P2 double-listing — a plan-doc note, not a blocker

The plan's module-ownership table lists **P2 under both `validate` and `build`**. This is worth
recording rather than silently resolving one way, per the working style's own instruction to surface
a real gap rather than force it quietly — but it is not the kind of contradiction that blocks the
phase, because the two ownership claims turn out to be about different halves of the same rule, not
competing claims over one:

- P2 is **V-layer** — checkable on receipt — and `validate.ts` already implements it
  (`FORBIDDEN_PREAMBLE` in `checkPatchPayload`), rejecting a *received* payload carrying
  `index <sha>..<sha>`, `mode`, `similarity index`, or rename-metadata lines. That disposition is not
  duplicated here.
- `build.ts`'s share of P2 is the *producer* half: never emit those lines in the first place. This is
  satisfied by construction, not by dedicated code — `makePatch` (`patch.ts`) reaches jsdiff's
  `structuredPatch`/`formatPatch`, and jsdiff never emits an `index`/`mode`/`similarity index` line at
  all (only `git diff`'s own default output does, which is why P2's own text calls out `--no-index`
  specifically as *not* suppressing it — that clause is about the `git` producer path, not jsdiff's).

E4 and P1/P3/P4, by contrast, are genuinely unfalsifiable on receipt (§5.2's own text for each) and
have no other owner — `build.ts` is their sole enforcement point, exactly as the plan's table intends.

### 2.3 E4 — variable-length fences

```ts
export function fenceLength(payload: string): number   // max(3, N+1)
export function fencePatchPayload(payload: string, info = 'diff'): string
```

`fenceLength` scans the *entire* payload string for the longest run of consecutive backticks,
regardless of line position — E4's own wording ("anywhere inside the payload bytes") rather than a
line-anchored scan matching only a bare closing-fence-shaped line. The wider scan is strictly
conservative: a longer computed fence than the minimum CommonMark's closing-fence grammar would
strictly require is never wrong, only occasionally larger than necessary, and computing the minimum
correctly would require re-deriving CommonMark's own closing-fence matching (leading whitespace
≤3, fence chars, then only trailing whitespace) inside this module — a second implementation of logic
`validate.ts`'s `findFencedBlocks` already owns for the consumer side. `payload` here always ends in
`\n` (verified against `diff@9.0.0`: every `makePatch` output, including the zero-hunk no-op case, is
LF-terminated), so `fencePatchPayload` never needs to insert a separating newline before the closing
fence — that is a fact about jsdiff's output, not a case this function has to handle defensively.

`fencePatchPayload` is exported on its own, separate from `buildPatch`, because it is the actual
"known gap to fix" the task named — a caller with an already-produced unified diff (from `git`, from
a different tool) needs correct fencing without being forced through `makePatch`/jsdiff.

### 2.4 P1, P3, P4 — producer obligations

**P1 (context lines)** is satisfied transitively: `buildPatch` calls `makePatch(before, after,
context)`, defaulted to `3`, and `patch.ts`'s own doc comment already states its default `context: 3`
is P1's enforcement point. `build.ts` does not re-derive this; the `context` parameter exists only
because `patch.ts` itself exposes one (for testing zero-context shapes), with the same "leave the
default alone" caveat repeated here.

**P3 (UTF-8, LF)** is satisfied because `makePatch`'s output is a JS string containing only `\n`
(never `\r\n`) — jsdiff does not introduce CRLF, and JSON serialisation of the resulting
`UnsignedEvent.content` is UTF-8 by construction (every JS string is). Nothing here could introduce
CRLF unless a caller's own `before`/`after` content already contained it, which is the caller's data,
not this module's to launder — PB-1 (§5.1) forbids normalising `content` at all, so `build.ts`
correctly does not attempt to.

**P4 (pre-publish self-verification)** is the one rule in this table with a genuine failure mode:
`patch-property.test.ts`'s own framing ("a patch whose context is ambiguous in `a`... halting is a
completely normal, frequent outcome over repeat-heavy content") establishes that `makePatch(before,
after)` can legitimately produce a payload that **does not re-apply** to `before` via the T1
determinism gate, when `before` contains repeated lines that make the hunk's context non-unique. This
is not a `patch.ts` bug — Phase 2's own gate already accepts this outcome — but it means a caller of
`buildPatch` cannot assume the template they are about to sign is self-consistent, which is exactly
what P4 asks a producer to check before publishing.

`buildPatch` therefore performs the self-check `build.ts` is positioned to make structural: after
assembling `template.content`, it runs `applyPatchContent(before, template.content)` (the same
fence-lookup-then-apply path a real consumer uses) and compares the result against `after`. On
success, `issues` is empty. On a halt, a limit, or an `applied`/`noop` result whose content disagrees
with `after`, `buildPatch` attaches `issue('P4', 'warning', …)` — `warning`, never `error`, since P4
is A-layer and TR-1 forbids an A/D rule rejecting a V-valid event; the template is still returned, so
a caller that wants to publish anyway (accepting the risk P4 only asks them to be *aware* of) still
can. This is also what makes P4 the one rule in `build.ts`'s partition with a real, test-observable
emission — see §5.

---

## 3. What `build.ts` does not attempt

- **No prose.** `template.content` for a Patch is exactly the fenced payload block; a caller wanting
  administrative prose alongside a diff (§4.4's "Update firmware revision..." example) prepends it to
  `template.content` themselves — string concatenation, not a feature this module needs to own.
- **No prose-only/no-op-only patch builder.** A patch with no diff at all is just `{kind: 1,
  created_at, tags: root+reply e-tags, content: <anything>}` — indistinguishable in shape from a
  Product/Metadata template's tag assembly, and not worth a dedicated function.
- **No endpoint-typing check for `buildBinding`** (BD-3/BD-4) — this module has no `EventStorage`
  access and cannot look up what an id resolves to; that check is `admit`/`store`'s job on receipt,
  not a producer-side concern this module could even attempt.

---

## 4. Rule-coverage working expectations

Stated before code exists, as `RESOLVE.md` §9, `ADMIT.md` §10, and `STORE.md` §8 did.

| rule | module | expected disposition |
|---|---|---|
| DQ-1 | query | not-covered — enforced structurally (every discovery filter but the kind-5 lookup includes `#t`); no rejection disposition exists to emit. |
| DQ-2 | query | not-covered — `deletionsFor` builds the recommended filter shape; the SHOULD-poll-periodically half is a caller's scheduling discipline, not a predicate. |
| DQ-3 | query | not-covered — filter-building half is structural; result-verification half is explicitly out of this module's scope (§1.4). |
| DQ-4 | query | not-covered — `classifyByRole` is a pure classifier with no failure mode: every event either has a matching marked `e` tag (included) or does not (excluded). Nothing to reject. |
| BD-8 | query | not-covered — this module can enable the discipline (relay-agnostic filters) but cannot enforce a caller's own fallback logic (§1.4). |
| E4 | build | not-covered — a computation (`fenceLength`), not a predicate with a rejection disposition; its own property test (§5, BG2) is the coverage. |
| P1 | build | not-covered — satisfied transitively via `patch.ts`'s own default; nothing here to assert beyond "the option threads through," which is a regression test, not a rule-code emission. |
| P2 | build | not-covered by this module — the emittable half belongs to `validate.ts` (§2.2); `build.ts`'s half is satisfied by construction (jsdiff never emits the forbidden lines) and has nothing to emit. |
| P3 | build | not-covered — no code path here can introduce CRLF; there is nothing to check that isn't already guaranteed by jsdiff's own output and JS string semantics. |
| **P4** | build | **emitted** — the one real disposition in this table. `buildPatch`'s self-check attaches `issue('P4', 'warning', …)` when `applyPatchContent(before, template.content)` disagrees with `after`. |

One emitting rule, nine not-covered. Neither table is all-D-layer (`build`'s is four A-layer rules
plus one V-layer half it does not itself own), so — unlike `query`'s all-D partition, which
`_coverage.ts`'s `itReportsTheSplit` accepts unconditionally — `build`'s partition needs at least one
real emission to pass that same check, and P4 is it.

---

## 5. The gate

**BQ-1 — Discovery/traversal filters match the spec's own worked examples.** For each of §8.1's four
steps and §8.2's three traversal queries, the builder's output is asserted deep-equal to the literal
JSON the spec text shows (substituting a fixture id/indexer for the spec's illustrative one). This is
the closest available substitute for a vendored vector file: the spec's prose examples *are* the
conformance corpus here, just not machine-readable ones.

**BQ-2 — `classifyByRole` round-trips against real tag shapes.** Given a mixed batch of Bindings (some
naming the anchor as `root`, some as `link`, some not referencing the anchor at all) and Patches
(naming it as `root` or `reply`), `classifyByRole` returns exactly the subset that names the anchor,
each tagged with its actual marker — and, filtered by `expectedType`, excludes the other type
entirely.

**BQ-3 — E4 fence-length property.** For payloads generated to contain a backtick run of length `k`
(0 ≤ k ≤ 6, biased toward the boundary at k=2/3/4), `fenceLength` returns exactly `max(3, k + 1)`, and
re-scanning the fenced result with `validate.ts`'s own `findFencedBlocks` recovers a payload
byte-identical to the input — i.e., the fence this module writes is provably not prematurely closed
by the embedded run, checked against the actual consumer-side parser rather than trusted by
inspection.

**BQ-4 — P4 self-check, both branches.** `buildPatch` over an ordinary `(before, after)` pair with no
repeated-line ambiguity returns `issues: []`. `buildPatch` over a `before` engineered to make the
resulting hunk's context non-unique (the same shape `patch-property.test.ts`'s `repeatyContent`
generator biases toward) returns a `P4` warning — built directly, not sampled, so the case is
guaranteed to land rather than hoped for.

**BQ-5 — round-trip through the full assembly.** For a `fast-check`-generated `(before, after)` pair,
`buildPatch(...).template.content` fed through `applyPatchContent(before, ·)` reaches `after` whenever
`buildPatch` reported no P4 issue — the same conditional shape Phase 2's own property test uses
("applied ⟹ content === b"), because an unconditional round-trip claim would be false exactly where
BQ-4's second case lives.

**BQ-6 — rule-coverage partition**, per §4, reusing `test/_coverage.ts` with `test/_a-query-coverage.ts`
and `test/_a-build-coverage.ts`.

Every counterexample becomes a permanent regression case, as every prior phase's has.

---

## 6. Open questions and regression cases

None yet — this section grows the way `RESOLVE.md` §4/§9, `ADMIT.md` §9/§10, and `STORE.md` §10 did,
if the gate items above surface something while being implemented.
