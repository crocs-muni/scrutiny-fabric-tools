# Mini-spec — the T1/T2/T3 patch matcher (`packages/core/src/patch.ts`)

Phase 2 of the implementation plan. `patch.ts` is **internal** and never appears in the `exports`
map (D32).

Normative source: `~/scrutiny-fabric/docs/protocol-spec.md` v0.6.0, §5.1–§5.4. Rules owned:
**T1, T2, T3, H1, N1–N3, C5, C6, PB-1, PB-2, E7**. Rules deliberately *not* owned here: E1–E6 and
C1–C4 (envelope and grammar, already enforced by `validate.ts` in Phase 1), H2 (the protocol-error
annotation needs the event id and author, which this module never sees — assembled by `resolve.ts`
in Phase 3), CHN-1/2/3 (Phase 3).

Every design claim below about jsdiff was verified by running `diff@9.0.0` on 2026-07-27. The
transcripts are reproduced inline rather than asserted from memory.

---

## 0. Shape of the module

```ts
// Ports. jsdiff sits *below* the determinism gate, never around it (D30).
interface DiffPort {
  parse(payload: string): readonly ParsedHunk[]   // throws → normalised to a halt
  create(before: string, after: string): string   // producer, for the gate's round-trip
}

applyPatchPayload(content: string, payload: string | undefined, opts?: ApplyOptions): ApplyResult
makePatch(before: string, after: string, context = 3): string
```

`makePatch` lives here, not in `build.ts`, because the Phase 2 gate
(`applyPatch(a, makePatch(a, b)) === b`) needs it and `build.ts` is Phase 6. `build.ts` will call
into it rather than duplicate it. `context` is a parameter only so the T1 property can ask for the
zero-context shape (see §8); producers leave the default alone, since three is what P1 asks for.

### Line representation

```
toLines(content) = content.split('\n')
fromLines(lines) = lines.join('\n')
```

Exactly inverse, for every string, with no normalisation whatsoever — which is what PB-1 and PB-2
require. `""` → `['']`. `"a\n"` → `['a','']`. `"a\nb"` → `['a','b']`. A CRLF payload keeps its `\r`
as the last character of each line body and therefore simply fails to match LF content; that is the
correct outcome, and it is detected at match time where the evidence exists, not by repairing bytes.

The trailing `''` element carries the trailing-newline bit. This is the whole of the C5 mechanism —
see §4.

---

## 1. How candidate positions are enumerated

Each parsed hunk is reduced to four values:

| Value | Built from |
|---|---|
| `oldPat: string[]` | the bodies of the hunk's `' '` (context) and `'-'` (removed) lines, in order |
| `newRep: string[]` | the bodies of the hunk's `' '` and `'+'` lines, in order |
| `oldNoEol: boolean` | a `\ No newline at end of file` line follows the last `' '`/`'-'` line |
| `newNoEol: boolean` | a `\ No newline at end of file` line follows the last `' '`/`'+'` line |

Two parser details, both verified:

- jsdiff emits the marker as a literal element of `hunk.lines`, immediately after the line it
  qualifies, and emits it **twice** when both sides lack the newline:
  `[" a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"]`.
- A wholly empty element `""` inside a hunk is a **context line with an empty body**, not a
  malformed line. Real producers strip the trailing space from an empty context line, so this is
  common, and jsdiff preserves it verbatim:
  `parsePatch('…@@ -1,2 +1,2 @@\n-a\n+b\n\n')` → `lines: ["-a","+b",""]`.

**Enumeration is a full linear scan.** For a current line array `L` and a hunk with
`|oldPat| = k`, the candidate positions are every `i ∈ [0, |L| − k]` such that
`L[i..i+k) === oldPat` element-wise, **and** the EOF constraint of §4 holds at `i`. Overlapping
occurrences are counted independently: content `a a a` against pattern `a a` yields two candidates
(0 and 1), which is ambiguous, which is correct.

**The `@@` line numbers are not used for matching at all.** C6 makes them advisory and T1 permits
using them only as a hint for the initial search position while still requiring a full-content
uniqueness proof. Since the full scan is mandatory, a hint can only reorder work whose result is
identical, so it buys nothing and adds a way to be wrong. `oldStart` is read for exactly one
purpose: T2 (§3).

Cost is charged before the scan, not during it — see §6.

---

## 2. How T1 uniqueness is proven across the full content

