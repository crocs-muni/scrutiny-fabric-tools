# Spec feedback — v0.6.0 (`scrutiny-v060`)

Defects found while implementing `@scrutiny-fabric/core`. D2 makes spec feedback a tracked
deliverable: gaps are recorded and batched into an amendment brief rather than worked around
locally. This file is that batch. It supersedes `SPEC-AMENDMENT-BRIEF.md`, which is spent.

Line numbers are against `~/scrutiny-fabric/docs/protocol-spec.md` at v0.6.0 (1449 lines). **The
spec has since moved to v0.6.1 (1504 lines), so every line citation below is stale by that delta.**
The quoted spec text is the v0.6.0 text the defect was reported against, and is retained
deliberately — rewriting it would erase what was actually wrong.

Status legend: **open** — reported, not yet resolved in the spec. **resolved in v0.6.1** — the
amendment landed; the entry is kept for the record, not as outstanding work.

**All eleven of F1–F11 are resolved as of spec v0.6.1**; F12–F14 are new and open. Verified during the Phase 8 audit
(2026-07-31) by re-reading the spec fresh; see `AUDIT-2026-07-31.md` §9 for the per-entry table
of what each amendment became (F1 retagged A, F3 widened `line-content` to `%x00-09 / %x0B-FF`,
F5 → C8, F10 → SF-7, F11 → OV-9/RL-5, …). Each implementation workaround was re-checked and all
remain correct. Three source comments still describe departures the amendments removed — tracked
as P12 in that report, not here. F13 and F14 were filed during the 2026-08-01 spec-and-plan pass, per
`PLAN-2026-08-01-rewrite-mandate.md` §5 and §7.

---

## F1 — P1 is unsatisfiable for short content, so it cannot be a Validity rule

**Status:** resolved in v0.6.1 · **Rules:** P1, T2, C7 · **Sections:** §5.2, §5.3, §6.0 · **Severity:** blocks a
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

**Status:** resolved in v0.6.1 · **Rules:** P2 · **Sections:** §5.2 · **Severity:** wrong advice, rule is sound

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

**Status:** resolved in v0.6.1 · **Rules:** C2, C7, E5 · **Sections:** §5.2 · **Severity:** the grammar as written
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

**Status:** resolved in v0.6.1 · **Rules:** PB-1, PB-2 · **Sections:** §6.0 · **Severity:** editorial, but it is
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

**Status:** resolved in v0.6.1 · **Rules:** C7, C1 · **Sections:** §5.2 · **Severity:** ambiguity, rare in practice

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

**Status:** resolved in v0.6.1 · **Rules:** T2, T3 · **Sections:** §5.3 · **Severity:** produces wrong content;
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

**Status:** resolved in v0.6.1 · **Rules:** C7, C5 · **Sections:** §5.2 · **Severity:** rejects payloads every
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

**Status:** resolved in v0.6.1 · **Rules:** C3 · **Sections:** §5.2 · **Severity:** minor, but it affects a tool
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

**Status:** resolved in v0.6.1 · **Rules:** C5 · **Sections:** §5.2 · **Severity:** rejects conformant payloads
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

---

## F12 — RL-2's ceiling unit ("bytes compared") is free to exhaust

**Status:** open · **Rules:** RL-2, RL-3 · **Sections:** §5.4 · **Severity:** lets an adversary run
an unbilled scan; bounded in practice, but the unit is the hole

**Where.** §5.4: *"Consumers SHOULD enforce configurable ceilings. Because an adversary optimises
against whichever unit is counted, consumers SHOULD additionally bound the total work of patch
application, measured in bytes compared, rather than relying on hunk or patch counts alone."*

**The problem.** "Bytes compared" is itself a unit an adversary can optimise against. T1's uniqueness
scan costs `|content| × |pattern|` *element* comparisons regardless of how many bytes those elements
contain, so a pattern consisting of **empty lines** costs a full scan and bills zero bytes. §5.4's own
justification for preferring total work over hunk counts — that an adversary optimises against
whichever unit is counted — applies verbatim to the unit it then recommends.

Found during the Phase 8 audit (2026-07-31) by reading `patch.ts`'s charge against the rule text.
Practical severity is limited rather than absent: a pattern of empty lines is unlikely to occur
exactly once in blank-line-heavy content, so the first such hunk usually HALTs on `ambiguous-match`
after one scan. Chaining several uncharged scans in one payload requires each empty pattern to be
unique, which is constructible but fiddly. The unbilled single scan is unconditional.

