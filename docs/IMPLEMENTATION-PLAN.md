# Implementation plan — `@scrutiny-fabric/core` v0.1

Target spec: **v0.6.1** (`scrutiny-v061`, bumped from v0.6.0 — see the Status section's corrective-pass
entry). Rationale for every decision here lives in
[`DECISIONS-2026-07-27.md`](DECISIONS-2026-07-27.md) — this document is the *what and in what order*,
not the *why*. Do not relitigate a decision without reading its D-entry first.

Supersedes the previous `IMPLEMENTATION-PLAN.md` (targeted spec v0.5.3, never committed).

---

## Status

| Phase | Work | State |
|---|---|---|
| — | Spec amended to v0.6.0 | ✅ **done** 2026-07-27 — spec repo `b44dbf1`, **134 rules** (V=47 A=55 D=31 +1 reserved), validator clean |
| — | Spec amended to v0.6.1: Appendix G (conformance vectors) lands | ✅ **done** 2026-07-29 — spec repo, **139 rules** (V=44 A=63 D=31 +1 reserved). See the corrective-pass note below |
| — | Corrective pass: re-target v0.6.1, fix what the new vectors found | ✅ **done** 2026-07-30 — branch `fix/spec-v061-drift`. See below |
| 0 | Monorepo scaffold | ✅ **done** — `pnpm verify` green; build emits ESM + `.d.ts`, exports ATTW-clean |
| 1 | `events`, `validate`, `id` | ✅ **done** — 131 tests; 25/44 V rules emit a code (post-retag), 19 declared not-covered with reasons in `test/_v-coverage.ts` |
| 2 | `patch` — the T1/T2/T3 matcher | ✅ **done** — 209 tests; gate green over 10k round-trip and 5k zero-context cases. Mini-spec in [`PATCH-MATCHER.md`](PATCH-MATCHER.md). Found SPEC-FEEDBACK F5–F9 and correction C1 to D31. F5's multi-file-section reading was codified as C8 in v0.6.1 with no code change needed |
| 3 | `resolve` — chain + overlays | ✅ **done** — 285 tests; G1 green over 10k permutations, G2 over 4k, 3/32 rules emit a code and 29 declared not-covered. Mini-spec in [`RESOLVE.md`](RESOLVE.md). Found SPEC-FEEDBACK F10–F11, both codified in v0.6.1 as SF-7 and OV-9/RL-5 with no code change needed. RC-5 (also new in v0.6.1) found a real bug — see below |
| 4 | `admit` | ✅ **done** — 328 tests repo-wide (40 admit-specific); AG1 green over 10k prefix-checked sequences, AG2 over 10k apply-then-invert round-trips, AG3's 0/9 rules emit a code and 9 declared not-covered (all D-layer, no rejection disposition exists to emit), AG4's floors now hold for every named bias shape. Mini-spec in [`ADMIT.md`](ADMIT.md). AG2's property test found and fixed a real invertibility gap in the design before any code shipped against it. A post-merge `/code-review` pass found two more gaps: one AG4 bias shape named in the mini-spec's own text was unreachable by construction (self-fork siblings share a pubkey, so they can never diverge on direct trust — corrected in `ADMIT.md` §10), and two of AG4's floors had never actually been asserted (revoke-after-redundant-observe, outcome-mix logging) — both now hold, the two hardest-to-reach shapes via dedicated generators since the uniform one scored 0 and a flaky 5–13 per 3,000 runs |
| 5 | `store` — reducer + ports + epochs | ✅ **done** — 436 tests repo-wide (33 store-specific: 13 in `store.test.ts`, 6 in `store-property.test.ts`, 14 in `a-store-coverage.test.ts`); SG1 green over 2k permutations (both per-event and batched) plus a per-root `resolveRoot` cross-check, SG2's reference-equality regression holds, SG3's two-relay race resolved in both orders, SG4's 2/12 rules emit a code (BD-7, SIG-1 enforcement) and 10 declared not-covered, SG5's floors hold for every named bias shape. Mini-spec in [`STORE.md`](STORE.md). Found and fixed two real design gaps before/while writing the gate: `chainEpoch`'s bump count is arrival-order-dependent by construction, so SG1 compares a `StoreView` projection instead of raw `StoreState` (STORE.md §3/§10); and `applyStoreDelta`'s idempotent dedup is correctly order-dependent for two distinct objects sharing an id, so every property fold simulates the verify gate first rather than calling the reducer directly on ungated input (STORE.md §10) |
| 6 | `query`, `build` | not started |
| 7 | Coverage tooling, adapters, docs | not started |

