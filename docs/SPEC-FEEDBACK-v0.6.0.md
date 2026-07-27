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