**Suggested amendment.** Have RL-2 name the unit as *comparisons, charged at no less than one per
line*, rather than "bytes compared" — or state that implementations MUST include a per-element floor
in whatever unit they choose.

**How this implementation handles it.** `patch.ts` charges `|content| × Σ(len(line) + 1)` rather than
`|content| × Σ len(line)`, so every pattern line costs at least one unit whatever its contents.
Landed in `83d2393`.

---

## F13 — Patch's own `e root` has no endpoint-typing rule; §4.4 never rejects an observed wrong-typed root

**Status:** open · **Rules:** PT-10 (new), PT-11 (new), BD-3, BD-4, BD-5, BD-7, UR-2 · **Sections:**
§4.3, §4.4, §7.6 · **Severity:** a real gap in the Validity layer's own coverage — not currently
exploitable in `@scrutiny-fabric/core`, but only because of two guards the spec itself does not
require

**Where.** §4.3's Binding endpoints have a full typing lifecycle. The rule table (lines 300–311):

> BD-3 | V | — | The `e root` endpoint MUST be a `scrutiny-product` event.
> BD-4 | V | — | The `e link` endpoint MUST be a `scrutiny-metadata` event.
> BD-5 | V | — | A Binding whose endpoints, once observed, do not satisfy BD-3/BD-4 is an invalid
> SCRUTINY event and MUST NOT be admitted.
> BD-7 | V | — | A Binding whose observed endpoint contradicts BD-3/BD-4 transitions to permanently
> invalid; implementations SHOULD cache the rejection.

— typed (BD-3/BD-4), rejected once observed (BD-5), permanently cached on rejection (BD-7). §4.4's
Patch rule table (lines 354–362) gives its own `e root` tag only a cardinality rule:

> PT-1 | V | NIP-10 | A Patch event MUST carry exactly one `e` tag with marker `root` (pointing at
> the root Product or Metadata).

"pointing at the root Product or Metadata" is prose, not a rule; no PT rule constrains what type the
referenced event actually turns out to be once observed. §7.6's UR-2 (line 846) covers only the case
where the root has not yet arrived: "A Patch whose `e root` is unobserved MUST be retained and
re-evaluated on the root's arrival." It says nothing about the case where the root *has* arrived and
is, say, a Binding, another Patch, or a plain non-SCRUTINY event.

**The gap.** Every other endpoint reference in the spec that can resolve to the wrong type gets a
rejection rule (BD-5/BD-7) once observed. A Patch's `e root` reference is the identical shape of
hazard — a NIP-10 `e` tag pointing at an arbitrary event id, whose type is unknown until that event
is observed — and gets only the pending half of the lifecycle (UR-2), never the rejection half.

**Independently re-verified against the current implementation.** `validate.ts`'s `checkPatch`
(lines 339–404) looks up the root event once observed (`options.lookupEvent?.(root.id)`, line 374)
and from that point on only ever reads `rootEvent.pubkey` — the root-author/foreign classification
at line 384 (`if (event.pubkey === rootEvent.pubkey) return`) — never `scrutinyEventType(rootEvent)`.
A Patch whose declared `e root` resolves to, say, a Binding event authored by the same pubkey as the
Patch passes `checkPatch` cleanly: PT-1/PT-2 cardinality holds, the root-author branch returns with
no issue pushed, and no other check in the function inspects the root's type.

**Independently re-verified whether this is currently exploitable.** It is not, for two reasons
neither of which the spec requires:

1. `admit.ts`'s `rootChainMembers` (lines 136–151) is only ever invoked with a root already confirmed
   by `isRoot` (lines 153–156, `t === 'product' || t === 'metadata'`) — see the call site at line 183
   (`const roots = all.filter(isRoot)`) feeding the loop at line 210. A Patch whose declared `e root`
   is not itself product/metadata can never acquire the `root-chain` admission reason, because
   nothing ever walks from a non-root root. (It can still be admitted via `direct-trust`, TR-2, if
   its own pubkey is directly trusted — admission and canonical-chain membership are different
   questions, and TR-2 credits *every* observed event by a trusted pubkey regardless of type.)