The spec amendment is complete and `tools/rules.json` regenerated against v0.6.1 (was v0.6.0).
`SPEC-AMENDMENT-BRIEF.md` is spent and can be deleted.

**Corrective pass, 2026-07-30 (`fix/spec-v061-drift`), found before Phase 5 started.** The spec repo
had moved to v0.6.1 since Phase 4 shipped — the exact protocol-drift failure mode D1/D45 exist to
prevent, caught here only because Phase 5's own kickoff re-reads the spec repo fresh. Fixed:

- `SPEC_VERSION`/`VERSION_TAG` bumped `0.6.0`/`scrutiny-v060` → `0.6.1`/`scrutiny-v061`; `rules.json`
  regenerated (134 → 139 rules: new SF-7, OV-9, RL-5, C8, RC-5; P1/E4/P3 retagged V → A).
- **A real bug, found only once Appendix G's vectors existed to catch it**: `ChainState.tipId` used
  `null` as a sentinel for "the root is the tip." RC-5 (new in v0.6.1) and the vendored
  `chain/root-only`/`chain/foreign-patch-never-enters-the-chain` vectors both require `tipId` to be
  the root's own concrete id instead — the type was widened from `string | null` to `string`
  everywhere except `forked` (which still has no `tipId` field at all, per SF-1). The bug this
  produced was real: an overlay anchored to a never-patched root compared its target id against
  `null` and always lost, misclassifying `stale` instead of `clean` — the *first* annotation
  published against any new Product. See `RESOLVE.md` §8's correction note.
- `validate.ts`'s P3 (lone-surrogate UTF-8 check) was emitting `error` — a V-layer rejection — for a
  rule the v0.6.1 retag moved to the A layer. That is a live **TR-1** violation (an A rule rejecting
  a V-valid event) that the project's own `invariants.test.ts` caught the moment `rules.ts` was
  regenerated, before any manual review. Downgraded to `warning`.
- C8 (multiple `file-section`s per payload) turned out to already be correctly implemented and
  tested under the pre-existing `SPEC-FEEDBACK F5` label — registered as covered, no code change.
- Vendored `vectors/application.json` (46 cases) and `vectors/validity.json` (19 cases) at their
  Appendix G.1 digests, with a checksum gate (`vectors-checksum.test.ts`) and three real per-case
  runners (`validate-vectors.test.ts`, the `apply`-kind cases in `patch.test.ts`,
  `resolve-vectors.test.ts` for `chain`-kind cases) rather than the loader's previous parse-only
  smoke test. `resolve-vectors.test.ts` also runs G.3's confluence requirement — every permutation
  of a case's `events`, not just the given order. All 65 vendored cases pass after the RC-5/P3
  fixes above; two apparent runner failures during development turned out to be bugs in the runner
  itself (a double-wrapped `options.apply`, and a misreading of `annotations`/`noAnnotations` as
  literal issue codes rather than the one rule ID that headlines each annotation *kind*), not the
  implementation — corrected before landing.
- `discovery.json` and `serialization.json` remain reserved and unpublished (per Appendix G.1) —
  Phase 5's own substitute gate (below) still applies for D-layer rules.

Every phase's rule/test counts above are updated to match. **Phase 5 starts from here, on top of a
conformant v0.6.1 base**, rather than assuming v0.6.0 as originally scoped.

Scaffolding (Phase 0) can proceed in parallel with the above.

## Scope

**v0.1 publishes exactly one package: `@scrutiny-fabric/core`.**

Deferred to v0.2+: `@scrutiny-fabric/cli`, `@scrutiny-fabric/mcp`. Possibly never:
`@scrutiny-fabric/artifacts` (D7 — build only when a real consumer needs it).
Never published: relay adapters (D6 — they ship as `examples/adapters/`).

---

## Package layout

