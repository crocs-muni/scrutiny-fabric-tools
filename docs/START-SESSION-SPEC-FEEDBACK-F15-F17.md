# Session starter — land F15 / F16 / F17 into the spec repo

Start a fresh session **in `~/scrutiny-fabric`** (the spec repo — never `scrutiny-fabric-tools`)
and paste the prompt at the bottom of this file. This is the third batched spec-feedback landing
session, after F13/F14 (v0.7.0). It closes the three spec gaps the 2026-08-08 quality audit's
adversarially-verified findings (S3-11, S3-21, S3-18/S3-19) exposed, and it must answer, not
defer, the two behavior rulings they turn on.

---

## What is already true — do not redo

- **F15, F16, F17 are fully drafted, evidenced, and independently re-verified** in
  `scrutiny-fabric-tools/docs/SPEC-FEEDBACK-v0.7.0.md` (the entire file is these three entries).
  Read it in full — it is the brief, not a summary to re-derive. Each entry carries verified
  evidence, ecosystem precedent, and a suggested resolution; this starter's own recommendations
  agree with it except where explicitly flagged below.
- **The full evidence trail with refuter reasoning** lives in
  `scrutiny-fabric-tools/docs/QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json` — findings S3-11,
  S3-21, S3-18, S3-19, each of which survived 3-of-3 independent adversarial refuters. That file
  is the machine-readable backup; the `.md` draft above already digests it.
- **The spec repo is on `main`, at v0.7.0** — F13 (PT-10/PT-11 root typing) and F14 (the `v`
  tag, no grandfather clause) landed there as `fix/spec-feedback-f13-f14` plus the v0.7.0 bump.
  House formats to match: `CHANGELOG.md` (terse, per-version, rule-ID-cited bullets) and
  `docs/DECISIONS.md` (numbered cross-cutting rationale, next available S-number). The
  `a92bedb..995e05b` commit shape (several small `fix(spec)`/`feat(spec)` commits, one
  `chore(spec)` version bump, a `docs(spec)` changelog write-up) is the commit discipline to
  match — not one giant commit.
- **F15's suggested fix is already implemented** in the reference implementation
  (`scrutiny-fabric-tools`, commit `d8ce649` on branch `chore/architecture-audit-2026-08-08`):
  version fields are kept as decimal text and compared per-field with the standard
  width-independent digit-string algorithm (strip leading zeros → longer string wins →
  lexicographic), with tests at the exact 2^53 boundary and for leading-zero equivalence. This
  session's F13/F14-starter file (`docs/START-SESSION-SPEC-FEEDBACK.md` in the tools repo) is the
  provenance trail for why the `v` tag exists.
- **Implementation-side groundwork for F16/F17 is complete, pending this session's rulings**:
  - The reference implementation's T2 clamp already reads `lineCount(lines)` (commit `0b97690`,
    with a permanent regression case `t2/out-of-range-insert-clamps-to-content-end` in
    `test/patch-regressions.ts`) — so the F17 recommendation is implementation-validated, the
    same posture F15 is in.
  - The F16 behavior (optimistic-include) is currently UNCHANGED in `resolve.ts` and is
    deliberately documented as a characterization pending this session: audit finding S3-21
    (`docs/QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json`) records that the `parent === undefined`
    branch of the `linkable` filter (resolve.ts, lines ~282–287) is untested and was chosen by
    implementation judgment, not by any spec text.
- **`scrutiny-fabric-tools` vendor discipline (D33)**: `packages/core/vectors/{validity,
  application}.json` are checksum-pinned copies of Appendix G. Any vector change in this session
  makes those pinned copies stale until re-vendored — that consequence must be recorded, exactly
  as the F13/F14 session recorded the same consequence for its own changes.

## What is not yet true

- None of F15/F16/F17 exists in the spec: no digit-string/comparison-algorithm rule in §3, no
  rule for the unobserved-`e-reply`-parent case (there is no UR-4 in Appendix F), and no
  out-of-range sentence in T2.
- Appendix G has zero vectors exercising a root-authored patch whose `e reply` target is
  unobserved (checked against all 46 `chain/*` cases in the current corpus) and none covering an
  out-of-range pure-insertion header.

## The three open decisions — answer them in writing before editing

The previous session-starters established this discipline (state assumptions explicitly, write
them down) for genuinely load-bearing choices. These three are that shape:

### 1. F16 — optimistic-include or hold-pending?