2. `resolve.ts`'s `resolve()` (lines 265–273) independently re-derives `rootType =
   scrutinyEventType(root)` from its own lookup of the actual root event and returns `{ chain:
   { status: 'absent', reason: 'root-not-patchable' } }` whenever that type is neither `product` nor
   `metadata` — regardless of what the Patch itself declared or how `checkPatch` classified it. The
   guarding comment at line 263 attributes this to BD-9 ("a Binding is corrected by kind 5 plus a
   replacement, never by a patch"), which is a citation of convenience — BD-9 is about *Bindings* not
   being patch-correctable, not about a Patch's own root typing — but the guard itself is real,
   unconditional, and independent of `admit.ts`.

Given both, this re-check confirms the mandate's claim: no incorrect canonical content is ever
rendered from a Patch declaring a wrong-typed `e root`, because chain construction is always driven
by `resolve()`'s own root lookup and type re-check, never by trusting `checkPatch`'s verdict. But
both guards are `@scrutiny-fabric/core`'s own incidental hardening. A differently-shaped conforming
implementation — one that treats a V-clean `checkPatch` result as sufficient before doing chain work,
or that omits `resolve.ts`'s BD-9-flavored guard (nothing in §4.4 or §7.6 requires it) — has no
defense at all: the spec's own rule table gives it nothing to reject on.

**Suggested resolution.** Mirror BD-3/BD-5's exact pattern for Patch's own root reference:

- **PT-10** (V) — "The event referenced by `e root` MUST be a `scrutiny-product` or
  `scrutiny-metadata` event."
- **PT-11** (V) — "A Patch whose OBSERVED `e root` violates PT-10 is invalid and MUST NOT be
  admitted."

UR-2 needs no change — it already covers the pending case ("retained and re-evaluated on the root's
arrival") precisely, and PT-11 is deliberately scoped to the *observed* case so the two rules
partition the same way BD-6/BD-7 already do for Bindings. Unlike BD-7, no separate caching rule is
proposed for PT-11: UR-3 already forbids caching a Patch's authorship class while its root is
unobserved, and once the root **is** observed a PT-10 violation cannot change on further observation
(the root event's own type is immutable), so caching a PT-11 rejection falls out of UR-3 as written
and does not need a new rule of its own.

**What the implementation does meanwhile.** `validate.ts`'s `checkPatch` does not evaluate
PT-10/PT-11 and emits no code for either — it performs only the pubkey-based authorship comparison.
Correctness is preserved incidentally, not by design against this specific rule: `admit.ts`'s
`isRoot`-gated `rootChainMembers` walk and `resolve.ts`'s own `rootType` re-check (cited above) both
independently prevent a wrong-typed declared root from ever contributing to a canonical chain or
overlay. PT-10/PT-11 are recorded in the not-test-covered coverage bucket with this reason until the
amendment lands and `checkPatch` gains a direct check.

---

## F14 — version-tag digit ceiling: TAG-2/VER-1's three-digit form has no headroom, and VER-1's ordering claim only holds because of the ceiling it should remove

**Status:** open · **Rules:** TAG-2 (rewritten), VER-1 (rewritten) · **Sections:** §3, §3.1, §4.5 ·
**Severity:** already hit once (D45); VER-1's ordering claim is false the moment any field needs two
digits, not just eventually

**Where.** §3's Version-tag form paragraph (line 64):

> Version tags match the regular expression `^scrutiny-v\d{3}$`. The three digits encode `MAJOR`,
> `MINOR`, `PATCH` respectively (`scrutiny-v061` ≡ v0.6.1). Comparisons between version tags are
> lexicographic on the three-digit suffix, which coincides with semantic ordering because the digits
> are zero-padded.

TAG-2 (line 75): "Every SCRUTINY event MUST carry exactly one version `t` tag matching
`^scrutiny-v\d{3}$`." VER-1 (line 79): "The three digits in `scrutiny-vMMP` encode MAJOR/MINOR/PATCH.
Lexicographic comparison coincides with semantic ordering."

**The problem, re-verified.** `^\d{3}$` is exactly one digit per field, so each of MAJOR/MINOR/PATCH
is capped at 9. This is not hypothetical: `DECISIONS-2026-07-27.md` D45 records that this project's
own spec target hit the ceiling once already — "`scrutiny-v059` is already patch 9 and the tag regex
is `^scrutiny-v\d{3}$` with digits encoding MAJOR/MINOR/PATCH, so there is no `scrutiny-v0510`.
Staying in 0.5.x would require changing the tag scheme itself — breaking TAG-2, VER-1, and every
published event." The current spec is at v0.6.1; the identical forcing recurs at MINOR=9 (a
hypothetical v0.9.x needing a tenth minor release) and, with no digit anywhere to borrow from a fixed
3-character suffix, MAJOR=9 is a hard wall — there is no larger bump left that stays inside the
current grammar at all.

The ceiling and the ordering claim are the same defect, not two independent ones: line 64's
"coincides with semantic ordering because the digits are zero-padded" is true only because each
field is fixed at exactly one digit. The moment a field needs two digits, "zero-padded to width 1"
stops meaning anything, and the classic lexicographic-string-sort failure reappears in its usual
form — a two-character `"10"` sorts before a one-character `"9"` under `<` on strings, the opposite
of numeric order. §3's own text supplies no path to widen the digit count without abandoning the
fixed-width regex TAG-2 requires, so there is no way to patch around the ceiling that does not also
require rewording VER-1.

Re-verified against `events.ts`: `VERSION_TAG_PATTERN = /^scrutiny-v\d{3}$/` (line 56) and
`parseVersionTag` (lines 182–190) read `digits[0]`, `digits[1]`, `digits[2]` as single characters —
implementing the one-digit-per-field ceiling exactly as specified, not a defensive workaround.
`compareVersionTags` (lines 199–203) is a **raw string `<`/`>` comparison** of the sliced
three-character suffix, with no per-field parsing at all — its own doc comment (lines 195–197)
restates VER-1 verbatim: "VER-1 guarantees lexicographic comparison of the three-digit suffix
coincides with semantic ordering, because the digits are zero-padded and fixed-width." This is
concrete, not speculative: the live reference implementation's `compareVersionTags` *is* the ordering
claim, encoded as code, and it breaks on the same input that breaks the spec prose.

**Suggested amendment.**

1. **New dedicated single-letter `v` tag**, following the exact precedent §3.1 already sets for
   `i`/`k` (line 104, and the NIP-73 row of §3.1's inherited-semantics table, line 131): single-letter,
   outside the `t` tag namespace, relay-indexable via NIP-01's single-letter tag indexing convention
   (`#v`) without inventing new machinery. Unlike `i`/`k`, the `v` tag is not NIP-73-shaped or
   externally defined — it is SCRUTINY's own, so it needs its own row in §3.1 rather than reuse of
   the NIP-73 row: `["v", "<MAJOR>.<MINOR>.<PATCH>"]`, each field an unpadded decimal integer, no
   fixed width, no digit-count ceiling in any field. This also answers the mandate's own open
   question — does the new format widen room for MAJOR, or is single-digit MAJOR acceptable
   indefinitely — directly: an unpadded field has no ceiling for MAJOR either, so the amendment
   should not special-case MAJOR differently from MINOR/PATCH.