```
scrutiny-fabric-tools/            ← consider renaming (open question 2 in DECISIONS)
├── packages/core/
│   ├── src/
│   │   ├── index.ts              root barrel — the primary documented import
│   │   ├── events.ts             parse / narrow / tag accessors / i-k parsing
│   │   ├── validate.ts           per-event-type validity
│   │   ├── id.ts                 serializeForId + eventIdMatches (hash injected)
│   │   ├── patch.ts              INTERNAL — not exported (D32)
│   │   ├── resolve.ts            canonical chain + overlay classification
│   │   ├── admit.ts              admission reason sets
│   │   ├── query.ts              filter builders + result post-filters
│   │   ├── build.ts              unsigned event templates
│   │   ├── store.ts              reducer + ports + epochs
│   │   ├── rules.ts              GENERATED from Appendix F — do not hand-edit
│   │   ├── interfaces.ts         the four extension points
│   │   └── errors.ts             Issue type
│   ├── vectors/                  VENDORED from the spec repo at a pinned checksum
│   └── test/
├── examples/adapters/            nostr-tools · ndk · applesauce · nostrify (CI-tested)
├── tools/                        rules.ts generator · coverage report · checksum gate
└── docs/                         this file, DECISIONS, generated COVERAGE.md
```

**`exports` map.** Root barrel first; subpaths are an optimisation for consumers who want graph
exclusion (D5). ESM-only, `"sideEffects": false`, extension-ful specifiers, **no dynamic imports
anywhere** (D9).

```
"."             → ./dist/index.js
"./events.js"   "./validate.js"  "./id.js"     "./resolve.js"
"./admit.js"    "./query.js"     "./build.js"  "./store.js"   "./rules.js"
```

`patch.js` is deliberately absent from `exports`.

**Dependencies.** Runtime: `diff` (jsdiff v9) only, reached solely through the applier port (D11,
D31). Zero runtime dependencies is the declared goal. `core` imports no crypto and handles no key
(D12).

---

## The extension surface

Four interfaces. That is the entire pluggability story — everything else is a pure function or the
reducer.

```ts
export const transportSymbol = Symbol.for('@scrutiny-fabric/transport')
export const storageSymbol   = Symbol.for('@scrutiny-fabric/storage')
export const signerSymbol    = Symbol.for('@scrutiny-fabric/signer')
export const trustSymbol     = Symbol.for('@scrutiny-fabric/trust')
```

`Symbol.for` uses a global registry, so two copies of `core` in one dependency tree still interoperate
— the structural fix for NDK #312 (D16).

| Interface | Shape | Supplied by |
|---|---|---|
| `RelayTransport` | `request(relays, filters) → AsyncIterable<Event>` · `publish` · `count` | `examples/adapters/*` |
| `EventStorage` | `put(events)` · `query(filters, {includeDeleted})` · `get(ids)` | in-memory default; app supplies IndexedDB / SQLite |
| `ScrutinySigner` | `getPublicKey()` · `signEvent(template)` — the NIP-07 shape, so `window.nostr` satisfies it unchanged | app (NIP-07 / NIP-46); CLI for raw keys |
| `TrustProvider` | `isTrusted(pk): boolean` **synchronous** · `version: number` · `deltaSince(v)` | app |

All four are listed in DECISIONS D16 and D21.

Also required at store construction, and not defaulted (D18):

```ts
verify: (event: NostrEvent) => boolean   // MUST cover signature AND id recompute
```

---

## Modules, and which rules each owns

Rule IDs are from Appendix F. These assignments drive the generated coverage report (D34).

