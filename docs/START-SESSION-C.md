# Session C starter — build `store`

Start a fresh Claude Code session **in `~/scrutiny-fabric-tools`** and paste the prompt below.

Phases 0–4 are done in one continuous line of sessions; this is the first phase since to get its own
dedicated starter doc, because `store` is the highest-integration-risk module left — it is the only
thing that wires `patch`, `resolve`, and `admit` together, and D24's epoch-cost promise (a
`trustEpoch` bump touching zero `applyPatch` calls) is a real invariant to break by accident, not a
slogan.

---

## What is already true — do not redo

- **Phases 0–4 are done and merged to `main`** (`dfd5f87`). `pnpm verify` is green: lint, typecheck,
  `rules:check`, build, ATTW, and the full test suite — **328 tests**, one property test
  (`resolve-property.test.ts`'s G1 permutation check) occasionally exceeds vitest's default 5s
  timeout when the whole suite runs under CPU contention; it is not a logic bug — it passes in
  ~3s standalone. Worth a `testTimeout` bump if it recurs, not a Phase 5 blocker.
- **`events`, `validate`, `id`, `patch` (internal), `resolve`, `admit` all exist**, each with its own
  mini-spec (`PATCH-MATCHER.md`, `RESOLVE.md`, `ADMIT.md`) written before its code, and each with a
  substitute gate (property tests / G1–G4 / AG1–AG4) standing in for the conformance vectors that
  still don't exist — **four phases deep now**, per `IMPLEMENTATION-PLAN.md`'s running note. Phase 5
  should assume this continues and define its own substitute gate rather than wait.
- **`interfaces.ts` exists**, minimal to `TrustProvider` (`admit`'s Phase 4 addition). `RelayTransport`,
  `EventStorage`, `ScrutinySigner` are **not yet created** — `store` is the first module that needs
  `EventStorage`, and probably the first that needs `ScrutinySigner` too (verification enforcement).
- **`resolve` and `admit` are both pure, trust-blind (`resolve`) or state-threading-but-storage-free
  (`admit`) functions.** Neither owns any persistence or epoch logic — that is entirely `store`'s to
  build. Both already expose the plain-data shapes (`Resolution`, `AdmissionIndex`) `store` will hold
  in its reducer state and compare against oracles.
- **The architecture is settled.** `DECISIONS-2026-07-27.md` has 45 decisions and 13 rejected
  alternatives. The ones that bind this phase specifically: D15 (reducer + port, never a class), D18
  (`verify` required, no default, fail closed), D19 (verification status travels with the event on
  ingest, `store.add(events, {source, verified})`), D20 (dedup only after verification), D24 (three
  independent epochs), D26 (overlay-classification cache key has no trust component), D28 (lazy
  chain-state materialisation under a byte-bounded LRU), D29 (pure functions are the oracle — every
  incremental path must agree with a from-scratch recompute), D37 (in-memory tier for v0.1; IndexedDB
  and SQLite are the app's problem), D38 (cache raw events, never persist resolved content as truth).

## Not yet true

- **`STORE.md` does not exist.** Write it before touching code, same as Phases 2–4. It needs to
  settle three things the plan flags as genuinely unresolved, not just unwritten: how the
  pending-reference buffer (§3.3) interacts with `resolve`'s and `admit`'s own confluence guarantees;
  how the three D24 epochs invalidate independently of each other without cross-contamination; how
  DEL-8/DEL-9's deletion cache and BD-7's rejection cache — both monotone, for different reasons —
  avoid getting their invalidation conflated.
- **The Phase 5 gate is now named but not yet built**: SG1 (store-level confluence), SG2 (the D24
  epoch-cost regression, promoted from an unstructured test to a numbered gate item), SG3
  (dedup-after-verification survives a two-relay pre-registration race, D20), SG4 (rule-coverage
  partition over UR-1…3, RC-3/4, BD-6/7, DEL-8/9, RL-2/3, SIG-1), SG5 (generator bias and floors).
  Full detail in `IMPLEMENTATION-PLAN.md`'s Phase 5 section — read it, don't just skim the list here.
- **`store.json` (or whatever this layer's vector file is eventually named) does not exist**, for the
  same reason every prior phase's named vector file didn't. Build the loading harness the same way —
  read cleanly, skip cleanly when absent — vectors are additive whenever they land.

---

## The prompt

```
You are building `store`, Phase 5 of @scrutiny-fabric/core — the reducer, StorageAdapter port, and
epoch bookkeeping that ties `patch`, `resolve`, and `admit` together into something a real consumer
calls.

READ FIRST, IN THIS ORDER
1. docs/IMPLEMENTATION-PLAN.md — the Phase 5 section specifically, but read the whole Status section
   above it too: four phases have now had to substitute their own gate for missing conformance
   vectors, and Phase 5 is expected to do the same, not to wait for them.
2. docs/DECISIONS-2026-07-27.md — D15, D18, D19, D20, D24, D26, D28, D29, D37, D38 bind this phase
   directly. Read them in full, not just the one-line summaries in the starter doc. Do not relitigate
   any of it; if one looks wrong, say so and stop rather than quietly doing something else.
3. packages/core/src/resolve.ts and packages/core/src/admit.ts — both are already-shipped, and both
   are pure with respect to persistence. `store` wraps them; it does not change them. Read RESOLVE.md
   and ADMIT.md for the design reasoning behind the shapes you'll be holding in reducer state.
4. ~/scrutiny-fabric/docs/protocol-spec.md §3.3 (pending references), §6.1–§6.2 (verification,
   dedup), and the D-rules `store` owns per the plan's module table: UR-1…3, RC-3/4, BD-6/7, DEL-8/9,
   RL-2/3, SIG-1 (the enforcement half — `id.ts` already owns the recompute half).

FIRST ACTION: create a branch. This project never commits directly to main.
  git checkout -b feat/store

FIRST DELIVERABLE: docs/STORE.md, a mini-spec written before any code, matching the voice and
structure of PATCH-MATCHER.md / RESOLVE.md / ADMIT.md — dense, precise, bold lead-ins, one section per
concern. It must settle, in writing, before code exists:
  - The pending-reference buffer's lifecycle: what triggers re-evaluation when a dangling `e root` /
    `e reply` / Binding endpoint arrives, and how that interacts with resolve's and admit's own
    confluence properties (UR-1/UR-2) without re-running either from scratch on every ingest.
  - How the three D24 epochs (trustEpoch, observedEpoch, per-root chain epoch) invalidate
    independently — concretely, what data structure lets a trustEpoch bump touch admission and
    nothing else.
  - How DEL-8/DEL-9's deletion cache and BD-7's rejection cache — both monotone, for different
    reasons — avoid cross-contaminating each other's invalidation.
  - The gate: SG1–SG5, stated precisely (see IMPLEMENTATION-PLAN.md's Phase 5 section for the working
    list; refine it, don't just copy it verbatim into STORE.md without thinking it through the way
    RESOLVE.md and ADMIT.md each did before their code existed).

HARD CONSTRAINTS — architectural decisions, not preferences
- `store`'s public API is a reducer plus a `StorageAdapter` port. NEVER a class. Swapping the default
  in-memory adapter for IndexedDB/SQLite later must not be a breaking change to the most-used entry
  point. (D15)
- `verify: (event) => boolean` is a REQUIRED constructor parameter with no default, covering both
  signature AND id recompute. A forgotten default is how CVEs happen. (D18)
- Verification status travels with the event on ingest: `store.add(events, {source, verified})`.
  Verification is unskippable by default; the escape hatch is named `trustUnverified` so misuse is
  visible in review. (D19)
- Dedup happens only AFTER verification, never before and never on the bare declared id. A malicious
  relay in a pool can pre-register a genuine event's id and suppress the authentic copy arriving from
  an honest relay — build SG3's two-relay race to prove this doesn't happen, don't just trust the
  ordering by inspection. (D20)
- Three independent epochs, not one merged invalidation signal. Merging trustEpoch and observedEpoch
  is correct but catastrophic — every "show everything" toggle would trigger seconds of diff
  re-application. SG2 is the regression that catches a merge creeping back in. (D24)
- The overlay-classification cache key is `(overlayId, hash(targetResolvedBytes))` — no trust
  component. Trust-gates the SET iterated, never the cache KEY. (D26)
- Chain states are computed lazily under a byte-bounded LRU, not eagerly materialised. Eager
  materialisation measured 216 MB at sec-certs scale versus ~25 MB lazy on a synthetic benchmark —
  unverified in a real browser, but the shape of the difference is real. (D28)
- The pure functions (`resolve`, `admit`'s `computeAdmission`) are retained as a conformance oracle.
  Every incremental path `store` builds must agree with a from-scratch recompute over the same
  observed set — this is the only real defence against admission-index and chain-cache drift. (D29)
- In-memory `StorageAdapter` only for v0.1. IndexedDB/SQLite adapters are the app's problem; `store`
  defines the port, not an implementation beyond the default. (D37)
- Cache raw events; never persist resolved content as truth. A persisted resolution can serve a
  conformance failure from the cache's own past. (D38)

WORKING STYLE
- STORE.md first, reviewed and settled, before any implementation code.
- Work gate item by gate item once code starts: SG1 through SG5, in the order STORE.md settles on.
  Report at each gate result, then continue — do not batch several and summarise at the end.
- Commit at each meaningful boundary (mini-spec, then each gate item landing) with a conventional-
  commit message. Do not push, do not merge to main, do not open a PR.
- Do not touch ~/scrutiny-fabric. It is read-only for this session.
- If a counterexample or design gap turns up — the way AG2 found the ForwardDelta narrowing and the
  unobserve root-chain-stranding bug — pin it as a permanent regression case and record it in
  STORE.md, the same way ADMIT.md §9 and §10 do. Do not fix it quietly and move on without a record.

IF SOMETHING DOESN'T FIT: if the plan is impossible, ambiguous, or contradicts the spec or an existing
decision, STOP and tell me. Every phase so far has found something the plan didn't anticipate — spec
defects, an unreachable bias shape, a missing invariant — so assume Phase 5 will too rather than
forcing a resolution that isn't actually settled.
```

---

## After Phase 5

Phase 6 (`query`, `build`) is comparatively low-risk — filter builders and unsigned-template
construction, no new persistence or trust concerns — and can likely run in the same style of session
without its own dedicated starter doc, the way Phases 2–4 did. Phase 7 (coverage tooling, adapters,
docs) is the point at which `tools/rules.json` finally gets consumed by a generated `COVERAGE.md`
(D34/D36) — worth its own session given it touches `tools/` rather than `packages/core/src/`.

## Do not

- Relitigate settled decisions. `DECISIONS-2026-07-27.md` is append-only; add a correction rather
  than rewriting it.
- Hand-edit `tools/rules.json` or `packages/core/src/rules.ts` — both are generated.
- Let `resolve.ts` or `admit.ts` grow a persistence or trust-reading dependency to make `store` easier
  to write. D25 (resolve reads no trust state) and D29 (pure functions as oracle) both depend on
  those modules staying exactly as pure as they are today.
- Start Phase 6 in the same session as Phase 5.