For each hunk with `|oldPat| > 0`, count **all** candidates over the whole of `L` — never stopping
at the first, never stopping at the second-with-an-early-exit that skips the tail, because the count
itself is the evidence and a partial scan cannot produce it.

| Count | Verdict |
|---|---|
| 0 | **halt** — `T1`, no match |
| ≥ 2 | **halt** — `T1`, ambiguous match (report the count and the first two indices) |
| exactly 1 | apply at that index |

This is the check no stock applier performs, and the reason `patch.ts` cannot delegate application
(D30). Verified against jsdiff 9.0.0 — a hunk whose `@@` header points at line 100 of a five-line
file, whose pattern occurs twice:

```js
applyPatch('x\nDUP\ny\nDUP\nz\n',
  '--- a/content\n+++ b/content\n@@ -100,1 +100,1 @@\n-DUP\n+CHANGED\n')
// → 'x\nDUP\ny\nCHANGED\nz\n'
```

jsdiff discarded the (nonsensical) line number, relocated by context, silently picked the *second*
of two equally good matches, and reported success. Under T1 this patch is invalid. This exact input
is regression case `t1/ambiguous-relocation`.

A hunk with `|oldPat| > 0` but no `-` and no `+` lines (pure context, no change) is still subject to
T1. It has a pattern, so it must be unambiguous; `newRep === oldPat` so applying it is a no-op on
the content but not on the verdict.

---

## 3. How T2's pure-insertion carve-out is detected

The carve-out condition is exactly `oldPat.length === 0` — the hunk has no context lines and no `-`
lines, so there is no pattern and nothing to disambiguate. Detected structurally from the parsed
hunk, never from the `@@` header's `0,0` shape, because `@@ -5,0 +6,2 @@` is equally a pure
insertion.

Such a hunk applies at the position implied by the `-` line number. jsdiff normalises that number
for us, verified:

| header | parsed `oldStart` |
|---|---|
| `@@ -0,0 +1,2 @@` | 1 |
| `@@ -5,0 +6,2 @@` | 6 |
| `@@ -1,0 +2,1 @@` | 2 |

For `oldLines === 0` jsdiff reports `oldStart = L + 1`, following the unified-diff convention that
`-L,0` means *insert after old line L*. The 0-based splice index is therefore `oldStart - 1`, i.e.
`L`, and it is clamped to `[0, |L|]`. Clamping rather than halting is deliberate: C6 makes the
number advisory everywhere else, so an out-of-range insertion point is a producer error about
position, not a failure to apply, and T2 gives us no uniqueness test to fall back on.

**The index is carried forward by the net line shift of prior hunks in the same patch.** T2's
number indexes the *pre-patch* file; T3 requires application against the *post-prior-hunk* content.
Once an earlier hunk has added or removed lines these designate different positions, and the spec
does not say which wins — a gap found by the property test, not by inspection, and recorded as
SPEC-FEEDBACK **F6**. Carrying the number forward by the running delta is what `git apply` and
jsdiff both do and the only reading under which T2 and T3 can both hold. Hunks located by T1 are
unaffected: they are found by content, not by number.

T1 is not evaluated for these hunks. That is the entire carve-out.

---

## 4. C5 — the trailing-newline mechanism

Because `toLines` puts the trailing-newline bit in a final `''` element, and because that element is
never itself a line of a diff, the following holds and drives everything:

> `i + |oldPat| === |L|` (the match consumes the final array element) **iff** the current content
> has no trailing newline and the hunk covers its last line.

Call that `atEnd`, with `end = i + |oldPat|`. The rules, applied at the single proven match index,
branch on the **old** side first because that is what the match has to agree with:

| Case | Condition | Action |
|---|---|---|
| A | `oldNoEol && !atEnd` | **halt** — `C5`. The patch asserts its old side ends the file; the match says otherwise. |
| A | `oldNoEol && atEnd` | splice `newRep`, then append `''` **unless** `newNoEol` — absent a marker the patch asserts the new side *is* newline-terminated. |
| B | `!oldNoEol && newNoEol` and `end === \|L\| − 1` and `L[−1] === ''` | splice `newRep`, dropping the existing terminator: the new side ends the file without a newline. |
| B | `!oldNoEol && newNoEol && atEnd` | splice `newRep`; there is no terminator to drop. |
| B | `!oldNoEol && newNoEol` otherwise | **halt** — `C5`. The new side claims to end the file somewhere that is not its end. |
| C | neither marker | plain splice, no adjustment. |