| Module | Owns | Notes |
|---|---|---|
| `events` | TAG-1…5, VER-1…4, IR-1…4, PR-4/5, MD-4/5 | §9 prefix registry is **open data, not an enum** (IR-4). **Never filter by version tag in a relay query** — the dead engine did, silently violating VER-4 |
| `validate` | TAG-1…5, VER-1…4, PR-1…5, MD-1…5, BD-1…7/10/12, PT-1…4/7, E1…E6, C1…C4, **C7**, P2, P3, IR-1…4 | Pure, one event in, `Issue[]` out. Endpoint typing (BD-3/4/5) and PT-7 lineage need the observed set → returns *pending*, resolved by `store` per §7.6. **C7 added** — it was dropped in transcription from §6.0's V manifest, which cites it explicitly. **P1 removed** — unsatisfiable at validation time; see `SPEC-FEEDBACK-v0.6.0.md` F1 |
| `id` | SIG-1 (recompute half) | `serializeForId` delegates to `JSON.stringify` per R11. Hash injected — no crypto in core |
| `patch` **(internal)** | T1, T2, T3, H1, N1…N3, C5, C6, PB-1/2, E7, C8 | **T1/T2/T3 is hand-written and non-injectable** (D30). No stock applier does the exactly-once check. Normalise jsdiff's two failure channels: returns `false` on context mismatch, *throws* on truncated/swapped hunks. C8 (new in spec v0.6.1) was already satisfied — jsdiff already splits a multi-header payload into per-file hunks and this module already sequences them all under T3 (SPEC-FEEDBACK F5) |
| `resolve` | CHN-1…3, RC-1/2/5, SF-1…7, H1/H2, OV-2/3/4/6/8/9, DEL-1/2/3/6/7, PT-5/6/8/9, IX-3, BD-9, RL-5 | **Reads no trust state** (D25). `ChainState.forked` has **no `tipId`** — makes SF-4 unrepresentable. RC-5, SF-7, OV-9, RL-5 are new in spec v0.6.1; SF-7 and OV-9/RL-5 codify design calls this module already made (SPEC-FEEDBACK F10/F11) and needed no code change. RC-5 exposed a real bug — see fix/spec-v061-drift |
| `admit` | TR-2…7, OV-7, DEL-4/5 | Refcounted reason sets. `direct-trust` = Set bit; `binding` = counter guarded by `liveBindings` (D23) |
| `query` | DQ-1…4, BD-8 | Returns plain NIP-01 filter objects; no transport dependency |
| `build` | E4 (fence length `max(3, N+1)`), P1…P4 | Emits `{kind, created_at, tags, content}` — **no `id`, `pubkey`, `sig`** (D13). Sole enforcement point for P1 and E4, both of which are unfalsifiable on receipt |
| `store` | UR-1…3, RC-3/4, BD-6/7, DEL-8/9, RL-2/3, SIG-1 (enforcement) | Reducer + `StorageAdapter` port, **not a class** (D15). Three epochs (D24) |

Not owned by any module, by design: IM-1…IM-5 (deferred with `artifacts`, D7), IX-1/2/4 and RL-1
(producer guidance), DEL-10/11 (client and relay behaviour).

---

## Build order

### Phase 0 — scaffold

pnpm workspace · `tsconfig` (strict, ES2022, `moduleResolution: node16`) · Biome · changesets with a
`linked` group (D8) · CI on Node 22, ubuntu + windows, PR-only to main. `package.json` with the
`exports` map, `"type": "module"`, `"sideEffects": false`.

Gate: `pnpm build` emits clean ESM + `.d.ts`; the `exports` map is ATTW-clean.

### Phase 1 — `events`, `validate`, `id`

Pure, no dependencies, mostly mechanical. Vendored `validity.json` and `serialization.json` vectors
should pass at the end of this phase.

Gate: every V-layer rule either emits its code in a test or is listed as not-test-covered with a
reason.

### Phase 2 — `patch`

**The highest-risk module in the project.** Write its own mini-spec before coding: how candidate
positions are enumerated, how uniqueness is proven, how T2's pure-insertion carve-out is detected,
how T3 sequences hunks against post-prior-hunk content.

Gate: the property test `applyPatch(a, makePatch(a, b)) === b` survives ≥10k generated cases with
`fast-check`, including repeated-line content (the case that breaks T1 and that hand-written tests
rarely produce). Every counterexample found becomes a permanent vector.

Second gate item, carried over from Phase 1: a **grammar-conformance property test for C7**. C7
obliges a consumer to accept *any* payload matching §5.2's grammar, and Phase 1 covers it with
fixtures for the shapes that were thought of — which is not the same claim. Build a `fast-check`
arbitrary that emits from the grammar productions (optional `Index:` preamble, optional
`diff --git` line, header block, 0..N hunks, arbitrary trailing data) and assert `validateEvent`
returns no `error`-severity issue for any of them. Seed it with the two shapes most likely to be
wrongly rejected: the N2 header-only block, and the zero-context hunk. Note that the grammar cannot
be implemented literally — see `SPEC-FEEDBACK-v0.6.0.md` F3.

### Phase 3 — `resolve`

Chain construction, kind-5 cascade, HALT, self-fork freeze, overlay classification. Trust-blind.
Lazy per-position content under a byte-bounded LRU (D28).

Write a mini-spec before coding, as Phase 2 did: how the canonical chain is walked, how a kind-5
cascade re-parents or truncates it, where a HALT freezes it, how a self-fork is detected, and how
overlays are classified against a chain that may itself be frozen.

#### Gate

