# Mini-spec — producer-side context widening (`packages/core/src/build.ts`)

Fully specifies mandate item 9 (`PLAN-2026-08-01-rewrite-mandate.md` §9, "Producer-side context
widening (build now, not deferred)"). Builds on `PATCH-MATCHER.md`'s vocabulary (T1/T2/T3, halt,
no-match/ambiguous-match) and does not redefine any of it. Scope is `buildPatch` only —
`buildProduct`/`buildMetadata`/`buildBinding` diff nothing and are untouched.

**This does not reopen F1.** `SPEC-FEEDBACK-v0.6.0.md` F1 resolved P1 as an **A**-layer producer
SHOULD ("`min(3, available)`"), not a Validity criterion — that disposition stands unchanged. This
spec only changes what `build.ts` does *above* P1's floor: P1 asks for at least 3 lines of context
where available; nothing in P1, T1, or C7 forbids a producer from asking for *more* when 3 would
make its own output ambiguous on its own admitted input. `context = 3` remains the floor and the
fast path; widening is `build.ts` electing to do better than the floor, never a reinterpretation of
what the floor requires.

**Motivating data**, from `AUDIT-2026-07-31.md` §5's Outside-Nostr comparative analysis: refusal
costs **~0.3% of prose at `context = 3`** but **5.8% at zero context**, concentrated on exactly the
tables and repeated `| field | value |` rows SCRUTINY's own content targets. The audit's own
proposal — "widen `context` iteratively until every hunk's pattern occurs exactly once in `before`,
falling back to the P4 warning only when even full-file context cannot disambiguate" — is the
**Final call** the mandate already made; this document specifies it to code-ready precision.

---

## 1. The shared module: `patch-matcher.ts`

**Final call: a new internal file, `packages/core/src/patch-matcher.ts`, never added to
`package.json`'s `exports` map — the identical treatment D32 already gives `./patch`.** Both
`patch.ts`'s applier and `build.ts`'s widening loop import from it; `patch.ts` no longer defines
`occurrences`/`reduceHunk`/`toLines`/`fromLines`/`lineCount`/`spliceAt` itself.

**What moves, verbatim in behaviour:**

| Export | Was | Signature |
|---|---|---|
| `toLines` | `patch.ts` private | `(content: string) => string[]` |
| `fromLines` | `patch.ts` private | `(lines: readonly string[]) => string` |
| `lineCount` | `patch.ts` private | `(lines: readonly string[]) => number` |
| `Hunk` | `patch.ts` private interface | `{ oldPat, newRep, oldNoEol, newNoEol, insertAt }` |
| `reduceHunk` | `patch.ts` private | `(raw: { oldStart: number; oldLines: number; lines: string[] }) => Hunk` |
| `Occurrences` | `patch.ts` private interface | `{ count, first, second }` |
| `occurrences` | `patch.ts` private | `(lines: readonly string[], pattern: readonly string[]) => Occurrences` |
| `SpliceOutcome` | `patch.ts` private type | `{ ok: true; lines: string[] } \| { ok: false; detail: string }` |
| `spliceAt` | `patch.ts` private | `(lines: readonly string[], hunk: Hunk, at: number) => SpliceOutcome` |

`spliceAt` moving too is a correction to this section's first draft — see §2.2.

**New, not extracted from anywhere — the widening loop's own trial primitive:**

```ts
/** Produce this pair's hunks at a given context, without formatting to text. Both callers need the
 *  reduced `Hunk` shape; only `patch.ts`'s `makePatch` additionally needs the raw `StructuredPatch`
 *  object (for `formatPatch`), so `diffHunks` wraps `structuredPatch` for the caller that doesn't. */
export function diffHunks(before: string, after: string, context: number): readonly Hunk[] {
  return structuredPatch('a/content', 'b/content', before, after, '', '', { context }).hunks.map(
    reduceHunk,
  )
}
```

