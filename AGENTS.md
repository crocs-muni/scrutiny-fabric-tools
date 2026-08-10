# AGENTS.md — scrutiny-fabric-tools

## Project

`@scrutiny-fabric/core` — reference implementation of the SCRUTINY Fabric protocol (spec v0.8.0).
Sans-IO, crypto-free, ESM-only TypeScript. Private today, going public soon. `diff` is the sole
runtime dependency; everything else is dev-only.

This file is the **rulebook** (how to work). The audit doc (`docs/QUALITY-AUDIT-*.md`) is the
**durable state** (what was done, what's next). GitHub Issues are the **board** (what/why/status).
Read all three before starting; they are not redundant.

## Source of truth

- **Spec repo** (`crocs-muni/scrutiny-fabric`, public, read-only from here): `protocol-spec.md` is
  the only normative source. `tools/rules.json` is generated from it; never hand-edit.
- **This repo**: `packages/core/src/` is the implementation. `.claude/skills/scrutiny-protocol/`
  carries the deep invariants and recurring traps (read it before touching `packages/core`).
- **Spec feedback** (`docs/spec-changes/`): one file per finding (F1, F2, …), status-tracked.
  D2: gaps are batched into amendment briefs, never worked around locally.
- **Audit**: `docs/QUALITY-AUDIT-2026-08-08.md` tracks the multi-step quality audit (Steps 0–9);
  its RESUME footer is the per-campaign checkpoint.

## Commands

```bash
pnpm verify                          # lint + typecheck + rules-sync + knip + build + publint + api-report + attw + size + audit + test (the CI gate)
pnpm test                            # vitest run (tests only)
pnpm test:mutate                     # StrykerJS mutation testing (patch/admit/resolve scoped; minutes, not in verify)
pnpm lint                            # biome check .
pnpm format                          # biome check --write .
pnpm rules:gen                       # regenerate rules.json + rules.ts from the spec (never hand-edit)
pnpm rules:check                     # verify rules.json is in sync
pnpm knip                            # dead-code scan
pnpm build                           # tsc -p tsconfig.build.json (all packages)
```

## Board protocol

GitHub Issues are the shared whiteboard — for humans and agents. Use `gh` for all operations.

### Status labels (at most one on an open issue)

| Label | Meaning |
|---|---|
| `in-progress` | Assignee and/or draft PR; actively working |
| `blocked` | Cannot proceed, or waiting on human review/decision |
| `icelog` | Parked on the Icebox; do not implement without asking first |

No status label on an open issue = ready to pick up. Closed = done.

### Working an issue

1. **Load context**: `gh issue view N --comments`. Read the body, labels, milestone, and comments.
2. **Claim**: `gh issue edit N --add-assignee @me --remove-label "blocked" --add-label "in-progress"`.
   Open a draft PR early once there is a branch (`Refs #N` in the PR body).
3. **Log** (shared with colleagues): short comments using the prefix discipline below. Long design
   stays in docs, not on the issue.
4. **Ship**: branch `<type>/<N>-<short-slug>`; commits `Refs #N` while WIP; `Fixes #N` / `Closes #N`
   only when the issue is fully done in the PR.
5. **Closeout**: `gh issue edit N --remove-label "in-progress" --remove-label "blocked"` then
   `gh issue close N --reason completed`.

### Comment prefixes

| Prefix | When |
|---|---|
| `Plan:` | What you're about to do and why |
| `Decision:` | A choice made and its rationale |
| `Context:` | Research links, notes colleagues need |
| `Stuck:` | What's blocking you and what would unblock it |
| `Done:` | What shipped and how to verify |

### Parking

`gh issue edit N --add-label "icelog" --remove-label "in-progress" --remove-label "blocked"`.
Do not implement parked issues without asking first.

## Autonomy ladder

| Action | Tier | Rule |
|---|---|---|
| Read, research, lint, test, web search | **auto** | No approval needed |
| Edit files, create/delete scratch | **auto** | Clean up before yielding |
| Commit on a session branch | **auto** | Conventional commits, one per decision, no sign-off trailers |
| Push a session branch | **auto-with-announce** | Push, then summarize what landed |
| Open or update a public-facing PR | **ask** | Require human confirmation |
| Anything public-permanent (issue wording, releases, repo settings) | **ask** | Human decides |
| Force-push, delete branches, rewrite history | **never** | Already policy; never ask, just don't |

**Downgrade-on-failure**: if the agent's evidence chain breaks (a false "killed" claim, a test that
passes for the wrong reason), the default for the rest of that session drops one rung until
re-checked. This is not punitive; it's the lesson of the 2026-08-09 Step-5 incident (T5-e), where a
broken hand-check harness silently produced false verdicts.