`application.json` does not exist — §11 still lists test vectors as future work and there is no
Appendix G, so the gate as originally written cannot be run. The corpus is not abandoned: the loader
in `test/_vectors.ts` already reads `packages/core/vectors/*.json` and skips cleanly when the
directory is absent, so vectors are **added on top of** the four items below when they land, not
substituted back in for them.

**G1 — Confluence (UR-1).** `resolve` is a pure function of an event *set*, so permuting its input
must change nothing:

```
∀ permutations π of an event set E:  resolve(π(E)) ≡ resolve(E)      deep equality
```

≥10 000 `fast-check` cases. This is not the tautology it looks like: it fails whenever arrival order
leaks into the result — a tie broken by insertion position, `Map`/`Set` iteration order reaching the
output, an accumulator whose fold is not commutative, or a pending patch (UR-2) that is retained but
never re-evaluated when its root arrives. The plan's own note says this property "would have caught
the pending-patch gap without anyone reading §5.3 closely"; that gap is an ordering leak of exactly
this shape.

**G2 — Branch choice is not a heuristic (SF-4).** G1 is necessary and *not sufficient*, and this is
the trap worth naming: an implementation that sorts two competing root-author patches by
`(created_at, id)` and takes the first is perfectly confluent and squarely violates SF-4, which
forbids picking a branch by `created_at`, by event ID, or by any heuristic. G1 cannot see that bug,
because such an implementation is deterministic.

So the second property is differential rather than invariant. Build a self-fork — two root-author
patches sharing one `e reply` parent — then permute the attributes a heuristic would reach for, and
assert the verdict never moves:

```
∀ self-forks F, ∀ swaps s ∈ {created_at, id, tag order, pubkey-hex ordering}:
    resolve(s(F)).status === 'forked'   and   resolve(s(F)) ≡ resolve(F)
```

A tie-breaking implementation returns a different chain as the swapped attribute flips sides. A
conforming one returns the same frozen state every time.

**G3 — A forked chain exposes no tip (SF-1).** `ChainState.forked` carries no `tipId`, so "read the
tip of a forked chain" is unrepresentable rather than merely wrong. Assert it structurally
(`expect(state).not.toHaveProperty('tipId')`, the same shape as the Phase 2 atomicity assertion)
rather than trusting the type alone, since the type vanishes at runtime.

**G4 — Rule-coverage partition.** Same discipline and same machinery as Phases 1 and 2 (D34): every
rule the module-ownership table assigns to `resolve` — CHN-1…3, RC-1/2, SF-1…6, H1/H2,
OV-2/3/4/6/8, DEL-1/2/3/6/7, PT-5/6/8/9, IX-3, BD-9 — either **emits its code** in a test, or is
listed as not-test-covered **with a written reason**. Reuse `test/_coverage.ts`; the table is a new
`test/_a-resolve-coverage.ts`. This is what made Phases 1 and 2 defensible without a corpus, and it
is the item that keeps a rule from being silently skipped.

**Generator design carries the gate.** Phase 2's lesson was that the property is only as good as its
bias — the round trip nominally covered T1 while barely reaching its rejecting branch, which is why
a zero-context generator with a floor assertion had to be added. The analogue here is to bias hard
toward the shapes where ordering can matter and then *assert the rates*, so the branch cannot
silently stop being exercised: `created_at` ties, kind-5 deletions arriving before their targets,
patches whose `e root` or `e reply` is not yet present, self-forks, overlay-on-overlay replies, and
chains already frozen by a HALT. Log the outcome mix as Phase 2 does and put a floor under the
interesting outcomes.

**Every counterexample becomes a permanent regression case**, shaped to convert verbatim into a
conformance vector, exactly as `test/patch-regressions.ts` is.

One property is deliberately *not* here: "adding an event never un-halts a frozen chain." It sounds
right and it interacts with UR-2's re-evaluation of pending patches in a way §5.3 does not obviously
settle. Decide it against the spec text during the mini-spec, then either assert it or record why
not — do not assume it.

### Phase 4 — `admit`

Reason sets, refcounting, `TrustedView` / `OpenView` (D22).

`discovery.json` does not exist, for the same reason `application.json` didn't at Phase 3 — see
that phase's note. Substitute gate, defined in [`ADMIT.md`](ADMIT.md) §10 in the same spirit:

- **AG1 — incremental admission ≡ full recompute, for every trust set**, checked after every
  prefix of a delta sequence rather than only at the end, since D23's sticky-admission bug only
  appears after a revocation *following* a redundant re-application.