Case A's second row is the one worth stating twice — `a = "a\nb"`, `b = "a\nc\n"`, where jsdiff
marks the old side only. `L = ['a','b']`, `oldPat = ['b']`, match at 1, `atEnd`, `newNoEol` false →
splice `['c']` then append `''` → `['a','c','']` → `"a\nc\n"` = `b`. Without the append the round
trip silently loses the final newline, which is precisely the class of bug PB-1 exists to prevent.

Case B's first row is its mirror — `a = "a\nb\n"`, `b = "a\nc"` — and was the row a naive
`atEnd`-only reading omitted, because there the pattern stops one short of the array's end.

`oldNoEol` is additionally part of the match predicate: a "no newline at EOF" hunk whose pattern
occurs only mid-file has no valid position, and case A rejects it rather than relocating.

---

## 5. How T3 sequences hunks

```
work  ← toLines(content)                // a copy; the caller's content is never mutated
shift ← 0                               // net line delta, for T2's header-relative index (F6)
for each hunk in document order:
    result ← matchAndApply(hunk, work, shift)   // §1–§4, full re-scan of `work`
    if result is a halt: return that halt, discarding `work` entirely
    shift ← shift + (|result| − |work|)
    work  ← result
return fromLines(work)
```

Three properties, each load-bearing:

- **Each hunk is matched against the output of all prior hunks in the same patch**, never against
  the pre-patch content. This is T3 verbatim. A hunk that was unique before an earlier hunk in the
  same patch duplicated its pattern is now ambiguous and halts — that is the intended behaviour, not
  a defect.
- **The scan is repeated in full for every hunk.** No index is carried forward from the previous
  hunk's match, because a prior hunk can insert or delete anywhere, including before the region
  already scanned.
- **Application is atomic.** A halt on hunk *n* discards the effect of hunks *1..n−1*; the patch
  contributes nothing. §5.3 step 3 requires pre-validation "in a temporary workspace", and a
  partially applied patch must never become visible content. `work` is a local array, so this is
  structural rather than a discipline.

This is also why jsdiff's applier is unusable even setting T1 aside. Verified — two hunks in
descending line order, which is malformed but not detectably so:

```js
applyPatch('a\nb\nc\nd\ne\nf\ng\nh\n',
  '--- a/content\n+++ b/content\n@@ -7,1 +7,1 @@\n-g\n+G\n@@ -2,1 +2,1 @@\n-b\n+B\n')
// → 'a\nb\nc\nd\ne\nf\nG\nB\nc\nd\ne\nf\ng\nh\n'
```

Eight lines in, fourteen out, no error. jsdiff's cross-hunk offset bookkeeping duplicated six lines.
Under T3 both hunks are individually unique against the running content and the result is
`a\nB\nc\nd\ne\nf\nG\nh\n`, deterministically. Regression case `t3/descending-hunks`.

> **Correction to the session brief.** The brief states jsdiff *throws* on swapped hunks. It does
> not — it silently corrupts, as above. It throws on **truncated** hunks and on an unparseable hunk
> header. Both channels are still normalised (§7); the swapped case is simply a third, worse
> channel, and it is an additional argument for owning application rather than delegating it.

---

## 6. Where HALT (H1) is raised, and how it stays distinct from RL-3

### The result type

The two outcomes are different variants of a discriminated union, not two values of one field, so
no call site can conflate them and no `if` can forget one:

```ts
type ApplyResult =
  | { status: 'applied';  content: string; hunksApplied: number; work: number }
  | { status: 'noop';     content: string; shape: 'prose-only' | 'header-only' }
  | { status: 'halt';     reason: HaltReason; issue: Issue; hunkIndex: number | null }
  | { status: 'limit';    limit: 'hunks' | 'work'; issue: Issue; observed: number; ceiling: number }
```

`halt` never carries content; the caller (Phase 3) supplies "the state after the last successfully
applied patch" from the chain, which is the only place that state exists. `limit` never carries
content either, which is how RL-4 is enforced structurally — there is nothing to cache.

### H1 — the patch genuinely failed to apply

Raised, and only raised, for:

| `HaltReason` | Rule | Condition |
|---|---|---|
| `no-match` | T1 | zero candidates |
| `ambiguous-match` | T1 | two or more candidates |
| `eof-mismatch` | C5 | the `\ No newline` contradiction of §4 |
| `malformed-payload` | H1 | `DiffPort.parse` threw, or the payload is non-empty with no `--- ` header line |