The gap: a **root-authored patch whose `e reply` parent has not been observed**. PT-6 covers a
root-author patch replying to a *foreign* patch (ignored for the chain); §7.6/UR-2 covers a patch
whose *root* is unobserved (retained, re-evaluated on arrival); CHN-1's root-forward walk implies
such a patch simply is not reached until its parent exists. Nothing says what a compliant client
must do in the meantime — and the reference implementation chose to include it optimistically.

**Recommendation: HOLD-PENDING, as a new rule (UR-4) in UR-2's exact shape.** A root-author patch
whose `e reply` target is unobserved is excluded from the canonical chain until that target
arrives, then re-evaluated (confluence is §7.1's existing guarantee, so arrival-order safety is
inherited rather than re-argued). Reasons, in weight order:

1. **The verdict it gives is honest about what it knows.** Including a patch in the canonical
   chain asserts a contiguity ("this patch follows the chain") the client cannot verify while the
   parent is missing. The spec's entire posture (BD-6's pending-endpoint lifecycle, DEL-8's
   unobserved-deletion-target handling, §7.6's own opening — "Most cases are already covered…"
   followed by held-and-re-evaluate rules) is: when evidence is incomplete, report *pending* or
   *held*, never approximate *resolved*. Optimistic-include is the only place in the spec that
   would assert a chain judgment on missing evidence.
2. **Hold-pending is self-healing; optimistic-include is a stuck opinion.** On parent arrival, a
   pending patch joins the chain by the normal rules and the client ends in the same state either
   way — but in the interim the two models publish *different canonical content for the same
   observed set*, which is exactly the cross-implementation divergence §1 exists to prevent. A
   "temporary divergence is fine" reading would need its own §7.1 carve-out, and nobody has
   written one.
3. **UR-2 already wrote the shape.** A patch with an unobserved *root* "cannot be classified at
   all … is held per §7.6 (UR-2). It does not participate in the canonical chain until then."
   The parent case is the same unresolved-reference problem one level down; the symmetrical rule
   is the least new machinery possible. Optimistic-include would instead need a new *exception*.
4. Confluence is NOT endangered: the final state after the parent arrives differs from
   optimistic's interim state with the parent — but both rules are set-confluent at fixpoint, and
   only hold-pending guarantees the interim state is also the normative one.

The respected counterargument — optimistic-include surfaces patch content earlier — is a client-UX
concern that §7.3 already provides for (render the patch as a foreign-overlay-shaped artifact
against provisional content if desired); it does not justify a *canonical chain* claim.

### 2. F17 — out-of-range pure-insertion coordinates: clamp, or HALT?

The gap: T2 says a pure-insertion hunk applies "at the position implied by its `@@` header's `-`
line number" in pre-application coordinates, carried forward by prior hunks' net delta — and says
nothing about an implied position outside the content's line range (e.g. `@@ -99,0 +100,1 @@`
against 2 lines of content). The reference implementation clamped to end — and its clamp had a
real content-corrupting bug (the trailing-newline sentinel) found by this audit, which is the
demonstration that "clamp" is not one behavior unless the bound is named.

**Recommendation: CLAMP to the content's line range — one sentence, inside T2.** Suggested
wording shape (improve it, don't copy it): *"If the position implied by the `@@` header (after
carry-forward) exceeds the number of lines of the current content, the hunk inserts its `+` lines
at the end of the content; if it is below the start, at the start."* Reasons:

1. **Proportionality to C6.** Malformed payloads are rejected (C1); a *misplaced* coordinate in an
   otherwise well-formed patch is a producer error about placement, and C6 already decided that
   line numbers are advisory rather than load-bearing. Halting the whole chain (H1's freeze) over
   an advisory coordinate treats the cheapest producer mistake with the harshest consumer outcome.
2. **Determinism survives either way — but only if pinned.** "Clamp vs HALT vs clamp-to-a-
   different-bound" are all defensible as behavior; what's indefensible is all three being
   compliant. One sentence dissolves the trichotomy. HALT would also do that, at a higher price.
3. **It matches T2's own boundary reading.** T2's example (`@@ -0,0 +1,N @@` against empty
   content) is exactly the "past end" edge of the same range; clamp-to-[0, lineCount] reduces to
   the existing text there, so the amendment extends the rule rather than contradicting it.

Also record explicitly what happens at the *content model* level, because that is where the
implementation bug hid: "number of lines" means the content's real lines — not any implementation
container (the reference implementation's `toLines` array carries a trailing-newline sentinel
element, and its first clamp hit it).

### 3. One release or two, and what number(s)?

House precedent: D45 (v0.5.9 → v0.6.0) forced a MINOR bump for a breaking wire change; the spec
repo's own v0.6.0 changelog discusses why. Pre-1.0 semver treats MINOR as the breaking slot.

**Recommendation: F15+F17 in one release; F16 in its own — F16 first if only one lands this
week.** F15 and F17 are *clarifications*: nothing in any realistic event set changes, because
version fields wide enough to hit the F15 collision do not exist, and pure-insertion headers in
range are unaffected by F17's new sentence — while on the undefined edge, the reference
implementation already runs the amended behavior (so "any other reading" was a latent bug, not a
feature). F16 (if hold-pending is ratified) *changes* normative chain semantics
for anyone currently optimistic — a breaking behavioral rule, deserving its own version number and
changelog entry, not a ride-along inside a clarifications release. If the session instead lands
optimistic-include, F16 is also a clarification (it blesses existing behavior) and can merge into
the same release as the other two — that branch of the decision changes the release plan, and
this starter deliberately does not pre-decide it.

## Hard constraints

- **This session edits `~/scrutiny-fabric` ONLY.** Never touch `scrutiny-fabric-tools` — the core
  follow-ups after landing (characterization-case flips per F16's ruling, re-vendor Appendix G at
  fresh checksums, `pnpm rules:gen`, any new UR-4 enforcement in resolve.ts, the F16 pinner test)
  are a separate session, tracked against the version number(s) this session reports back.
- **Create a branch first.** This repo also never commits directly to `main`:
  `git checkout -b fix/spec-feedback-f15-f16-f17`
- **Appendix F format is exact.** Any new rule (UR-4 if F16 lands hold-pending) goes into the
  table in the exact shape of its neighbors (ID, layer, inherits, rule text) and the flat rule
  index is regenerated/updated consistently — match UR-2's row style; do not hand-wave ordering.
- **Loose ends are not optional.** For F15 the §3 ordering paragraph (line ~66, "parse … as
  numbers") must be reconciled with the no-ceiling sentence two lines above it — do not leave the
  two claims lingering at each other. For F16, check every §7.x section that walks or classifies
  (CHN-1, §7.3 orphan criteria "unobtainable", §7.6's resubmission grammar, SF-1's fork
  detection text) for interactions with a hold-pending parent — a chain-breaking parent looks
  exactly like a fork to a careless reader, and SF-1/PT-6 must not quietly disagree. For F17,
  the example inside T2's own text (`@@ -0,0 +1,N @@` on empty content) must still read
  consistently after the new sentence.
- **Vectors are part of the landing, not a follow-up.** At minimum: one `chain/*` vector for the
  F16 ruling (dangling root-authored parent, expected chain shape per the ruling) and one
  application vector for out-of-range T2 insertion (the 2-line-content clamp case; expected
  appended content, `$'a\nb\nX\n'`-style exact bytes) — in Appendix G's existing format, with the
  vendored-copy consequence recorded in the spec repo's `docs/DECISIONS.md` (next S-number), the
  same place the F13/F14 session recorded its own vectors question.
- **Changelog stays terse.** The original F13/F14 starter banned the growth pattern S3's
  DECISIONS.md entry describes (24 → 138 words/bullet). Rule-ID-cited bullets, S-numbered
  rationale elsewhere.

## The prompt

```
You are landing three verified spec gaps — F15, F16, F17 — into the SCRUTINY Fabric protocol
specification. Their reference-implementation evidence is complete and independently re-verified;
two of the three suggested fixes are already implemented and tested on the reference branch;
your job is to give them normative spec text, answer the two behavior rulings, and land the
minimum vectors that make the answers checkable — in this repo's own house style.

READ FIRST, IN THIS ORDER
1. ../scrutiny-fabric-tools/docs/SPEC-FEEDBACK-v0.7.0.md — the three entries in full: verified
   evidence, ecosystem precedent (Go x/mod/semver compareInt, RPM rpmvercmp, glibc strverscmp,
   Maven ComparableVersion BigInteger; node-semver as the live counterexample), and each entry's
   suggested resolution. Treat the suggestions as a start you may improve, not settled prose.
2. ../scrutiny-fabric-tools/docs/START-SESSION-SPEC-FEEDBACK-F15-F17.md §"The three open
   decisions" — the recommended rulings AND their counterarguments. F16's recommendation is
   hold-pending as a new UR-4 in UR-2's shape; F17's is clamp-to-content-line-range as one T2
   sentence. Agree or overturn with reasons; both write-ups exist so the alternative is argued,
   not strawmanned.
3. docs/protocol-spec.md: §3 (version-tag form, line ~64 and ordering ~66 — F15's collision
   lives across those two sentences), §3.1 mini-examples, §4.4 (PT-5/PT-6/PT-7 rule table),
   §5.3 (T1/T2 rule table text in full), §6.0/§6.1 (Validity manifest, verdict dispositions),
   §7.1 (re-evaluation), §7.3 (orphan criteria), §7.6 (UR-1/UR-2, resubmission), Appendix F
   (rule-table format), Appendix G (vector format and existing chain cases).
4. CHANGELOG.md and docs/DECISIONS.md in full — the house style your entries must match: terse
   rule-ID-cited release bullets; S-numbered cross-cutting rationale. Read the v0.7.0 (F13/F14)
   entries specifically as the direct template, and the D45 discussion for the version-bump
   precedent.
5. git log a92bedb..995e05b — the actual commit shape of the v0.7.0 landing: several small
   fix(spec)/feat(spec) commits, one chore(spec) version bump, a docs(spec) changelog write-up.

FIRST ACTION: create a branch. This repo never commits directly to main:
  git checkout -b fix/spec-feedback-f15-f16-f17

FIRST DELIVERABLE, before touching protocol-spec.md: answer, in writing, the three open
decisions from the starter:
  (a) F16: hold-pending (new UR-4) or optimistic-include? State the ruling and the reasons you
      accept or reject from the starter's write-up. If optimistic-include, say which normative
      text you add to keep the interim chain unambiguous across implementations, and note that
      this changes the release plan (see (c)).
  (b) F17: clamp-to-range or HALT for out-of-range pure-insertion coordinates? Same discipline.
  (c) One release or two, and the version number(s)? Use the D45/pre-1.0 precedent, not default
      PATCH bumps, and note the chosen split depends on (a)'s ruling.

HARD CONSTRAINTS
- This session edits ~/scrutiny-fabric ONLY. The reference implementation's follow-ups
  (characterization flips, re-vendor, rules regen, UR-4 enforcement) are explicitly out of scope.
- Appendix F changes keep exact table format; any new rule (UR-4) follows UR-2's row shape.
- Update every touched rule's flat-index row consistently. Reconcile, don't coexist: §3's
  ordering sentence must no longer invite the Number-arithmetic reading F15 documents.
- Vectors (Appendix G format): one chain vector exercising the F16 ruling; one application
  vector for the out-of-range T2 clamp with exact expected bytes. Record the checksum-pinned
  vendored-copy consequence for scrutiny-fabric-tools in docs/DECISIONS.md (next S-number),
  exactly as the F13/F14 landing recorded its own.
- Changelog bullets stay terse and rule-ID-cited; rationale goes to DECISIONS.md as S-entries.
- Commit at rule-level boundaries (per-entry spec text; vectors; version bump; changelog +
  decisions), matching the a92bedb..995e05b shape.

REPORT BACK at the end: the exact version number(s) landed, the F16 and F17 rulings with their
final rule text, the vector files touched, and the one-line pointer the reference
implementation's follow-up session (characterization-case flips, UR-4 enforcement, re-vendor,
rules:gen) should start from. Scheduling that session is not your job — hand back the number(s)
and pointers.
```

---

## After this session

The `scrutiny-fabric-tools` follow-up (separate session, scheduled against the version this one
reports back): re-vendor Appendix G vectors at fresh checksums (D33), `pnpm rules:gen` against
the amended Appendix F, land UR-4 enforcement in `resolve.ts` if hold-pending won (or delete the
S3-21 caveat if optimistic-include won), flip the S3-21/S3-30/future Step-4 characterization pins
to match, and add the F17/F16-derived regression cases to the planned `test/*-regressions.ts`
tables. None of that is scheduled as a numbered phase until this session exists.

## Do not

- Touch `scrutiny-fabric-tools` from this session. The core follow-up is a separate session.
- Leave §3's "as numbers" wording un-reconciled after F15 (the whole point of F15 is that this
  reading is wrong on the reference platform and silently produced the audit's S3-11 defect).
- Write the F16 rule only in CHN-1/PT-6 terms without checking §7.6's resubmission grammar —
  the unobserved-parent case must compose with §7.6's "retained and re-evaluated" shape, not
  duplicate it in a second voice.
- Land the T2 amendment without saying explicitly what "number of lines" means with a trailing
  newline at end of file — that ambiguity is the exact bug this entry exists because of.
- Bundle the version numbers silently — write down the one-release-vs-two reasoning with the D45
  precedent named.