- **AG2 — apply-then-invert any delta sequence ≡ exact initial state.** Found a real design gap
  before any code shipped against it: the original `ForwardDelta` also included `untrust`, and a
  standalone `untrust(pk)` for a never-trusted `pk` is a legitimate no-op whose syntactic inverse
  (`trust(pk)`) is not — `ForwardDelta` was narrowed to `observe | trust` in response (§9).
- **AG3 — a rule-coverage partition** over admit's rules (TR-2…7, OV-7, DEL-4, DEL-5), reusing
  `test/_coverage.ts`. All nine land in `not-covered`: no rule this module owns has a rejection or
  annotation disposition to emit (§6.0 — D rules are not admission criteria for the event itself).
- **AG4 — generator bias and floors** over the hard shapes: a Binding observed before either
  endpoint (BD-6), the same delta redelivered adjacently and non-adjacently, retrust churn, and
  multi-reason overlap.

Gate: green over 10k AG1 sequences and 10k AG2 sequences. AG1 passed clean on the first
implementation attempt; AG2 found the `ForwardDelta` gap above and a second bug — `unobserve` was
stripping only `direct-trust` from a removed root-chain *member*, leaving a stranded
`root-chain:*` reason nothing would ever revisit — both fixed, the second pinned as a permanent
regression case in `test/admit-property.test.ts`.

### Phase 5 — `store`

Reducer, pending-reference buffer (§3.3), deletion cache, the three epochs (D24), verification
enforcement, dedup-after-verification (D20), in-memory `StorageAdapter` — a port, never a class (D15).

Write a mini-spec before coding, as Phases 2–4 did: `STORE.md`. It needs to settle, before any code
exists, how the pending-reference buffer's lifecycle interacts with `resolve`'s and `admit`'s own
confluence guarantees (a patch or Binding endpoint arriving out of order must not force either module
to be re-run from scratch), how the three epochs are invalidated independently without ever letting a
`trustEpoch` bump touch `applyPatch`, and how DEL-8/DEL-9's deletion cache interacts with BD-7's
rejection cache — both are monotone, but for different reasons, and conflating their invalidation is
the shape of bug D23's refcounting already produced twice.

#### Gate

