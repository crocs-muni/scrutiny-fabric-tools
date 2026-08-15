# Implementation plan — `@scrutiny-fabric/core` v0.1

Target spec: **v0.6.1** (`scrutiny-v061`, bumped from v0.6.0 — see the Status section's corrective-pass
entry). Rationale for every decision here lives in
[`DECISIONS-2026-07-27.md`](DECISIONS-2026-07-27.md) — this document is the *what and in what order*,
not the *why*. Do not relitigate a decision without reading its D-entry first.

Supersedes the previous `IMPLEMENTATION-PLAN.md` (targeted spec v0.5.3, never committed).

**Scope note, added after Phase 6.** Phases 0–8 are v0.1: the protocol implementation plus its own
audit before shipping. Phases 9–12 sketch what comes after — CLI, MCP server, `artifacts`, adapters as
real packages — at the depth a plan-of-record needs, not the depth a mini-spec needs. None of 9–12 has
had its own kickoff read-the-spec-fresh pass yet; treat their paragraphs below as a starting brief for
that pass, not as settled design the way Phases 0–8's are.

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
| 6 | `query`, `build` | ✅ **done** — 478 tests repo-wide (36 Phase-6-specific); BQ-1 matches the spec's own §8.1/§8.2 worked examples literally, BQ-2 round-trips `classifyByRole` against mixed Binding/Patch tag shapes, BQ-3 holds the E4 fence-length property over 2k generated backtick-run cases against the real consumer-side parser, BQ-4/BQ-5 cover both branches of `buildPatch`'s P4 self-check (including a directly-built, not sampled, T1-ambiguous case), BQ-6's partition is `query` 0/5 emitted (all D-layer, same shape as `admit`'s AG3) and `build` 1/5 emitted (P4). Mini-spec in [`QUERY-BUILD.md`](QUERY-BUILD.md). Found and recorded, not fixed as a bug: the plan's own module-ownership table double-lists P2 under both `validate` and `build` — resolved as two halves of one rule (validate's V-layer receipt-side rejection vs. build's producer-side "never emit it," satisfied by construction), not a conflict — see `QUERY-BUILD.md` §2.2 |
| 7 | Coverage tooling, adapters, docs | not started — **blocked twice over** by Phase 8: `RelayTransport` does not exist (`interfaces.ts` declares only `TrustProvider` and `EventStorage`; the transport interface lives solely in the D16 table below), and `EventFilter` must be reshaped to a real NIP-01 filter first, or every adapter inherits a converter and a silently-widening filter. See `AUDIT-2026-07-31.md` §7. Both blockers are now scoped as Phases 13 and 17 below |
| 8 | Deep implementation audit + comparative analysis | ✅ **done** 2026-07-31 — report in [`AUDIT-2026-07-31.md`](AUDIT-2026-07-31.md); 495 tests. **Verdict: v0.1 is not shippable as-is.** Found three correctness defects and a structural hole in the coverage machinery. Fixed here: the T2 carry-forward bug (silent wrong canonical bytes across an EOF-newline change), the registry-closure gap (21 rules were in no coverage table, six of them actively emitted), RL-1/IX-2 producer checks, and load-flaky property gates. Proposed as their own phases: the resolve-memo staleness (P1) and the `EventFilter` reshape (P2), both critical. Corrections C2–C8 appended to DECISIONS |
| 9 | ~~`artifacts` package~~ | ❌ **dropped** 2026-07-31 — see Corrections **C4**. The real sec-certs corpus has median content of 287 bytes and a maximum of 2,088; nothing in it approaches §4.6's ~30 KB `imeta` threshold, so the motivating consumer does not exist. D7's shape decision stays on record. IM-1…IM-4 are declared unowned in `test/_unowned.ts`, which records that **IM-4 is a MUST** — so `core` must never grow *partial* imeta support |
| 10 | `@scrutiny-fabric/cli` | not started — v0.2; first real consumer of `ScrutinySigner` (still undefined) |
| 11 | `@scrutiny-fabric/mcp` | not started — v0.2; no Appendix-A-equivalent sketch exists, needs its own scoping pass before a build brief is possible |
| 12 | Published relay adapters | **contingent** — blocked on a Corrections entry reversing D6; not started, may never start |
| 13 | `EventFilter` → flat NIP-01 shape | not started — v0.1-completion (not v0.2); fixes `AUDIT-2026-07-31.md` P2/P6; must land before Phase 17 |
| 14 | Wire `validateEvent` into `store.add()` | not started — v0.1-completion; fixes P5; mini-spec [`VALIDATION-WIRING.md`](VALIDATION-WIRING.md); must land before Phase 15, not in the same commit |
| 15 | `overlayAwaiting` reducer index (resolve-memo staleness) | not started — v0.1-completion; fixes P1/C5; mini-spec [`OVERLAY-AWAITING.md`](OVERLAY-AWAITING.md); lands after Phase 14 |
| 16 | `Store`'s trust-filtered view (`admissionView`/`viewRoot`) | not started — v0.1-completion; mini-spec [`TRUST-VIEW.md`](TRUST-VIEW.md); sequenced after Phase 14/15 for diff hygiene, no hard dependency |
| 17 | `RelayTransport` interface (D16's fourth interface) | not started — v0.1-completion; mini-spec [`RELAY-TRANSPORT.md`](RELAY-TRANSPORT.md); depends on Phase 13; unblocks Phase 7's adapters |
| 18 | Producer-side context widening (`build.ts`) + `patch-matcher.ts` extraction | not started — v0.1-completion; mini-spec [`CONTEXT-WIDENING.md`](CONTEXT-WIDENING.md); must land before Phase 19 |
| 19 | `buildPatch`'s options object | not started — v0.1-completion; depends on Phase 18 |
| 20 | Public-surface hygiene: `patch-types.ts`, `EndpointRef`/`ETagRef`, `resolveRoot`'s internal collision | not started — v0.1-completion; three independent small items, bundled |
| 21 | Default in-memory `EventStorage`: real indexes | not started — v0.1-completion; depends on Phase 13 (see that phase's own design-correction note) |
| 22 | Reference signer example (`examples/signers/`) | not started — v0.1-completion; independent of every other phase in this range |
| 23 | Module-ownership table codegen | not started — v0.1-completion; extends Phase 7's own coverage tooling, not a second generator |

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

Deferred to v0.2+: `@scrutiny-fabric/cli` (Phase 10), `@scrutiny-fabric/mcp` (Phase 11). Possibly
never: `@scrutiny-fabric/artifacts` (D7 — build only when a real consumer needs it; Phase 9).
Never published, unless D6 is formally reversed: relay adapters (D6 — they ship as
`examples/adapters/`, Phase 7; a real package is Phase 12, contingent).

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
| `RelayTransport` | `request(relays, filters, onEvent, onEose?) → unsubscribe` (callback + explicit unsubscribe, never an async iterator — see Phase 17/[`RELAY-TRANSPORT.md`](RELAY-TRANSPORT.md)) · `publish` · `count` | `examples/adapters/*` |
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
| `build` | E4 (fence length `max(3, N+1)`), P1…P4, **RL-1**, **IX-2** | Emits `{kind, created_at, tags, content}` — **no `id`, `pubkey`, `sig`** (D13). Sole enforcement point for P1 and E4, both of which are unfalsifiable on receipt. **RL-1 and IX-2 added by Phase 8**: three of §5.4's four bounds (tag value ≤1024 B, signed event ≤64 KB, hunks ≤64) and IX-2's 64-`i`-tag ceiling are computable from the template this module assembles, so they are checked here the way P4 already self-checks. §5.4's fourth bound — patches per chain — stays with RL-2/RL-3 on the consumer side |
| `store` | UR-1…3, RC-3/4, BD-6/7, DEL-8/9, RL-2/3, SIG-1 (enforcement) | Reducer + `StorageAdapter` port, **not a class** (D15). Three epochs (D24) |

Not owned by any module, by design: **13 rules, now enumerated with written reasons in
`packages/core/test/_unowned.ts` and machine-checked** — OV-1 (reserved), OTS-1, CA-1, BD-11, OV-5,
DEL-10/11, IX-1, IX-4, and IM-1…IM-4 (dropped with `artifacts`, C4). The previous form of this
sentence was wrong twice: it listed IX-2 and RL-1, both of which turned out implementable (see
`build` above), and it omitted seven rules entirely.

> ⚠️ **This table is documentation, not a specification, and it has been found wrong three times.**
> `QUERY-BUILD.md` §2.2 found the P2 double-listing; Phase 8 found 25 rules double-listed, seven
> silent omissions, and 21 rules in no coverage table at all. Its range notation (`E1…E6`, `P1…P4`)
> silently over-claims — `E4` appears only in `build.ts`, never in `validate.ts` — and the `events`
> row duplicates 17 rules from the `validate` row while `events.ts` mentions ten of them.
> **No gate may transcribe this table.** `test/rule-closure.test.ts` now closes the registry over the
> coverage tables directly; the six per-module `OWNED` arrays that still copy from here are the
> remaining weak link, and the table should ultimately be *generated* from the coverage tables per
> D36's own "derive, never duplicate". See `AUDIT-2026-07-31.md` §3.

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

### Phase 8 — deep implementation audit + comparative analysis

Not a build phase — a review phase, and the last one before calling v0.1 done. Two halves:

**Internal audit.** A project-wide pass much deeper than any single phase's own `/code-review` +
`/simplify` — read every module (`events`, `validate`, `id`, `patch`, `resolve`, `admit`, `store`,
`query`, `build`) with the hindsight only a finished surface gives: correctness, API ergonomics,
performance at real corpus scale (hazard #4's sec-certs figures are the standing reference point —
re-measure them here, they were never measured in a browser), and cross-module consistency that only
shows up once every module exists — e.g. does `query`'s `EventFilter` shape still hold up once a real
`RelayTransport` consumes it in Phase 7's adapters?

**Comparative analysis.** Read the ecosystem libraries `DECISIONS-2026-07-27.md` already cites
(nostr-tools, NDK, applesauce, nostrify, welshman) for how they solved adjacent problems —
verification defaults, storage shape, filter ergonomics — and pull concrete, measured lessons the way
D19's own per-library table does, not impressions. SCRUTINY's most novel surface is the diff-based
content-evolution mechanic, which has no real precedent *in* Nostr — look at git itself and at
OT/CRDT systems for how deterministic patch application at scale is usually handled, and check
`patch.ts`'s T1/T2/T3 gate against whatever's learned.

**Resolve the conformance-vector gap.** Confirmed against Appendix G.1 as of this writing:
`discovery.json` (D-layer) and `serialization.json` (§3 serialization) remain reserved and unpublished
in the spec repo; only `application.json` (46 cases, A-layer) and `validity.json` (19 cases, V-layer)
are vendored and checksummed. Decide whether this project keeps relying on its own substitute-gate
discipline indefinitely (G1–G4/AG1–AG4/SG1–SG5/BQ-1–6), contributes vectors upstream, or derives a
project-local pseudo-corpus from the property tests' own permanent regression cases.

**Fold in the two orphaned rules.** RL-1 and IX-1/IX-2/IX-4 are producer-side SHOULDs owned by no
module (see the module-ownership table above). Decide whether `build.ts` gains a lightweight advisory
check for them, the way it already enforces P1/E4 by construction, or whether they genuinely have no
implementable form for a library to check on a producer's behalf.

Deliverable: a written audit report with a prioritized punch-list. Small, contained findings become
follow-up commits immediately; anything that would reshape a module's public surface gets scoped as
its own phase before landing, not folded silently into whatever's convenient.

### Phase 9 — `artifacts` package (imeta/Blossom verification)

IM-1…5 (§4.6): SHA-256 streaming verification of `imeta` attachments, size-mismatch-as-verification-
failure, multi-URL mirror fallback, warn-before-display for unverified artifacts. Ships as a separate
package per D7 — Node-first, `node:crypto` streaming by default with an injectable hasher, so it never
touches `core`'s zero-dependency property or breaks browser bundles. D7 already flags this as possibly
never shipping, and hazard #1 below calls it "the weakest unit" — Phase 8's audit should produce a real
opinion on whether to build this at all before this phase's own kickoff starts.

### Phase 10 — `@scrutiny-fabric/cli`

Appendix A already sketches the shape: walk / inspect / diff / format-patch / sign / publish, built on
`core`'s existing `resolve`/`build`/`query`. Needs `ScrutinySigner` defined — D16's fourth interface,
still undefined as of Phase 7. The plan's own interface table already names the CLI as
`ScrutinySigner`'s raw-key consumer, so this phase is where that interface most likely gets written,
not Phase 7's adapters (which need `RelayTransport`, a different interface, not this one).

### Phase 11 — `@scrutiny-fabric/mcp`

An MCP server exposing `core`'s query/resolve/build surface to AI agents — D40–D42's own rationale for
why `rules.json`/`Issue.code` are agent-legible in the first place is the reason this is worth building
at all. Far less specified than the CLI: no Appendix-A-equivalent sketch exists anywhere for it, so
this phase needs its own scoping pass (a `/grilling` session, not just a kickoff brief) before a build
brief can be written.

### Phase 12 — published relay adapters (contingent)

D6 currently rejects this for v0.1: `examples/adapters/` (Phase 7) stays copy-paste, never a published
package, specifically to avoid forcing one relay library on every consumer. This phase exists only if
Phase 8's comparative analysis, or real downstream usage, produces a concrete reason to reverse that —
and reversing D6 needs a dated Corrections entry in `DECISIONS-2026-07-27.md` before this phase could
even be scoped, not just built. If it ever happens, D6's own naming rule still applies: name the
library in the package name (`@scrutiny-fabric/relay-nostr-tools`), never a generic `relay`.

---

**Corrective-pass vs. numbered phases, decided.** The fourteen items in
`PLAN-2026-08-01-rewrite-mandate.md` plus the trust-filtered-view item land below as **numbered
phases**, not a dated corrective-pass section like 2026-07-30's before Phase 5. That precedent fixed
drift discovered in *already-shipped* phases before continuing forward (a spec re-target, three
vector-caught regressions in Phases 1–4's own output) — a "repair what's already built" shape. Every
item here is instead new, unshipped surface or behaviour, each substantial enough to warrant its own
mini-spec and gate the way Phases 1–6 already do. This matches `AUDIT-2026-07-31.md` §12's own
precedent more closely: it already proposed four of these items — "`EventFilter` → flat NIP-01",
"Memo invalidation for overlay degradation", "Validation in the ingest path", "`RelayTransport`
definition" — as their own phases, not as a corrective note, and this pass extends that framing to
the remaining ten mandate items plus the trust-view item rather than inventing a new one.

Numbered **13–23**, not inserted between Phase 8 and Phase 9: Phases 9–12 are already-written,
cross-referenced content — `DECISIONS-2026-07-27.md`'s **C4** and **C7** both cite Phase 9 and Phase
12 by number, and `AUDIT-2026-07-31.md` cites Phase 7 repeatedly — so renumbering them to make room
would break every existing citation across this document set for no correctness gain, the same
citation-integrity concern this project's own append-only `DECISIONS-2026-07-27.md` is built around.

**These are v0.1-completion phases, not v0.2+ work, despite sitting numerically after Phases 9–12's
CLI/MCP/artifacts/adapters sketches.** Phase 7 itself is blocked on two of them (13, 17; see that
phase's own Status-table row above); the rest close audit findings or mandate decisions against
`core`'s existing v0.1 surface, not new v0.2 product surface. Read this block before Phase 9's when
actually sequencing work — the numbers are archival (chosen to avoid renumbering), not execution
order.

### Phase 13 — `EventFilter` → flat NIP-01 shape

Fixes `AUDIT-2026-07-31.md` **P2** (the plan's own module table and `query.ts`'s file comment both
claim `query` "returns plain NIP-01 filter objects," which is false — filters nest under a `tags` key
no relay honours) and **P6** (the in-memory storage's `limit` sort has no `id` tie-break, the same
confluence-leak class `store.ts`'s `matchesFilter` already had). **Final call**
(`PLAN-2026-08-01-rewrite-mandate.md` §1): a flat `type EventFilter` alias with real NIP-01 keys
(`ids`, `authors`, `kinds`, `since`, `until`, `limit`, `search`, plus a `` [key: `#${string}`] ``
index signature), arrays staying `readonly` — TypeScript's structural typing already makes this
assignable to and from nostr-tools/NDK/nostrify's mutable `Filter` with zero copying of their
convention, so this project's own readonly-everywhere discipline (`StoreState`, `AdmissionIndex`,
`Resolution`) is not broken for a compatibility gain structural typing already delivers for free.
**Rejected**, per `AUDIT-2026-07-31.md` §7's own compile test: keeping `tags` as a named field — the
stated rationale ("kept... so it can coexist with `kinds`/`since`/`until`/`limit`'s differing value
types") does not hold under this repo's own `--strict` TS 5.8, which compiles the flat shape with an
index signature clean; and an `interface`, unlike a `type` alias, never receives an implicit index
signature, so the fix must be a `type`. Repoint `store.ts`'s `matchesFilter` to read the flat
`#`-prefixed keys directly, and fix the `limit` tie-break in the same pass
(`.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))`) — the mandate's own
instruction to bundle P6 here, since both live in the same function's neighbourhood. Test oracle: a
hand-rolled NIP-01 matcher from the spec text, cross-checked once against `nostr-tools` as a
devDependency (never a runtime one), flagging `nostr-protocol/nips#650` wherever the test exercises
the `since`/`until` boundary. Before landing: grep the monorepo for any other construction of the old
nested shape.

Gate: the property test in `AUDIT-2026-07-31.md` §7 (a NIP-01 matcher run against both the old and
new shapes) demonstrates the fix; the existing in-memory `matchesFilter` tests are repointed rather
than duplicated.

**Sequencing.** Must land before Phase 17 (`RelayTransport`) — its `request()`/`count()` filter
parameter is this flat shape. Unblocks Phase 7's own adapters.

### Phase 14 — Wiring `validateEvent` into `store.add()`

Mini-spec: [`VALIDATION-WIRING.md`](VALIDATION-WIRING.md). Fixes `AUDIT-2026-07-31.md` **P5** —
`createStore`'s documented ergonomic entry point never calls `validateEvent` at all, so a consumer
can ingest and resolve malformed Bindings, mis-tagged events, and PT-7-violating overlays with no
V-layer check ever running. **Final call** (mandate §6): admit every event to storage always — never
silently discard for a bug in this project's *own* validator, DEL-4's "never silently drop" argument
applied to a different failure mode — and exclude invalid events from the *resolved view* only.
`AddResult` becomes three buckets (`accepted`/`rejected`/`pending`, `issues` pluralized);
`rejectedBindings`/`bindingsAwaiting` generalize to rule-agnostic `invalidIds`/`pendingAwaiting`,
reusing the existing `addAwaiting`/`removeAwaiting` primitives unmodified.

**Design correction already recorded in `VALIDATION-WIRING.md` §3, restated here since it changes
what this phase actually builds:** the mandate's own sketch says call `checkBinding` directly, but
`checkBinding` is a module-private, non-exported function in `validate.ts` — exporting it would
either break `validate.ts`'s deliberately-single-function shape or force `store.ts` to re-implement
`validateEvent`'s own type dispatch, exactly the duplication risk this item exists to remove. This
phase calls the public `validateEvent` instead, which dispatches to `checkBinding` internally;
`store.ts`'s own `checkBindingTyping`/`bindingRejectionIssue` are deleted. `resolveRoot`'s event feed
gains a filter step excluding `invalidIds`, and the revalidation path on a later arrival reuses
`chainEpochTargets`/`bump` rather than new plumbing.

A related, out-of-scope gap surfaced while writing `VALIDATION-WIRING.md` §8 and is **not fixed by
this phase**: `admit.ts`'s `computeAdmission`/`applyDelta` never check BD-3/BD-4 endpoint typing, so
a Binding this phase correctly marks `invalid` still credits admission to its wrongly-typed
endpoints — oracle and incremental path agree with each other on a spec-incorrect answer, not a D29
disagreement. Recorded, deliberately not folded in here (it touches D23's admission mechanism, a
different module's public surface); needs its own future decision and Corrections entry.

Corrections entry for this item's D29 violation (distinct from Phase 15's): **already landed** as
`DECISIONS-2026-07-27.md` **C11**, during this spec-and-plan pass.

**Sequencing.** Must not land in the same commit as Phase 15 (`overlayAwaiting`) — both touch
`processObservedEvent`/`chainEpochTargets` and `resolveRoot`'s event-feed construction. Land this
phase **first**: `VALIDATION-WIRING.md` §5 shows this item already generalizes the "arrival of `X` →
look up a reverse index keyed by `X` → maybe bump some root's `chainEpoch`" shape (today exercised
only by Binding endpoints); Phase 15's `overlayAwaiting` is a second, simpler instance of the
identical shape and lands more cleanly as an additive sibling once this one exists. This is a
diff-hygiene preference, not a correctness dependency in either direction —
`VALIDATION-WIRING.md` §5 proves neither item's correctness needs the other.

### Phase 15 — Resolve-memo staleness fix: the `overlayAwaiting` reducer index

Mini-spec: [`OVERLAY-AWAITING.md`](OVERLAY-AWAITING.md). Fixes `AUDIT-2026-07-31.md` **P1** /
`DECISIONS-2026-07-27.md` **C5** — `chainEpochTargets` has no row that fires when an arbitrary
event's own arrival is the thing some *other* root's cached resolution depends on (an overlay's
`e reply` naming an event outside its own root's chain), so `resolveRoot` serves a stale DEL-7 α/β
degradation forever once such a target arrives after the overlay itself. This is D29 violated and
RC-3 violated (stale bytes served when fresh inputs are locally available) and a UR-1 confluence
failure in effect. **Final call** (mandate §3, refined by `OVERLAY-AWAITING.md`): the permanent
reverse index `overlayAwaiting: Record<targetId, rootId[]>`, populated unconditionally from every
observed Patch's own `e reply`/`e root` tags (never cleared, in **either** dimension — the
target-keyed entry and each entry's contributing root ids both, a refinement the mandate's one-line
sketch left silent), consulted by a new, always-applicable fifth row in `chainEpochTargets` for
*every* observed or unobserved event regardless of type (a second refinement — the mandate's sketch
read as Patch-scoped consultation, which was never the intent). **Rejected**, per the mandate's own
reasoning: the read-time patch (breaks reference-stability on cache hits) and keying the memo on
`observedEpoch` for any resolution containing an orphaned overlay (`AUDIT-2026-07-31.md` §2's
cheapest option — reintroduces coarse, D24-violating invalidation for the one case a precise fix
should target, and couples the memo key to its own cached value's shape). `STORE.md` §6's memo key
needs **no change at all** — the fix repairs `chainEpoch`'s precision at its source rather than
compensating one layer up.

Corrections entry amending D24: **already landed** as `DECISIONS-2026-07-27.md` **C10**, refined per
the two points above.

**Sequencing.** Lands after Phase 14, per that phase's own §5 — an additive sibling lookup next to
`pendingAwaiting`'s already-generalized reverse-index shape, not a second independent reinvention of
it.

### Phase 16 — `Store`'s trust-filtered view: `admissionView()` / `viewRoot()`

Mini-spec: [`TRUST-VIEW.md`](TRUST-VIEW.md). Resolves the mandate's own explicitly unresolved item
("Trust-filtered view ergonomics... design this properly during the spec-and-plan pass; do not
decide it by assertion") and `AUDIT-2026-07-31.md` §10.1 — rendering OV-7 overlays under trust today
needs four imports and reaching into `getState().admit`, an internal field, and leaves
`TrustProvider`'s `version`/`deltaSince` permanently unconsumed by any production path. **Final
call** (`TRUST-VIEW.md` §5): two new `Store` methods, `admissionView(): AdmissionView` and
`viewRoot(rootId, options?: ViewRootOptions): Resolution`, composing the already-memoized
`resolveRoot`, `toIndex(getState().admit)`, and `trustedView`/`visibleOverlays` — no new state, no
new epoch (D24 unaffected: `admissionView()` reads `state.admit` fresh, nothing expensive to cache).
`resolveRoot` itself is **unchanged**; `viewRoot` filters only `overlays`, never
`chain`/`pending`/`annotations`, which D25/TR-7 requires (trust-filtering before chain construction
is the highest-severity bug D25 documents). **Rejected**: a standalone barrel
`viewResolution(resolution, view)` helper (organisation around an already-minimal, already-exported
`visibleOverlays`, not a genuine ergonomic gain, and does not address the audit's actual complaint
about `getState().admit`); `CreateStoreOptions` accepting a `TrustProvider`, under either reading
(replacing `trust`/`untrust` throws away D24's ~20× measured incremental-vs-full-recompute
advantage; sitting alongside them creates a second trust source needing an invented reconciliation
policy nothing today needs) — the bridge this would provide already exists in userland via
`deltaSince`/`store.trust` or a direct `computeAdmission` call.

**Design correction, found while writing `TRUST-VIEW.md` §7 and restated here since it is load-bearing
for this phase's own Corrections dependency:** recommending `Store.trust`/`untrust` as *the*
documented path reads, on D21's summary line alone ("no trust package... never a set"), as exactly
what D21 forbids. Clarification, not a reversal: D21's rationale targets a *policy*-computing
mechanism (out of scope per §6.1); `store.ts`'s `Set` is bookkeeping over a decision already made
elsewhere, the same role `IngestMeta.verified` plays for verification. Corrections entry clarifying
D21: **already landed** as `DECISIONS-2026-07-27.md` **C12**.

**Sequencing.** No hard dependency on Phase 14/15 — `TRUST-VIEW.md` touches neither `StoreState`'s
fields nor `chainEpochTargets`. Sequenced here, after them, purely for diff hygiene: all three
phases touch `store.ts`, and serializing them avoids three concurrent PRs against the same file's
neighbourhood.

### Phase 17 — `RelayTransport` interface (D16's fourth interface)

Mini-spec: [`RELAY-TRANSPORT.md`](RELAY-TRANSPORT.md). Fixes the double block on Phase 7
`AUDIT-2026-07-31.md` §6.4/§7 already names: `interfaces.ts` declares only `TrustProvider` and
`EventStorage`; `RelayTransport` has, until now, lived solely in the plan's D16 table. **Final call**
(mandate §4, unchanged from the original design pass): callback-plus-explicit-unsubscribe
`request()`, a `publish()` returning a per-relay outcome map mirroring NIP-01's `OK` exactly,
optional `count()` (NIP-45 is genuinely optional relay-side) — the shape every one of
nostr-tools/NDK/applesauce/nostrify already exposes internally, so an adapter stays a thin
pass-through. `RELAY-TRANSPORT.md` resolves the three questions the mandate left open: **(1)**
`onEvent` gains a second, relay-of-origin parameter — not a reopening of R9 (which rejected
*building a censorship-detection feature*, not carrying the data point at all), but a fix for
`store.ts`'s own `IngestMeta.source` (D19), permanently unpopulatable for the multi-relay case
without it; **(2)** a `publish()` timeout is reported in the map as `{ok: false, reason: 'timeout'}`,
never by omission — an absent key is "a collapsed boolean wearing a `Map`'s clothing," the exact
information-loss the explicit map exists to prevent; **(3)** `onEose` fires once per relay, matching
NIP-01's own per-subscription-per-relay semantics (no design correction needed here — the mandate's
own sketch already had this right).

**Sequencing.** Depends on Phase 13 (`EventFilter` reshape) — `request()`/`count()`'s filter
parameter is the flat NIP-01 shape that phase produces; this interface's own text does not depend on
it, but the Phase 7 adapters built against it should wait. `core` ships no implementation of this
interface, ever, per D6 — only `examples/adapters/*` (Phase 7) consume it.

### Phase 18 — Producer-side context widening (`build.ts`)

Mini-spec: [`CONTEXT-WIDENING.md`](CONTEXT-WIDENING.md). Builds now, not deferred, per the mandate's
own zero-technical-debt framing: a hybrid strategy keeping `context = 3` as the fast path (covers
~99.7% of edits per `AUDIT-2026-07-31.md` §5's own figures) and widening only on T1 ambiguity, up to
full-file context, falling back to the existing P4 warning verbatim if even that cannot disambiguate.
Extracts a genuine shared module, `patch-matcher.ts` — `toLines`/`fromLines`/`lineCount`/`Hunk`/
`reduceHunk`/`Occurrences`/`occurrences`/`SpliceOutcome`/`spliceAt`, moved verbatim out of
`patch.ts`'s private scope — used by both `patch.ts`'s applier and `build.ts`'s widening loop,
treated identically to `./patch` under D32 (never added to `exports`; internal-only). **Two design
corrections found while writing the mini-spec, both load-bearing for correctness, not just style:**
**(1)** the widening step must be exactly 1, not a free parameter — any larger fixed step re-imports
the same "skips untried values without proving anything about them" hazard the mandate already
rejects binary search for; **(2)** the per-context uniqueness check must thread spliced content
across hunks via `spliceAt`, exactly mirroring T3's own sequencing in `applyPatchPayload` — checking
each hunk against the static, unpatched `beforeLines` array (the mandate's own one-line sketch, and
this document's own first draft) can report "unique" where the real, T3-sequenced consumer-side scan
would still find a hunk ambiguous, because an earlier hunk's own replacement text can introduce or
remove a duplicate of a later hunk's pattern.

A dedicated resource ceiling, `maxWidenWork` (default `16 MiB`, identical unit and default to
`patch.ts`'s existing `ApplyOptions.maxWork`, charged per F12's already-landed per-element floor),
answers the mandate's own open question about bounding a pathological `before`. No
`DECISIONS-2026-07-27.md` Corrections entry is needed (`CONTEXT-WIDENING.md` §8 checks this against
D28, D31/C1, and D11 individually and finds each unaffected).

**Sequencing.** No dependency on Phases 13–17. Must land **before** Phase 19 — `maxWidenWork` is
expected to fold into that phase's options-object refactor of `buildPatch`'s parameters.

### Phase 19 — `buildPatch`'s options object

Fixes the transposable-parameter hazard the mandate names directly (§10) and
`AUDIT-2026-07-31.md` §10 (item 3): `root`/`reply` and `before`/`after` are same-typed positional
pairs, and swapping `before`/`after` produces a plausible *inverse* patch that still passes the P4
self-check, against the wrong baseline — a silent footgun no documentation fixes. **Final call:**
collapse the six positional parameters into a single named-fields options object, making the swap a
compile error instead of a runtime surprise. Folds in Phase 18's `maxWidenWork` option
(`CONTEXT-WIDENING.md` §3: "expects it to fold into item 10's options object when that item lands —
sequencing between items 9 and 10 is item 10's concern") and, incidentally, gives `buildPatch`'s
existing P4 self-check a place to accept the caller's own `ApplyOptions` rather than always running
at default ceilings (`AUDIT-2026-07-31.md` §10 item 3's second half: a 70-hunk patch's P4 self-check
reports a resource limit as a producer-correctness failure today, with no parameter to fix it).

**Sequencing.** Depends on Phase 18 landing first.

### Phase 20 — Public-surface hygiene: `patch-types.ts`, `EndpointRef`/`ETagRef`, `resolveRoot`'s internal collision

Three small, independent, mechanical items bundled under one phase, matching this plan's own
precedent for grouping same-sized unrelated work (Phase 6's `query`+`build`, Phase 7's
coverage+adapters+docs):

- **`patch-types.ts` extraction** (mandate §2): `HaltReason`, `LimitKind`, `ApplyOptions`, and
  `HaltRule` move into a dedicated `packages/core/src/patch-types.ts` (types only), re-exported from
  `index.ts`'s root barrel, no new `exports`-map subpath (D17). Clarifying Corrections entry for D32
  (confirming its scope is the applier function and its subpath, not patch-adjacent result/option
  types): **already landed** as `DECISIONS-2026-07-27.md` **C9**.
- **`EndpointRef`/`ETagRef` field unification** (mandate §11): today `authorPubkey` vs `authorHint`
  name the identical concept, silently renaming a field on a round-trip through `eTags`. Unify to
  one canonical name across both types.
- **`resolveRoot`'s internal naming collision** (mandate §12, `AUDIT-2026-07-31.md` §10): `store.ts`
  already works around this internally (`resolveRootBound` names the bound public method precisely
  so the *private*, memo-driven helper — the one `OVERLAY-AWAITING.md` §7's worked trace calls as
  `resolveRoot(state, rootId, memo)` — can keep the shorter name). The public `Store.resolveRoot`/
  `viewRoot` surface, already relied on verbatim by `TRUST-VIEW.md` and `VALIDATION-WIRING.md`'s
  finished designs (Phases 14–16), is not the one to rename; renaming the private helper is a
  contained, non-breaking fix.

**Sequencing.** No dependency on Phases 13–19 in either direction. Placed after them here only
because the `resolveRoot` item is easiest to scope precisely once Phases 14–16's `store.ts` changes
have landed and the private/public split is stable.

### Phase 21 — Default in-memory `EventStorage`: real indexes

Fixes what `AUDIT-2026-07-31.md` §5 measures directly: `createInMemoryEventStorage` is "the weakest
store of the five" real Nostr libraries ship — one `Map`, no indexes, a full materialisation per
filter object, an uncached deletion scan. **Final call** (mandate §14): build it properly — real
indexes by `kind` and by `#e`/`#i`/`#t`, replacing the single-`Map`-plus-full-scan default.
`EventStorage` stays a swappable port either way (D15/D37 unchanged); "zero technical debt" is read
here as covering the reference implementation itself, not only the public interfaces around it.
Comparative-analysis lesson to apply, not just the headline finding: **do not copy welshman's index
design as-is** (`AUDIT-2026-07-31.md` §5) — `_applyAnyFilter` picks the first applicable index in
fixed priority and never intersects, and every filter `query.ts` emits carries both
`#t:[FABRIC_TAG]` and `kinds:[SCRUTINY_KIND]`, so a tag-first index whose commonest key holds 100% of
rows is worse than none; the useful discriminators here are `#i`, `#e`, and `#t` restricted to the
event-type tags specifically.

**Design correction, found while sequencing this pass, not stated anywhere in the mandate or the
audit's own item-14 text:** this phase must build its indexes against the **flat**, post-Phase-13
`EventFilter` shape, not today's nested one. `AUDIT-2026-07-31.md` P2 already documents that
`createInMemoryEventStorage`'s own matcher reads `filter.tags` today — building real `#e`/`#i`/`#t`
indexes against that soon-to-be-replaced nested shape would mean indexing against a type Phase 13 is
about to delete out from under it, duplicating the work. The mandate's own item-14 text never
mentions item 1 at all; sequencing this phase after Phase 13 (rather than treating the two as
independent) avoids the duplication its silence would otherwise invite.

**Sequencing.** Depends on Phase 13.

### Phase 22 — Reference signer example (`examples/signers/`)

Fixes `AUDIT-2026-07-31.md` §10 item 2: "hello world" cannot compile today until a newcomer
independently discovers which Schnorr library to use — correctly, `core` refuses to default this
(D12/D18: no crypto in core, `verify` required with no default) but offers no worked example either.
**Final call** (mandate §13): a documented, copy-paste reference implementation under
`examples/signers/`, using `@noble/curves` + `@noble/hashes` — **never a published dependency of
`core`**, the identical treatment D6 already gives relay adapters, and for the same reason (don't
force one library's choice onto every consumer). `@noble` is what nostr-tools and NDK already
standardize on, making this the most ecosystem-compatible choice available, not an arbitrary one.

**Sequencing.** Independent of every other phase in this range.

### Phase 23 — Module-ownership table codegen

Fixes the documentation-drift hazard `AUDIT-2026-07-31.md` §3/`DECISIONS-2026-07-27.md` **C6**
already found and partially fixed (`rule-closure.test.ts`'s registry-closure gate): the
module-ownership table above is hand-maintained and has been found wrong three times — the P2
double-listing (`QUERY-BUILD.md` §2.2), 25 rules double-listed and 21 in no coverage table at all
(Phase 8), and its own range notation over-claiming coverage that no gate checks. **Final call**
(mandate §8, unchanged from the original design pass): generate this table from the six per-module
coverage tables (`_a-validate-coverage.ts`, etc.) plus `_unowned.ts` — the same set
`rule-closure.test.ts` already closes over the full rule registry — rather than hand-maintaining it.
**Rejected**, on the record already (D35): `@owns` JSDoc annotations as an alternative source —
adopting them now without a fresh Corrections entry would silently overturn D35 by rewrite, which
this project's own append-only rule forbids. Scope decision this phase makes explicit: this is the
**same** generator Phase 7's `coverage.json`/`COVERAGE.md` already promised, extended by one more
emitted artifact (this table's Markdown), not a second, narrower script — the underlying data (which
module emits which rule code) is identical to what Phase 7's tool already computes. The hand-written
"why a module owns a rule" narrative prose relocates to a short prose note per module, kept in this
file by hand, next to the generated ID columns rather than interleaved with them.

**Sequencing.** No dependency on Phases 13–22. Practically follows Phase 7 (needs the coverage
tables Phase 7's own tooling produces), which is not renumbered here and remains where this plan
already placed it.

**Spec-amendment items (mandate items 5 and 7) are not phases here.** Both are drafted and filed this
session as `SPEC-FEEDBACK-v0.6.0.md` **F13** (Patch's `e root` endpoint-typing gap — new rules
PT-10/PT-11) and **F14** (the version-tag digit ceiling — TAG-2/VER-1 rewritten around a dedicated
`v` tag), per D2's "batched, never a direct edit" rule. Neither has landed in the sibling spec repo
yet, so — matching this plan's own precedent for the §11 future-work items already excluded from
numbered phases, below — there is no implementation phase to schedule until the spec actually
amends. Once it does: F13 needs a small `checkPatch` addition in `validate.ts` citing the new
PT-10/PT-11 directly, replacing today's incidental `admit.ts`/`resolve.ts` hardening that same
`SPEC-FEEDBACK-v0.6.0.md` entry confirms is not spec-required; F14 needs a `v`-tag migration across
`events.ts`'s `VERSION_TAG_PATTERN`/`parseVersionTag`/`compareVersionTags` and every `t`-tag example
in the spec's own §4.1–§4.4, with no grandfather clause per the mandate's own no-real-corpus premise.
Track both against the spec repo's own version, not as a numbered phase in this plan.

---

**Not a phase here.** §11's Future Work items (merges & overlay adoption, recursive overlays, a
`supersedes` tag, confidential metadata, vendor identity discovery, Metadata↔Metadata binding,
cherry-pick attribution, snapshot pins, NIP-90 DVM integration) are protocol amendments authored in the
sibling `~/scrutiny-fabric` spec repo, not implementation work in this one. Nothing here can start
until that repo's spec version moves — track it separately, not as a numbered phase in this plan.

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

CLI (Phase 10) · MCP server (Phase 11) · `artifacts` / imeta fetching (Phase 9) · published relay
adapters (Phase 12, contingent) · relay selection and the outbox model (app-level; welshman has an
open "Re-work router" issue — not our problem to solve) · LLM grounding and prompt assembly · graph
layout · session persistence schema · NIP-77 Negentropy · OpenTimestamps verification · SQLite-WASM
storage adapter · TypeDoc HTML · performance budgets (D declined) · N-hop web-of-trust expansion (the
`TrustProvider` interface is the migration path; no implementation).

The four bracketed items have a phase number because Phase 8's audit is expected to at least start
them. Everything after "relay selection" has none — they stay genuinely unscoped, not merely
unscheduled, until something (a real consumer, a decision reversal) gives one of them a reason to.

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

1. ~~**`artifacts` is the weakest unit.**~~ **Resolved 2026-07-31 (C4)** — dropped, not deferred
   again. No app needs it: the real corpus's largest content is 2,088 bytes against a ~30 KB
   threshold. The residual constraint is that IM-4 is a MUST, so partial imeta support in `core`
   would be a conformance failure rather than an incomplete feature.
2. **`store`'s public API must not be a class.** Ship reducer + port from the first release; swapping
   later is a breaking change to the most-used entry point (D15).
3. **D23's refcounting is only sound while BD-3/BD-4 hold.** §11 lists Metadata↔Metadata bindings as
   future work. Isolate the reachability step to one ~10-line method and comment the dependency.
4. **All benchmark figures in DECISIONS are synthetic — except these.** Re-measured 2026-07-31
   against the real sec-certs mapping (C3). The 216 MB eager-materialisation figure is reproducible
   but **mislabelled**: it is 6,737 roots × depth ≈67, and the real corpus is depth **≤1**, where
   eager costs 3.68 MB against 2.73 MB lazy. D28's byte-bounded LRU is not warranted and was never
   built. **Still true, and now the part that matters:** nothing has been measured in a browser, and
   the figure that decides whether a tab survives is not the resolution cache but the raw event
   corpus — ~1.35 KB/event over an estimated 30k–110k events, i.e. **40–150 MB**, 15–50× the entire
   caching question. That is the measurement still owed.
5. **The relay timestamp window is confirmed and will bite the bulk publisher.** Verified against
   `hoytech/strfry/strfry.conf` on 2026-07-27: `rejectEventsOlderThanSeconds = 94608000` (exactly
   three years) and `rejectEventsNewerThanSeconds = 900`. Setting `created_at` to a certificate's
   issue year therefore means **silent rejection of the entire historical corpus** — no error, no
   stored events. `created_at` is publish time; historical dates go in `content` (spec amendment A11).
