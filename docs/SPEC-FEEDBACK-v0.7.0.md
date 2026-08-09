# Spec feedback — v0.7.0 (`scrutiny-v0.7.0`)

Defects found while implementing `@scrutiny-fabric/core`. D2 makes spec feedback a tracked
deliverable: gaps are recorded and batched into an amendment brief rather than worked around
locally. This file is the v0.7.0 batch, continuing `SPEC-FEEDBACK-v0.6.0.md`.

Line numbers are against `~/scrutiny-fabric/docs/protocol-spec.md` at v0.7.0 (1513 lines).

Status legend: **open** — reported, not yet resolved in the spec. **resolved in vX.Y.Z** — the
amendment landed; the entry is kept for the record, not as outstanding work.

**Where the previous batch stands.** F1–F11 were already resolved in v0.6.1. Re-read fresh against
v0.7.0: **F13 is resolved** — the Patch root-typing lifecycle landed as the **Root typing** paragraph
(§4.4, line 347) and the PT-10/PT-11 rows (§4.4, lines 367–368), in exactly the shape F13 proposed.
**F14 is resolved** — §3's rewritten Version-tag form and Version-tag ordering paragraphs (lines
64–66) retire the three-digit `scrutiny-vMMP` form outright, remove the digit ceiling in every field
("no fixed width and no digit-count ceiling in any field — MAJOR included"), and explicitly retract
the lexicographic claim, following F14's suggested amendment point by point. **F12 remains open** —
RL-2 (line 600) still names "bytes compared" as the bounded unit. **F15–F17 are new and open**;
F15 is the direct follow-on to F14: the width ceiling it removed from the grammar re-enters one
level down, in the comparator.

All three entries are grounded in the Step 3 module-quality audit of 2026-08-08
(`QUALITY-AUDIT-2026-08-08-STEP3-FINDINGS.json`): each underlying finding survived adversarial
verification with three independent refuter votes and zero refutations (the audit's own survival
rule), and the refuters' live reproductions are quoted below.

---

## F15 — VER-1's "as numbers" ordering collides with its own no-ceiling guarantee: on the reference platform the per-field comparison silently collapses distinct tags past ~2^53

**Status:** open · **Rules:** VER-1, TAG-2 · **Sections:** §3 · **Severity:** silently wrong ordering
of two spec-permitted tags, verified live against the reference implementation's own comparator; the
digit ceiling F14 was filed to remove re-enters through the comparison, under a representation
choice the current text leaves open

**Where.** §3's Version-tag form paragraph (line 64) declares the ceiling gone:

> Version tags match the regular expression `^scrutiny-v\d+\.\d+\.\d+$`: `MAJOR`, `MINOR`, `PATCH`
> are unpadded decimal integers (`scrutiny-v0.7.0` ≡ v0.7.0), with no fixed width and no digit-count
> ceiling in any field — MAJOR included.

and the Version-tag ordering paragraph (line 66), mirrored by VER-1 (line 81), defines the ordering
through numbers:

> Ordering between two version tags is a per-field numeric tuple comparison: parse `MAJOR`, `MINOR`,
> `PATCH` as separate decimal integers from the tag value and compare `(MAJOR, MINOR, PATCH)`
> field-by-field as numbers. This is never a wholesale string or lexicographic comparison of the
> tag value.

