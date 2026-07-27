# Spec feedback — v0.6.0 (`scrutiny-v060`)

Defects found while implementing `@scrutiny-fabric/core`. D2 makes spec feedback a tracked
deliverable: gaps are recorded and batched into an amendment brief rather than worked around
locally. This file is that batch. It supersedes `SPEC-AMENDMENT-BRIEF.md`, which is spent.

Line numbers are against `~/scrutiny-fabric/docs/protocol-spec.md` at v0.6.0 (1449 lines).

Status legend: **open** — reported, not yet resolved in the spec.

---

## F1 — P1 is unsatisfiable for short content, so it cannot be a Validity rule

**Status:** open · **Rules:** P1, T2, C7 · **Sections:** §5.2, §5.3, §6.0 · **Severity:** blocks a
faithful implementation

§6.0 (line 638) assigns P1 to the Validity layer, and line 641 gives V a single disposition: "A
V-invalid event MUST NOT enter SCRUTINY processing and MUST NOT be rendered." P1 (line 557) reads:

> Minimum 3 lines of context before and after each change block (the default for all reference
> tools).

Three independent problems, in descending order of force:

1. **T2 becomes unreachable.** T2 (line 590) is an Application rule that normatively defines apply
   semantics for a hunk with **no context lines**: "A hunk with no context lines and no `-` lines
   … MUST apply at the position implied by its `@@` header's `-` line number." If P1 rejected at
   the V layer, no zero-context hunk could ever reach the A layer, and T2 would specify mandatory
   behaviour for a case the spec has already made impossible.

2. **The spec's own example violates P1.** The payload at lines 564–571 has zero context lines
   before or after its change block. Under P1-as-rejection the specification's illustrative patch
   is V-invalid.

3. **The parenthetical is factually false.** Verified 2026-07-27 by running the reference
   invocation from line 549 against a one-line file:

   ```
   $ git diff --no-index --unified=3 a/content b/content
   @@ -1 +1 @@
   -Infineon M7794A12 (BSI-DSZ-CC-0814-2012, CC EAL4+)
   +Infineon M7794A12 - Rev B (BSI-DSZ-CC-0814-2012, CC EAL4+)
   ```

   `--unified=3` is a *maximum* the tool supplies where the content affords it, not a minimum it
   guarantees. Since SCRUTINY diffs a single `content` field — frequently one line — every change
   within three lines of a content boundary produces a P1-violating payload from the spec's own
   recommended command. This is the common case, not an edge case.

There is also a weaker argument from C7 (line 541), which obliges consumers to accept any payload
matching the §5.2 consumer grammar, whose `hunk-block` production (line 525) permits any number of
context lines. It is weaker because it depends on reading the grammar literally, and the grammar is
itself defective — see F3.

**Suggested resolution.** Either retag P1 as **A** and reword it as a producer obligation, or
reword the requirement as `min(3, available)`. Note that the second form still cannot be checked by
a validity function: "available" depends on the *target event's* content, which a pure
one-event-in-issues-out validator never sees. Under either resolution P1 is enforced when
**building** a patch, not when validating a received one.

**What the implementation does meanwhile.** `validate.ts` does not evaluate P1 and emits no code
for it. `build.ts` (Phase 6) enforces it by construction via jsdiff `context: 3` (D31). P1 is
recorded in the not-test-covered coverage bucket with this reason.

---

## F2 — P2's stated remedy does not work: `git diff --no-index` still emits the index line

**Status:** open · **Rules:** P2 · **Sections:** §5.2 · **Severity:** wrong advice, rule is sound

P2 (line 558) forbids `index <oldsha>..<newsha> <mode>` lines and advises: "Use `--no-index` with
git, or strip these post-hoc." The first clause is false. Verified 2026-07-27:

```
$ git diff --no-index --unified=3 a/content b/content
diff --git a/a/content b/b/content
index 7ebcdab..331da67 100644
--- a/a/content
+++ b/b/content
@@ -1 +1 @@
```

