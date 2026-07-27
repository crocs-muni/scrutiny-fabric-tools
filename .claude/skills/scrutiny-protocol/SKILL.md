---
name: scrutiny-protocol
description: Working rules for implementing @scrutiny-fabric/core, the TypeScript reference implementation of the SCRUTINY Fabric protocol. Use whenever editing anything under packages/core, citing a protocol rule ID (TAG-1, BD-3, T1, DEL-5, …), touching tools/rules.json or rules.ts, reading or amending the protocol spec, or planning a phase of the implementation plan. Covers the hard architectural invariants, the traps that killed two previous implementations, and the rule-citation discipline.
license: MIT
metadata:
  spec-version: "0.6.0"
  spec-tag: scrutiny-v060
---

# Implementing SCRUTINY Fabric

## Orient first

Read in this order. Do not skip 2 — it exists to stop you redoing settled work.

1. `docs/IMPLEMENTATION-PLAN.md` — what to build, in what order. The work order.
2. `docs/DECISIONS-2026-07-27.md` — 45 decisions and 13 rejected alternatives, with rationale.
   **Append-only.** If a decision looks wrong, say so and stop; add a correction entry rather than
   quietly doing something else.
3. `~/scrutiny-fabric/docs/protocol-spec.md` — v0.6.0, 134 rules. The only normative source.
   Appendix F is the flat index.
4. `docs/SPEC-FEEDBACK-v0.6.0.md` — verified spec defects and how this implementation handles each.

**`~/scrutiny-fabric` is read-only.** Never edit the spec from this repo. A defect found while
implementing goes into `SPEC-FEEDBACK-v0.6.0.md` with the line number and the evidence — batched, not
worked around locally (D2).

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
| **Runtime dependencies: `diff` only**, reachable solely through the applier port. | D11. Zero dependencies is the declared goal. |

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

## Working conventions

- Branch `feature/…`, `fix/…`, `chore/…`. Conventional commits. **Never push to main; always a PR.**
- Commit at each phase boundary.
- **No sign-off trailers.** No `Co-Authored-By`, no `Signed-off-by`. Use `git commit -m "message"`.
- Never commit `.env`, `*.nsec`, `*.key`.
- `investigations/` is gitignored **except** `REPORT.md` files, which the spec's Appendix E cites by
  path.