`store.json` (or whatever this layer's eventual vector file is named) does not exist, for the same
reason `discovery.json` didn't at Phase 4 — see that phase's note, now four phases deep. Substitute
gate, to be defined in `STORE.md` in the same spirit as `ADMIT.md` §10:

- **SG1 — confluence, store-level (UR-1).** The permutation property named in the Testing Strategy
  section below, at the level `store` actually ships it: any permutation of an event set, ingested
  through `store`'s public `add`, reaches identical state. Phase 3 gated this at the `resolve` level
  and Phase 4 effectively re-proves it for `admit`'s own state (AG1); this is the version that matters
  for real consumers, since nothing outside this module calls `resolve` or `admit` directly.
- **SG2 — epoch cost (D24).** A regression test asserts a `trustEpoch` change performs **zero**
  `applyPatch` calls — carried over from this section's previous form, promoted to a numbered gate
  item so it gets the same "assert the rate, not just the behaviour" discipline as AG4's floors rather
  than living as one unstructured regression test.
- **SG3 — dedup-after-verification is not bypassable (D20).** A malicious relay pre-registering a
  genuine event's declared id before an honest relay delivers the verified copy must not suppress the
  authentic copy. Build the two-relay race directly rather than trusting the ordering guard by
  inspection — this is exactly the censorship primitive D20 exists to prevent.
- **SG4 — rule-coverage partition.** Same discipline as G4/AG3 (D34), reusing `test/_coverage.ts` for
  `store`'s owned rules: UR-1…3, RC-3/4, BD-6/7, DEL-8/9, RL-2/3, SIG-1 (enforcement half). Unlike
  `admit`'s all-`not-covered` partition, several of these (SIG-1 enforcement, RL-2/3) do have a
  rejection disposition to emit — state the working expectation in `STORE.md` before code exists,
  exactly as `RESOLVE.md` §9 and `ADMIT.md` §10 did.
- **SG5 — generator bias and floors.** Bias toward: a Binding's endpoints delivered non-adjacently
  across two separate `add` calls (BD-6, now crossing a real module boundary rather than one
  `applyDelta`), a `trustEpoch` bump immediately followed by an `observedEpoch`-invalidating event in
  the same tick, and the two-relay dedup race from SG3. Log the outcome mix and assert a floor under
  each, as every prior phase's G4/AG4 has.

Every counterexample becomes a permanent regression case, as every prior phase's has.

### Phase 6 — `query`, `build`

Filter builders for §8.1's degradation ladder and §8.2's traversals; template builders with correct
fence-length computation.

### Phase 7 — coverage, adapters, docs

`tools/` generates `rules.ts` from Appendix F, emits `coverage.json` + `COVERAGE.md`, and gates the
vendored-vector checksum. Four adapters in `examples/adapters/`, each CI-tested against a mock relay.
README plus executable doc examples.

---

## Testing strategy

Three layers, and the middle one is where the real defect-finding happens.

**1. Conformance vectors** — vendored from the spec repo at a pinned checksum. CI fails if the
checksum drifts (D33).

**2. Property tests** — four, named because each targets a specific known failure mode:

```
applyPatch(a, makePatch(a, b)) === b
    → the diff matcher. Generates repeated-line content, which breaks T1.

any permutation of an event set → identical store state
    → confluence (UR-1: "state depends on the observed set, never on
      arrival order"). UR-2's retain-and-re-evaluate is the mechanism
      that makes it achievable, not the property itself. Would have
      caught the pending-patch gap without anyone reading §5.3 closely.
      Phase 3 gates a resolve-level form of this, plus SF-4, which
      confluence alone cannot see — see that phase's gate.

incremental admission index ≡ full recompute, for every trust set
    → the refcount bugs in D23, including sticky-admission-after-revocation.

apply-then-invert any delta sequence → exact initial state
    → double-apply and duplicate-endpoint decrement bugs.
```

**3. Oracle comparison** — every incremental path must agree with a from-scratch pure recompute over
the vector corpus (D29). This is the only real defence against admission-index drift.

**Coverage is measured by observed rule-code emission, not annotations** (D34). Three buckets:
emitted during tests · declared by a vector's `rule` field · not test-covered, listed with a reason.
CI fails if code cites a rule ID absent from the spec.

---

## Explicitly out of scope for v0.1

CLI · MCP server · `artifacts` (imeta fetching) · published relay adapters · relay selection and the
outbox model (app-level; welshman has an open "Re-work router" issue — not our problem to solve) ·
LLM grounding and prompt assembly · graph layout · session persistence schema · NIP-77 Negentropy ·
OpenTimestamps verification · SQLite-WASM storage adapter · TypeDoc HTML · performance budgets (D
declined) · N-hop web-of-trust expansion (the `TrustProvider` interface is the migration path; no
implementation).

---

## Verification

```bash
pnpm -r build              # clean ESM + .d.ts, ATTW-clean exports
pnpm -r exec tsc --noEmit  # types
pnpm biome check .         # lint + format
pnpm -r test               # unit + vectors + property tests
pnpm coverage:rules        # regenerate COVERAGE.md; fails on rule-ID drift
pnpm vectors:verify        # vendored checksum matches the spec repo's pinned digest
```

## Working conventions

Branches `feature/…`, `fix/…`, `chore/…`. Conventional commits. Never push directly to main; always a
PR. Never commit `.env`, `*.nsec`, `*.key`. `investigations/` stays gitignored **except** the
`REPORT.md` files, which the spec's Appendix E cites by path.

## Known hazards, carried forward

1. **`artifacts` is the weakest unit.** If only one app ever needs it, it stays app-level.
2. **`store`'s public API must not be a class.** Ship reducer + port from the first release; swapping
   later is a breaking change to the most-used entry point (D15).
3. **D23's refcounting is only sound while BD-3/BD-4 hold.** §11 lists Metadata↔Metadata bindings as
   future work. Isolate the reachability step to one ~10-line method and comment the dependency.
4. **All benchmark figures in DECISIONS are synthetic.** Re-measure against the real sec-certs mapping
   before trusting absolutes; the 216 MB eager-materialisation figure was never measured in a browser.
5. **The relay timestamp window is confirmed and will bite the bulk publisher.** Verified against
   `hoytech/strfry/strfry.conf` on 2026-07-27: `rejectEventsOlderThanSeconds = 94608000` (exactly
   three years) and `rejectEventsNewerThanSeconds = 900`. Setting `created_at` to a certificate's
   issue year therefore means **silent rejection of the entire historical corpus** — no error, no
   stored events. `created_at` is publish time; historical dates go in `content` (spec amendment A11).