## Handoff convention

Each campaign (audit step, feature, spec-amendment follow-up) gets a `HANDOFF.md` at the repo root
(~20 lines): Goal → Progress → Decisions → Next Steps. A fresh session reads `HANDOFF.md` + the
relevant audit-doc section, not the entire history. `HANDOFF.md` is overwritten per campaign; the
audit doc is append-only and keeps the long-form evidence.

## Refute-or-promote (deep-review posture)

Deep review fleets are **budget items, not rituals**. Default posture:

- **Dual-lens review** (implementation + spec-citation) only on rule-owning modules touched by the
  change, not on all 15 modules every time.
- **Adversarial refuters** (3 per disputed finding, majority-vote survival) only on findings that
  survive the dual-lens pass — not on every finding.
- **Cost ceiling**: if a fleet run exceeds ~15 agents for a single module, stop and rescope.

If a refuter cannot find a flaw, the finding is **promoted**. If it can, the finding goes back for
iteration. Tournament selection (N parallel implementations + judge) is available for genuine
design forks, not for routine fixes.

## Mutation testing (`packages/core`)

`pnpm test:mutate` runs StrykerJS scoped to `patch.ts`, `admit.ts`, `resolve.ts` (config:
`packages/core/stryker.config.mjs`; narrow with `--mutate src/patch.ts`). **Not in `pnpm verify`** —
run it when a change alters the behaviour of those three modules. Clean up every survivor: kill it
with a stronger test, or justify it.

Do **not** trust Stryker's verdicts at face value — measured caveats (evidence in
`docs/QUALITY-AUDIT-2026-08-08.md` §3 Step-5):

- The vitest runner's per-mutant test selection can mark a genuinely suite-killed mutant as
  Survived (stryker-js #6073-class, ~1 in 30 mutants here). Disputed survivors get an offset-spliced
  hand-check against the **full** suite (`tools/mutant-check.mjs`) before being called equivalent.
- Disable-comment binding fails on some positions: rerun and confirm `Ignored` before counting.
- Incremental mode replays stale verdicts: `false` in the committed config; acceptance scores come
  only from plain `pnpm test:mutate`.
- `coverageAnalysis` is silently ignored by the vitest runner (always perTest).

## Workflow (always / ask / never)

- **Always**: feature branch + PR for code. Never push to `main` directly.
- **Always**: run `pnpm verify` before every commit; fix failures first.
- **Always**: follow the board protocol above when touching issues.
- **Always**: one conventional commit per finding/decision. No sign-off trailers, no
  `Co-authored-by`, no AI attribution anywhere.
- **Always**: match process to the task — prefer a suitable skill over a fixed ritual every turn.
- **Ask**: force-pushing, picking up `icelog` items, pushing to remote, committing.
- **Never**: commit `.env`, `*.nsec`, `*.key`. Hand-edit `rules.json` or `rules.ts`. Push to `main`.
- Keep the README short and human; put agent/process guidance here, not in the README.

## Learned workspace facts

- `pnpm verify` runs 12 steps in ~30s; `pnpm test:mutate` on one module takes 1–5 minutes.
- `packages/core/src/rules.ts` is generated from `tools/rules.json`; `pnpm rules:gen` regenerates
  both from the spec. CI runs `pnpm rules:check` and fails on drift.
- The spec repo (`~/scrutiny-fabric`) is read-only. Spec defects go into `docs/spec-changes/` and
  are batched into amendment briefs per D2, never filed from here.
- The audit branch `chore/architecture-audit-2026-08-08` carries Steps 0–9; main is protected.