`--no-index` makes git diff two paths outside a repository; it has no effect on index-line
emission. The reference toolchain table at line 549 recommends this exact command, so a producer
following the spec literally emits payloads that P2 declares invalid.

**Suggested resolution.** Strike "Use `--no-index` with git, or" and keep "strip these post-hoc",
or name a filter explicitly. The rule itself is correct and needs no change.

**What the implementation does meanwhile.** P2 stays an error. An `index <sha>..<sha>` line has no
production in the consumer grammar — it appears exactly where the grammar has no slot, between
`diff --git` and `---` — so C7's acceptance obligation never attaches to it, and C3 (line 537)
explicitly distinguishes this line from the tolerated `Index:` preamble.

---

## F3 — The consumer grammar's `*VCHAR` excludes SP and all non-ASCII

**Status:** open · **Rules:** C2, C7, E5 · **Sections:** §5.2 · **Severity:** the grammar as written
rejects the spec's own example

The grammar at lines 519–529 is ABNF, in which `VCHAR = %x21-7E` (RFC 5234) — printable ASCII
excluding the space. The grammar's own `trailing = SP *VCHAR` (line 528) confirms SP is being
treated as distinct from `VCHAR`. Read literally:

- `hunk-line = ( " " / "+" / "-" / "\" ) *VCHAR LF` (line 527) cannot match a context line
  containing an internal space.
- It cannot match any line containing a non-ASCII byte — including the spec's own example line
  `+Infineon M7794A12 — Rev B (BSI-DSZ-CC-0814-2012, CC EAL4+)` (line 570), which contains an
  em dash.
- `trailing = SP *VCHAR` cannot match a `patch -u` timestamp such as `2026-07-27 12:00:00 +0200`,
  because of the internal spaces — yet C2 (line 536) mandates tolerating exactly those timestamps.

**Suggested resolution.** Define the line-body production as "any octet sequence except LF", e.g.
`line-content = *(%x00-09 / %x0B-FF)`, and redefine `trailing` the same way. Alternatively state
that the grammar is illustrative and that the payload is UTF-8 text delimited by LF.

**What the implementation does meanwhile.** `validate.ts` implements the loosened reading: a line
body is any sequence of characters other than LF. Implementing the grammar literally would reject
the majority of real payloads.

---

## F4 — §6.0's Validity manifest cites §5.1, whose only two rules are tagged A

**Status:** open · **Rules:** PB-1, PB-2 · **Sections:** §6.0 · **Severity:** editorial, but it is
the citation implementers partition against

The V bullet at line 638 reads:

> - The patch-payload envelope and unified-diff format grammar (§5.1, §5.2 E1–E6, C1–C4, C7,
>   P1–P3).

§5.1 contains exactly two rules, PB-1 and PB-2 (lines 481–482), and **both are tagged A**. The
v0.6.0 changelog (line 21) records that this bullet was audited this revision specifically to stop
it sweeping in an Application rule: "§6.0's Validity manifest now cites `E1–E6` rather than `E*`
(which swept in E7, an Application rule) and includes C7." The wholesale `§5.1` citation defeats
that audit by the same standard.

This matters beyond tidiness: the V manifest is the list an implementation partitions its validity
checks against, and F1 turns on whether that list is authoritative or over-broad. It is
demonstrably over-broad by its own editorial standard.

**Suggested resolution.** Replace `§5.1` with nothing, or cite the §5.1 prose without implying its
rules are V.

---

## F5 — a payload with two header blocks has two incompatible readings

**Status:** open · **Rules:** C7, C1 · **Sections:** §5.2 · **Severity:** ambiguity, rare in practice

The grammar at line 519 admits exactly one `header-block`:

```
patch-payload = [ index-preamble ] [ diff-git-line ] header-block *hunk-block
```

Given a payload containing a second `--- a/content` / `+++ b/content` pair, two readings follow
from the spec's own text and they disagree:

1. `hunk-line = ( " " / "+" / "-" / "\" ) *VCHAR LF` (line 527). `--- a/content` begins with `-`, so
   it is a **valid hunk-line** — a removal of the line `-- a/content`.
2. Every real unified-diff parser, including jsdiff, treats it as the start of a **second file
   patch**. Verified 2026-07-27: `parsePatch` returns two patch objects for such a payload.

Nothing in §5.2 says which is intended, and the two produce different content.

**Suggested resolution.** State that a payload contains exactly one header block and that a
subsequent `---` line at hunk-line position is a removal line, or explicitly permit multiple header
blocks and define their sequencing. Either is fine; the silence is the defect.

**What the implementation does meanwhile.** Takes reading 2, concatenating the hunks of every
parsed file patch in document order and sequencing them under T3. It drops nothing and is
deterministic. Covered by a test in `patch.test.ts`.

---

## F6 — T2 and T3 disagree about which file a pure insertion's line number indexes

**Status:** open · **Rules:** T2, T3 · **Sections:** §5.3 · **Severity:** produces wrong content;
found by the Phase 2 property test, not by inspection

T2 (line 591) says a pure-insertion hunk "MUST apply at the position implied by its `@@` header's
`-` line number". T3 (line 592) says each hunk is evaluated "against the content as produced after
all prior hunks in the **same patch** have already been applied".

For a hunk located by T1 there is no conflict — it is found by content match, and C6 makes the
numbers advisory. For a **pure insertion** there is no pattern to match, so the `@@` number is the
only positional information available. But that number indexes the **pre-patch** file, while T3
requires application against the **post-prior-hunk** content. Once an earlier hunk in the same
patch has added or removed lines, the two instructions designate different positions and the spec
does not say which wins.

Concretely, from the generated counterexample (fast-check seed 2082756637), content `a\n+++ b/content\n`:

```
--- a/content
+++ b/content
@@ -1,1 +0,0 @@
-a
@@ -2,0 +2,1 @@
+a
\ No newline at end of file
```

The first hunk removes one line. Applying the second hunk's `-2` literally against the now-shorter
content inserts one position too late and yields `+++ b/content\n\na` — an extra blank line — where
the patch's own intent is `+++ b/content\na`.

**Suggested resolution.** Add to T2: the `@@` line number is interpreted in the coordinates of the
patch's pre-application content, and is carried forward by the net line delta of all prior hunks in
the same patch. That is what `git apply` and jsdiff both do, and it is the only reading under which
T2 and T3 can both hold.

**What the implementation does meanwhile.** Tracks a running line-count shift and offsets T2's
insertion index by it. Pinned as regression case
`t2/insertion-index-after-an-earlier-hunk-shifted-lines`.

---

## F7 — the grammar's `hunk-line` cannot match a blank context line

**Status:** open · **Rules:** C7, C5 · **Sections:** §5.2 · **Severity:** rejects payloads every
real tool accepts

`hunk-line = ( " " / "+" / "-" / "\" ) *VCHAR LF` (line 527) requires a prefix character. A context
line that is itself empty is therefore encoded as a single space — and a lone trailing space is the
first thing stripped by editors, mail transports, web forms, and any pipeline that trims lines. The
resulting bare empty line matches no production, so a consumer reading the grammar strictly rejects
a payload that every deployed applier accepts.

Verified 2026-07-27:

- `git diff` **emits** the space form: `cat -A` shows ` $` for a blank context line.
- `git apply` **accepts** the stripped form: given a hunk whose blank context line has no leading
  space, it reports "Applied patch cleanly."
- `jsdiff.parsePatch` accepts it too, preserving it as a `""` element in `hunk.lines`.

This is the same class of defect as F3 — the grammar is stricter than the format it describes — but
it is independent of the `*VCHAR` reading and survives F3's suggested fix.

**Suggested resolution.** Allow an empty line as a context line:
`hunk-line = ( " " / "+" / "-" / "\" ) line-content LF / LF`.

