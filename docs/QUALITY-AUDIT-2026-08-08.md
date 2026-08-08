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
| `version.ts` | 21 | ✅ | reviewed — 1 finding applied (S3-5) |
| `patch-types.ts` | 40 | ✅ | reviewed (with `patch.ts` task) — new in Phase 20, extracted from `patch.ts` for P10 |
| `errors.ts` | 59 | ✅ | reviewed — 2 flagged (S3-14, S3-15) — one doc-comment fix already landed (Step 1, stale `{@link Issue.rule}`) |
| `id.ts` | 83 | ✅ | reviewed — clean, 0 findings |
| `query.ts` | 121 | ✅ | reviewed — 2 flagged (S3-13, S3-16) |
| `interfaces.ts` | 156 | ✅ | reviewed — 2 findings applied (S3-9, S3-10); one doc-comment fix already landed (Step 1, malformed TSDoc code span) |
| `index.ts` | 181 | ✅ | reviewed — 1 flagged (S3-25) — the public barrel; Knip found `HaltRule` missing from its re-exports (see Finding 1b: verified half-stale, `HaltRule` is in the barrel now) |
| `patch-matcher.ts` | 215 | ✅ | reviewed (with `patch.ts` task; `scanCost` added here for S3-6) — extracted in Phase 18 |
| `events.ts` | 277 | ✅ | reviewed — 1 flagged (S3-11), 2 refuted (S3-31, S3-32) |
| `patch.ts` | 392 | ✅ | reviewed, **dual-lens + thermo-nuclear** — 3 flagged (S3-18, S3-19, S3-20), 1 applied (S3-7), 2 refuted (S3-33, S3-34); one doc-comment fix already landed |
| `build.ts` | 407 | ✅ | reviewed — 1 applied (S3-6), 1 flagged (S3-17); one doc-comment fix already landed |
| `admit.ts` | 526 | ✅ | reviewed, **dual-lens + thermo-nuclear** — 6 flagged (S3-22, S3-23, S3-26, S3-27, S3-28, S3-29); Knip found `bindingEndpoints`/`BindingEndpoints` unexported (Finding 1a: verified, see §3); one doc-comment fix already landed |
| `resolve.ts` | 530 | ✅ | reviewed, **dual-lens + thermo-nuclear** — 2 flagged (S3-21, S3-30), 1 refuted (S3-36) |
| `validate.ts` | 680 | ✅ | reviewed — 1 flagged (S3-12; the checkBinding/checkPatch duplication question: verified *coincidental similarity, not worth extracting*, and P1 confirmed not re-introduced) |
| `store.ts` | 882 | ✅ | reviewed, **dual-lens + thermo-nuclear** — 1 applied (S3-8), 1 flagged (S3-24), 1 refuted (S3-35); three doc-comment fixes already landed (unescaped `>`) |

15 modules, 15 reviewed. Step 3 complete: 32 distinct findings — **6 applied directly, 20 flagged
for human decision, 6 refuted** (§3 table; full evidence and refuter reasoning in
`docs/QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json`).

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
| 1a | `admit.ts` / `index.ts` | Knip: `bindingEndpoints` (function) and `BindingEndpoints` (interface) exported from `admit.ts` but never imported anywhere, including the barrel | Low | **verified** (Step 3: S3-23, S3-25, S3-27) | resolution per S3-27 (verified 3/3): **add both to the barrel** — `BindingEndpoints` is already public via `AdmitState.liveBindings`, so un-exporting is the wrong fix; S3-25 confirms the `./admit.js` subpath leaks them anyway; the stale doc comment justifying the current state dies with the fix. Awaiting human go-ahead |
| 1b | `patch.ts` / `index.ts` | Knip: `patch.ts` re-exports `ApplyOptions`/`HaltReason`/`LimitKind` from `patch-types.ts` (Phase 20's P10 fix) and `index.ts` re-exports those three from the barrel — but **`HaltRule` is missing from the barrel**, even though `PatchHalt.rule` is publicly typed with it. Also `PatchApplied`/`PatchNoop`/`PatchHalt`/`PatchLimit` (the `ApplyResult` variants) are still unexported anywhere | Medium | **verified — half-stale** (S3-20, 2/3) | Step 3 closed the first half: `HaltRule` IS in the barrel now (the gap described above was already fixed). True remainder: the four `ApplyResult` variant interfaces (`PatchApplied`/`PatchNoop`/`PatchHalt`/`PatchLimit`) are still unexported anywhere — human decision on exporting them |
| 2 | (process, not code) | This branch has no changeset despite carrying several breaking changes (`refactor(core)!:` commits from the merged stack). The changeset-presence CI gate (Step 1) correctly flags this | N/A | confirmed | Not fixed yet — deferred to Step 8 close-out, once the branch's final diff (after Step 3's applied fixes) is known. Do not add a placeholder changeset now; it would need rewriting after every Step 3 commit |
| 3 | tooling | `pnpm audit --prod` doesn't scope to prod-only deps in this pnpm workspace (pnpm 9.15.9) | Low | confirmed | Worked around via `pnpm.overrides` (see §2 above); not a code defect |
| 4 | process | Session brief's Step 0 git commands assumed two independent stack tips; they're actually one linear stack | N/A | refuted (false alarm) | No action — documented in §0 for anyone re-reading the session transcript |

