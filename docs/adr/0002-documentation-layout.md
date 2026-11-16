# ADR-0002: Documentation layout

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Supersedes** | ADR-0001 C14 ("docs/ carries only the ADR and the generated coverage table") |

## Context

C14 was written when the repo held only `packages/core`. It moved design specs and audits into
GitHub issues. By November 2026 the repo had drifted from that rule. The relay, mirror and MCP
existed. `investigations/` held reports cited by the protocol spec. The mirror held about 3,000
lines of `SELFTEST.md`. The MCP design lived in an issue body, on an unmerged branch and in a diagram
on one laptop.

Specs kept in issues have three problems: they do not change in the same commit as the code, they
cannot be reviewed line by line, and agents (a primary reader, see `AGENTS.md`) cannot grep them
offline. The single ADR file also covered core only, and readers had to combine D-entries with later
C-corrections to learn what was currently decided.

## Decision

Every kind of documentation has one home in the repo:

| Doc type | Question it answers | Location | Mutability |
|---|---|---|---|
| README | What is this; how do I use or run it | `README.md`, `packages/*/README.md`, `relay/README.md` | Kept current |
| Rulebook | How do I work here | `AGENTS.md`, `.agents/skills/` | Kept current |
| Spec | How should X work | `docs/specs/<topic>.md`, with a status header (Draft → Accepted → Implemented) | Edited until Implemented; afterwards changed only in the same PR as the code |
| ADR | Why X over Y | `docs/adr/NNNN-<title>.md`, one decision per file (Context / Decision / Consequences / Status), indexed in `docs/adr/README.md` | **Append-only.** A change is a new ADR that supersedes the old one |
| Investigation | What did research or measurement show | `investigations/<topic>/REPORT.md`, dated | Frozen |
| Generated reference | Exact API and coverage | `docs/COVERAGE.md`, `packages/core/etc/api-report.api.md`, `rules.ts` | Generated only |
| Module self-test notes | How this module is verified | `SELFTEST.md` beside the code | Changed with the code |
| Issues | What is being worked on | GitHub | Work tracking only. No new design specs or audits in issues |

Migration:

- `docs/DECISIONS-2026-07-27.md` moved, unchanged, to `docs/adr/0001-core-architecture-baseline.md`.
  A stub remains at the old path because `crocs-muni/scrutiny-fabric` links to it.
- Existing `design-reference` and `audit-evidence` issues stay closed as historical record.
- Diagrams live beside the spec that uses them (Mermaid inline, or an HTML file next to it).

**Skills live in `.agents/skills/`**, the cross-agent location that Codex reads natively.
`.claude/skills` is a committed symlink to `../.agents/skills`, because Claude Code reads only
`.claude/skills` (as of 2026-11). On Windows, git checks a symlink out as a plain text file unless
`core.symlinks=true` and Developer Mode are enabled. Without them, create a junction once per clone:

```bat
rmdir .claude\skills 2>nul & del .claude\skills 2>nul
mklink /J .claude\skills .agents\skills
git update-index --skip-worktree .claude/skills
```

## Consequences

- Code, its spec and its reasons change in one PR, and agents can grep all of them.
- `docs/` grows: `adr/`, `specs/`, `COVERAGE.md` and the redirect stub.
- A spec can drift after it reaches Implemented. Mitigation: review requires a spec edit in any PR
  that changes specified behaviour.
- Windows contributors without symlink support need the junction step above, or Claude Code does
  not see the project skills.
