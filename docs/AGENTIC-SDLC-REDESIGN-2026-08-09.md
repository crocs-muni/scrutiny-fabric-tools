# Agentic SDLC redesign — research digest and decisions (2026-08-09)

**Source:** thorough web research (10+ sources) via subagent, cross-checked against this repo's
2026-08-08 quality audit and [RedHatResearch/aibom-security](https://github.com/RedHatResearch/aibom-security)'s
AGENTS.md. Decisions owner-approved in session. All 9 approved items landed in commits
`b357cc7` and `40b0e07`.

---

## What we took from aibom-security

Their AGENTS.md is 170 lines and maps our workflow nearly 1:1. The takeaways:

1. **Board protocol** — Issues are the whiteboard for humans AND agents. Claim → `in-progress`
   label → draft PR early → short `Plan:`/`Decision:`/`Context:`/`Stuck:`/`Done:` comments →
   closeout by issue kind. No chat-only memory.
2. **Autonomy ladder** — explicit tiers: read/write/test = auto; commit = auto with rules; push =
   auto-with-announce; public-facing = ask; force-push/aliases = never. **Downgrade-on-failure**:
   evidence chain breakage (false kill claims) drops the default one rung for the rest of the session.
3. **Negative constraints** ("MUST NOT", "never") reduce hall over positive prescriptions.
4. **Command-first file**: executable commands with flags up early, no architecture prose.
5. **Keep agent guidance out of README**; put it in AGENTS.md.
6. **Learned user preferences** section captures owner style once it's proven (ours: context-first,
   push cautiously, question authority when needed).
7. **Fit process to task** — "prefer a suitable skill over a fixed ritual every turn."

## What research corroborated (2025–2026)

| Source | Finding | Link |
|---|---|---|
| GitHub Blog (2,500 repos) | Six core areas: Commands, Testing, Structure, Style, Git, Boundaries. Commands early with flags. Real code samples over prose. | [github.blog](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/) |
| Red Hat Developer | Target <150 lines (30–50 small repos). Pointer tables over prose. Concrete invariants that catch silent failures. | [developers.redhat.com](https://developers.redhat.com/articles/2026/07/27/standardize-project-context-agentsmd-and-agent-skills) |
| Codex Knowledge Base | Agent compliance degrades when positive rules outnumber negative. Start with high-impact architecture rules. | [codex.danielvaughan.com](https://codex.danielvaughan.com/2026/07/02/agents-md-evidence-based-authoring-guide-rule-taxonomy-misalignment-codex-cli-compliance-hooks/) |
| agents.md spec | Minimal, open, tool-agnostic. Covers 24+ harnesses. Subdirectory files take precedence. | [agents.md](https://agents.md/) |
| Taiizor cookbook | Same strike range: 60–150 lines. Migration tools from CLAUDE.md → AGENTS.md. | [github.com/Taiizor/agents-md-cookbook](https://github.com/Taiizor/agents-md-cookbook) |
| CaiSi | Giant instruction files cause information overload without improving performance. | [caisi.dev](https://caisi.dev/blog/why-giant-instruction-files-fail/) |
| Atlan | Runtime-focused guide, six areas, three-tier boundary policy. | [docs.atlan.com](https://docs.atlan.com/agents/how-tos/write-an-agents-md-file) |
| Addy Osmani | Keep prompts tightly scoped; hierarchical summaries for large specs; six-area checklist. | [addyosmani.com](https://addyosmani.com/blog/good-spec/) |

For multi-agent orchestration, quality gates, and AI-code provenance see the session transcript —
the SDLC redesign built on all three simultaneously.

## What landed (all nine approved rows)

| # | Item | Commit | Notes |
|---|---|---|---|
| 1 | Root `AGENTS.md` | `b357cc7`, `40b0e07` | 85 lines after simplification; orientation/commands/invariants/workflow/board/autonomy/mutation-testing/refute-or-promote/handoff |
| 2 | PR evidence block | `.github/PULL_REQUEST_TEMPLATE.md` | `b357cc7` | Verify + mutation + refute + spec-citation checklist |
| 3 | Survivor hand-check harness | `packages/core/tools/mutant-check.mjs` + `pnpm mutant-check` | `b357cc7` | Offset-spliced full-suite verification before any "equivalent mutant" justification |
| 4 | Spec-changes index | `docs/spec-changes/README.md` | `b357cc7` | One row per F-finding, status-tracked: proposed/applied/archived |
| 5 | Board labels | `in-progress` / `blocked` / `icelog` | this file | Created via `gh` |
| 6 | Board-activated on #24 | `in-progress` label applied | now | Issue 24 is the audit tracker, claimed |
| 7 | HANDOFF.md convention | Documented in AGENTS.md | `b357cc7` | Per-campaign checkpoint; activates at Step 6 kickoff |
| 8 | Refute-or-promote-lite | Documented in AGENTS.md | `b357cc7` | Deep-review fleet from fixed-ritual to per-module + per-disputed finding |
| 9 | Audit §2 tool-row + pointer | `docs/QUALITY-AUDIT-2026-08-08.md` | `b357cc7` | New "Agentic SDLC governance" row |

## Open governance questions (kept here so they resurface)

1. **Org Project board**: a shared GitHub Project spanning spec-repo, tools-repo, and lens-repo.
   `gh project create` fails if the org restricts it; the ready-to-paste admin ask is in the session
   summary.
2. **CLAUDE.md at repo root**: skip for now (the harness pre-loads `~/.claude/CLAUDE.md` and a repo
   duplicate could confuse). Add later if Claude-specific auto-load is needed.
3. **HANDOFF.md**: per-campaign checkpoint convention documented in AGENTS.md. First one lands at
   Step 6 kickoff.

## Audit steps remaining

- [ ] **Step 6** — browser memory investigation (closes `AUDIT-2026-07-31.md` hazard #4)
- [ ] **Step 7** — doc debt (IMPLEMENTATION-PLAN status refresh beyond the ownership table;
  DECISIONS §5's 5 open questions; retire spent planning docs)
- [ ] **Step 8** — close out (finalize skill, `pnpm verify` clean, changeset added,
  tool green-or-justified, doc/issue to 100%)
- [ ] **Step 9** — report PR reconciliation recommendation for #11–23, wait for go-ahead (do not close PRs)
