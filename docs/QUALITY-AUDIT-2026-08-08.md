# Quality & architecture audit — 2026-08-08

Branch `chore/architecture-audit-2026-08-08`. Tracking issue:
[#24](https://github.com/crocs-muni/scrutiny-fabric-tools/issues/24). This document and the issue are
kept in sync after every unit of work — either tool can be
picked up by a different session (Claude Code, OpenCode, or otherwise) and resume from the
**RESUME FROM HERE** line at the bottom without re-deriving state from scratch.

Purpose: make `@scrutiny-fabric/core` "really perfect" — architecturally elegant, modular, simplified,
test-strength-verified, and tooled ahead of comparable projects — before it becomes the real path to
`main`. Full brief context lives in the session that started this; this doc is the durable record.

---

## 0. What this branch actually is

Three lines of work combined onto one integration branch, per the session brief's Step 0:

- `main` (Phases 0–8, merged, 495 tests at last audit)
- The 12-PR stack, Phases 13–23 (`feature/phase-13-event-filter` … `feature/phase-23-ownership-codegen`
  plus `feature/phase-22-signer-example`) — fully coded, **zero prior real review**
- `fix/spec-v070-conformance` — F13/F14 spec conformance (PT-10/PT-11 endpoint typing; retirement of
  the three-digit version-tag scheme, spec v0.7.0)

**Correction to the session brief's own git commands, recorded here rather than silently fixed:** the
brief's Step 0 assumed `feature/phase-20-public-surface` and `feature/phase-23-ownership-codegen` were
two independent tips both needing an explicit merge. They are not — they are the same linear stack;
`feature/phase-20-public-surface`'s tip commit (`12dc9f8`) is a strict descendant of
`feature/phase-23-ownership-codegen`'s tip (`95c443c`), confirmed by `git merge` fast-forwarding
cleanly. The session that ran Step 0 initially misread this from the `git log` output and asked the
user to confirm a corrective plan before discovering the fast-forward proved the original brief
correct after all — no work was lost, but flagging the false alarm for the record. End state after
Step 0: `feature/phase-20-public-surface` + `feature/phase-22-signer-example` (examples only, clean
merge) + `fix/spec-v070-conformance` (auto-merged cleanly via `ort`, no textual conflicts). 530 tests
green after `pnpm ownership:gen` closed one drift (the ownership table hadn't picked up PT-10/PT-11).

Leftover from the false alarm: a branch named `chore/architecture-audit-2026-08-08-wrongbase` exists
locally, identical to `feature/phase-20-public-surface`'s tip, kept rather than force-deleted (`git
branch -D` requires explicit user authorization per this session's standing instructions). Safe to
delete at Step 8 close-out.

---

## 1. Per-module checklist

Line counts measured on this integration branch (post-merge baseline, not pre-merge — the brief asked
for integration-branch numbers). `rules.ts` is excluded: generated, never hand-reviewed.

| Module | Lines | Reviewed? | Status |
|---|---:|:---:|---|
| `version.ts` | 21 | ☐ | not started |
| `patch-types.ts` | 40 | ☐ | not started — new in Phase 20, extracted from `patch.ts` for P10 |
| `errors.ts` | 59 | ☐ | not started — one doc-comment fix already landed (Step 1, stale `{@link Issue.rule}`) |
| `id.ts` | 83 | ☐ | not started |
| `query.ts` | 121 | ☐ | not started |
| `interfaces.ts` | 156 | ☐ | not started — one doc-comment fix already landed (Step 1, malformed TSDoc code span) |
| `index.ts` | 181 | ☐ | not started — the public barrel; Knip found `HaltRule` missing from its re-exports (see Findings §1) |
| `patch-matcher.ts` | 215 | ☐ | not started — extracted in Phase 18 |
| `events.ts` | 277 | ☐ | not started |
| `patch.ts` | 392 | ☐ | not started — **thermo-nuclear review** (historically highest-risk); one doc-comment fix already landed |
| `build.ts` | 407 | ☐ | not started — one doc-comment fix already landed |
| `admit.ts` | 526 | ☐ | not started — **thermo-nuclear review**; Knip found `bindingEndpoints`/`BindingEndpoints` unexported (see Findings §1); one doc-comment fix already landed |
| `resolve.ts` | 530 | ☐ | not started — **thermo-nuclear review** |
| `validate.ts` | 680 | ☐ | not started |
| `store.ts` | 882 | ☐ | not started — **thermo-nuclear review**; three doc-comment fixes already landed (unescaped `>`) |

15 modules, 0 reviewed. Step 3 (multi-agent review) has not started.

---

## 2. Tool-setup checklist (Step 1)

All items complete; `pnpm verify` green end-to-end as of commit `8aeb981`.

| Tool | Status | Note |
|---|:---:|---|
| Knip (dead code) | ✅ | `knip.json`. `exports`/`types` categories set to `warn` pending Step 3 (see Findings §1) |
| publint (package shape) | ✅ | Clean, no findings |
| `@microsoft/api-extractor` (public-surface report) | ✅ | `packages/core/api-extractor.json`, report at `packages/core/etc/api-report.api.md`. Fixed 5 broken TSDoc comments blocking strict mode |
| size-limit (bundle-size gate) | ✅ | `.size-limit.json`. Full barrel 18.97 kB (brotli) / 20 kB limit; `id.js` subpath 187 B / 1 kB limit — proves D5 tree-shaking works |
| zizmor (workflow static analysis) | ✅ | Found + fixed: 3 unpinned-action-uses (now SHA-pinned), 1 credential-persistence warning (`persist-credentials: false` added). Separate CI job, offline mode |
| `dependabot.yml` | ✅ | `github-actions` ecosystem only, scoped per brief (npm surface too small to justify) |
| `pnpm audit --prod` | ✅ | **Finding**: `--prod` does not scope to production-only dependencies in this pnpm version's workspace mode (verified: byte-identical output to plain `pnpm audit`). 3 findings, all dev-only chains (`@changesets/cli`→`js-yaml`, `vitest`→`nanoid`); `diff`, the sole runtime dependency, was clean throughout. Pinned both via `pnpm.overrides`, following the existing vite/esbuild precedent, rather than relying on `--prod` to filter |
| Changeset-presence CI gate | ✅ | `pnpm changeset:check` (`changeset status --since=main`), separate CI job, PR-only, `fetch-depth: 0`. **Deliberately not added to local `pnpm verify`** — this branch has no changeset yet (see Findings §2) and won't until its final scope is known at Step 8; forcing one prematurely would just need constant rewriting |

Declined (per brief, not re-litigated): oxlint, Renovate/npm-scoped Dependabot, CodeQL, Turborepo/
syncpack/Bun, Socket Security, mitata, jazzer.js-as-permanent-adoption.

---

## 3. Findings log

| # | Module | Finding | Severity | Verdict | Action |
|---|---|---|---|---|---|
| 1a | `admit.ts` / `index.ts` | Knip: `bindingEndpoints` (function) and `BindingEndpoints` (interface) exported from `admit.ts` but never imported anywhere, including the barrel | Low | unverified | Deferred to Step 3's `admit.ts` review — decide export-and-barrel vs. un-export |
| 1b | `patch.ts` / `index.ts` | Knip: `patch.ts` re-exports `ApplyOptions`/`HaltReason`/`LimitKind` from `patch-types.ts` (Phase 20's P10 fix) and `index.ts` re-exports those three from the barrel — but **`HaltRule` is missing from the barrel**, even though `PatchHalt.rule` is publicly typed with it. Also `PatchApplied`/`PatchNoop`/`PatchHalt`/`PatchLimit` (the `ApplyResult` variants) are still unexported anywhere | Medium | unverified | Deferred to Step 3's `patch.ts` review (P10 was only 3/4 done — the `HaltRule` gap looks like a plain oversight, not a judgment call, but routing it through the same adversarial-verify process as everything else in Step 3 rather than fixing ad hoc) |
| 2 | (process, not code) | This branch has no changeset despite carrying several breaking changes (`refactor(core)!:` commits from the merged stack). The changeset-presence CI gate (Step 1) correctly flags this | N/A | confirmed | Not fixed yet — deferred to Step 8 close-out, once the branch's final diff (after Step 3's applied fixes) is known. Do not add a placeholder changeset now; it would need rewriting after every Step 3 commit |
| 3 | tooling | `pnpm audit --prod` doesn't scope to prod-only deps in this pnpm workspace (pnpm 9.15.9) | Low | confirmed | Worked around via `pnpm.overrides` (see §2 above); not a code defect |
| 4 | process | Session brief's Step 0 git commands assumed two independent stack tips; they're actually one linear stack | N/A | refuted (false alarm) | No action — documented in §0 for anyone re-reading the session transcript |

---

## 4. Steps 4–9 status

Not started. Full step list for reference (see the session brief for detail):

- [ ] Step 3 — multi-agent module review (Workflow tool), both lenses, thermo-nuclear on store/patch/resolve/admit, adversarial verification
- [ ] Step 4 — regression-test backfill (`test/resolve-regressions.ts`, `test/admit-regressions.ts`, `test/store-regressions.ts`)
- [ ] Step 5 — Stryker mutation testing (patch.ts, admit.ts, resolve.ts scoped)
- [ ] Step 6 — browser memory investigation (closes `AUDIT-2026-07-31.md` hazard #4)
- [ ] Step 7 — doc debt (IMPLEMENTATION-PLAN status table refresh beyond the ownership table; DECISIONS §5's 5 open questions; retire spent planning docs)
- [ ] Step 8 — close out (finalize skill, `pnpm verify` clean, changeset added, tool green-or-justified, doc/issue to 100%)
- [ ] Step 9 — report PR reconciliation recommendation for #11–23, wait for go-ahead (do not close PRs)

---

## RESUME FROM HERE

**Step 0 and Step 1 are complete.** Next: Step 2's remaining half (mirror this doc as a GitHub issue —
in progress), then Step 3, starting with the per-module Workflow-based review. Nothing in Steps 4–9 has
begun. If resuming in a different tool: `git fetch && git checkout chore/architecture-audit-2026-08-08`,
read §0–§3 above, then continue at Step 3.