**What the implementation does meanwhile.** Treats a bare `""` inside a hunk as a context line with
an empty body. Pinned as regression case `grammar/empty-context-line`.

---

## F8 — the reference producer emits a separator line the grammar does not admit

**Status:** open · **Rules:** C3 · **Sections:** §5.2 · **Severity:** minor, but it affects a tool
the spec names

`index-preamble = "Index: content" LF "=" 1*"=" LF` (line 521) admits the `===…` separator only
when preceded by an `Index: content` line. jsdiff — named in the reference toolchain at line 549 —
emits the separator **without** the `Index:` line when the patch is produced through
`structuredPatch` + `formatPatch` rather than `createPatch`. Verified 2026-07-27 with `diff@9.0.0`:

```
===================================================================
--- a/content
+++ b/content
@@ -1,1 +1,1 @@
```

`createPatch` emits both lines, but it names the paths `content`, not `a/content` / `b/content`,
so it violates C1 — meaning neither jsdiff entry point emits a payload the spec accepts unmodified.

**Suggested resolution.** Make the `Index:` line optional relative to the separator:
`index-preamble = [ "Index: " *VCHAR LF ] "=" 1*"=" LF`.

**What the implementation does meanwhile.** `makePatch` strips a leading bare separator line so its
own output is grammatical, and the consumer path tolerates the line either way (§5.2's grammar is a
floor on acceptance, not a ceiling).

---

## F9 — C5 names an English string that GNU diff and git localise

**Status:** open · **Rules:** C5 · **Sections:** §5.2 · **Severity:** rejects conformant payloads
produced under a non-English locale

C5 (line 540) refers to "a `\ No newline at end of file` marker". GNU diff and git translate this
message through gettext, so the same content diffed under `LANG=de_DE.UTF-8` produces
`\ Kein Zeilenumbruch am Dateiende`. A consumer matching the English text treats such a payload as
carrying an unrecognised line and silently loses the no-trailing-newline signal — which changes the
resulting bytes, and PB-1 makes those bytes normative.