2. **TAG-2 rewritten**: "Every SCRUTINY event MUST carry exactly one `v` tag whose value matches
   `^\d+\.\d+\.\d+$`." The `t`-tag version form (`scrutiny-vMMP`, `^scrutiny-v\d{3}$`) is retired
   outright, not deprecated alongside the new form. **No grandfather clause** — no dual-path
   "accept either form" text anywhere, since no real corpus exists yet to preserve compatibility
   with, which is the rewrite mandate's own premise for every item in that document. This is
   consistent with D45's own precedent: the v0.5.9→v0.6.0 migration did not carry the old tag scheme
   forward in parallel when its ceiling was first hit, and the spec already states that underscored
   variants from older drafts go unrecognised (TAG-4) rather than being accepted alongside the
   current kebab-case form — this project's history is retiring an old tag form outright, not
   accreting a dual-path.
3. **VER-1 rewritten**, explicitly retracting the lexicographic claim: "Ordering between two version
   tags is a per-field numeric tuple comparison: parse `MAJOR`, `MINOR`, `PATCH` as separate decimal
   integers from the `v` tag value and compare `(MAJOR, MINOR, PATCH)` field-by-field as numbers.
   This is never a wholesale string or lexicographic comparison of the tag value." Should state
   directly that the previous "lexicographic … because zero-padded" text was correct only under the
   one-digit-per-field ceiling this amendment removes, and does not survive it.