### Step 3 findings (multi-agent module review)

Method: 17 review passes (dual-lens on all 15 modules + thermo-nuclear on patch/resolve/admit/
store), 3 independent adversarial refuters per finding, majority-of-valid-votes survival rule.
Severity column is the finding's category (correctness=act-now, public-surface/spec-citation/
architecture=decision-needed, duplication/simplification/test-coverage=triage). Full evidence +
refuter reasoning per finding: `docs/QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json`. **Applied
directly** rows are in the `refactor(core)`/`docs(core)` commits closing this step; **flagged**
rows are written up for human review, NOT auto-applied. Vote notation: ✓ = refuter could not
refute, R = refuted; "orig run" = fully verified in the first run.

| # | Module | Finding | Severity | Verdict | Action |
|---|---|---|---|---|---|
| S3-5 | `version.ts` | [simplification] `VERSION_TAG` hand-duplicates `SPEC_VERSION`'s literal instead of deriving it | simplification | verified 3/3 (orig run) | **applied** |
| S3-6 | `build.ts` | [duplication] F12's per-hunk cost formula duplicated verbatim between `patch.ts`'s applier and `build.ts`'s widening loop | duplication | verified 3/3 | **applied** — extracted `scanCost` into `patch-matcher.ts`, both call sites share it |
| S3-7 | `patch.ts` | [simplification] Ceilings doc comment duplicated verbatim across `patch.ts` and `patch-types.ts` | simplification | verified 3/3 | **applied** — `patch.ts` copy now a one-line pointer; `patch-types.ts` canonical |
| S3-8 | `store.ts` | [architecture] `ResolveMemo.eventsCache` doc asserts identity-swap semantics that are false (fresh `observedById` clone on *every* delta), so the events cache spuriously rebuilds on `trust()`/`untrust()` — a perf cliff on D24's cheapest path, verified live | architecture | verified 3/3 | **applied** — cache gated on `observedEpoch`; false doc comment corrected; api-report regenerated |
| S3-9 | `interfaces.ts` | [simplification] Stale module-header comment claims `RelayTransport` is not yet in this file | simplification | verified 3/3 (+1 merged vote from a recovered duplicate-run finding) | **applied** |
| S3-10 | `interfaces.ts` | [simplification] `TrustProvider` docstring stale about Phase 5 and where `version`/`deltaSince` are called | simplification | verified 3/3 | **applied** — now points at Phase 16 / TRUST-VIEW.md |
| S3-11 | `events.ts` | [correctness] `compareVersionTags` loses precision on version fields wider than 2^53, silently reintroducing a digit-count ceiling | correctness | verified 3/3 (orig run) | human decision |
| S3-12 | `validate.ts` | [duplication] checkBinding's BD-3/4/5 endpoint typing vs checkPatch's PT-10/11 typing: **coincidental similarity, not worth extracting** — this answers the module's specific review question | duplication | verified 3/3 (orig run) | human decision (endorsed verdict: leave separate) |
| S3-13 | `query.ts` | [test-coverage] `classifyByRole`'s Patch (root/reply) path never exercised by a test, despite the module's gate documentation promising it | test-coverage | verified 3/3 (orig run) | human decision — natural Step 4 input |
| S3-14 | `errors.ts` | [spec-citation] module doc understates TR-1: says D-layer only, but spec and the actual invariant test cover A-layer too | spec-citation | verified 3/3 (orig run) | human decision |
| S3-15 | `errors.ts` | [architecture] `issue()` accepts reserved RuleIds (e.g. OV-1) with no builder- or type-level guard | architecture | verified 3/3 (orig run) | human decision |
| S3-16 | `query.ts` | [duplication] kind-5 (NIP-09 deletion) is a repeated hand-typed magic number across four modules, unlike `SCRUTINY_KIND`'s single-source treatment for kind 1 | duplication | verified 3/3 | human decision |
| S3-17 | `build.ts` | [public-surface] `widenContext`/`WidenResult` exported publicly, leaking an internal-only algorithm (and a `patch-matcher.ts` type) into `build.ts`'s published API | public-surface | verified 3/3 | human decision |
| S3-18 | `patch.ts` | [correctness] **T2's out-of-range insertion clamp corrupts content when clamping against the trailing-newline sentinel** | correctness | verified 3/3 | human decision — same defect as S3-19, found by both lenses independently |
| S3-19 | `patch.ts` | [correctness] **T2 insertion clamp uses `lines.length` instead of `lineCount(lines)`, silently inserting a spurious blank line when content ends with a trailing newline** | correctness | verified 3/3 | human decision — same defect as S3-18, found by both lenses independently |
| S3-20 | `patch.ts` | [public-surface] item 1b is half-stale: `HaltRule` now in the barrel, but the four `ApplyResult` variants remain unexported anywhere | public-surface | verified 2/3 | human decision (updates Finding 1b) |
| S3-21 | `resolve.ts` | [test-coverage] `parent === undefined` branch of PT-6/OV-8's linkable filter completely untested, appears behaviorally inert | test-coverage | verified 3/3 | human decision — natural Step 4 input |
| S3-22 | `admit.ts` | [correctness] **trusted-but-mistyped Bindings still credit admission to their wrongly-typed endpoints (BD-3/BD-4/BD-5 gap)** | correctness | verified 3/3 | human decision |
| S3-23 | `admit.ts` | [public-surface] `bindingEndpoints`/`BindingEndpoints` are genuinely dead public exports; the doc comment justifying them is stale | public-surface | verified 2/3 | human decision — superseded by S3-27's resolution (see Finding 1a) |
| S3-24 | `store.ts` | [architecture] in-memory storage's deletion-hiding cache is invalidated by every `put()`, forcing a full O(total-events) rescan on next `query()` even for puts unrelated to any deletion | architecture | verified 3/3 | human decision |
| S3-25 | `index.ts` | [public-surface] `bindingEndpoints`/`BindingEndpoints` leak through the `./admit.js` subpath despite being correctly withheld from the barrel | public-surface | verified 2/3 | human decision (updates Finding 1a) |
| S3-26 | `admit.ts` | [correctness] **record-key prototype hazard: an event id of `"__proto__"` silently corrupts `AdmissionIndex`/`AdmitState` and diverges the incremental path from the oracle** | correctness | verified 3/3 | human decision |
| S3-27 | `admit.ts` | [public-surface] barrel omission is real, but un-exporting is the wrong fix — `BindingEndpoints` is already on the public surface via `AdmitState.liveBindings` | public-surface | verified 3/3 | human decision — the coherent resolution for 1a/S3-23/S3-25: add to barrel |
| S3-28 | `admit.ts` | [correctness] **`EMPTY_ADMIT_STATE` is only shallow-frozen — nested records/arrays are mutable, diverging from `store.ts`'s deep-freeze convention** | correctness | verified 3/3 | human decision |
| S3-29 | `admit.ts` | [test-coverage] untrust-narrowing hazard (`invertDelta` must reject standalone untrust) enforced only by the ForwardDelta type + doc comments; no named, greppable regression case | test-coverage | verified 2/3 | human decision — natural Step 4 input |
| S3-30 | `resolve.ts` | [test-coverage] root-retraction path through `resolve()` unpinned — chain preservation rests on an undocumented-in-tests removed-vs-deleted seeding distinction | test-coverage | verified 3/3 | human decision — natural Step 4 input |
| S3-31 | `events.ts` | [duplication] event-type tag strings independently re-derived in `validate.ts`/`store.ts` | — | refuted 0/3 survived (orig run) | no action |
| S3-32 | `events.ts` | [simplification] `eTags` repeats the same conditional-spread pattern twice inline | — | refuted (orig run) | no action |
| S3-33 | `patch.ts` | [public-surface] "1b re-verified: `HaltRule` gap already fixed" — the framing overstated the remaining gap | — | refuted 0/3 survived (R R R) | no action (substance recorded at S3-20) |
| S3-34 | `patch.ts` | [correctness] T1's uniqueness count ignores the `oldNoEol` marker, causing a spurious ambiguous-match halt | — | refuted 1/3 survived | no action |
| S3-35 | `store.ts` | [correctness] `pendingAwaiting` leaks a stale entry on asymmetric Binding endpoint resolution | — | refuted 0/3 survived | no action |
| S3-36 | `resolve.ts` | [simplification] `cascade()` is O(patches × depth) via rescanning candidates each fixpoint round | — | refuted 0/3 survived | no action |

