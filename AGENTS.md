# AGENTS.md — scrutiny-fabric-tools

@scrutiny-fabric/core — reference implementation of the SCRUTINY Fabric protocol (spec v0.8.0).
Sans-IO, crypto-free, ESM-only TypeScript; `diff` is the sole runtime dependency.
This file is the rulebook (how to work); the board has the state.

## Orientation

| What | Where |
|---|---|
| Implementation (15 modules) | `packages/core/src/` |
| Project skill (deep invariants, recurring traps) | `.claude/skills/scrutiny-protocol/` — **read before touching `packages/core`** |
| Architecture decisions (ADR, append-only) | `docs/DECISIONS-2026-07-27.md` — §6 carries corrections, docs doctrine (C14), and build-order rationale (C15) |
| Module-ownership table (generated) | `docs/COVERAGE.md` — `pnpm ownership:gen` |
| Protocol spec (read-only from here) | `crocs-muni/scrutiny-fabric/docs/protocol-spec.md` |
| Spec-feedback findings (F1–F17) | Issues on `crocs-muni/scrutiny-fabric` (label `spec-feedback`) |
| Design-reference mini-specs (archived) | Issues on this repo (label `design-reference`) |
| Audit evidence (archived) | Issues on this repo (label `audit-evidence`) |
| Generated rules registry | `tools/rules.json` → `packages/core/src/rules.ts` — **never hand-edit** |
| Board | GitHub Issues in this repo |
| Campaign status | GitHub Milestone `Quality audit — 2026-08-08 (Steps 0–9)` |