4. **Downstream sweep, not just the two rules**: the mini-example JSON in §4.1–§4.4 all carry
   `["t", "scrutiny-v061"]`; each needs `["v", "0.6.1"]` in its place — in place of, not alongside,
   given the no-grandfather-clause decision above. §4.5's indexer-discipline table treats `i`/`k`
   tags on root events as immutable (IX-3); the amendment should state explicitly that a `v` tag is
   fixed per-event by construction (it types that one event's own wire format, not the chain's
   evolving content), so no analogous mutability question exists for it — not because it inherits
   IX-3, but because the question does not arise the way it does for content-describing indexers.

**How this implementation handles it.** `events.ts`'s `VERSION_TAG_PATTERN`, `parseVersionTag`, and
`compareVersionTags` implement today's 3-digit `t`-tag scheme and its string-comparison ordering
exactly as the current spec specifies — including the same ceiling and the same "zero-padded"
assumption, restated verbatim in `compareVersionTags`'s own doc comment. No workaround exists in the
implementation today, because the ceiling has not yet forced a second migration; this entry is filed
prospectively, following D45's own lesson, so that a fix lands with headroom instead of under the
forced-bump pressure that produced v0.6.0 the first time.

## F15 — PT-7 × DEL-7 interaction: orphaned/α is reachable only for PT-7-typed targets, which §10's "obtainable" wording never says

**Status:** open · **Rules:** DEL-7 (wording clarification requested), PT-7 (unaffected — works as
specified) · **Sections:** §4.4, §7.3, §10 · **Severity:** documentation-level — no implementation
divergence; the reference implementation follows both rules as written, and their composition is
narrower than §10's prose suggests.

**Where.** §4.4 PT-7: "A foreign patch's `e reply` MUST point at the root event or a root-author
patch. Overlay-to-overlay reply is invalid (§7.3)." §10 DEL-7: "α/β degradation for orphaned
overlays. If the overlay's target is obtainable (cached or fetched), render against the target's
universe (α). If unobtainable, render as a standalone artifact (β); the overlay is not re-anchored
to any other event."

**The interaction, verified by executable probe.** Read in composition, a foreign overlay whose
`e reply` names an event outside the overlayed root's lineage — the exact shape the implementation
side's audit trail (OVERLAY-AWAITING.md §7's worked trace, correcting now) uses to motivate the
α case ("unrelated to R entirely, or the root/tip of a different chain") — passes PT-7 only while
the target is *unobserved* (a pending verdict), and fails it the moment the target becomes
observable (it is neither the root nor a root-author patch). DEL-7's α case therefore never
materialises for that shape: a conforming consumer drops the event from any V-gated resolution
feed, and the overlay never re-renders as orphaned/α. The reachable α space under both rules is
exactly: root-author-patch positions in ambiguous chain regions (downstream of a HALT, inside an
unresolved self-fork, fork siblings — §7.3's own definition of orphaned), plus not-yet-observed
root-author-patch targets, whose later arrival is already the chain's own invalidation trigger.

Probe evidence (reference implementation, 2026-08-02): pre-target arrival —
`state=orphaned, degradation=beta, verdict=pending`; post-arrival — `verdict=invalid,
issues=["PT-7"]`, overlay excluded from `resolveRoot`'s event feed. The α outcome is unreachable.

**Suggested amendment.** No semantic change to either rule. §10 near DEL-7 gains one clarifying
paragraph: α degradation presupposes a reply target that remains PT-7-valid once observed —
root-author-patch positions, including fork/HALT-ambiguous regions — and that targets failing
PT-7's typing are invalid events whose appearance in a resolution is a validation-feed question
outside DEL-7's scope, never an α reclassification. Optionally tighten "obtainable (cached or
fetched)", which reads broader than the typed space PT-7 admits. A sibling correction is filed in
the implementation repo's OVERLAY-AWAITING.md (dated 2026-08-02), which also records that the
memo-staleness regression this class of shape actually exercises is *exclusion-driven* (the
pending→invalid flip leaving the feed), not α/β-driven.
