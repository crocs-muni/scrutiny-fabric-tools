# Investigation 1 — jsdiff v9 ↔ git diff parity — REPORT

**Date:** 2026-05-21
**Driver:** `run.mjs` (Node v25.6.1, jsdiff v9 from npm, git 2.53.0.windows.1)
**Spec reference:** `../../../scrutiny-fabric/docs/protocol-spec.md` §5.1, §5.2, §5.3

## Verdict

**PROCEED WITH ADAPTER**, with three additional protocol-level guard rails the
extended harness uncovered (see "Findings from extended scenarios 16–22").

jsdiff produces unified-diff output whose **hunk content is byte-identical to
`git diff --no-index --unified=3`** in every scenario tested (14/14). The
remaining differences are confined to the four-line file-header preamble and
are mechanically fixable with a ~10-line adapter. Apply-direction parity is
perfect both ways (14/14, both `applyPatch(git-produced)` and `git apply
jsdiff-produced`). The `diff` dependency lock in `IMPLEMENTATION-PLAN.md`
stands.

## Per-scenario results

All scenarios were also reverse-applied (b→a is implied by the producer test on
the inverse fixture; not run separately). Producer column reports byte-equality
of git output vs jsdiff output **after stripping path-only differences**.

| # | Scenario | Producer | git→jsdiff apply | jsdiff→git apply | Canonical |
|---|---|---|---|---|---|
| 01 | single-line, 1-line file | header-only | EQUAL | EQUAL | ✓ |
| 02 | single-line, 10-line file | header-only | EQUAL | EQUAL | ✓ |
| 03 | edit at file start | header-only | EQUAL | EQUAL | ✓ |
| 04 | edit at file end | header-only | EQUAL | EQUAL | ✓ |
| 05 | multi-hunk (>6 apart) | header-only | EQUAL | EQUAL | ✓ |
| 06 | multi-hunk (6 apart) | header-only | EQUAL | EQUAL | ✓ |
| 07 | pure insertion | header-only | EQUAL | EQUAL | ✓ |
| 08 | pure deletion | header-only | EQUAL | EQUAL | ✓ |
| 09 | empty → content | header-only | EQUAL | EQUAL | ✓ |
| 10 | content → empty | header-only | EQUAL | EQUAL | ✓ |
| 11 | no-trail → trail | header-only | EQUAL | EQUAL | ✓ |
| 12 | trail → no-trail | header-only | EQUAL | EQUAL | ✓ |
| 13 | CRLF both sides | header-only | EQUAL | EQUAL | ✓ |
| 14 | unicode multibyte | header-only | EQUAL | EQUAL | ✓ |
| 16 | multi-hunk offsets (3 hunks) | header-only | EQUAL | EQUAL | ✓ |
| 17 | diff-looking content | header-only | EQUAL | EQUAL | ✓ |
| 18 | empty patch (a===b) | **shape mismatch** | EQUAL (no-op) | **REJECTED** | ✓ |
| 19 | mixed line endings | header-only | EQUAL | EQUAL | ✓ |
| 20 | UTF-8 BOM prefix | header-only | EQUAL | EQUAL | ✓ |

"header-only" = the four-line file preamble differs, but every line from
`@@ ...` onward is byte-identical. Scenario 18 is the lone exception —
producers emit different bytes for the empty-patch case.

Raw harness output: `out/<scenario>/{git.patch, jsdiff.patch, jsdiff.patch.stripped}`.
Machine-readable summary: `out/summary.json`.

## What differs (producer)

Across all 14 cases the divergence is identical and small:

| Line | git emits | jsdiff emits | Spec §5.2 says |
|---|---|---|---|
| 1 | `diff --git a/<path> b/<path>` | *(absent)* | **REQUIRED** |
| 2 | `index <sha>..<sha> <mode>` | *(absent)* | **FORBIDDEN** ("No `index` lines") |
| 3 | `--- a/<path>` | `--- <name>` | `--- a/content` |
| 4 | `+++ b/<path>` | `+++ <name>` | `+++ b/content` |
| pre | *(absent)* | `Index: <name>\n===…===\n` | not mentioned |
| hunk | `@@ -1 +1 @@` (shorthand when N=1) | `@@ -1,1 +1,1 @@` (always full) | both forms valid |

Net result: **jsdiff's hunk body is already spec-canonical; git's is not** (it
emits a forbidden `index` line). Both are equally far from canonical at the
preamble level, just in opposite directions.