**The problem, verified live.** "Field-by-field as numbers" is correct as a statement of the total
order but leaves the representation of "numbers" to the host. On a platform whose only native number
type is an IEEE-754 double — JavaScript/TypeScript, the reference implementation's own platform, and
the host language of much of the Nostr web ecosystem — the obvious reading ("call the host's decimal
parser, subtract") is lossy past `Number.MAX_SAFE_INTEGER` (2^53 − 1, ~16 decimal digits), while the
spec's own grammar (`^scrutiny-v\d+\.\d+\.\d+$`, TAG-2) places no bound on field width. The two
constraints are now mutually unimplementable as worded: every field beyond roughly sixteen digits is
legal by TAG-2, and distinct fields of that width cannot be ordered by "as numbers" on the platform
that spec was written for.

The Step 3 audit's finding on `events.ts` was independently reproduced by all three refuters. The
mechanics: `VERSION_TAG_PATTERN = /^scrutiny-v(\d+)\.(\d+)\.(\d+)$/` (line 63, no digit-count limit);
`parseVersionTag` (lines 194–199) does `Number(major)` / `Number(minor)` / `Number(patch)`;
`compareVersionTags` (lines 211–217) subtracts those Numbers. In Node:

```
Number('9007199254740993') === Number('9007199254740992')   // true — both round to 9007199254740992
compareVersionTags('scrutiny-v9007199254740993.0.0',
                   'scrutiny-v9007199254740992.0.0')          // 0 (equal)
```

Two tags that the grammar permits, that are textually distinct, and that the declared numeric order
makes strictly unequal, compare equal. One refuter found a sharper failure the finding itself had
not: sufficiently long digit strings overflow `Number()` to `Infinity`, and `Infinity - Infinity` is
`NaN` — a comparator that can return `NaN` loses not just accuracy but the comparator contract
itself (the subtraction no longer encodes a sign), so any downstream sort or equality check built on
it misorders or mismerges without raising an error at any layer. Nothing rejects the input: the
failure is silent at the V layer, exactly where the spec's own doc comment for the pattern
(`events.ts` lines 55–62, restating VER-1: "Unpadded decimal integers encoding MAJOR.MINOR.PATCH …
with no fixed width and no digit-count ceiling in any field") promises it cannot happen.

This is not a hypothetical ceiling. It is the third recurrence of the same defect class the project's
own history already records twice. D45 (`DECISIONS-2026-07-27.md`) documents the first — the
v0.5.9→v0.6.0 version-scheme forcing under the three-digit form:

> `scrutiny-v059` is already patch 9 and the tag regex is `^scrutiny-v\d{3}$` with digits encoding
> MAJOR/MINOR/PATCH, so there is no `scrutiny-v0510`. Staying in 0.5.x would require changing the
> tag scheme itself — breaking TAG-2, VER-1, and every published event.

F14 then removed the *grammatical* ceiling in v0.7.0 — and F14's own closing note named the lesson
("a fix land[s] with headroom instead of under the forced-bump pressure that produced v0.6.0 the
first time"). This entry applies that lesson one level down: the ceiling now lives in the comparator,
and VER-4 ("Implementations MUST NOT reject higher-version events *solely* because of the version
tag", line 84) already depends on the ordering being implementable — a consumer whose comparator
cannot order two large fields cannot tell which event is the "higher-version" one it is obliged not
to reject. Better to define the comparison so that ceiling does not exist at all, before a real tag
ever approaches it.

**Suggested resolution.** Reword VER-1 (and §3's ordering paragraph) to define the comparison
without reference to any host number type: **compare each field's unpadded decimal digit string by
length, then lexicographically**. Because the spec mandates *unpadded* decimal (no leading zeros —
"unpadded decimal integers", line 64), a field's digit-string length determines its magnitude
exactly, so length-then-lex is total, platform-independent, precision-free, and numerically correct
for every value the grammar admits. Two clarifying properties make this cheap to land:

- It is a **re-description of the same total order VER-1 already declares**, not a behaviour change:
  on every field that fits a safe integer (all tags existing or foreseeable for the foreseeable
  life of the protocol) the two formulations agree. It can ship as a clarification revision, and
  deserves one or two conformance vectors pinning a field past 2^53 so the claim is machine-checked
  rather than refuter-checked.
- It is the settled mainstream solution, not an invention. Ecosystem precedent for width-independent
  decimal-field comparison: Go `golang.org/x/mod/semver`'s `compareInt` compares version fields as
  digit strings — length first, then lexicographically — and never converts to integers at all,
  written precisely to be unbounded; RPM's `rpmvercmp.c` strips leading zeros then compares
  digit-run length, then lex within the run; Debian `dpkg`/`glibc` (`verrevcmp`/`strverscmp`)
  compare digit runs as unbounded numbers by length then lex, likewise without fixed-width
  conversion; Maven's `ComparableVersion` compares with `BigInteger`, which is tolerable only
  because the JVM has native bignums — a host property a spec must not assume. The counterexample
  is node-semver, which converts components with `Number()` and is therefore forced to bolt its own
  artificial ceiling back on (rejecting fields past `MAX_SAFE_INTEGER`) — i.e., the
  convert-to-host-numbers reading produces *either* this finding's silent bug *or* a re-introduced
  digit ceiling, and both contradict the no-ceiling clause line 64 states.

**What the implementation does meanwhile.** `events.ts` first implemented "as numbers" as
`Number()` plus subtraction — the literal the spec's current wording invites — and the collapse was
live. The fix has since been applied on branch `chore/architecture-audit-2026-08-08`, implementing
exactly the suggested resolution: parsed fields stay decimal text, per-field comparison strips
leading zeros then compares digit-string by length then lexicographically, with a test case at
exactly the 2^53 boundary. The suggested resolution is therefore implementation-validated; what
remains is the spec blessing it, so a host-specific catch-all such as "use `BigInt` where
available" never leaves a bignum-less consumer spec-compliant and wrong in a way it cannot detect.

---

## F16 — §7.6 covers an unobserved `e root` and PT-6 covers an observed foreign parent; nothing covers the third unresolved-reference shape: a root-author patch whose `e reply` parent is itself unobserved

**Status:** open · **Rules:** CHN-1, PT-6 (UR-1, UR-2, RC-3, SF-1) · **Sections:** §4.4, §5.3, §7.1,
§7.6 · **Severity:** spec gap on the one dangling-reference shape §7.6's own enumeration does not
name; PT-6 cannot be evaluated on it; the normative conformance corpus pins zero outcomes for it
(checked directly: zero of 46 chain cases), so two conformant implementations may currently derive
different chain state from the same observed set — the divergence §7.1's re-evaluation discipline
exists to prevent

**Where.** §7.6's opening paragraph (line 841) enumerates the unresolved-reference cases "already
covered":

> Most cases are already covered: Bindings whose endpoints are unobserved by §4.3's
> pending-endpoint lifecycle (BD-6), deletions whose target is unobserved by §10 (DEL-8), and
> annotations whose target is unobserved by §10's α/β degradation rule (DEL-7).

and then adds the patch case (§7.6, line 843 / UR-2, line 852), mirrored inside the chain-building
procedure itself (§5.3 step 1, line 548):

> A Patch whose `e root` is unobserved MUST be retained and re-evaluated on the root's arrival. It
> does not participate in the canonical chain until then.

CHN-1 (line 565) defines the walk: "The canonical chain is built by walking root-author patches … by
following NIP-10 `e reply` markers **from the root forward**." PT-6 (line 363) constrains the
parent's authorship:

> A root-author patch's `e reply` MUST point at the root event or another root-author patch. A
> root-author patch replying to a foreign patch is ignored for canonical-chain construction (§7.3).

**The gap.** For a root-author patch `P` whose root is observed, there are exactly three states for
its `e reply` parent `Q`, and the spec addresses the first and second but is silent on the third:

1. `Q` is the root or an observed root-author patch — the normal link; CHN-1 walks `P`.
2. `Q` is observed and is a foreign patch — PT-6 (and its §7.3 prose mirror, OV-8 at line 803):
   `P` is "ignored for canonical-chain construction". Also fine.
3. **`Q` is unobserved** — `P`'s reply marker points at an event id nothing has delivered yet. This
   is the common two-device/mesh-lag shape (a root author publishes `Q` on one relay and `P` on
   another; `P` may arrive before `Q`), and no rule names it. §7.6's enumeration covers every
   dangling-reference shape in the protocol *except a patch's own `e reply`*: UR-2 covers the
   dangling `e root`; nothing covers the dangling reply parent.

Three consequences follow from the silence, in increasing strength:

1. **PT-6 is unevaluable on shape 3.** "MUST point at the root event or another root-author patch"
   requires the parent's authorship class, which requires having the parent. While the pointer
   dangles, a consumer cannot say whether the patch satisfies or violates PT-6 — the rule has an
   undefined state, so the interim disposition is implementation taste, not conformance. The
   parallel is exact: BD-5/BD-7 gave Bindings both halves of the lifecycle precisely because an
   endpoint reference "whose type is unknown until that event is observed" is the identical shape of
   hazard (this entry's sibling, F13, argued the same for `e root` and landed as PT-10/PT-11);
   dangling reply parents need the same treatment one level down the same paragraph.
2. **Two natural dispositions exist and they disagree observably.** A **hold-pending** consumer
   (UR-2's own shape, extended one tag over): retain `P`, re-evaluate on `Q`'s arrival, let `P`
   participate in nothing until then. An **optimistic-include** consumer: count `P` as a chain
   candidate immediately, on the theory that `Q` is very likely root-authored (its child is). The
   observable divergences from the *same observed set*: (i) self-fork detection — SF-1's detection
   row (line 748) reads "Any client encountering two root-author patches with the same `e reply`
   target", and does not require the parent to be observed or in the chain; an optimistic consumer
   holding two patches sharing a dangling parent may report a fork (chain undefined, freeze per
   SF-2) while a hold-pending consumer reports a clean root-only chain; (ii) rollback — when `Q`
   later arrives and turns out foreign (PT-6 retroactively excludes `P`), deleted, or never
   published, the optimistic consumer must *unsurface* whatever it showed, which RC-3's
   recompute-on-change discipline does not anticipate for topology it had already admitted; (iii)
   any surface derived from chain membership (published canonical-bytes views, tip identity per
   RC-5, overlay anchoring against the chain) differs until `Q` arrives. §7.1's Eventual-consistency
   paragraph (line 727) and UR-1 (line 851) — "the state an implementation reaches MUST depend only
   on the *set* of events it has observed" — are written to make precisely this impossible; they
   cover the case only if the case is named.
3. **The only machine-checkable conformance instrument pins nothing.** Appendix G's corpus is
   normative ("an implementation that reports a different outcome for any case does not conform",
   line 1464) and asserts confluence over its `chain` cases (`vectors/application.json`, line
   1510). A direct scan of all 46 chain cases (performed by two of the audit's refuters,
   independently) finds zero cases of a root-author patch with an unobserved reply parent while the
   root is observed; the only unobserved-reference vector in the corpus
   (`chain/patch-whose-root-is-unobserved-is-retained`) is the different UR-2 case. Appendix G's own
   caveat ("The corpus is incomplete by design", line 1512) applies, but the practical effect stands:
   for this shape, any outcome is conforming, on the protocol's own conformance definition.

**Independently re-verified against the reference implementation.** The implementation has already
picked one of the two dispositions, incidentally rather than by rule. `resolve.ts`'s `linkable`
filter (lines 282–287) decides chain eligibility as:

```ts
const linkable = rootAuthored.filter((p) => {
  const parentId = replyTarget(p)
  if (parentId === undefined) return false
  const parent = byId.get(parentId)
  return parent === undefined || parent.pubkey === root.pubkey
})
```

The `parent === undefined` disjunct is optimistic-include. The Step 3 audit found it is *never
exercised*: `_resolve-generators.ts` wires every root-author patch to previously observed parents
and emits dangling reply pointers only on foreign patches (`danglingOverlays`); `resolve.test.ts`'s
PT-6/OV-8 test uses an observed foreign parent; and zero of the 46 vendored chain vectors reach it.
The refuters performed the decisive experiment — substituted the strict form
(`parent !== undefined && parent.pubkey === root.pubkey`) and re-ran the full committed test suite;
every test passed either way — and additionally argued that within a single `resolve()` call the
disjunct is behaviorally inert, because a parent absent from the input can never become a walk
position, so whether `P` is marked linkable or not, the walk never visits its map key. Their
conclusion is the sharpest possible statement of why the spec cannot stay silent:

> That makes the clause either (a) dead code that can be deleted without changing any observable
> `resolve()` output … or (b) load-bearing for some interaction I have not found — and given it is
> completely untested, nobody currently knows which.

The project's own reference implementation cannot currently say which behaviour is faithful to the
spec, because the spec does not say.

**Suggested resolution.** Name the third shape in §7.6, using UR-2's exact rule shape one tag over
(new rule, e.g. **UR-4**; alternatively widen UR-2 to "any referenced event", but a dedicated row
reads cleaner against the existing enumeration):

> A root-author patch whose `e reply` target is unobserved MUST be retained and re-evaluated on the
> target's arrival. It does not participate in canonical-chain construction or self-fork detection
> until then; PT-6 is evaluated if and when the target is observed.

One asymmetry is worth stating alongside it: unlike UR-2's case, the root *is* observed here, so
PT-5's authorship classification is already known — the hold concerns topology only, not
classification, and UR-3 does not need to extend to cover it. (If the spec instead blesses
optimistic-include, it must define the rollback contract for a parent that arrives foreign,
deleted, or never at all — hold-pending is the cheaper rule, composes with CHN-1's forward walk as
written, and matches every other pending-lifecycle the spec already has.) Whichever way the
amendment lands, add one `chain/*` conformance vector pinning the shape (46 → 47 cases), so
Appendix G stops permitting divergence by omission.

**What the implementation does meanwhile.** Optimistic-include at `resolve.ts:282–287`, unexercised
by any test, generator, or vector, flagged by the audit; whichever resolution lands,
`resolve.test.ts` gains the distinguishing example and `_resolve-generators.ts` a
root-authored-dangling-parent case of its own.

---

## F17 — T2 defines the pure-insertion position but not the case where the implied position is out of range, so conformant consumers may clamp to different bounds — or HALT — on a C6-permitted input

**Status:** open · **Rules:** T2, C6 (T3, H1) · **Sections:** §5.3, §5.2 · **Severity:** unspecified
consumer behaviour on an input the spec's own advisory-numbers rule makes ordinary; already surfaced
as a shipped content bug in the reference implementation, found independently by two audit passes
and confirmed by all six refuter votes

**Where.** T2 (line 561) pins a pure-insertion hunk's position to its header and its carry-forward:

> Such a hunk MUST apply at the position implied by its `@@` header's `-` line number; the T1
> uniqueness check does not apply. **That line number is interpreted in the coordinates of the
> patch's pre-application content, and MUST be carried forward by the net line delta of all prior
> hunks in the same patch.**

while C6 (line 510) makes a wrong header number unremarkable:

> Hunk `@@` line numbers are advisory. Consumers MUST locate each hunk by context match against the
> current content, subject to the determinism requirement in §5.3.

**The problem.** T2's "position implied by the header" presupposes that position *exists*. It need
not: `@@ -99,0 +100,1 @@` against a two-line content implies an insertion after line 99, a
coordinate the content does not contain; carried forward by T3's shift, it is still past the end.
Nothing in T2, T3, or H1 assigns this case a behaviour. And this is the one hunk shape where the
consumer cannot fall back on C6's remedy: C6 says to recover from bad numbers by context match, but
a pure-insertion hunk has no context lines *by definition* — that absence is exactly why T2 exists —
so every producer-side miscount at a content boundary arrives at the consumer as a coordinate with
no defined semantics, and C6 simultaneously forbids treating the header as trustworthy or the
payload as invalid (C7).

The current text therefore leaves at least three defensible settlements on the same input, and they
produce different protocol-visible results:

1. **Clamp to end-of-content** (the reference implementation's choice): append at the end.
2. **Clamp to a different bound** (last real line, off-by-one variants, bounds derived from an
   internal line-container rather than the content itself — see below for why that last trap is
   real): different bytes.
3. **Treat the empty coordinate as an apply failure and HALT** under §5.3 step 5 / H1: not just
   different bytes but a different *verdict*, with H1's full downstream cascade (chain frozen, later
   patches never evaluated, protocol-error annotation) — a far more disruptive divergence than a
   clamp disagreement, and one that no rule currently rules out, since "pre-validation fails" is
   defined only through T1/T2 and T2 is silent here.

Two conformant consumers can therefore publish different canonical bytes — or one can publish bytes
where the other reports HALT — from identical input. The target-state snapshot rule (OV-2) inherits
the divergence: an overlay evaluated "against the target's resolved content" cannot be "a pure
function of (overlay payload, target's resolved content)" (OV-4) when the resolved content is
underdetermined.

**The reference implementation demonstrates the trap is live, not theoretical.** It clamps (§5.3's
permitted latitude, pre-amendment) — and the 2026-08-08 Step 3 audit found the clamp bound itself
was wrong, in two independent review passes (dual-lens and thermo-nuclear), on the same expression,
each finding surviving all three refuters (6/6 confirmations, zero refutations):

```ts
// packages/core/src/patch.ts:296 (line 305 at audit time)
at = Math.min(Math.max(hunk.insertAt + shift, 0), lines.length)
```

`lines` is the raw `toLines` array, whose length **includes a synthetic trailing `''` sentinel
element** that `patch-matcher.ts`'s `lineCount()` doc comment (lines 38–47) identifies as "the
trailing-newline bit" that is "never itself a line of a diff". As the upper bound of an insertion
index, the sentinel-inclusive length lands the insertion *after* that element instead of at the end
of the real content. Reproduced by the refuters against the shipped module, with the unterminated
case as control:

```
applyPatchPayload('a\nb\n', '--- a/content\n+++ b/content\n@@ -3,0 +3,1 @@\n+NEW\n')
  → { status: 'applied', content: 'a\nb\n\nNEW', hunksApplied: 1, work: 0, issues: [] }   // wrong
applyPatchPayload('a\nb',   '--- a/content\n+++ b/content\n@@ -3,0 +3,1 @@\n+NEW\n')
  → 'a\nb\nNEW'                                                                          // correct
```

Against newline-terminated content, an out-of-range T2 header produces a spurious blank line *and*
silently drops the trailing newline, returned as `status: 'applied'` with zero issues — wrong
canonical bytes under a clean verdict, the exact failure class the already-fixed P3/T2 carry-forward
bug (fixed in `83d2393`, which corrected the sibling `shift` line in the same expression but never
touched this clamp) was written to eliminate. Both findings note the one-token fix (clamp against
`lineCount(lines)`, already imported into `patch.ts`), and that fix has since been applied on
branch `chore/architecture-audit-2026-08-08` — the clamp now reads `lineCount(lines)` — so the
one-token shape is implementation-validated. The refuters also documented
why the defect hid: the round-trip property test cannot reach it because the producer (`makePatch`)
never emits an out-of-range header — the same blind spot documented for the P3 bug.

That the first conformant implementation's own clamp chose a subtly wrong bound — wrong in a way
invisible until adversarially probed — is the strongest available evidence that the spec must not
leave the *bound* to implementation judgment: "clamp" is not one behaviour; the sentinel-including
container bound and the content-line-count bound differ on real input. F17's resolution must define
the out-of-range semantics in terms of the **content's lines**, not any container.

**Suggested resolution.** Extend T2 by one sentence pinning the out-of-range case, with one answer
naming the bound in content terms. Preferred form:

> If the implied position (carried forward per T3) exceeds the content's line count, the hunk
> applies at the end of the content; if it is less than zero, at the beginning. The line count is
> the count of the content's lines — excluding any trailing-newline terminator, which is not a line
> (§5.1's verbatim byte sequence has exactly as many lines as it contains, terminated or not).

Clamp-and-append is the right choice over HALT for three reasons: a pure-insertion hunk carries no
content assertion to protect (no context lines, no `-` lines — nothing the patch claims about the
existing content, so nothing to falsify); C6/C7 already forbid punishing the consumer for an
advisory number by rejecting the payload, and HALT would do exactly that by proxy, freezing a chain
over a number everyone agrees is advisory; and clamp-to-end is a total function, so it introduces
no new HALT source — keeping H1's failure conditions precisely as scoped as they are today. The
alternative form — "a producer error that consumers MAY clamp but MUST treat deterministically" —
is acceptable only if *deterministically* is fully pinned to one bound; anything short of that
preserves today's divergence. Either way, the essential move is that the out-of-range outcome has
one named settlement instead of three implied ones.

**What the implementation does meanwhile.** Clamped against the sentinel-inclusive bound until the
2026-08-08 audit found it; branch `chore/architecture-audit-2026-08-08` now clamps against
`lineCount(lines)` and pins the behaviour with `t2/out-of-range-insert-clamps-to-content-end` in
`test/patch-regressions.ts`. What remains is the spec settlement itself: the out-of-range outcome
still has no named semantics in T2, so a different consumer may still clamp at a different bound.