The grammar itself is already correct here: `hunk-line` admits `\` as a prefix without constraining
what follows.

**Suggested resolution.** Reword C5 to key on the prefix — "a hunk line beginning with `\` is a
no-newline-at-end-of-file marker; its text is informational and MUST NOT be relied upon" — and keep
the English form as an example.

**What the implementation does meanwhile.** Matches on the `\` prefix, not the message text. Pinned
as regression case `c5/localised-marker`.

---

## F10 — self-fork precedence over HALT is stated unconditionally, and conflicts with H1 when the HALT is upstream

**Where.** §5.3 step 5: *"A root-self-fork (§7.2) is a separate freeze condition that applies before
HALT; if the chain is forked, canonical bytes freeze at the shared parent regardless of whether the
per-patch pre-validation would have failed."* Against H1, same table: *"No later patches are applied,
even if they might themselves be individually valid."* And SF-6: *"patched content is frozen at the
earliest unresolved fork."*

**The conflict.** Take a canonical chain `root → p1 → p2` where `p2` has two root-author children —
a self-fork at `p2` — and where `p1` fails pre-validation.

| rule | freeze point |
|---|---|
| H1 | the root state; `p1` never applies |
| §5.3 step 5, read literally | `p2`, the shared parent of the forked patches |

Freezing at `p2` requires applying `p1` and `p2` — that is, applying two patches *past a HALT*, which
H1 prohibits without qualification. The precedence sentence does not bound itself to the case where
the fork is upstream of the halt, which is the only case where the two rules agree.

The asymmetry is worth seeing: when the fork is **upstream**, there is no conflict and nothing to
decide, because the walk stops at the fork parent and the downstream HALT is never even discovered —
the chain past an undefined point is not evaluated. The conflict exists only in the other direction.

**Why it matters.** The two readings return different canonical bytes for the same event set, from
two MUST-level rules, with no stated tiebreak. §7.1's canonical-bytes guarantee is what non-UI
consumers — indexers, vulnerability scanners — serve downstream, and RC-3 obliges them to recompute
into it. Two conforming implementations disagreeing here is exactly the class of divergence the
determinism rules exist to prevent.

**Suggested fix.** Bound the precedence to the case it was written for, and name the freeze point
rather than the winning rule. Something like: *"Where both conditions are live, canonical bytes
freeze at whichever point is earlier in chain order. A self-fork upstream of a HALT freezes at the
shared parent and the downstream patches are never evaluated; a HALT upstream of a self-fork freezes
at the last successfully applied patch, and the fork is still surfaced per SF-3 though it did not
determine the content."*

**What the implementation does meanwhile.** Freezes at the earlier of the two points, reports the
earlier cause as the status, and surfaces *every* condition found as an annotation regardless of
which one froze the chain — so SF-3's MUST is satisfied even when the fork lost the race. Reasoning
and the two cases are written up in `docs/RESOLVE.md` §4.

---

## F11 — §5.4's resource limit has no disposition in §7.3's overlay table, or in the chain states

**Where.** §5.4: *"Exceeding a ceiling aborts application and MUST be surfaced as a distinct
resource-limit-exceeded annotation, never as HALT. The event remains V-valid."* Against §7.3's
overlay table, which offers exactly four states, and §7.4's chain procedure, which offers
resolved-or-HALT-or-frozen.

**The gap.** A ceiling can be hit in two places, and neither has a defined outcome.

*Classifying an overlay.* The four states are clean, conflict, stale, orphaned. A ceiling is none of
them: the overlay may well apply, so `conflict` asserts a failure that was never established; the
target is perfectly well defined and obtainable, so `orphaned` is false and would wrongly trigger
the α/β rule. OV-4 requires the classification be a pure function of (payload, target content) —
which it still is, given fixed ceilings — but the function has no value to return.

*Applying the chain.* §7.4 step 4 has two outcomes, apply-all or HALT. A ceiling is explicitly not a
HALT, but the chain is not resolved either: patches remain that were deliberately not applied.
Reporting `resolved` would name the last applied patch as the tip and claim a completeness the
implementation does not have — and RC-3 obliges non-UI consumers to serve canonical bytes on that
basis.

**Why it matters.** RL-2 exists because patch payloads are adversary-controlled on a permissionless
network, so hitting a ceiling is an expected operating condition, not an exotic one. Two conforming
implementations will pick different fallbacks — most likely `conflict`, which is the closest of the
four and is a false statement about the overlay's author.

**Suggested fix.** Give the limit its own disposition in both places. For overlays, a fifth state
(or an explicit "the classification is unavailable" carve-out attached to the annotation). For the
chain, wording that distinguishes "aborted under a ceiling" from both "resolved" and "HALT", since
§5.4 already insists the two must not be conflated.

**What the implementation does meanwhile.** Adds a fifth `OverlayState`, `unclassified`, marked in
the type's own documentation as *not* one of §7.3's four; and a fifth `ChainState`, `aborted`,
carrying the ceiling that was hit. Both are accompanied by the distinct RL-3 annotation §5.4
requires, and neither ever cites H1.

---

## Cross-cutting note — the V layer has only one disposition

Three of the four items above are symptoms of the same underlying shape: §6.0 gives the Validity
layer exactly one consequence (line 641, "MUST NOT enter SCRUTINY processing"), so every rule the
manifest sweeps into V becomes a rejection rule. Rules that are genuinely *advisory to producers*
(P1, P3's LF clause, E4) or *obligations on the consumer to accept* (C7, N2) have no disposition
that fits, and get V-tagged for want of anywhere better.

`@scrutiny-fabric/core` resolves this locally by giving each emitted issue a severity of `error` or
`warning`, where only `error` rejects. That is an implementation affordance with no basis in the
spec text, and it is recorded here as such rather than presented as a reading. The spec may wish to
introduce a non-rejecting advisory disposition explicitly.