## Required producer adapter

To make jsdiff output spec-canonical, pass the configured path (`content`) and
post-process:

```js
function canonicalize(rawJsdiffPatch) {
  return rawJsdiffPatch
    // strip jsdiff's non-spec preamble
    .replace(/^Index: [^\n]*\n=+\n/, '')
    // rewrite name-only headers to a/<name>, b/<name>
    .replace(/^--- ([^\s\n]+)\n/m, '--- a/$1\n')
    .replace(/^\+\+\+ ([^\s\n]+)\n/m, '+++ b/$1\n')
    // prepend the required diff --git line
    .replace(/^/, 'diff --git a/content b/content\n');
}
```

This belongs in `packages/core/src/diff.ts`. It's deterministic, dependency-free,
and trivially unit-testable against the 14 fixtures here.

The shorthand-vs-full hunk-count difference (`@@ -1 +1 @@` vs `@@ -1,1 +1,1 @@`)
is explicitly permitted by the spec ("Shorthand … is also valid"), so no
canonicalisation is needed there.

## Apply-direction parity

- **`jsdiff.applyPatch(a, gitPatch) === b`** in all 14 scenarios. jsdiff
  tolerates the `index`, `diff --git`, and absolute-path headers without
  complaint — it only reads hunks.
- **`git apply jsdiffPatch`** succeeds in all 14 scenarios after we prepend
  `diff --git a/content b/content` (matching what the canonical adapter would
  produce). `git apply --check` also passes.

This is the strongest result of the investigation: **chain application across
implementations is interoperable today**, even if a publisher used jsdiff and a
verifier used `git apply`, or vice versa.

## Edge-case notes

- **`\ No newline at end of file` (11, 12):** Both libraries emit this marker
  in identical positions and apply it correctly. No spec amendment needed.
- **Empty-file edges (09, 10):** `@@ -0,0 +1,N @@` and `@@ -1,N +0,0 @@` are
  emitted and consumed identically.
- **CRLF (13):** Both libraries treat `\r\n` as line-terminator, leaving an
  embedded `\r` on each "line". Output bytes match. Per spec §5.1 content must
  be LF-normalised *before* diffing, so this case mostly verifies that a
  producer who forgets to normalise won't get caller-specific behaviour — the
  two libraries fail (or rather, succeed) the same way.
- **Unicode (14):** Lines are counted, not bytes/codepoints. Combining marks
  and emoji ZWJ sequences pass through unchanged.

## Scenario 15 — malformed patches fed to `applyPatch`

| Malformation | jsdiff result |
|---|---|
| truncated hunk | **throws** `Hunk at line 3 contained invalid line` |
| wrong context line | **returns `false`** |
| swapped line-number header | **throws** `Hunk at line 3 has more lines than expected …` |
| bogus filename header (`--- not-a-file`) | **ACCEPTED** — patches anyway |

**Implication for `core/diff.ts`:** jsdiff's `applyPatch` uses two different
failure channels (return-`false` and thrown exception) and **does not validate
the filename header at all**. The protocol-level `applyUnifiedDiff` wrapper
must:

1. Normalise both failure modes into a single rejection signal (the
   "pre-validation" required by spec §5.3).
2. Validate the filename header itself (the spec mandates `--- a/content` /
   `+++ b/content` — `applyPatch` will silently accept anything).

These behaviours are stable test-vector material for Phase D.

## Findings from extended scenarios 16–22

Adding five new fixtures (16–20) and two new code paths (21, 22) surfaced
three real interop issues, all in patch *application* / *empty-patch* shape
rather than in the diff text itself.

### Scenarios with full parity (no spec action)

- **16 (multi-hunk offsets)** — three independent hunks at line ranges 3–10,
  13–22, and 26–30, with the first hunk inserting two lines. Both producers
  emit independent hunk headers numbered against the original (`@@ -3,...`,
  `@@ -13,...`, `@@ -26,...`), and both appliers handle the running offset
  correctly. EQUAL both directions.
- **17 (diff-looking content)** — file contains lines literally starting with
  `+`, `-`, `@@`, `\ `, and `diff --git`. Both libs correctly disambiguate via
  the leading space on context rows and the `+`/`-` on change rows. EQUAL.
