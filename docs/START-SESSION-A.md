# Session A starter — amend the spec to v0.6.0

Start a fresh Claude Code session **in `~/scrutiny-fabric`** and paste the prompt below.

Two background agents were run on 2026-07-27 to pre-flight this work: one extracting the rule
registry, one adversarially reviewing the amendment brief against the spec. **Check their findings
first** — they may have identified amendments needing revision before execution.

---

## Pre-flight already done (do not redo)

- All eight new rule IDs are free in v0.5.9: `TR-7`, `UR-1`, `UR-2`, `UR-3`, `RL-1`, `RL-2`, `RL-3`,
  `SIG-1`.
- All four new section slots are free and sequentially correct: §3.3 and §3.4 (existing §3 stops at
  3.2), §6.5 (existing §6 stops at 6.4), Appendix G (existing appendices stop at F).
- Appendix F contains **123 rules — 47 V, 50 A, 25 D, 1 reserved**. Use this as a checksum: after the
  amendments it should be 123 + however many rules you add.
- Relay limits cited in amendments A5 and A11 are **verified** against `hoytech/strfry/strfry.conf`:
  `maxEventSize = 65536`, `maxNumTags = 2000`, `maxTagValSize = 1024`,
  `rejectEventsNewerThanSeconds = 900`, `rejectEventsOlderThanSeconds = 94608000` (exactly 3 years).
  No need to re-verify.

## Repo state

`~/scrutiny-fabric` is on branch `chore/spec-repo-cleanup`, 4 commits ahead of `main`, working tree
clean. Tracked files: `.gitignore`, `LICENSE`, `README.md`, `docs/protocol-spec.md`,
`docs/threat-model.md`. Everything else was archived to `~/scrutiny-fabric-archive` (local, not a
repo) on 2026-07-27.

---

## The prompt

```
You are amending the SCRUTINY Fabric protocol specification from v0.5.9 to v0.6.0.

The specification is docs/protocol-spec.md in this repository. It is the only normative document
for this protocol; treat it with corresponding care.

Your work order is ~/scrutiny-fabric-tools/docs/SPEC-AMENDMENT-BRIEF.md. Read it in full before
touching anything. It contains twelve amendments (A1-A12), each with a motivation and, for most,
draft prose to insert. The prose is a draft: improve the wording, preserve the normative content.
Match the document's existing voice exactly - it is precise, uses bold lead-ins, states rules in
tables with columns "# | Layer | Inherits from | Rule", and capitalises MUST / MUST NOT / SHOULD /
SHOULD NOT / MAY.

Before you start, read ~/scrutiny-fabric-tools/docs/DECISIONS-2026-07-27.md sections 2 and 3 for
the reasoning behind these amendments, and check whether two background agents left findings that
change the plan - one built a rule-registry extractor at ~/scrutiny-fabric-tools/tools/, one
adversarially reviewed the brief. If the reviewer flagged an amendment as unsound, resolve that
before executing it.

Hard constraints:
- Never renumber or reuse an existing rule ID. New rules get new IDs. A retired rule becomes a
  reserved cross-reference, as OV-1 already does.
- Every new MUST/SHOULD/MAY in prose gets a rule ID AND a matching row in Appendix F. A normative
  statement without a registered ID is a defect - the v0.5.9 changelog records three such rules
  being discovered after the fact.
- Replace every occurrence of scrutiny-v059 with scrutiny-v060, including all examples in section 4
  and Appendix D.
- Add a v0.6.0 changelog entry in the established style. Include the note that each MINOR line
  admits only ten PATCH revisions, since v0.5.9 exhausted the 0.5.x line - that is why this is
  v0.6.0 and not v0.5.10.
- Do not create parallel specifications or split the document.

Work amendment by amendment. After each, state what you changed and which rule IDs you added, so I
can follow along. Do not batch all twelve and then summarise.

When all twelve are done, run the verification checklist at the end of the brief and report each
item pass/fail. Then commit on this branch with a conventional-commit message. Do not push, do not
merge to main, do not open a PR.

If any proposed amendment turns out to conflict with the existing spec in a way the brief did not
anticipate, stop and tell me rather than inventing a resolution.
```

---

## After Session A

1. Build the conformance vector skeletons and validator (Appendix G, amendment A8). Author vectors
   **incrementally as rules get implemented** — attempting all ~123 up front is how this stalls.
2. Delete `SPEC-AMENDMENT-BRIEF.md`; it is an input, not documentation.
3. Update the target version in `IMPLEMENTATION-PLAN.md`'s status table, and unblock Phase 0.

## Do not

- Merge to `main` or push. Both repos have unmerged branches awaiting review as PRs.
- Touch `~/scrutiny-fabric-tools` beyond reading the brief and the decision record.
- Re-open settled decisions. The record in `DECISIONS-2026-07-27.md` is append-only; if something
  there is wrong, add a correction rather than rewriting history.