Process note (for the record): the original Claude Code run launched all 89 review/verify agents
and completed 45 before an API usage limit interrupted it with results unconsumed; the workflow's
on-disk journal + output snapshot preserved the full prompts and partial state. A follow-up
OMP/Kimi session re-ran the 44 failed agents (3 reviews, 41 verifications) with byte-identical
prompts, recovered 7 verdicts + 4 findings from duplicate run-1 agents in the journal, and
completed all 66 verification votes. One run-1 `interfaces.ts` finding was recovered from the
journal and merged into S3-9 (same stale header comment, independently found).

Housekeeping left by the interrupted session, stashed (not deleted) to unblock `pnpm lint`:
`git stash` entry "step3-resume: prior session's untracked scratch" holds `_scratch_ts_test/`,
`_scratch_verify/`, `packages/core/scratch-repro.ts`, `packages/core/test/scratch_t2.test.ts`,
`packages/core/test/zz-verify-bug.test.ts` — pop it if any of that scratch is wanted, else drop.
`docs/START-SESSION-SPEC-FEEDBACK.md` is still untracked (not stashed; looks intentional).

---

## 4. Steps 4–9 status

- [x] Step 3 — multi-agent module review (both lenses, thermo-nuclear on store/patch/resolve/admit, adversarial verification). **Complete with an interruption caveat**: 45/89 agents completed in the original run; the remaining 44 were re-run from on-disk state (see §3 process note). 6 apply-directly findings applied + committed; 20 flag-for-human findings await human triage (`docs/QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json`)
- [ ] Step 4 — regression-test backfill (`test/resolve-regressions.ts`, `test/admit-regressions.ts`, `test/store-regressions.ts`)
- [ ] Step 5 — Stryker mutation testing (patch.ts, admit.ts, resolve.ts scoped)
- [ ] Step 6 — browser memory investigation (closes `AUDIT-2026-07-31.md` hazard #4)
- [ ] Step 7 — doc debt (IMPLEMENTATION-PLAN status table refresh beyond the ownership table; DECISIONS §5's 5 open questions; retire spent planning docs)
- [ ] Step 8 — close out (finalize skill, `pnpm verify` clean, changeset added, tool green-or-justified, doc/issue to 100%)
- [ ] Step 9 — report PR reconciliation recommendation for #11–23, wait for go-ahead (do not close PRs)

---

## RESUME FROM HERE

**Steps 0–3 are complete.** Next: **human triage of the 20 flag-for-human findings** (§3, full
evidence in `docs/QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json`) — start with the five correctness
defects, all verified 3/3 by adversarial refuters:

1. S3-18/S3-19 — `patch.ts` T2 insertion clamp corrupts content at the trailing-newline sentinel
   (`lines.length` where `lineCount(lines)` is meant; two review lenses found it independently)
2. S3-22 — `admit.ts` trusted-but-mistyped Bindings still credit admission (BD-3/4/5 gap)
3. S3-26 — `admit.ts` record-key prototype hazard (`"__proto__"` as event id)
4. S3-28 — `admit.ts` `EMPTY_ADMIT_STATE` only shallow-frozen
5. S3-11 — `events.ts` `compareVersionTags` 2^53 precision ceiling

Then the public-surface decisions (S3-17, S3-20, and the 1a/S3-23/S3-25/S3-27 cluster whose
verified recommendation is: **add `bindingEndpoints`/`BindingEndpoints` to the barrel**), then
Step 4 regression backfill (S3-13, S3-21, S3-29, S3-30 are its named inputs).

If resuming in a different tool: `git fetch && git checkout chore/architecture-audit-2026-08-08`,
read §0–§3 above, then triage. Housekeeping: one `git stash` entry holds the interrupted session's
untracked scratch files (details in §3 process note — pop or drop); `docs/START-SESSION-SPEC-FEEDBACK.md`
remains untracked and looks intentional; `chore/architecture-audit-2026-08-08-wrongbase` still awaits
the user's explicit `git branch -D` authorization.
