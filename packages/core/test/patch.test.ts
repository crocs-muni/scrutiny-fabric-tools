/**
 * §5.3 patch application — T1, T2, T3, H1, and the no-op and resource-limit boundaries.
 *
 * The permanent regression corpus lives in `patch-regressions.ts` and is replayed first. The cases
 * here cover the remaining behaviour and, together, emit every rule code `patch.ts` owns — see
 * `_a-patch-coverage.ts` for the partition that machine-checks that claim.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyPatchContent, applyPatchPayload, makePatch } from '../src/patch.js'
import { repeatyContent } from './_generators.js'
import { body, describeResult, expectApplied, expectHalt } from './_patch.js'
import type { ApplyCase } from './_vector-cases.js'
import { vectorCases } from './_vector-cases.js'
import { loadVectors } from './_vectors.js'
import { REGRESSIONS } from './patch-regressions.js'

describe('permanent regression corpus', () => {
  for (const c of REGRESSIONS) {
    it(`${c.name} (${c.rule})`, () => {
      const result = applyPatchPayload(c.content, c.payload)
      expect(result.status, `${c.why}\n→ got ${describeResult(result)}`).toBe(c.expect.status)
      if (c.expect.status === 'applied') expectApplied(result, c.expect.content, c.why)
      if (c.expect.status === 'halt') expectHalt(result, c.expect.reason, c.why)
    })
  }
})

describe('T1 — uniqueness across the full content', () => {
  it('counts every occurrence, not just the first two', () => {
    const result = applyPatchPayload('d\nx\nd\nx\nd\n', body('@@ -1,1 +1,1 @@', '-d', '+D'))
    expectHalt(result, 'ambiguous-match')
    if (result.status === 'halt') expect(result.detail).toContain('3 places')
  })

  it('applies when the pattern is unique, however long the content', () => {
    const content = `${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}\n`
    const result = applyPatchPayload(content, body('@@ -1,1 +1,1 @@', '-line 250', '+CHANGED'))
    expect(result.status).toBe('applied')
    if (result.status === 'applied') expect(result.content).toContain('\nCHANGED\n')
  })

  it('treats a pure-context hunk as subject to T1 even though it changes nothing', () => {
    // No '-' and no '+' lines, but a pattern exists, so it must still be unambiguous.
    expectHalt(applyPatchPayload('s\ns\n', body('@@ -1,1 +1,1 @@', ' s')), 'ambiguous-match')
  })
})

describe('T2 — the pure-insertion carve-out', () => {
  it('honours the @@ number, which is the only positional information a pure insertion has', () => {
    for (const [header, expected] of [
      ['@@ -0,0 +1,1 @@', 'N\na\nb\nc\n'],
      ['@@ -1,0 +2,1 @@', 'a\nN\nb\nc\n'],
      ['@@ -3,0 +4,1 @@', 'a\nb\nc\nN\n'],
    ] as const) {
      expectApplied(applyPatchPayload('a\nb\nc\n', body(header, '+N')), expected, header)
    }
  })

  it('clamps an out-of-range insertion point rather than halting', () => {
    // C6 makes the number advisory everywhere else, and T2 leaves no uniqueness test to fall back
    // on, so an impossible position is a producer error about placement, not a failure to apply.
    const result = applyPatchPayload('a\n', body('@@ -900,0 +900,1 @@', '+N'))
    expect(result.status).toBe('applied')
  })
})

describe('T3 — sequencing against the content prior hunks produced', () => {
  it('re-scans in full for each hunk', () => {
    const result = applyPatchPayload(
      'one\ntwo\nthree\nfour\n',
      body('@@ -1,1 +1,1 @@', '-one', '+1', '@@ -3,1 +3,1 @@', '-three', '+3'),
    )
    expectApplied(result, '1\ntwo\n3\nfour\n')
  })

  it('is atomic — a halt on a later hunk discards the effect of earlier ones', () => {
    const before = 'keep\ntarget\n'
    const result = applyPatchPayload(
      before,
      body('@@ -1,1 +1,1 @@', '-keep', '+CHANGED', '@@ -2,1 +2,1 @@', '-absent', '+x'),
    )
    expect(result.status).toBe('halt')
    // The union carries no content on a halt, so a partially applied patch is unrepresentable
    // rather than merely unused. §5.3 step 3's "temporary workspace", structurally.
    expect(result).not.toHaveProperty('content')
    if (result.status === 'halt') expect(result.hunkIndex).toBe(1)
  })

  it('reports the hunk index in document order', () => {
    const result = applyPatchPayload(
      'a\nb\nc\n',
      body(
        '@@ -1,1 +1,1 @@',
        '-a',
        '+A',
        '@@ -2,1 +2,1 @@',
        '-b',
        '+B',
        '@@ -3,1 +3,1 @@',
        '-nope',
        '+C',
      ),
    )
    if (result.status === 'halt') expect(result.hunkIndex).toBe(2)
    else expect.fail(`expected a halt, got ${result.status}`)
  })
})

describe('no-ops — E7, N1, N2, N3', () => {
  it('treats absent fenced block as a prose-only no-op (E7, N1)', () => {
    const result = applyPatchContent('unchanged\n', 'Just prose about the change, no diff block.')
    expect(result).toEqual({
      status: 'noop',
      content: 'unchanged\n',
      shape: 'prose-only',
      issues: [],
    })
  })

  it('treats a header block with zero hunks as a no-op (N2)', () => {
    const result = applyPatchContent('unchanged\n', '```diff\n--- a/content\n+++ b/content\n```')
    expect(result).toEqual({
      status: 'noop',
      content: 'unchanged\n',
      shape: 'header-only',
      issues: [],
    })
  })

  it('locates the payload through E1–E6 rather than re-implementing fence scanning', () => {
    const content = [
      'Prose first.',
      '```diff',
      '--- a/content',
      '+++ b/content',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '```',
      'A later block is prose, per E6:',
      '```diff',
      '--- a/content',
      '+++ b/content',
      '@@ -1,1 +1,1 @@',
      '-new',
      '+ignored',
      '```',
    ].join('\n')
    expectApplied(applyPatchContent('old\n', content), 'new\n')
  })
})

describe('PB-1 / PB-2 — bytes are never normalised', () => {
  it('round-trips content that is only a trailing newline apart', () => {
    for (const [a, b] of [
      ['x', 'x\n'],
      ['x\n', 'x'],
      ['', 'x'],
      ['x', ''],
      ['', '\n'],
    ] as const) {
      const ctx = `${JSON.stringify(a)} → ${JSON.stringify(b)}`
      expectApplied(applyPatchPayload(a, makePatch(a, b)), b, ctx)
    }
  })

  it('preserves a BOM and does not strip it', () => {
    expectApplied(applyPatchPayload('﻿a\nb\n', body('@@ -2,1 +2,1 @@', '-b', '+c')), '﻿a\nc\n')
  })

  it('matches CRLF content when the payload is CRLF too', () => {
    const result = applyPatchPayload('a\r\nb\r\n', body('@@ -1,1 +1,1 @@', '-a\r', '+z\r'))
    expectApplied(result, 'z\r\nb\r\n')
  })
})

describe('RL-3 — a resource limit is never a HALT', () => {
  const manyHunks = body(
    ...Array.from({ length: 10 }, (_, i) => [
      `@@ -${i + 1},1 +${i + 1},1 @@`,
      `-L${i}`,
      `+X${i}`,
    ]).flat(),
  )
  const content = `${Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n')}\n`

  it('reports the hunk ceiling as a limit, not a halt', () => {
    const result = applyPatchPayload(content, manyHunks, { maxHunks: 4 })
    expect(result.status).toBe('limit')
    if (result.status === 'limit') {
      expect(result.limit).toBe('hunks')
      expect(result.observed).toBe(10)
      expect(result.ceiling).toBe(4)
      expect(result.issues.map((i) => i.code)).toEqual(['RL-3'])
    }
  })

  it('reports the work ceiling as a limit, and charges it before scanning', () => {
    const result = applyPatchPayload(content, manyHunks, { maxWork: 1 })
    expect(result.status).toBe('limit')
    if (result.status === 'limit') expect(result.limit).toBe('work')
  })

  it('carries no content, so there is nothing to cache as canonical (RL-4)', () => {
    const result = applyPatchPayload(content, manyHunks, { maxHunks: 1 })
    expect(result).not.toHaveProperty('content')
  })

  it('never cites H1, and a halt never cites RL-3', () => {
    const limited = applyPatchPayload(content, manyHunks, { maxHunks: 1 })
    const halted = applyPatchPayload('q\n', body('@@ -1,1 +1,1 @@', '-absent', '+x'))
    expect(limited.status === 'limit' && limited.issues.map((i) => i.code)).not.toContain('H1')
    expect(halted.status === 'halt' && halted.issues.map((i) => i.code)).not.toContain('RL-3')
  })

  it('applies normally under the default ceilings', () => {
    expect(applyPatchPayload(content, manyHunks).status).toBe('applied')
  })
})

describe('failure channels are normalised into one rejection signal', () => {
  it('never throws, and never returns content, on any malformed payload', () => {
    const malformed = [
      body('@@ -1,3 +1,3 @@', '-a'), // jsdiff throws
      body('@@ nonsense @@', '-a'), // jsdiff throws
      'total garbage\n', // jsdiff returns [{hunks: []}]
      '+++ b/content\n@@ -1 +1 @@\n-a\n+b\n', // no --- header
      ' ￿',
    ]
    for (const payload of malformed) {
      expectHalt(applyPatchPayload('a\n', payload), 'malformed-payload', JSON.stringify(payload))
    }
  })

  it('does not treat "--- " embedded mid-line as a header (Step-5 pin)', () => {
    // The header check is anchored per line.^--- ` only mid-line must not count:
    // without the anchor, garbage containing an indented diff header reads as valid input.
    const payload = 'prose that mentions\n--- a/content@@ -1,1 +1,1 @@\n-x\n+y\n'
    const result = applyPatchPayload('a\n', 'x --- y\nno header block here\n')
    expectHalt(result, 'malformed-payload')
    if (result.status === 'halt') {
      expect(result.detail).toBe('payload has no "--- a/content" header line')
      expect(result.hunkIndex).toBeNull()
    }
  })

  it('cites H1 on every halt', () => {
    for (const c of REGRESSIONS.filter((r) => r.expect.status === 'halt')) {
      const result = applyPatchPayload(c.content, c.payload)
      if (result.status !== 'halt') expect.fail(`${c.name} did not halt`)
      expect(
        result.issues.map((i) => i.code),
        c.name,
      ).toContain('H1')
    }
  })

  it('never marks a halt or a limit as error severity', () => {
    // Severity means "the event is invalid and MUST NOT be rendered". Neither a HALT nor a ceiling
    // makes an event invalid: TR-1 forbids an A-layer rule rejecting a V-valid event, and §5.4 says
    // so outright for RL-3. The status discriminant carries the weight instead.
    const halted = applyPatchPayload('q\n', body('@@ -1,1 +1,1 @@', '-absent', '+x'))
    const limited = applyPatchPayload('a\n', body('@@ -1,1 +1,1 @@', '-a', '+b'), { maxHunks: 0 })
    for (const r of [halted, limited]) {
      if (r.status === 'halt' || r.status === 'limit') {
        expect(r.issues.every((i) => i.severity === 'warning')).toBe(true)
      }
    }
  })
})

describe('F5 / C8 — a payload with two header blocks (multiple file-sections)', () => {
  it('sequences every parsed hunk under T3 rather than dropping any', () => {
    const payload = `${body('@@ -1,1 +1,1 @@', '-a', '+A')}${body('@@ -2,1 +2,1 @@', '-b', '+B')}`
    const result = applyPatchPayload('a\nb\n', payload)
    expectApplied(result, 'A\nB\n')
    if (result.status === 'applied') expect(result.hunksApplied).toBe(2)
  })
})

describe('D31 / F8 — produced payloads are spec-canonical bytes', () => {
  // Step-5/Stryker pinning: the round-trip gates only require that `applyPatchPayload` can parse
  // what `makePatch` emits, and jsdiff tolerates exactly the bytes F8 strips. Nothing therefore
  // observed the producer's actual byte shape — the `===` separator strip, the `a/content` /
  // `b/content` header names, the single header pair — until these assertions. 14 mutants
  // survived here on the first mutation pass; every one of them turns on bytes, not verdicts.

  it('emits header pair, hunks, and no separator or Index preamble for a normal change', () => {
    expect(makePatch('a\nb\nc\n', 'a\nB\nc\n')).toBe(
      '--- a/content\n+++ b/content\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    )
  })

  it('emits the N2 header-only shape for identical content', () => {
    // jsdiff's producer emits 'Index: a/content\n===…===\n--- a/content\n+++ b/content\n' here;
    // F8 strips back to the header pair alone.
    expect(makePatch('a\nb\n', 'a\nb\n')).toBe('--- a/content\n+++ b/content\n')
  })

  it('emits the zero-context shape without separators at context 0', () => {
    expect(makePatch('x\ny\n', 'x\nz\n', 0)).toBe(
      '--- a/content\n+++ b/content\n@@ -2,1 +2,1 @@\n-y\n+z\n',
    )
  })
})

// `makePatch(a, b, 0)` gives a hunk whose pattern is exactly its removed lines. Zero context is
// what a hand-written or minimising producer emits, and the shape under which T1 ambiguity stops
// being rare — see the comment on the property below.
describe('T1 under zero-context patches', () => {
  // The round-trip gate barely exercises T1's ambiguous branch: makePatch emits three context
  // lines, and a seven-line pattern almost never repeats — measured at 6 halts per 2000 pairs.
  // Zero context over repeat-heavy content is where ambiguity is the common case, so the branch
  // gets its own property rather than being nominally covered by the gate.
  it('either applies correctly or halts, and reaches both outcomes often', () => {
    const seen = { applied: 0, halt: 0, noop: 0, limit: 0 }
    fc.assert(
      fc.property(repeatyContent, repeatyContent, (a, b) => {
        const result = applyPatchPayload(a, makePatch(a, b, 0))
        seen[result.status]++
        if (result.status === 'applied' && result.content !== b) {
          expect(result.content, JSON.stringify({ a, b })).toBe(b)
        }
      }),
      { numRuns: 5_000 },
    )
    console.log(`zero-context outcomes: ${JSON.stringify(seen)}`)
    expect(seen.applied).toBeGreaterThan(0)
    expect(seen.halt, 'zero-context patches must exercise the T1 halt path').toBeGreaterThan(50)
  })
})

describe('conformance vectors — application.json, kind: apply (Appendix G)', () => {
  const vectors = loadVectors()
  it('loads cleanly, and skips when the corpus is absent', () => {
    // Vendored in fix/spec-v061-drift (D33). Still asserts the loader's own contract rather than a
    // count, so a future absent-corpus run (a fresh checkout before vendoring) stays green too.
    expect(Array.isArray(vectors)).toBe(true)
  })
  for (const v of vectors) {
    it(`${v.file} parses`, () => {
      expect(v.data).toBeDefined()
    })
  }

  const applyCases = vectorCases<ApplyCase>(vectors, 'application.json').filter(
    (c) => c.kind === 'apply',
  )
  for (const c of applyCases) {
    it(`${c.name} (${c.rule})`, () => {
      const result = applyPatchPayload(c.content, c.payload, c.options)
      expect(result.status, c.why).toBe(c.expect.outcome)
      // G.3: halt reasons are advisory, never asserted for equality. Only `applied` content is
      // normative.
      if (c.expect.outcome === 'applied' && result.status === 'applied') {
        expect(result.content, c.why).toBe(c.expect.content)
      }
    })
  }
})
