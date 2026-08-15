/**
 * Permanent regression cases for the patch matcher.
 *
 * Two sources, and both are permanent: inputs shrunk out of a failing property run, and inputs that
 * demonstrate a stock applier doing the wrong thing where T1/T2/T3 require otherwise. A shrunk
 * counterexample is worth more than the property that found it, because it stays checked when
 * someone later weakens the generator — and a counterexample that lives only in a CI log is lost.
 *
 * These are shaped to become conformance vectors verbatim once the corpus exists (D33): `content`,
 * `payload` and the expected outcome, with the rule each one pins.
 */

import type { HaltReason } from '../src/patch-types.js'
import type { RuleId } from '../src/rules.js'
import { body } from './_patch.js'

export interface RegressionCase {
  readonly name: string
  /** The rule the case pins. Typed so a renamed or misspelled rule fails to compile (D35). */
  readonly rule: RuleId
  readonly why: string
  readonly content: string
  readonly payload: string
  readonly expect:
    | { readonly status: 'applied'; readonly content: string }
    | { readonly status: 'noop' }
    | { readonly status: 'halt'; readonly reason: HaltReason }
}

export const REGRESSIONS: readonly RegressionCase[] = [
  {
    name: 't1/ambiguous-relocation',
    rule: 'T1',
    why:
      'diff@9.0.0 applyPatch discards the (nonsensical) @@ line number, relocates by context, ' +
      'silently picks the second of two equally good matches and reports success: ' +
      '"x\\nDUP\\ny\\nCHANGED\\nz\\n". T1 makes this patch invalid.',
    content: 'x\nDUP\ny\nDUP\nz\n',
    payload: body('@@ -100,1 +100,1 @@', '-DUP', '+CHANGED'),
    expect: { status: 'halt', reason: 'ambiguous-match' },
  },
  {
    name: 't1/adjacent-duplicate',
    rule: 'T1',
    why: 'Adjacent duplicates make overlapping occurrences, which must count independently.',
    content: 'a\na\na\n',
    payload: body('@@ -1,2 +1,2 @@', '-a', '-a', '+b', '+b'),
    expect: { status: 'halt', reason: 'ambiguous-match' },
  },
  {
    name: 't1/no-match',
    rule: 'T1',
    why: 'Zero occurrences is a HALT, not a relocation to the nearest thing.',
    content: 'q\n',
    payload: body('@@ -1,1 +1,1 @@', '-a', '+b'),
    expect: { status: 'halt', reason: 'no-match' },
  },
  {
    name: 'c6/advisory-line-numbers',
    rule: 'C6',
    why: 'A wildly wrong @@ number must not prevent a unique context match from applying.',
    content: 'x\nUNIQUE\ny\n',
    payload: body('@@ -9999,1 +9999,1 @@', '-UNIQUE', '+CHANGED'),
    expect: { status: 'applied', content: 'x\nCHANGED\ny\n' },
  },
  {
    name: 't3/descending-hunks',
    rule: 'T3',
    why:
      'diff@9.0.0 applyPatch turns these eight lines into fourteen — its cross-hunk offset ' +
      'bookkeeping duplicates six lines and reports success. Sequencing each hunk against the ' +
      'content the previous one produced gives one deterministic answer instead.',
    content: 'a\nb\nc\nd\ne\nf\ng\nh\n',
    payload: body('@@ -7,1 +7,1 @@', '-g', '+G', '@@ -2,1 +2,1 @@', '-b', '+B'),
    expect: { status: 'applied', content: 'a\nB\nc\nd\ne\nf\nG\nh\n' },
  },
  {
    name: 't3/ambiguity-created-by-earlier-hunk',
    rule: 'T3',
    why:
      'T3 verbatim: a hunk that satisfies T1 against the pre-patch content but not against the ' +
      'content an earlier hunk in the same patch produced must HALT.',
    content: 'p\nq\n',
    payload: body('@@ -1,1 +1,1 @@', '-p', '+q', '@@ -2,1 +2,1 @@', '-q', '+r'),
    expect: { status: 'halt', reason: 'ambiguous-match' },
  },
  {
    name: 't2/insertion-into-empty',
    rule: 'T2',
    why: 'The carve-out is oldPat.length === 0, and @@ -0,0 normalises to insertion index 0.',
    content: '',
    payload: body('@@ -0,0 +1,2 @@', '+x', '+y'),
    expect: { status: 'applied', content: 'x\ny\n' },
  },
  {
    name: 't2/shift-after-eof-newline-change',
    rule: 'T2',
    why:
      'Found by the Phase 8 audit. T2 carries the insertion index forward by the net *line* delta ' +
      'of prior hunks, but the delta was computed over toLines array length — and the trailing ' +
      'newline is a final "" element, so a hunk that only drops the EOF newline (C5) moved the ' +
      'count by one having added and removed no lines. The insertion then landed one position ' +
      'early, silently: T2 has no uniqueness test, so the wrong answer applied cleanly rather ' +
      'than halting. Produced "X\\na\\nb\\nC" before the fix. Reachable only with hunks in ' +
      'descending order (t3/descending-hunks), which is why the ascending-only round-trip ' +
      'property never generated it.',
    content: 'a\nb\nc\n',
    payload: body(
      '@@ -3,1 +3,1 @@',
      '-c',
      '+C',
      '\\ No newline at end of file',
      '@@ -1,0 +2,1 @@',
      '+X',
    ),
    expect: { status: 'applied', content: 'a\nX\nb\nC' },
  },
  {
    name: 't2/insertion-amid-duplicates',
    rule: 'T2',
    why:
      'A pure insertion has no pattern, so T1 does not apply even though the surrounding content ' +
      'is entirely duplicate lines. The @@ number is the only positional information there is.',
    content: 'a\na\na\n',
    payload: body('@@ -2,0 +3,1 @@', '+NEW'),
    expect: { status: 'applied', content: 'a\na\nNEW\na\n' },
  },
  {
    name: 't2/insertion-index-after-an-earlier-hunk-shifted-lines',
    rule: 'T2',
    why:
      'Shrunk from the zero-context property, seed 2082756637. The second hunk is a pure ' +
      'insertion whose "@@ -3" numbers the pre-patch file, but the first hunk has already ' +
      'removed a line. Applying the header number literally against the current content inserts ' +
      'one position too late and yields "+++ b/content\\n\\na". T2 and T3 disagree here and the ' +
      'spec does not reconcile them; the header number is carried forward by the net line shift. ' +
      'See F6.',
    content: 'a\n+++ b/content\n',
    payload: body('@@ -1,1 +0,0 @@', '-a', '@@ -2,0 +2,1 @@', '+a', '\\ No newline at end of file'),
    expect: { status: 'applied', content: '+++ b/content\na' },
  },
  {
    name: 'c5/drop-trailing-newline',
    rule: 'C5',
    why: 'The new side ends the file without a newline, so the terminator must be consumed.',
    content: 'a\nb\n',
    payload: body('@@ -2,1 +2,1 @@', '-b', '+c', '\\ No newline at end of file'),
    expect: { status: 'applied', content: 'a\nc' },
  },
  {
    name: 'c5/gain-trailing-newline',
    rule: 'C5',
    why:
      'The old side is marked no-newline and the new side is not, so the result gains a ' +
      'terminator. Without this the round trip silently loses the final newline — the class of ' +
      'bug PB-1 exists to prevent.',
    content: 'a\nb',
    payload: body('@@ -2,1 +2,1 @@', '-b', '\\ No newline at end of file', '+c'),
    expect: { status: 'applied', content: 'a\nc\n' },
  },
  {
    name: 'c5/marker-contradicts-match',
    rule: 'C5',
    why:
      'The old side claims to end the file, but the content it matches is newline-terminated. ' +
      'That is a genuine failure to apply, not something to paper over by normalising.',
    content: 'a\nb\n',
    payload: body('@@ -2,1 +2,1 @@', '-b', '\\ No newline at end of file', '+c'),
    expect: { status: 'halt', reason: 'eof-mismatch' },
  },
  {
    name: 'c5/localised-marker',
    rule: 'C5',
    why:
      'GNU diff and git localise the marker text. §5.2 admits "\\" as a hunk-line prefix without ' +
      'constraining what follows, so the prefix is what is matched, not the English string.',
    content: 'a\nb',
    payload: body('@@ -2,1 +2,1 @@', '-b', '\\ Kein Zeilenumbruch am Dateiende', '+c'),
    expect: { status: 'applied', content: 'a\nc\n' },
  },
  {
    name: 'pb1/crlf-not-normalised',
    rule: 'PB-1',
    why:
      'A CRLF payload against LF content must fail to match rather than be repaired. The bytes ' +
      'are signature-protected and PB-1 forbids normalising either side.',
    content: 'a\nb\n',
    payload: '--- a/content\n+++ b/content\n@@ -2,1 +2,1 @@\r\n-b\r\n+c\r\n',
    expect: { status: 'halt', reason: 'no-match' },
  },
  {
    name: 'grammar/empty-context-line',
    rule: 'C7',
    why:
      'A blank context line loses its leading space to editor and mail pipelines, so a bare "" ' +
      "line is common in the wild. git, patch(1) and jsdiff all accept it; §5.2's hunk-line " +
      'production does not. See F7.',
    content: 'a\n\nb\n',
    payload: '--- a/content\n+++ b/content\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n',
    expect: { status: 'applied', content: 'a\n\nc\n' },
  },
  {
    name: 'grammar/content-line-looks-like-a-header',
    rule: 'PB-2',
    why:
      'Content whose own lines read "--- a/content" must survive. Inside a hunk every line ' +
      'carries a prefix, so the payload is unambiguous — but a matcher that scans for headers ' +
      'line-wise instead of parsing will corrupt it.',
    content: '--- a/content\nkeep\n',
    payload: body('@@ -2,1 +2,1 @@', '-keep', '+kept'),
    expect: { status: 'applied', content: '--- a/content\nkept\n' },
  },
  {
    name: 'malformed/truncated-hunk',
    rule: 'H1',
    why: 'diff@9.0.0 throws here. Normalised into the same rejection signal as every other failure.',
    content: 'a\nb\nc\n',
    payload: body('@@ -1,3 +1,3 @@', '-a'),
    expect: { status: 'halt', reason: 'malformed-payload' },
  },
  {
    name: 'malformed/headerless-garbage',
    rule: 'H1',
    why:
      'diff@9.0.0 returns [{hunks: []}] for this and does not throw. Trusting the hunk count ' +
      'alone would make it indistinguishable from the N2 header-only no-op, silently turning ' +
      'malformed input into "applied cleanly, no change".',
    content: 'a\n',
    payload: 'total garbage\nno headers here\n',
    expect: { status: 'halt', reason: 'malformed-payload' },
  },
  {
    name: 'noop/header-only',
    rule: 'N2',
    why: 'The shape jsdiff createPatch emits when a === b. MUST NOT be rejected as malformed.',
    content: 'a\nb\n',
    payload: '--- a/content\n+++ b/content\n',
    expect: { status: 'noop' },
  },
  {
    name: 'malformed/empty-fenced-block',
    rule: 'C1',
    why:
      'An empty ```diff block yields an empty payload, which used to short-circuit to the N2 ' +
      'header-only no-op and validate with zero issues. It is neither no-op shape: E7/N1 cover ' +
      'the absence of a block, N2 covers a block carrying a header, and this has a block with no ' +
      'header. §5.2 makes header-block mandatory, so C1 applies and application is malformed. ' +
      'Found by review on PR #1.',
    content: 'a\nb\n',
    payload: '',
    expect: { status: 'halt', reason: 'malformed-payload' },
  },
  {
    name: 't2/out-of-range-insert-clamps-to-content-end',
    rule: 'T2',
    why:
      'A pure-insertion hunk whose advisory @@ index is out of range clamps to the end of the ' +
      'real content — not one element past it. `lines.length` counts the trailing-newline ' +
      "sentinel ('' element), and clamping against it inserted *after* the sentinel: a spurious " +
      "blank line was added and the file's trailing newline silently dropped, reported as " +
      "'applied'. Found independently by two review passes in the 2026-08-08 audit (S3-18/S3-19).",
    content: 'a\nb\n',
    payload: body('@@ -99,0 +100,1 @@', '+X'),
    expect: { status: 'applied', content: 'a\nb\nX\n' },
  },
]