Each carries an `Issue` citing the specific rule, plus one citing `H1` for the halt itself. That
keeps rule-code coverage honest under D34: T1's code is emitted by a test that observes a real
ambiguity, not by an annotation.

### RL-3 — a ceiling was hit before a verdict was reached

Never a halt. §5.4 is explicit: "Exceeding a ceiling aborts application and MUST be surfaced as a
distinct resource-limit-exceeded annotation, never as HALT. The event remains V-valid."

Ceilings are configurable, defaulting to §5.4's recommendations:

| Option | Default | Basis |
|---|---|---|
| `maxHunks` | 64 | §5.4, T1 cost |
| `maxWork` | 16 MiB | RL-2's "total work … measured in bytes compared" |

Work is charged **before** each scan, not accumulated during it, so an adversarial patch is refused
rather than executed and then regretted. The charge for one hunk is its exact upper bound,
`|L| × Σ len(oldPat)`, which is the cost of the worst case in which every candidate position
compares every pattern character. If the running total would exceed `maxWork`, return `limit`
immediately.

The distinction in one line: **`halt` is a verdict about the patch; `limit` is an admission that no
verdict was reached.** A `limit` result is local (another consumer with a higher ceiling reaches a
verdict), which is exactly why RL-4 forbids caching it as canonical bytes.

### Severity

Both H1 and RL-3 issues are `warning`, never `error`. `Severity.error` in `errors.ts` means *the
event is invalid and MUST NOT be processed or rendered*, and neither a HALT nor a ceiling makes an
event invalid — TR-1 forbids an A-layer rule from rejecting a V-valid event, and §5.4 says so
explicitly for RL-3. The `status` discriminant, not the severity, carries the weight of the outcome.

This also motivates strengthening `test/invariants.test.ts`: the existing assertion is "no `error`
cites a D-layer rule". The honest generalisation is **no `error` cites an A-layer or D-layer rule**,
since TR-1 covers both. Checked against Phase 1 before proposing it — every rule `validate.ts`
emits at `error` severity (TAG-1, IR-1, C1, P3, BD-1, BD-2, BD-5) is V-layer, so tightening the
assertion is safe today and it will catch the first A-layer `error` anyone adds.

---

## 7. Normalising the applier's failure channels

`DiffPort.parse` wraps `jsdiff.parsePatch` and converts its behaviour into total, typed results.
Three observed behaviours:

| Input | jsdiff 9.0.0 | Normalised to |
|---|---|---|
| hunk declaring 3 old lines, carrying 1 | throws `Error: Hunk at line 3 contained invalid line` | `malformed-payload` halt |
| unparseable `@@` header | throws, same message | `malformed-payload` halt |
| `'total garbage\nno headers here\n'` | returns `[{ hunks: [] }]`, no throw | `malformed-payload` halt — **not** an N2 no-op |

The third row is the dangerous one. A header-less garbage payload parses to zero hunks and would
look identical to the N2 header-only no-op, silently turning malformed input into "applied cleanly,
no change". N2 requires *valid* `--- a/content` / `+++ b/content` headers, so the header block's
presence is checked directly on the payload text before the hunk count is trusted.

`jsdiff.applyPatch`'s `false`-on-mismatch channel does not arise, because it is never called: after
T1 has proven a unique index there is nothing left for a third-party applier to decide, and calling
one would reintroduce exactly the relocation of §2. The channel is documented here so that a future
alternative `DiffPort` implementation normalises it, and the T1 regression cases of §2 and §5 assert
our divergence from it directly.

`DiffPort.create` wraps `structuredPatch` + `formatPatch` with names `a/content` / `b/content` per
D31, which emits spec-canonical bytes natively — verified:

```
'===================================================================\n--- a/content\n+++ b/content\n@@ -1,1 +1,1 @@\n-a\n+b\n'
```

The `===` separator line is a bare `Index:` preamble remnant that C3 tolerates.

### Multiple header blocks — an ambiguity, recorded

`parsePatch` splits a payload containing two `--- a/content` header blocks into two file patches.
The §5.2 grammar admits exactly one `header-block`, but read literally the second `--- a/content`
line is *also* a valid `hunk-line` (it begins with `-`), so the grammar gives two incompatible
readings of the same bytes. We take jsdiff's: concatenate the hunks of every parsed file patch, in
document order, and sequence the lot under T3. That drops nothing and is deterministic. This is
recorded in `SPEC-FEEDBACK-v0.6.0.md` as **F5**.

