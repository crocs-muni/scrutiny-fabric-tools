# AGENTS.md — scrutiny-fabric-tools

@crocs-muni/scrutiny-fabric — reference implementation of the SCRUTINY Fabric protocol (spec v0.8.0).
Sans-IO, crypto-free, ESM-only TypeScript; `diff` is the sole runtime dependency.
This file is the rulebook (how to work); the board has the state.

## Orientation

| What | Where |
|---|---|
| Implementation (15 modules) | `packages/core/src/` |
| Project skills (deep invariants, recurring traps) | `.agents/skills/` — `scrutiny-protocol/` is **required reading before touching `packages/core`**. `.claude/skills` is a symlink to it (Windows: see ADR-0002) |
| Architecture decisions (ADRs, append-only, one per file) | `docs/adr/` — index in `docs/adr/README.md`. ADR-0001 is the core baseline (D1–D45, C1–C16) |
| Design specs (how a component should work) | `docs/specs/` — status header Draft → Accepted → Implemented |
| Investigations (research and audit reports, frozen) | `investigations/<topic>/REPORT.md` |
| Module-ownership table (generated) | `docs/COVERAGE.md` — `pnpm ownership:gen` |
| Protocol spec (read-only from here) | `crocs-muni/scrutiny-fabric/docs/protocol-spec.md` |
| Spec-feedback findings (F1–F17) | Issues on `crocs-muni/scrutiny-fabric` (label `spec-feedback`) |
| Older design-reference mini-specs and audit evidence (archived, closed) | Issues on this repo (labels `design-reference`, `audit-evidence`) — no new ones; see ADR-0002 |
| Generated rules registry | `tools/rules.json` → `packages/core/src/rules.ts` — **never hand-edit** |
| Board | GitHub Issues in this repo — work tracking only |
| Campaign status | GitHub Milestone `Quality audit — 2026-08-08 (Steps 0–9)` |