`patch-matcher.ts` imports `structuredPatch` from `diff` for this one function. `patch.ts` keeps its
own `parsePatch`/`formatPatch`/`structuredPatch` imports for parsing untrusted payload text and for
`makePatch`'s formatting — `makePatch` does **not** route through `diffHunks`, because `formatPatch`
needs the whole `StructuredPatch` object, not the reduced `Hunk[]`. `build.ts` imports `diffHunks`,
`occurrences`, `spliceAt`, `toLines`, `lineCount`, and `Hunk` from `patch-matcher.ts`; it never
imports `diff` directly. Net effect: the package's only two points of contact with the `diff` dependency are
`patch.ts` and `patch-matcher.ts` — fewer, not more, than before this extraction, since `build.ts`
gains jsdiff-adjacent behaviour without gaining a jsdiff import.

`parseHunks` and `MalformedPayload` **stay in `patch.ts`**. The widening loop never parses untrusted
payload text — `diffHunks` hands it hunks directly from `structuredPatch`'s own object (§1's earlier
draft made this point correctly) — so it has no use for the malformed-payload channel, which exists
solely to normalise `jsdiff.parsePatch`'s failure modes on text nobody here produced. `spliceAt` is
different: §2.2 below found that the widening loop genuinely needs it, for the same reason
`applyPatchPayload` does — advancing state correctly between hunks in one trial payload, not merely
detecting ambiguity within a single one.

### 1.1 Why a new file, not widening `patch.ts`'s own export surface

The alternative — export `occurrences`/`reduceHunk` directly from `patch.ts`, since `build.ts`
already imports `applyPatchContent`/`makePatch` from it today — is cheaper and is **not** a D32
violation: D32 is scoped to the applier function and its `exports`-map subpath, not to a same-package
internal import, confirmed by reading D32 verbatim (mandate item 2 already established this reading
for patch-adjacent *types*). So the choice here is not "does D32 forbid it" — it doesn't — but which
shape is more modular.

**Rejected: widen `patch.ts`'s export surface.** Two reasons, argued against D5/D17's own axis:

1. **D5/D17 are about the published npm surface, not source-tree layout, and applying their
   axis here (rather than ignoring it as inapplicable) still favours extraction.** D5: "subpaths are
   retained only where they buy graph exclusion … not organisation." D17: subpaths are named by
   caller intent. Neither rule *forbids* an internal file split — a non-exported file costs nothing
   on the npm graph, unlike a published subpath — but the *reasoning* behind both is that a boundary
   should track a real difference in what depends on what, not just tidiness. Here that real
   difference exists: `occurrences`/`reduceHunk`/`toLines` are genuinely below both `patch.ts` and
   `build.ts`, owned by neither. Exporting them from `patch.ts` would make `build.ts` — a caller with
   its own already-distinct identity (`./build` is a published subpath per D17's list; `./patch` is
   internal-only per D32) — reach into another caller's leaf module for primitives that module happens
   to have needed first. That is coupling by accident of arrival order, the same shape of problem D17
   already rejected for V/A/D-named subpaths (R1): a boundary that tracks "who got there first," not
   what the code actually depends on.
2. **The mandate's own wording already says "extract," not "export."** Item 9's rationale: "extracting
   the uniqueness scanner was rejected earlier as premature for one caller, but the widening loop
   gives it a second real caller, which is exactly when that extraction stops being premature."
   Extraction into a module neither caller owns is the literal reading; widening `patch.ts`'s exports
   would instead make `build.ts` a dependent of `patch.ts`'s internals specifically, which is not what
   "a second real caller" earns — a second caller earns a shared home, not a promotion of the first
   caller's private module to quasi-public status for one friend.

