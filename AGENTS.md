# AGENTS.md — scrutiny-fabric-tools

@scrutiny-fabric/core — reference implementation of the SCRUTINY Fabric protocol (spec v0.8.0).
Sans-IO, crypto-free, ESM-only TypeScript; `diff` is the sole runtime dependency.
This file is the rulebook (how to work); the audit doc has the state; issues have the board.

## Orientation

| What | Where |
|---|---|
| Implementation (15 modules) | `packages/core/src/` |
| Project skill (deep invariants, recurring traps) | `.claude/skills/scrutiny-protocol/` — **read before touching `packages/core`** |
| Protocol spec (read-only from here) | `crocs-muni/scrutiny-fabric/docs/protocol-spec.md` |
| Spec feedback queue | `docs/spec-changes/` — one file per F-finding, status-tracked |
| SDLC redesign record (why this file exists) | `docs/AGENTIC-SDLC-REDESIGN-2026-08-09.md` |
| Audit state (current campaign) | `docs/QUALITY-AUDIT-*.md` — read its RESUME line |
| Generated rules registry | `tools/rules.json` → `packages/core/src/rules.ts` — **never hand-edit** |
| Board | GitHub Issues in this repo |

## Commands

| Command | Purpose |
|---|---|
| `pnpm verify` | The CI gate: lint, typecheck, rules-sync, knip, build, publint, api-report, attw, size, audit, test. Run before every commit (~30s) |
| `pnpm test` | vitest run |
| `pnpm test:mutate` | StrykerJS mutation testing scoped to patch/admit/resolve (see below) |
| `pnpm mutant-check <module>` | Offset-splice a surviving mutant into real source and run the full suite — proves whether a "Survived" is genuine or a runner attribution miss |
| `pnpm rules:gen` | Regenerate `rules.json` + `rules.ts` from the spec (never hand-edit) |

## Architectural invariants

Violating these is a design change, not a bug fix. See the project skill for the "why."

| Invariant | Rule |
|---|---|
| No cryptography, ever | D12 — hashes are injected; Biome blocks `crypto` imports in `packages/*/src/**` |
| `build.ts` emits unsigned templates only | D13 — `{kind, created_at, tags, content}`; signer fills `id`, `pubkey`, `sig` |
| ESM only, `sideEffects: false` | D9 — extension-ful specifiers, no dynamic `import()` |
| `patch.ts` is internal, never in the exports map | D32 |
| Four interfaces are `Symbol.for()` branded | D16 — two copies of core interop across dependency trees |
| Runtime deps: `diff` only, via applier port | D11 |
| No version tag in a relay filter | VER-4 |
| Prefix registry is open data, never a closed enum | IR-4/R13 |
| Trust is presentation-time only; resolve never reads it | TR-7/D25 |

## Workflow

**Always**: feature branch + PR · `pnpm verify` before every commit · conventional commits (one per decision, no sign-off trailer, no AI attribution) · follow the board protocol when touching issues.
**Ask**: force-pushing, `icelog` items, pushing to remote, opening public-facing PRs.
**Never**: `.env`/`*.nsec`/`*.key`, hand-edit `rules.json`/`rules.ts`, push to `main`, rewrite history.

## Board protocol

Issues are the shared whiteboard — use `gh`. At most one status label on an open issue:

| Label | Meaning |
|---|---|
| `in-progress` | Assignee and/or draft PR; actively working |
| `blocked` | Cannot proceed, or waiting on human review/decision |
| `icelog` | Parked; do not implement without asking first |

No label = ready to pick up. Closed = done.

**Workflow**: `gh issue view N --comments` → claim (`--add-assignee @me --add-label in-progress`) → open draft PR early (`Refs #N`) → log with short comments using prefixes: `Plan:` `Decision:` `Context:` `Stuck:` `Done:` → branch `<type>/<N>-<slug>` → `Fixes #N` only when fully done → `gh issue close N --reason completed`.

## Autonomy ladder

| Action | Tier | Rule |
|---|---|---|
| Read, research, lint, test, web search | **auto** | — |
| Edit files, create/delete scratch | **auto** | clean up before yielding |
| Commit on a session branch | **auto** | conventional, one per decision |
| Push a session branch | **auto-with-announce** | then summarize |
| Public-facing PR, issue wording, releases, repo settings | **ask** | human decides |
| Force-push, delete branches, rewrite history | **never** | policy, non-negotiable |

Drop one rung for the rest of the session if your evidence chain breaks (a false kill claim, a
test that passes for the wrong reason). Session incident T5-e taught this.

## Mutation testing

`pnpm test:mutate` runs StrykerJS scoped to `patch.ts`, `admit.ts`, `resolve.ts`. **Not in**
`pnpm verify** — run it when those modules' behavior changes; clean up every survivor (kill with a stronger test, or justify with evidence).

The vitest runner's per-mutant selection can mark a suite-killed mutant as Survived
(stryker-js #6073-class, ~1 in 30 here). Hand-check disputed survivors with
`pnpm mutant-check <module>` before calling anything equivalent. `coverageAnalysis` is
silently ignored (always perTest). Incremental is off — it replays stale verdicts.

## Refute-or-promote

Review fleets are budget items, not rituals. Dual-lens (implementation + spec-citation)
only on rule-owning modules touched; adversarial refuters (3 per finding, majority-vote)
only on findings that survive that pass. If no refuter kills it, it's promoted.

## Handoff convention

Each campaign gets a fresh `HANDOFF.md` (~20 lines): Goal → Progress → Decisions → Next Steps.
A fresh session reads that + the relevant audit-doc section, not the full history.
`HANDOFF.md` is overwritten per campaign; the audit doc is append-only evidence.
