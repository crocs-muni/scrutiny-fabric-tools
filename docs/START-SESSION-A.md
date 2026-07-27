# Session A starter — amend the spec to v0.6.0

Start a fresh Claude Code session **in `~/scrutiny-fabric`** and paste the prompt below.

The brief was revised on 2026-07-27 after an adversarial review found an earlier 18-item draft
contained real contradictions with the spec. It is now **nine changes**, each justified by a concrete
failure it prevents. About half the earlier draft was documentation tidiness and was dropped; the
brief's "Deliberately not doing" section records what and why.

---

## Pre-flight already done — do not redo

- **Rule IDs are free** in v0.5.9: `UR-1`, `UR-2`, `UR-3`, `RL-1`…`RL-4`, `SIG-1`, `TR-7`, `CA-1`,
  `C7` (the existing C-series stops at C6).
- **Section slots are free** and sequentially correct: §5.4 (existing §5 stops at 5.3), §7.6
  (existing §7 stops at 7.5).
- **Rule count is 123** — 47 V, 50 A, 25 D, 1 reserved. After the nine changes it should be **134**.
- **Registry is clean.** `node tools/extract-rules.mjs` in the tools repo reports 0 errors against the
  unamended spec, so you have a known-good before-state.
- **Relay limits verified** against `hoytech/strfry/strfry.conf`: `maxEventSize = 65536`,
  `maxNumTags = 2000`, `maxTagValSize = 1024`, `rejectEventsNewerThanSeconds = 900`,
  `rejectEventsOlderThanSeconds = 94608000` (exactly 3 years).
- **Both background reviews are already folded into the brief.** Nothing left to check.

## Repo state

`~/scrutiny-fabric` is on `main`, working tree clean, 5 tracked files: `.gitignore`, `LICENSE`,
`README.md`, `docs/protocol-spec.md` (v0.5.9, 1363 lines), `docs/threat-model.md`. Everything else was
archived to `~/scrutiny-fabric-archive` (a plain local directory) on 2026-07-27. Nothing is pushed.

---

## The prompt

```
You are amending the SCRUTINY Fabric protocol specification from v0.5.9 to v0.6.0.

The specification is docs/protocol-spec.md in this repository. It is the only normative document for
this protocol and it is the most valuable artifact in the project. Treat it accordingly.

FIRST: create a branch. The repo is on main and this project never commits directly to main.
  git checkout -b chore/spec-v0.6.0

Your work order is ~/scrutiny-fabric-tools/docs/SPEC-AMENDMENT-BRIEF.md. Read it in full before
touching anything. It contains NINE changes, numbered 1 to 9. Each has a plain-language motivation
explaining the concrete failure it prevents, the change to make, and the rule-table rows to add or
amend. The prose is a draft: improve the wording, preserve the normative content.

Match the document's existing voice exactly. It is precise and dense, uses bold lead-ins, states
rules in tables with the columns "# | Layer | Inherits from | Rule", and capitalises MUST /
MUST NOT / SHOULD / SHOULD NOT / MAY.

For background on why these changes exist, read sections 2 and 3 of
~/scrutiny-fabric-tools/docs/DECISIONS-2026-07-27.md. Do not re-litigate settled decisions.

HARD CONSTRAINTS

- Never renumber or reuse a rule ID. New rules get new IDs. Amending a rule keeps its ID.
- Every new MUST / SHOULD / MAY in prose needs a rule ID AND a matching row in Appendix F.
- Do NOT blanket-replace "scrutiny-v059". The changelog's v0.5.9 entry legitimately contains
  "scrutiny-v058 -> scrutiny-v059", and the new v0.6.0 entry must contain
  "scrutiny-v059 -> scrutiny-v060". A global replace corrupts the changelog. Replace it only in
  section 3, the section 4 examples, and Appendix D.
- Do NOT change the rule-table column headers. A validation script matches them exactly and will
  silently return zero rows if they change.
- Do not create parallel specifications or split the document.

AFTER EVERY CHANGE, run the registry validator and paste its output:
  node ~/scrutiny-fabric-tools/tools/extract-rules.mjs --spec docs/protocol-spec.md
It exits non-zero if the per-section rule tables and Appendix F disagree. Catching a mismatch
immediately is much cheaper than finding it after nine changes.

WORK ONE CHANGE AT A TIME. After each, tell me what you changed, which rule IDs you added or
amended, and the validator result. Do not batch several changes and summarise at the end.

Changes 3, 5 and 7 each require edits in three or four separate places, because the spec states the
same thing more than once and changing one copy leaves the others contradicting it. The brief lists
every location per change. Do not skip the secondary edits.

WHEN ALL NINE ARE DONE
- Run the verification checklist at the end of the brief and report each item pass/fail.
- Confirm the validator reports 134 rules with 0 errors.
- Commit on the branch with a conventional-commit message.
- Do NOT push, do NOT merge to main, do NOT open a PR.

IF SOMETHING DOESN'T FIT: if a proposed change conflicts with the existing spec in a way the brief
did not anticipate, STOP and tell me. Do not invent a resolution. The brief has already been
through one adversarial review that found real contradictions, so a further one is possible.
```

---

## After Session A

1. Review the diff, then merge and push when satisfied.
2. Build the conformance vector files and validator (change 8's Appendix G work is *not* in this
   brief — it was deferred). Author vectors **incrementally as rules get implemented**; attempting all
   134 up front is how this stalls.
3. Delete `SPEC-AMENDMENT-BRIEF.md` — it is an input, not documentation.
4. Update the target version in `IMPLEMENTATION-PLAN.md`'s status table and unblock Phase 0.

## Do not

- Touch `~/scrutiny-fabric-tools` beyond reading the brief, the decision record, and running the
  validator.
- Re-open settled decisions. `DECISIONS-2026-07-27.md` is append-only; if something there is wrong,
  add a correction rather than rewriting it.