**Also rejected: making `patch-matcher.ts` a real published subpath (`./patch-matcher`).** Never
considered seriously — nothing in it is a port, a type contract for external implementers, or
anything a consumer would construct. It has even less claim to publication than `./patch` itself,
which at least fronts a real applier a future alternative `DiffPort` might target. `patch-matcher.ts`
is pure shared arithmetic on string arrays; D32's internal treatment applies to it a fortiori.

---

## 2. The widening algorithm

**Final call, per the mandate's own sketch:** on T1 ambiguity at the starting context (default 3),
widen linearly — never binary search — up to full-file context, re-running the T1 uniqueness scan via
the shared `occurrences` function at each step, stopping at the first context where every hunk is
unique. If full-file context still cannot disambiguate every hunk, degrade to the existing P4 warning
verbatim (§4).

### 2.1 Design correction, found while writing this section

The mandate's sketch says "widen … by a fixed step" without naming the step. A fixed step **greater
than 1** reintroduces exactly the hazard the mandate rejects binary search for: it *skips* candidate
context values without proving anything about what happens at the skipped ones. Concretely, a step of
4 trying `3, 7, 11, …` could pass over a context of 5 that would have disambiguated a hunk, land on 7
where the pattern happens to duplicate again further out (plausible on repeated-table content, the
audit's own worst case), and degrade to the P4 warning when a smaller, untried context would have
resolved it. That is not hypothetical caution transferred from the binary-search argument by analogy
— it is the same defect: relying on an unproven relationship between context and disambiguation
(here, "skipping is safe") to justify not checking every value.

**Correction: the step is 1, not a free parameter.** Enumerate every integer context from the
starting value up to full-file context, in order, stopping at the first success. This needs no
monotonicity assumption of any kind — not "ambiguity resolves monotonically as context grows" (which
the mandate is right to distrust generally, and which C5/EOF and hunk-merging interactions make
genuinely uncertain near file boundaries), and not "skipping to a larger step is safe." Every
candidate context in the reachable range is actually tried. This is the reading under which "widen
linearly" is a real constrat rather than a description that happens to also fit an untrusted skip.

### 2.2 A second design correction: per-hunk checks must thread spliced content across hunks (T3)

The mandate's one-line sketch — "re-run the T1 uniqueness scan via the shared `occurrences` function
at each step" — and this section's own first draft both checked each hunk's `oldPat` against the
static, unmodified `beforeLines` array, independently of every other hunk in the same trial payload.
That is exactly right for the overwhelmingly common single-hunk patch (`AUDIT-2026-07-31.md`'s own
finding: SCRUTINY diffs a single `content` field, "frequently one line"), and it is **wrong in
general** for a multi-hunk trial, for precisely the reason T3 exists: `patch.ts`'s own
`applyPatchPayload` matches each hunk against the content produced by every prior hunk *in the same
patch*, never against the pre-patch content (`PATCH-MATCHER.md` §5, "each hunk is matched against the
output of all prior hunks"). A widening check that ignores this can disagree with what the real gate
does at consumption time: if an earlier hunk's `newRep` text happens to introduce (or remove) a
duplicate of a *later* hunk's `oldPat` pattern elsewhere in the file — a real possibility for exactly
the repeated-row editing the audit calls out (editing one row to match another row's existing value
is precisely "create a duplicate") — checking the later hunk against static `beforeLines` can report
"unique" where the true, T3-sequenced scan would still find it ambiguous.

**Bound, not ignored:** `buildPatch`'s existing `P4` self-check (§4, unchanged) still runs the *real*
`applyPatchContent` against whatever context the widening loop settles on, so a wrong "resolved"
verdict from an unthreaded check would still be caught before publication — it would just waste the
opportunity to widen further and actually fix it, landing on a `P4` warning where a wider context
might have genuinely resolved the true ambiguity. That bound is real but is a reason to fix this
properly, not a reason to leave it: the fix costs nothing beyond sharing `spliceAt` (§1, already
revised above), which is exactly the same function `applyPatchPayload` already uses to advance
between hunks — reimplementing a second, simplified "just enough to advance" splice here would be
exactly the two-independently-written-implementations risk item 6 flags for `checkBindingTyping`
duplicating `checkBinding`.

**Correction:** the per-context check threads content forward with `spliceAt` between hunks, exactly
mirroring `applyPatchPayload`'s own loop, and stops at the *first* ambiguous hunk (mirroring T3's own
atomicity — a real halt never bothers scanning hunks past the first failure, so neither does this
probe). `spliceAt`'s C5/EOF branches are not incidental overhead here: `before`/`after` can differ in
trailing-newline state exactly as any other patched pair can, and getting that wrong would misalign
where the next hunk's search window starts.

### 2.3 Why full-file context always succeeds, and what "exhausted" really means

Worth proving rather than asserting, since it changes how `exhausted: true` should be read. At
`context ≥ fullContext`, a hunk's `oldPat` spans the entirety of `beforeLines`: there is no more
context left to add once a hunk's window already touches both file boundaries, and jsdiff's `context`
parameter has no per-hunk cap, so two changes separated by fewer than `2 × context` lines merge into
one hunk — at `context ≥ fullContext` that is *every* pair of changes in the file, so the whole file
collapses to exactly one hunk. `occurrences` requires `i + |pattern| ≤ |lines|` for a match at `i`; when
`|pattern| = |lines|` that forces `i = 0`, the only position that fits, **regardless of the file's own
content**. A pattern spanning the whole array is therefore unique by a length argument alone, not by
luck about what the file happens to contain.

Consequently, `widenContext`'s `exhausted: true` outcome is reachable **only** through §3's work
ceiling cutting the search off before `context` actually reaches `fullContext` — never through a
genuine attempt at true full-file context that still finds ambiguity. §2.4's `if (capped ===
fullContext) return { ..., exhausted: true }` branch is kept anyway, as the honest way to express "the
search stopped without a proof, for whatever reason" without asserting a check ran and failed when in
the ceiling-hit case it never got to run at true `fullContext` at all. In ordinary operation (no
ceiling hit) that branch is dead code — a fact worth stating plainly rather than leaving implicit,
since it is the difference between "full-context can, in principle, still fail" (not true) and "full
context is only ever *not reached*" (true, and the reason §3's ceiling is the sole practical source of
the mandate's own "degrade to the P4 warning" fallback).

### 2.4 The algorithm

```ts
function widenContext(
  before: string,
  after: string,
  startContext: number,
  ceilingWork: number,
): { context: number; hunks: readonly Hunk[]; exhausted: boolean } {
  const beforeLines = toLines(before)
  const afterLines = toLines(after)
  const fullContext = Math.max(lineCount(beforeLines), lineCount(afterLines))
  let work = 0

  for (let context = startContext; ; context++) {
    const capped = Math.min(context, fullContext)
    const hunks = diffHunks(before, after, capped)

    // Thread content across hunks exactly as applyPatchPayload's own loop does (T3): each hunk is
    // checked against the result of every prior hunk in *this trial payload*, never against static
    // `beforeLines` alone — see §2.2 for why an independent per-hunk check is wrong in general.
    let lines = beforeLines
    let ambiguous = false
    for (const hunk of hunks) {
      if (hunk.oldPat.length === 0) continue // T2's carve-out — no pattern to disambiguate

      // F12's per-element floor, reused verbatim, charged against the *running* line count at this
      // hunk's own scan — the same quantity patch.ts's own charge uses, never a static file-wide one.
      const cost = lines.length * hunk.oldPat.reduce((s, l) => s + l.length + 1, 0)
      work += cost
      if (work > ceilingWork) return { context: capped, hunks, exhausted: true }

      const found = occurrences(lines, hunk.oldPat)
      if (found.count !== 1) {
        ambiguous = true
        break // atomic, same as T3 — a later hunk in this trial is never scanned past the first miss
      }
      lines = spliceAt(lines, hunk, found.first).lines
    }

    if (!ambiguous) return { context: capped, hunks, exhausted: false }
    if (capped === fullContext) return { context: capped, hunks, exhausted: true } // see §2.3
  }
}
```

- **`oldPat.length === 0` hunks are skipped**, not specially handled: T2's pure-insertion carve-out
  (`PATCH-MATCHER.md` §3) has no pattern to disambiguate, so widening can neither help nor hurt one.
  If a wider context merges a formerly-separate insertion hunk into an adjacent context-bearing hunk
  — a real jsdiff behaviour, since larger context windows overlap more readily — the merged hunk gets
  its own `oldPat` and is checked normally; no special case is needed for the merge itself.
- **Termination is arithmetic, not a property to prove.** `context` strictly increases by exactly 1
  each iteration and is clamped to `fullContext`, a value fixed before the loop starts. The loop exits
  via one of three `return`s within at most `fullContext − startContext + 1` iterations, a bound known
  in advance. No recursion, no early-exit-then-resume, nothing whose safety depends on a property test
  — which is the entire point of rejecting binary search here (mandate's own reasoning) rather than
  re-deriving a weaker version of the same objection three steps later.
- **A file already at or under full-file context at the starting value degrades immediately.** If
  `startContext ≥ fullContext` on the very first iteration (short `before`/`after`, the common case per
  `AUDIT-2026-07-31.md` C4's own corpus measurement — median content 287 bytes), the loop makes exactly
  one attempt and — per §2.3 — that attempt is guaranteed to succeed, so `exhausted: true` at the
  starting value can only mean the ceiling was already exceeded by the very first trial.

---

## 3. The widening search's own resource ceiling

**Open question the mandate left for this pass, resolved: yes, a dedicated ceiling, named
`maxWidenWork`, default `16 * 1024 * 1024` — identical unit and identical default to `patch.ts`'s
existing `ApplyOptions.maxWork`.**

**Why a ceiling at all.** The widening loop re-runs `diffHunks` + `occurrences` at every context step
up to `fullContext`, which for a large `before` can be large. RL-2's own justification for measuring
total work rather than hunk or patch counts — "an adversary optimises against whichever unit is
counted" — applies to the *producer* side exactly as it does to the consumer side `maxWork` already
protects: content shaped to be cheap in bytes but expensive to scan (long runs of short or blank
lines — the audit's own "tables and repeated `| field | value |` rows") would let widening re-scan a
large, byte-cheap pattern at every one of potentially thousands of context steps for free under a
naive byte-charged ceiling.

**Why the charge reuses F12's fix rather than re-deriving one.** F12 already found and fixed exactly
this hole for `patch.ts`'s own `maxWork`: "bytes compared" is a unit an adversary can optimise
against, because a pattern of empty lines costs a full `|content| × |pattern|` element-comparison
scan while billing zero bytes. The landed fix charges `len(line) + 1` per pattern line — a per-element
floor, never zero — precisely so a blank-line-dominated pattern still costs something. The widening
loop's cost model (§2.4) charges identically, for the identical reason: it is the same kind of scan
(`occurrences` over `before`'s lines against a hunk's `oldPat`), run repeatedly instead of once, so the
same adversary-optimises-the-counted-unit argument applies with the same force at every step, not just
the first.

**Why the default is `patch.ts`'s existing `DEFAULT_MAX_WORK`, not a new number.** Reusing 16 MiB
rather than inventing a separate constant keeps the producer and consumer resource models coherent: a
`before`/`after` pair whose widening search cannot be completed within the budget a *consumer's own
default* `maxWork` would allow is one whose eventual application would already strain that consumer at
its default settings — failing closed to the P4 warning at that point is consistent with, not
arbitrary relative to, what the far side will do anyway.

**Where the option lives.** `maxWidenWork` is a new named option on `buildPatch`. Mandate item 10
(collapsing `buildPatch`'s six positional parameters into a named-fields options object) is a separate,
later decision in the same document; this spec adds the option under whatever shape `buildPatch` has
today and expects it to fold into item 10's options object when that item lands — sequencing between
items 9 and 10 is item 10's concern, not this one's. No separate hunk-count ceiling is needed for the
widening search itself: hunk count is already bounded on the *final*, post-widening payload by
`build.ts`'s existing `MAX_HUNKS_PER_PAYLOAD`/RL-1 check (§4), and nothing in the widening loop can
produce more total comparison work than `maxWidenWork` already bounds regardless of how many hunks a
given step returns.

---

## 4. Composition with `buildPatch`'s existing P4 self-check and RL-1's hunk-count warning

**The widening loop determines an input to today's pipeline; it does not add a second verdict
mechanism alongside P4.** Revised `buildPatch` sequence:

1. Resolve the context to actually use: `{ context: resolvedContext, exhausted } = widenContext(before, after, startContext, maxWidenWork)`, where `startContext` is `buildPatch`'s existing `context` parameter (still defaulting to 3 — the fast path is the starting point of widening, not a separate branch bypassed by it).
2. Call `makePatch(before, after, resolvedContext)` **once**, at whatever context won or was last tried. This is the only place `formatPatch` runs; the widening loop itself never formats to text.
3. `fencePatchPayload`, template assembly, and the RL-1 hunk-count check proceed exactly as today, **counted from the payload this call just produced** — unchanged wording, unchanged comment, now correctly reflecting a context that may not be 3, since a wider context can merge hunks and change the count that gets charged against `MAX_HUNKS_PER_PAYLOAD`.
4. The **existing** P4 self-check (`applyPatchContent(before, content)`, compare against `after`) runs exactly as it does today, with **no new branch for the exhausted case**.

Point 4 is the load-bearing simplification: **the "exhausted widening" outcome needs no new code path,
because P4's self-check already reruns T1 independently.** If `widenContext` returned `exhausted:
true`, the payload built at `resolvedContext = fullContext` still genuinely has an ambiguous hunk (that
is what "exhausted" means); `applyPatchContent` will call `patch.ts`'s own `occurrences` on the same
`oldPat` against the same `before` and rediscover count ≥ 2, producing a `halt` with `settled = false`,
which the existing code already turns into exactly the P4 warning the mandate asks for — verbatim,
unchanged wording, because the wording ("applying the built patch … produced a `halt` … rather than
the given `after` content") already describes this case correctly without modification. This is also
why the mandate's own note ("no new rule citation, since `RuleId` is a generated literal union and
nothing names a distinct exhausted-widening outcome") requires no engineering beyond *not adding
anything*: P4 already is that outcome's citation.

**Why `widenContext` checks `occurrences` directly instead of just retrying the full P4 apply-and-compare
loop at each context.** Two reasons: (a) precision — a hunk can fail to settle for a non-T1 reason
(C5's `eof-mismatch`), and widening context can never fix that; re-checking via full application at
each step would keep widening all the way to `fullContext` for a failure widening cannot address,
wasting the entire ceiling on a dead end. Checking `occurrences` directly stops on the *first* context
where every hunk's T1 count is 1, which is the only condition widening can actually influence. (b)
cost — `occurrences` alone is cheaper per step than a full splice-and-compare round trip, and it is
exactly what the mandate specifies ("re-run the T1 uniqueness scan via the shared `occurrences`
function at each step").

---

## 5. Worked example

`before` (17 lines):

```
head
c1
c2
c3
old
c1
c2
c3
mid
c1
c2
c3
old
c1
c2
c3
tail
```

`after`: identical except line 5's `old` becomes `new`. The edit sits inside a block (`c1/c2/c3`
around a token) that recurs later in the file around the *other* `old` at line 13 — the shape the
audit calls out explicitly (repeated `| field | value |`-style blocks).

**At `context = 3`:** the hunk's pattern is the 7-line window `[c1, c2, c3, old, c1, c2, c3]` (0-indexed
lines 1–7). `occurrences` finds this exact 7-element sequence starting at index 1 (the real edit) *and*
starting at index 9 (lines 9–15: `c1, c2, c3, old, c1, c2, c3`, around the second, untouched `old`) —
count = 2. **Ambiguous.** Under the pre-widening behaviour this patch is unbuildable-with-confidence:
`makePatch` still emits it (it has no way to know), but `buildPatch`'s P4 self-check would already have
caught it as a warning — this is the exact shape item 9 exists to reduce, not one P4 was blind to.

**Widening to `context = 4`:** the pattern grows to the 9-line window `[head, c1, c2, c3, old, c1, c2,
c3, mid]` (indices 0–8). The only other place `old` occurs is index 12, so the only other window worth
checking is the one where index 12 sits at the same relative position (index 8, i.e. a window starting
at index 8): `[mid, c1, c2, c3, old, c1, c2, c3, tail]`. Position 0 differs (`mid` vs `head`) and
position 8 differs (`tail` vs `mid`) — no match. `occurrences` returns count = 1. **Resolved.**
`widenContext` returns `{ context: 4, exhausted: false }`; `buildPatch` calls `makePatch(before, after,
4)` once and proceeds normally, with **no P4 warning**, where the unwidened pipeline would have emitted
one.

---

## 6. Testing

- **A dedicated ambiguity-then-resolution fixture**, built directly from §5's example, asserting
  `widenContext` returns `{ context: 4, exhausted: false }` and that `buildPatch`'s result carries no
  `P4` issue — the positive case the whole feature exists for.
- **An exhausted fixture, reached the only way §2.3 shows it can be** — via `maxWidenWork`, not via a
  genuine failure at true full-file context (§2.3 proves a pattern spanning the whole file is always
  unique, so a fixture built to fail *at* `fullContext` itself is unbuildable and should not be
  attempted). This is the same fixture as the `maxWidenWork` ceiling case below; asserting
  `buildPatch` still returns a template (TR-1: an A-layer rule never rejects) with exactly the
  existing `P4` warning wording, unchanged, is the actual, reachable version of what an
  "exhausted-at-full-context" fixture was trying to test.
- **A `maxWidenWork` ceiling fixture**: adversarial `before` (long, blank-or-short-line-heavy, sized so
  a full sweep to `fullContext` would exceed a deliberately small test ceiling), asserting the search
  stops early (`exhausted: true` before `resolvedContext` reaches `fullContext`) rather than completing
  — this is the property F12's per-element floor exists to make true; without the floor this fixture
  would need to be byte-heavy rather than merely line-heavy to trigger the ceiling, which is precisely
  the gap F12 closed.
- **Extend the existing `patch-property.test.ts` gate, not replace it.** The zero-context property
  (`context: 0`, `applied ⟹ content === b`, with a floor on the halt count) exercises `patch.ts`'s
  `makePatch`/`applyPatchPayload` directly and is untouched by this change — `buildPatch` is a
  different, higher-level entry point, and nothing here routes zero-context test input through
  widening. A new property belongs alongside it: for random `before`/`after` pairs generated with the
  same repeat-heavy alphabet, `buildPatch`'s resulting template, when self-applied via
  `applyPatchContent`, either matches `after` with no `P4` issue, or carries a `P4` issue only when
  `widenContext` genuinely reported `exhausted: true` — re-derived independently in the test, exactly
  as `PATCH-MATCHER.md` §9 already does for the base gate, so the property cannot be satisfied by an
  implementation that widens too eagerly or gives up too early.
- **A two-hunk threading fixture, §2.2's own regression case.** A `before`/`after` pair with two
  edits in one patch, constructed so the *first* hunk's `newRep` introduces a duplicate of the
  *second* hunk's `oldPat` pattern elsewhere in the file. Asserts `widenContext` correctly reports
  ambiguity at the second hunk (threading `lines` forward via `spliceAt` between hunks) rather than
  the false "unique" an independent per-hunk check against static `beforeLines` would report — the
  case §2.2 exists to fix, built directly rather than hoped for.
- **Verify, against a live `diff@9.0.0` run, that `structuredPatch`'s own `hunks` array is
  shape-identical to what `parsePatch` reconstructs from `formatPatch`'s text** (same `oldStart`/
  `oldLines`/`lines` fields, same `\ No newline at end of file` marker placement) before relying on
  `diffHunks` feeding `reduceHunk` hunks it was designed against a *parsed* shape for. Expected true —
  `formatPatch` does not transform `hunk.lines`, only prepends header text — but every other claim
  about jsdiff's behaviour in `PATCH-MATCHER.md` is backed by a reproduced transcript, not an
  expectation, and this one should be held to the same standard before `diffHunks` ships.
- Every counterexample becomes a named permanent regression case, same discipline as
  `patch-regressions.ts`.

---

## 7. What this does not do

- Does not change `makePatch`'s signature, default, or behaviour. `makePatch` remains a fixed-context
  primitive called once per `buildPatch` invocation (at whatever context widening resolved to) and
  directly by tests wanting a specific context shape.
- Does not change `patch.ts`'s applier, `applyPatchPayload`, or any `HaltReason`/rule citation. T1's
  consumer-side behaviour (halt on ambiguity, no relocation) is exactly as `PATCH-MATCHER.md` specifies;
  widening only reduces how often a *producer* hands a consumer a payload that reaches that branch.
- Does not touch `resolve.ts`, chain resolution, or any cache. See §8 on D28.
- Does not add a new `RuleId`, `HaltReason`, or `Severity`. The exhausted-widening case surfaces
  through the existing `P4` issue, unchanged.
- Does not apply to `buildProduct`/`buildMetadata`/`buildBinding` — they never call `makePatch`.

---

## 8. Standing decisions touched

**No `DECISIONS-2026-07-27.md` correction entry is needed for this item.** Checked against the three
decisions the task named as candidates for interaction:

- **D28** (eagerly-materialised chain state vs. lazy resolution, struck via C3): no interaction.
  D28/C3 concern `resolve.ts`'s per-position `ChainState` during chain *resolution*, entirely disjoint
  from `build.ts`'s producer-side patch *construction*. Nothing here reads or writes anything C3
  discusses.
- **D31** (jsdiff producer recipe: `structuredPatch` + `formatPatch`, corrected by C1): unaffected,
  reinforced if anything. The actual payload-producing call remains exactly C1's corrected recipe —
  `structuredPatch(...)` then `formatPatch(patch)` with no second argument, called once per
  `buildPatch` invocation at the resolved context. `diffHunks` adds a *second*, distinct use of
  `structuredPatch` (for hunk inspection during widening, never for text output), which does not
  change what D31/C1 govern: the bytes a patch payload contains are still produced by exactly the
  recipe C1 specifies, exactly once.
- **D11** (`core` is sans-IO, one runtime dependency (`diff`), behind an applier port): unaffected.
  No new dependency is added. The package's points of contact with `diff` are now `patch.ts` and
  `patch-matcher.ts` — the same one dependency, imported from one additional internal file, with
  `build.ts` itself gaining zero direct `diff` import. If anything this is a tighter match to D11's
  spirit of confining the dependency's touch-points than the pre-widening state, where `build.ts`
  already imported `patch.ts` (which imports `diff`) transitively without the boundary being explicit.

**D32** (`./patch` is internal, never published) is the one decision this item's design actively
relies on rather than merely avoids contradicting: `patch-matcher.ts` receives the identical treatment
by the identical reasoning (§1), which is a direct application of D32's principle to a second file,
not an amendment to D32's text.