---

## 8. No-ops (E7, N1, N2, N3)

| Input | Rule | Result |
|---|---|---|
| no fenced block matching E2 in `content` | E7, N1 | `noop`, `shape: 'prose-only'` |
| payload with valid headers and zero hunks | N2 | `noop`, `shape: 'header-only'` |
| payload is the empty string | E5 edge | `noop`, `shape: 'header-only'` |

N3 requires both to be a *successful* no-op against the current content: the content is returned
unchanged and the event stays in the chain. Neither skips a HALT nor triggers one, per §5.3 step 3
("No-op patches … skip pre-validation"). Confirmed that jsdiff's producer emits the N2 shape for
identical inputs, which is why the shape exists at all:

```js
createPatch('content', 'a\nb', 'a\nb', '', '', { context: 3 })
// → 'Index: content\n===…===\n--- content\n+++ content\n'
```

Payload location reuses `findPatchPayload` from `validate.ts` (E1–E6, already covered by Phase 1);
`patch.ts` does not re-implement fence scanning.

---

## 9. Testing

### The gate

`applyPatchPayload(a, makePatch(a, b)) === b` over ≥ 10 000 fast-check cases. The generator is
biased toward the pathological case, not toward valid-looking input:

- alphabet `['a','b','c','']` for line bodies, so repeated and adjacent-duplicate lines are frequent
  rather than incidental — this is the content that breaks T1
- 0–40 lines, including the empty array
- `''`, a single line with no trailing newline, leading and trailing blank runs
- CRLF and mixed endings (never normalised — PB-1)
- non-ASCII and astral characters
- bodies containing backtick runs

Note the gate's own subtlety: `makePatch(a, b)` can legitimately produce a patch that `a` makes
ambiguous under T1, at which point a halt is the *correct* answer and `=== b` is the wrong
assertion. The property is therefore stated as **`applied` ⟹ content equals `b`, and a halt is only
permitted when the T1 count for some hunk is genuinely ≠ 1** — the second clause is re-derived
independently in the test rather than read back from the implementation, so the property cannot be
satisfied by an implementation that halts on everything.

Every counterexample becomes a named permanent regression case under `test/patch-regressions.ts`,
and a conformance vector once the corpus exists. A counterexample that lives only in a CI log is
lost.

**The round trip alone does not exercise T1.** Measured: over 2 000 generated pairs the outcome mix
is roughly `applied 1970 · halt 6 · noop 25`. Because `makePatch` emits three context lines, a
hunk's pattern runs to about seven lines and almost never repeats — so the gate that exists to
prove the determinism check works barely reaches its rejecting branch. A second property therefore
generates **zero-context** patches (`context: 0`, the shape a hand-written or minimising producer
emits) over the same repeat-heavy content, where ambiguity is the common case: `applied 4660 ·
halt 290` over 5 000 runs, with `applied ⟹ content === b` asserted throughout and a floor on the
halt count so the property fails if the branch stops being reached.

### Second gate item — C7 grammar conformance

Carried over from Phase 1. A fast-check arbitrary emitting from the §5.2 productions (optional
`Index:` preamble, optional `diff --git` line, header block, 0..N hunks, arbitrary trailing data),
asserting `validateEvent` returns no `error`-severity issue for any of them. Seeded with the two
shapes most likely to be wrongly rejected: the N2 header-only block and the zero-context hunk. The
grammar is read per F3 — a line body is any sequence of characters other than LF — because read
literally it rejects the spec's own example.

### Vector loader

`test/_vectors.ts` reads `packages/core/vectors/*.json` and returns an empty list when the directory
is absent or empty, so the suite is green before the corpus exists (it does not exist yet) and
picks the vectors up with no further change when it does. `node:fs` is confined to the test tree;
`src/` stays free of Node globals per `tsconfig.build.json`'s `"types": []`.

---

## 10. What this module does not do

- No chain walking, no kind-5 cascade, no HALT re-evaluation on topology change (H1's second
  sentence) — Phase 3, `resolve.ts`.
- No protocol-error annotation (H2) — it needs the event id and author, which never reach here.
- No overlay classification, though CHN-3 makes the same T1/T2/T3/H1 rules apply to overlays; Phase
  3 calls this module for that.
- No caching. The LRU of D28 belongs to `resolve.ts`.
- No trust. Nothing in this module reads a trust set (D25).