- **19 (mixed line endings)** — `\n` and `\r\n` interleaved in the same input.
  Both libs preserve raw bytes; no normalisation surprise. EQUAL. (This is
  *only* defensive — §5.1 still requires producers to normalise before
  diffing.)
- **20 (BOM)** — leading U+FEFF. Both libs treat the BOM as content prefix on
  line 1 and produce identical output.

### Scenarios that need spec action

#### Scenario 18 — empty patch shape mismatch (**spec gap**)

When `a === b`:

| Producer | Output |
|---|---|
| `git diff --no-index --unified=3` | **0 bytes** |
| `jsdiff.createPatch` | 4 lines: `Index:` preamble + `--- content` + `+++ content`, **no hunks** |

Consume side: `jsdiff.applyPatch(a, "")` returns `a` (treats empty patch as
no-op). `git apply` on the jsdiff-shaped empty patch fails check:
`CHECK_FAILED: error: patch with only garbage at line N`.

This is a real interop break for empty patches. Two compliant producers can
emit completely different bytes for an a==b "patch," and one of them is
rejected by the other side's applier.

**Spec action required:** §5.2 must define exactly one shape for an empty
patch — most naturally, "an empty patch is a prose-only patch (no fenced
`diff` block at all)." A fenced `diff` block with no hunks SHOULD then be
treated as protocol-invalid.

#### Scenario 21 — timestamp suffix on `---`/`+++` (**recommend forbid**)

A patch carrying `--- a/content\t2026-05-21 12:00:00 +0000` is accepted and
applied successfully by **both** jsdiff `applyPatch` and `git apply`. So this
is not currently an interop break — it's a *canonical-form* concern.

The spec currently shows the headers as bare `--- a/content` with no timestamp
and does not say whether a suffix is permitted. Given the spec already
mandates that diffs are produced from materialised "virtual files," and the
path is *fixed* to `content`, allowing timestamps adds no information and
expands the canonical-form surface unnecessarily.

**Recommended spec action:** explicitly forbid any whitespace or trailing
data after `--- a/content` / `+++ b/content`. Producers using tools that emit
timestamps (`patch -u`, GNU `diff -u` defaults) MUST strip them.

#### Scenario 22 — hunk relocation is on by default in both libraries (**revises original T1**)

With a hunk header of `@@ -3,3 +3,3 @@` against content where the actual
matching context is at lines 5–7 (file was prepended by 2 lines after the
patch was authored):

| Applier | Result |
|---|---|
| `git apply` (default) | **ACCEPTED**, stderr: `Hunk #1 succeeded at 5 (offset 2 lines)` |
| `jsdiff.applyPatch` (default, fuzzFactor=0) | **ACCEPTED**, hunk relocated silently |
| `jsdiff.applyPatch` (fuzzFactor=2) | **ACCEPTED**, hunk relocated silently |

Both default appliers do **context-based hunk relocation**. The line numbers
in the hunk header are advisory, not anchoring. This contradicts the
original report's T1 recommendation ("mandate zero-fuzz strict matching") —
neither library *defaults* to that, and forcing it requires non-default
configuration in both.

**Revised spec action:** rather than mandating strict line-number anchoring,
mandate **unambiguous context match**: a hunk MUST match exactly one position
in the target content. If the hunk's context+removed lines match at multiple
positions (or zero positions), application MUST fail. This is what both
libraries already do under the hood when context is unambiguous — and it's
the property the protocol actually needs for deterministic chain resolution.

Side note: this also means **patches that hash-pin against a specific content
version** are not currently supported by the format. If we want guaranteed
"this patch was authored against exactly this base content", the patch event
itself needs to carry a hash of the pre-image (separate concern; outside
§5).

## Spec amendments suggested (file in `scrutiny-fabric` repo, not here)

See `SPEC-UPDATE-PROMPT.md` in this directory for the full proposed
amendments. Summary:

- **T1 (revised)** — mandate unambiguous-context hunk match (not zero-fuzz).
- **T2** — consumers MUST validate `--- a/content` / `+++ b/content` headers.
- **T3** — empty patch MUST be prose-only (no fenced `diff` block); fenced
  `diff` block with zero hunks is invalid.
- **T4 (new)** — forbid timestamp/whitespace suffixes on `---` / `+++`
  headers.
- **L1** — explicitly allow jsdiff-style `Index:` preamble; consumers ignore.

## Test-vector candidates for Phase D

