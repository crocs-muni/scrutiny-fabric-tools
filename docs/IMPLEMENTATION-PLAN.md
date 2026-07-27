# Implementation plan — `@scrutiny-fabric/core` v0.1

Target spec: **v0.6.0** (`scrutiny-v060`). Rationale for every decision here lives in
[`DECISIONS-2026-07-27.md`](DECISIONS-2026-07-27.md) — this document is the *what and in what order*,
not the *why*. Do not relitigate a decision without reading its D-entry first.

Supersedes the previous `IMPLEMENTATION-PLAN.md` (targeted spec v0.5.3, never committed).

---

## Status

| Phase | Work | State |
|---|---|---|
| — | Spec amended to v0.6.0 | ⛔ blocked — `SPEC-AMENDMENT-BRIEF.md` in the spec repo |
| — | Conformance vector skeletons + validator in the spec repo | ⛔ blocked on the above |
| 0 | Monorepo scaffold | not started |
| 1 | `events`, `validate`, `id` | not started |
| 2 | `patch` — the T1/T2/T3 matcher | not started |
| 3 | `resolve` — chain + overlays | not started |
| 4 | `admit` | not started |
| 5 | `store` — reducer + ports + epochs | not started |
| 6 | `query`, `build` | not started |
| 7 | Coverage tooling, adapters, docs | not started |

**Do not start Phase 0 until the spec is at v0.6.0.** Both prior implementations died of protocol
drift; beginning against an unamended spec reproduces the cause.

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

⚠️ **Correction to DECISIONS D16**, which says "three interfaces, and only three". `TrustProvider`
(D21) is a fourth. There are four.

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
| `validate` | PR-1…3, MD-1…3, BD-1…5/10/12, PT-1…4, E1…E6, C1…C4, P1…P3 | Pure, one event in, `Issue[]` out. Endpoint typing (BD-3/4/5) needs the observed set → returns *pending*, resolved by `store` per §3.3 |
| `id` | SIG-1 (recompute half) | `serializeForId` delegates to `JSON.stringify` per R11. Hash injected — no crypto in core |
| `patch` **(internal)** | T1, T2, T3, H1, N1…N3, C5, C6, PB-1/2, E7 | **T1/T2/T3 is hand-written and non-injectable** (D30). No stock applier does the exactly-once check. Normalise jsdiff's two failure channels: returns `false` on context mismatch, *throws* on truncated/swapped hunks |
| `resolve` | CHN-1…3, RC-1/2, SF-1…6, H1/H2, OV-2/3/4/6/8, DEL-1/2/3/6/7, PT-5/6/8/9, IX-3, BD-9 | **Reads no trust state** (D25). `ChainState.forked` has **no `tipId`** — makes SF-4 unrepresentable |
| `admit` | TR-2…7, OV-7, DEL-4/5 | Refcounted reason sets. `direct-trust` = Set bit; `binding` = counter guarded by `liveBindings` (D23) |
| `query` | DQ-1…4, BD-8 | Returns plain NIP-01 filter objects; no transport dependency |
| `build` | E4 (fence length `max(3, N+1)`), P1…P4 | Emits `{kind, created_at, tags, content}` — **no `id`, `pubkey`, `sig`** (D13) |
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

### Phase 3 — `resolve`

Chain construction, kind-5 cascade, HALT, self-fork freeze, overlay classification. Trust-blind.
Lazy per-position content under a byte-bounded LRU (D28).

Gate: `application.json` vectors pass. A self-fork test asserts the returned variant exposes no tip.

### Phase 4 — `admit`

Reason sets, refcounting, `TrustedView` / `OpenView` (D22).

Gate: `discovery.json` vectors pass, plus the two adversarial property tests below.

### Phase 5 — `store`

Reducer, pending-reference buffer (§3.3), deletion cache, the three epochs, verification enforcement,
dedup-after-verification (D20), in-memory `StorageAdapter`.

Gate: the confluence property (below) passes. A regression test asserts a `trustEpoch` change performs
**zero** `applyPatch` calls (D24).

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
    → confluence (UR-2). Would have caught the pending-patch gap
      without anyone reading §5.3 closely.

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
5. **Verify strfry's timestamp window** before the bulk publish. If `rejectEventsOlderThanSeconds`
   really defaults to ~3 years, backdating `created_at` to a certificate's issue year means silent
   rejection of the entire historical corpus.
