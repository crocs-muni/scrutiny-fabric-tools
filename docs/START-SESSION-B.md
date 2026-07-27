# Session B starter — build `@scrutiny-fabric/core`

Start a fresh Claude Code session **in `~/scrutiny-fabric-tools`** and paste the prompt below.

Unlike Session A, this is **not one sitting.** The plan has seven phases with a defined stopping point
each. This launcher covers **Phase 0 (scaffold) and Phase 1 (events, validate, id)**. Phase 2 — the
patch matcher — is the riskiest module in the project and deserves its own session with a fresh context.

---

## What is already true — do not redo

- **Spec is at v0.6.0** (`scrutiny-v060`), `~/scrutiny-fabric/docs/protocol-spec.md`, 1449 lines
  (up from 1363 at v0.5.9).
- **134 normative rules**: V=47, A=55, D=31, plus 1 reserved. Appendix F is the flat index.
- **`tools/extract-rules.mjs`** validates the registry and regenerates `tools/rules.json`. It reports
  0 errors against v0.6.0. Run it if the spec changes; do not hand-edit `rules.json`.
- **`tools/rules.json`** holds all 134 rules as `{id, section, layer, inheritsFrom, summary, text,
  reserved}`. Phase 7's coverage report consumes this; Phase 1 can use it to enumerate what to implement.
- The architecture is settled. `DECISIONS-2026-07-27.md` has 45 numbered decisions with rationale and
  13 explicitly rejected alternatives.

## Not yet true

**Conformance vectors do not exist.** The spec has no Appendix G and §11 still lists test vectors as
future work — deliberately, to keep the amendment to behaviour-affecting changes. So Phase 1 cannot
fully satisfy its stated gate. Build the vector-loading harness (read `vectors/*.json`, skip cleanly
when absent) and cover Phase 1 with hand-written unit tests for now. Vectors drop in later without
rework.

---

## The prompt

```
You are building the first release of @scrutiny-fabric/core, a TypeScript reference implementation of
the SCRUTINY Fabric protocol.

READ FIRST, IN THIS ORDER
1. docs/IMPLEMENTATION-PLAN.md  — what to build and in what order. Your work order.
2. docs/DECISIONS-2026-07-27.md — why it is shaped this way. 45 decisions, 13 rejected alternatives.
   Read sections 2 and 3 fully. Do not relitigate any of it; if you think a decision is wrong, say so
   and stop rather than quietly doing something else.
3. ~/scrutiny-fabric/docs/protocol-spec.md — the protocol. v0.6.0, 134 rules. This is the only
   normative source. Appendix F is the flat rule index.

FIRST ACTION: create a branch. This project never commits directly to main.
  git checkout -b feat/core-scaffold

SCOPE FOR THIS SESSION: Phase 0 and Phase 1 only. Stop at the end of Phase 1 and report. Do not start
Phase 2 — the patch matcher is the highest-risk module and gets its own session.

Phase 0 — scaffold. pnpm workspace with packages/core. tsconfig strict, ES2022, moduleResolution
node16. Biome for lint and format. Changesets with a linked group. GitHub Actions CI on Node 22,
ubuntu and windows, PR-only to main. package.json with "type": "module", "sideEffects": false, and a
hand-written exports map.
  Gate: pnpm build emits clean ESM plus .d.ts, and the exports map is ATTW-clean.

Phase 1 — events, validate, id. Three modules, all pure, no dependencies.
  Gate: every Validity-layer rule either emits its rule code in a test, or is listed as
  not-test-covered with a stated reason.

HARD CONSTRAINTS — these are architectural decisions, not preferences

- core contains NO cryptography and handles NO secret key. There must be no code path that accepts
  one. (D12)
- build.ts emits UNSIGNED templates: {kind, created_at, tags, content}. No id, no pubkey, no sig —
  those are the injected signer's job. (D13)
- id.ts provides serializeForId(event) and eventIdMatches(event, sha256) with the HASH FUNCTION
  INJECTED. That is how core stays crypto-free while still being able to check that an event's id
  matches its contents. Use JSON.stringify for the serialization — this was investigated twice and
  it is correct by ecosystem convention. (D14, R11)
- ESM only. "sideEffects": false. Extension-ful subpath specifiers (./events.js, not ./events).
  NO DYNAMIC IMPORTS ANYWHERE — a lazy import that a bundler flattens is how matrix-js-sdk shipped an
  8.89 MB bundle for an empty project. (D9)
- patch.ts is INTERNAL. It must not appear in the exports map. Exposing the applier invites callers to
  bypass the determinism gate the spec says implementations MUST enforce. (D32)
- The four interfaces — RelayTransport, EventStorage, ScrutinySigner, TrustProvider — are branded with
  Symbol.for(), so two copies of core in one dependency tree still interoperate. (D16)
- The §9 indexer-prefix registry is OPEN DATA, never a closed enum. Rule IR-4 makes unknown prefixes
  valid, and the previous dead implementation rejected five prefixes that real data needs. (R13)
- NEVER put a version tag into a relay filter. The dead implementation did, silently dropping every
  higher-version event and violating VER-4 invisibly. Version handling is post-hoc and permissive.
- Runtime dependencies: `diff` only, and only reachable through the applier port. Zero dependencies is
  the declared goal. (D11)

ERRORS AND ANNOTATIONS: every Issue carries {code, layer, section} where code is an Appendix F rule ID.
tools/rules.json has all 134 with their layer and section — generate or validate against it, do not
retype them. (D40)

CONFORMANCE VECTORS DO NOT EXIST YET. Build the loading harness so it reads vectors/*.json and skips
cleanly when the directory is empty, then cover Phase 1 with hand-written unit tests. Vectors will be
authored in the spec repo later and vendored in at a pinned checksum.

WORKING STYLE
- Work phase by phase. Report at each phase gate with the gate result, then continue.
- Within a phase, work module by module and show me the public API surface before filling in bodies.
- Commit at each phase boundary with a conventional-commit message. Do not push, do not merge to main,
  do not open a PR.
- Do not touch ~/scrutiny-fabric. It is read-only for this session.

IF SOMETHING DOESN'T FIT: if the plan is impossible, ambiguous, or contradicts the spec, STOP and tell
me. Both the plan and the spec have already been through adversarial review that found real
contradictions, so a further one is entirely possible. Do not invent a resolution.
```

---

## After Phase 1

Start a **fresh session** for Phase 2. Its scope, from the plan:

> Write its own mini-spec before coding: how candidate positions are enumerated, how uniqueness is
> proven, how the pure-insertion carve-out is detected, how multiple changes sequence against
> already-modified content.
>
> Gate: the property test `applyPatch(a, makePatch(a, b)) === b` survives ≥10k generated cases with
> `fast-check`, including repeated-line content — the case that breaks the uniqueness rule and that
> hand-written tests rarely produce. Every counterexample found becomes a permanent vector.

Two things worth knowing before that session: no existing diff library enforces the spec's
exactly-once-context requirement — both `git apply` and `jsdiff.applyPatch` silently relocate changes
by context match — so that check is ours to write. And `jsdiff.applyPatch` fails in two different ways,
returning `false` on a context mismatch and *throwing* on truncated or swapped input; both must be
normalised into one rejection signal.

## Do not

- Relitigate settled decisions. `DECISIONS-2026-07-27.md` is append-only; add a correction rather than
  rewriting it.
- Hand-edit `tools/rules.json` — it is generated from the spec.
- Start Phase 2 in the same session as Phase 1.
