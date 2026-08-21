---
name: scrutiny-protocol
description: Working rules for implementing @scrutiny-fabric/core, the TypeScript reference implementation of the SCRUTINY Fabric protocol. Use whenever editing anything under packages/core, citing a protocol rule ID (TAG-1, BD-3, T1, DEL-5, …), touching tools/rules.json or rules.ts, reading or amending the protocol spec, or planning a phase of the implementation plan. Covers the hard architectural invariants, the traps that killed two previous implementations, and the rule-citation discipline.
license: MIT
metadata:
  spec-version: "0.8.1"
  spec-tag: scrutiny-v080
---

# Implementing SCRUTINY Fabric

## Orient first

Read in this order. Do not skip 2 — it exists to stop you redoing settled work.

1. `docs/DECISIONS-2026-07-27.md` — the architecture decision record. Append-only; if a decision
   looks wrong, add a correction entry rather than quietly doing something else. §6 carries the
   build-order rationale and the docs-doctrine decision (C14).
2. `~/scrutiny-fabric/docs/protocol-spec.md` — v0.8.1, 142 rules. The only normative source.
   Appendix F is the flat index.
3. Spec-feedback findings (F1–F18) are issues on `crocs-muni/scrutiny-fabric` (label
  `spec-feedback`). Cite by F-number; the issue resolves it.

**`~/scrutiny-fabric` is read-only.** Never edit the spec from this repo. A defect found while
implementing becomes a new spec-feedback issue on the spec repo (next free F-number) with the
line number and the evidence — batched into an amendment session, not worked around locally (D2).

## Why this project is paranoid

Two previous implementations died of **protocol drift, not bad code**. One targeted spec v0.3.2 while
the spec reached v0.5.9, with a version constant (`scrutiny_v032`) in a form the spec no longer
recognised. Nothing in CI ever complained. The countermeasure adopted is generated, CI-enforced rule
coverage — not discipline. Respect the machinery; it is load-bearing.

## Hard invariants

These are architectural decisions, not preferences. Breaking one is a design change, not a bug fix.

| Invariant | Why |
|---|---|
| **No cryptography, ever. No code path accepts a secret key.** Hashes are injected. | D12. Enforced by a Biome `noRestrictedImports` rule over `packages/*/src/**`, and by `"types": []` in `tsconfig.build.json` so `node:` imports and Node globals fail the build. |
| **`build.ts` emits unsigned templates**: `{kind, created_at, tags, content}`. No `id`, `pubkey`, `sig`. | D13. Those are the injected signer's job; NIP-07 computes them natively. |
| **ESM only**, `sideEffects: false`, extension-ful specifiers (`./events.js`). **No dynamic imports anywhere.** | D9. A lazy `import()` that a bundler flattens is how matrix-js-sdk shipped an 8.89 MB bundle for an empty project. |
| **`patch.ts` is internal** and must never appear in the exports map. | D32. Exposing the applier invites callers to bypass the determinism gate §5.3 says implementations MUST enforce. |
| **The four interfaces are branded with `Symbol.for()`.** | D16. Two copies of core in one dependency tree still interoperate — the structural fix for NDK #312. |
| **The §9 indexer prefix registry is open data, never a closed enum.** | IR-4 and R13. The dead implementation's closed check rejected `pp`, `vendor`, `scheme`, `cc-cert-id`, `cc-scheme` — all present in real data. |
| **Never put a version tag into a relay filter.** | The dead engine did, silently dropping every higher-version event and violating VER-4 invisibly. Version handling is post-hoc and permissive. |
| **Every consumed event MUST have both its signature and its `id` verified before processing.** | SIG-1 (v0.8.0). The signature commits to `id` (a hash); a relay can alter `content`/`tags` while keeping `id`+`sig`, and a signature-only check still passes. `id.ts` computes the recompute half; the signature half is the caller-injected `verify` function (D18). Applies to **every** event, including kind 5 deletions — an unverified deletion is indistinguishable from a forged one. |
| **Conformance vectors are normative (Appendix G).** | D33. Vendored from the spec repo at a pinned SHA-256; `test/vectors-checksum.test.ts` checks the digests, `test/resolve-vectors.test.ts` runs the cases. Every `chain` case MUST hold under **any permutation** of its `events` array (UR-1 confluence), not merely the order given. The corpus is incomplete by design — a rule's absence is not a claim it is untestable. |

## Rule citation discipline

The chain is `protocol-spec.md` → `tools/rules.json` → `packages/core/src/rules.ts`, and **no link is
hand-written**.

- **Never hand-edit `rules.json` or `rules.ts`.** Regenerate: `pnpm rules:gen`. CI runs
  `pnpm rules:check` and fails on drift.
- **Never hand-type a rule's layer or section.** Build issues with `issue(code, severity, message)`
  from `errors.ts`; it looks both up from the registry, so an `Issue` cannot cite a rule with the
  wrong metadata attached (D40).
- `RuleId` is a generated literal union, so citing a rule absent from the spec is a **compile error**,
  not a CI check.

### Severity, and the TR-1 invariant

`severity: 'error' | 'warning'` has **no basis in the spec** — §6.0 gives the Validity layer exactly
one disposition. It is a local affordance, recorded in SPEC-FEEDBACK. The invariant that keeps it
honest, asserted in `test/invariants.test.ts`:

> No issue citing a **D-layer** rule may ever be an `error`.

TR-1: a V-valid event MUST NOT be rejected by an A or D rule.

### Coverage is observed emission, never annotation

D34. A rule is covered when a test **observes its code being emitted**, or it is listed as
not-test-covered **with a written reason**. `test/_v-coverage.ts` holds the partition and it is
machine-checked against the generated registry.

Do not invent an "info" issue for a rule that has no failure mode just to score it. That makes the
coverage number lie in exactly the way D34 exists to prevent. Rules with no emission fall into honest
buckets: permissions (IR-4, VER-2), MUST-ACCEPT obligations (C7, N2), definitional rules (E5, IR-3),
producer-only rules unfalsifiable on receipt (P1, E4), and meta-rules (TR-1).

## Recurring traps

- **A rule tagged V is not automatically a rejection rule.** §6.0's V manifest is demonstrably
  over-broad — it cites §5.1, whose only two rules are tagged A. Before enforcing a V rule as a
  rejection, ask: *is this predicate true of conformant output?* P1's is not (see SPEC-FEEDBACK F1).
- **The §5.2 consumer grammar is a floor on acceptance, not a ceiling.** Tolerate unrecognised lines;
  reject only what a rule explicitly forbids.
- **The grammar cannot be implemented literally.** Its `*VCHAR` is ABNF `%x21-7E`, excluding SP and
  all non-ASCII — it would reject the spec's own em-dash example. Treat a line body as any sequence
  of characters other than LF (SPEC-FEEDBACK F3).
- **Never discard an event whose reference has not arrived.** UR-1 makes ingestion confluent: state
  depends only on the *set* of events observed, never on arrival order. Return `pending`, not
  `invalid`. A Binding's endpoint typing may be cached once observed (UR-3); a Patch's authorship
  class may **not**, because it changes when the root arrives.
- **A root-author patch whose `e reply` parent is unobserved is held, not optimistically included.**
  UR-4 (v0.8.0, F16). This is the third dangling-reference shape — UR-2 covers an unobserved root,
  BD-6 covers unobserved Binding endpoints. The reference implementation once had an optimistic
  `parent === undefined` disjunct in its `linkable` filter that was behaviorally inert at fixpoint but
  untested — hold-pending was ratified to match every other pending lifecycle (BD-6, DEL-8, UR-2):
  report `held`, never approximate-*resolved*. Two children of one dangling parent would fire SF-1
  and freeze canonical bytes behind an error annotation for a fork that may evaporate when the parent
  arrives. Overlay targeting a held patch is orphaned (OV-3).
- **`created_at` is publish time, not the time of the fact.** Deployed relays reject events outside a
  bounded window — verified: strfry `rejectEventsOlderThanSeconds = 94608000` (three years),
  `rejectEventsNewerThanSeconds = 900`. Backdating a certificate's issue year means **silent**
  rejection of the whole corpus. Historical dates go in `content` (CA-1).
- **Trust is applied at presentation time only** (TR-7). Filtering before chain construction
  silently conceals self-forks and HALT. Chain resolution never reads the trust set (D25).

## Commands

```bash
pnpm verify
```

Runs lint, typecheck, rule-registry sync, build, ATTW, and tests — the same sequence CI runs. Use it
before every commit. Individual steps: `pnpm lint`, `pnpm typecheck`, `pnpm rules:check`,
`pnpm build`, `pnpm attw`, `pnpm test`, and `pnpm format` to apply Biome fixes.

## Mutation testing (`packages/core`)

`pnpm test:mutate` runs StrykerJS scoped to `patch.ts`, `admit.ts`, `resolve.ts` (config:
`packages/core/stryker.config.mjs`; narrow with `--mutate src/patch.ts`). Deliberately **not** in
`pnpm verify` — run it when a change alters the behaviour of those three modules, and clean up
every survivor: kill it with a stronger test, or justify it. Accepted justifications, in order of
preference: a `// Stryker disable next-line <Mutators>: <evidence>` comment for provably
equivalent mutants, or a landed test the runner attests as a kill.

Do **not** trust Stryker's verdicts at face value — all of these were measured in the 2026-08-09
audit (evidence in #48 §3 Step-5; do not re-derive):

- The vitest runner's per-mutant test selection can mark a genuinely suite-killed mutant as
  Survived (stryker-js #6073-class, ~1 in 30 mutants here). Any disputed survivor gets an
  offset-spliced hand-check against the **full** suite before it may be called equivalent.
- Its disable-comment binding fails on some positions (stacked/merged comments, certain
  `if/else`-chain arms): rerun and confirm the mutant reports as `Ignored` before counting it.
- Incremental mode replays stale verdicts across test edits: it is `false` in the committed
  config; acceptance scores come only from plain `pnpm test:mutate`.
- `coverageAnalysis` is silently ignored by the vitest runner (always perTest).

## Working conventions

- Branch `feature/…`, `fix/…`, `chore/…`. Conventional commits. **Never push to main; always a PR.**
- Commit at each phase boundary.
- **No sign-off trailers.** No `Co-Authored-By`, no `Signed-off-by`. Use `git commit -m "message"`.
- Never commit `.env`, `*.nsec`, `*.key`.
- `investigations/` is gitignored **except** `REPORT.md` files, which the spec's Appendix E cites by
  path.