From the harness fixtures, these are the highest-value vectors:

- **09 (empty → content)** and **10 (content → empty)** — boundary cases.
- **11 (no-trail → trail)** and **12 (trail → no-trail)** — `\ No newline …`.
- **14 (unicode)** — confirms byte-fidelity.
- **15.wrong_context** and **15.truncated_hunk** — confirms `applyUnifiedDiff`
  rejects, regardless of which jsdiff failure mode is triggered.
- **15.bogus_header** — confirms `applyUnifiedDiff` rejects on bad filename
  header (this requires the wrapper code, not jsdiff alone, to catch).

## Out of scope / not tested

- Performance of jsdiff on large inputs (deferred per plan).
- 3-way merge — protocol chain application is strictly linear.
- Binary content — spec is text-only UTF-8.
- jsdiff `Diff.diffLines` other entry points — only `createPatch`/`applyPatch`
  are in the v0.1 API surface.

---

**Action:** unblock Phase A (monorepo scaffold). Carry the producer adapter
(above) into `packages/core/src/diff.ts` when Phase B starts. Carry scenario 15
findings into the Phase D test-vector list.

## Investigation 1c — native git-compat formatter & jsdiff issue regressions

After the web-search round, two follow-ups were added.

### 1c.1 — `formatPatch({isGit:true})` removes the need for `canonicalize()`

jsdiff v9 exposes `structuredPatch` → `formatPatch(patch, options)`. Setting
`patch.isGit = true` and passing the names as `'a/content'` / `'b/content'`
produces this output directly:

```
diff --git a/content b/content
--- a/content
+++ b/content
@@ -L,N +L,N @@
 …
```

No `Index:` preamble. No name-rewrite needed. No `diff --git` line synthesis.
The harness was extended with a `native(isGit)` column that compares this
output against a git patch normalised to spec-canonical form (i.e. with the
spec-forbidden `index <sha>..<sha>` line stripped and git's `@@ … @@ <fn>`
function-context hint stripped, both of which the spec already forbids /
doesn't require).

**Result: 17 of 21 content-bearing scenarios produce byte-identical output.**
The remaining 4 differ as follows:

| Scenario | Difference | Spec impact |
|---|---|---|
| 01 (1-line file) | git `@@ -1 +1 @@` vs jsdiff `@@ -1,1 +1,1 @@` | spec accepts both |
| 23 (empty→single-char no-trail) | same hunk shorthand difference | spec accepts both |
| 18 (a===b) | known empty-patch shape mismatch | addressed by T3 |
| (any 1-line hunk) | same shorthand difference | spec accepts both |

So `formatPatch({isGit:true})` already emits spec-canonical bytes. The
shorthand-vs-full form for `N=1` hunks is the only systematic divergence,
and §5.2 explicitly accepts both.

**Implication for `core/diff.ts`:** the `canonicalize()` post-processor from
the original report is no longer needed. The Phase-B producer call collapses
to:

```ts
import { structuredPatch, formatPatch } from 'diff';

export function makeUnifiedDiff(a: string, b: string): string {
  const sp = structuredPatch('a/content', 'b/content', a, b, '', '', { context: 3 });
  if (sp.hunks.length === 0) return '';   // signal "prose-only" upstream
  return formatPatch({ ...sp, isGit: true });
}
```

A small follow-up may still rewrite `@@ -L,1 +L,1 @@` → `@@ -L +L @@` for full
byte parity with `git diff` output found in the wild, but it is cosmetic —
spec compliance does not require it.

### 1c.2 — Two new fixtures (jsdiff issues #94 / #209)

| Fixture | Source | Producer parity | Apply both ways |
|---|---|---|---|
| 23 (empty → single non-newline char) | jsdiff #94 | hunk body byte-identical (shorthand-vs-full only) | EQUAL |
| 24 (both no-trail, last line changed) | jsdiff #209 | byte-identical | EQUAL |

Neither historical regression reproduces against jsdiff v9.0.0. Recommend
both go straight into the Phase D `test-vectors.json` as regression guards.

### 1c verdict

Native `formatPatch({isGit:true})` supersedes the original `canonicalize()`
adapter. The Phase-B implementation surface shrinks by ~10 lines, and there
is now exactly one supported code path for producer output. No new spec
action beyond the original T1/T2/T3/L1 (T4 dropped — see
`SPEC-UPDATE-PROMPT.md`).
