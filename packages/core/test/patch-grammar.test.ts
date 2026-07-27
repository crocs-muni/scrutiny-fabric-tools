import { describe, expect, it } from 'vitest'
import { findPatchPayload } from '../src/validate.js'
import { validateEvent } from '../src/validate.js'
import { MINIMAL_PAYLOAD, codesOf, fenced, lookup, patch, product } from './_fixtures.js'

const root = product()
const opts = lookup(root)

/** Validate a patch event whose content is `content`. */
function check(content: string) {
  return validateEvent(patch(root.id, root.id, content), opts)
}
function codes(content: string) {
  return codesOf(patch(root.id, root.id, content), opts)
}

// ---------------------------------------------------------------------------
// C7 — a conforming consumer MUST accept anything matching the consumer grammar.
//
// C7 is satisfied by the ABSENCE of an error, so it can never emit a rule code. These are the
// shapes most likely to be rejected by an over-eager implementation. Coverage for C7 comes from
// this block plus the vectors, not from an emitted code (D34 bucket 2).
//
// Known limit: these prove acceptance of the shapes considered here, not of every payload the
// grammar admits. A generated grammar-conformance property test is a Phase 2 gate item.
// ---------------------------------------------------------------------------
describe('C7 — payloads that MUST be accepted', () => {
  const accepted: Array<[string, string]> = [
    ['header-only, zero hunks (N2, C7)', ['--- a/content', '+++ b/content'].join('\n')],
    ['zero-context hunk (T2 shape, and what git emits for short content)', MINIMAL_PAYLOAD],
    [
      'Index: preamble (C3)',
      [
        'Index: content',
        '===================================================',
        MINIMAL_PAYLOAD,
      ].join('\n'),
    ],
    ['diff --git line (C4)', ['diff --git a/content b/content', MINIMAL_PAYLOAD].join('\n')],
    [
      'trailing timestamps on the header lines (C2)',
      [
        '--- a/content\t2026-07-27 12:00:00.000000000 +0200',
        '+++ b/content\t2026-07-27 12:05:00.000000000 +0200',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    ],
    [
      'trailing data on the @@ line (C2)',
      ['--- a/content', '+++ b/content', '@@ -1 +1 @@ function foo()', '-old', '+new'].join('\n'),
    ],
    [
      'non-ASCII in hunk lines — the spec grammar rejects this, see F3',
      [
        '--- a/content',
        '+++ b/content',
        '@@ -1 +1 @@',
        '-Infineon M7794A12 — smartcard chip',
        '+Infineon M7794A12 — Rev B',
      ].join('\n'),
    ],
    [
      'context lines containing spaces — also rejected by the literal grammar, F3',
      [
        '--- a/content',
        '+++ b/content',
        '@@ -1,3 +1,3 @@',
        ' first line with spaces',
        '-second line here',
        '+second line changed',
        ' third line with spaces',
      ].join('\n'),
    ],
    [
      'no-newline-at-eof marker (C5)',
      [
        '--- a/content',
        '+++ b/content',
        '@@ -1 +1 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
      ].join('\n'),
    ],
    [
      'several hunks (T3 shape)',
      [
        '--- a/content',
        '+++ b/content',
        '@@ -1 +1 @@',
        '-a',
        '+A',
        '@@ -10 +10 @@',
        '-b',
        '+B',
      ].join('\n'),
    ],
  ]

  for (const [name, payload] of accepted) {
    it(`accepts ${name}`, () => {
      const result = check(fenced(payload))
      expect(result.status, JSON.stringify(codes(fenced(payload)))).toBe('valid')
    })
  }
})

// ---------------------------------------------------------------------------
// E1–E6 — envelope
// ---------------------------------------------------------------------------
describe('envelope (§5.2 E1–E6)', () => {
  it('matches info strings case-insensitively and ignores extra tokens (E2)', () => {
    for (const info of ['diff', 'patch', 'DIFF', 'Diff', 'diff highlight=true']) {
      expect(findPatchPayload(fenced(MINIMAL_PAYLOAD, info)), info).toBeDefined()
    }
  })

  it('does not treat a non-diff fenced block as a payload (E2, E7)', () => {
    expect(findPatchPayload(fenced('some code', 'ts'))).toBeUndefined()
    expect(check(fenced('some code', 'ts')).status).toBe('valid')
  })

  it('takes the payload as exactly the bytes between the fences, LF-terminated (E5)', () => {
    const content = `Prose above.\n\n${fenced(MINIMAL_PAYLOAD)}\n\nProse below.`
    expect(findPatchPayload(content)).toBe(`${MINIMAL_PAYLOAD}\n`)
  })

  it('takes the first matching block and treats later ones as prose (E6, PT-3)', () => {
    const second = ['--- a/content', '+++ b/content', '@@ -1 +1 @@', '-x', '+y'].join('\n')
    const content = `${fenced(MINIMAL_PAYLOAD)}\n\nQuoted example:\n\n${fenced(second)}`

    expect(findPatchPayload(content)).toBe(`${MINIMAL_PAYLOAD}\n`)
    const emitted = codes(content)
    expect(emitted).toContain('E6')
    expect(emitted).toContain('PT-3')
  })

  it('ignores a tilde-fenced diff block and says so (E1)', () => {
    const content = fenced(MINIMAL_PAYLOAD, 'diff', '~~~')
    expect(findPatchPayload(content)).toBeUndefined()
    expect(codes(content)).toContain('E1')
  })

  it('reports an unterminated payload block (E3)', () => {
    const content = `\`\`\`diff\n${MINIMAL_PAYLOAD}\n`
    expect(codes(content)).toContain('E3')
  })

  it('handles a longer fence wrapping a payload that itself contains a fence (E4 consumer side)', () => {
    // E4 requires producers to choose max(3, N+1) backticks. The consumer obligation is to match
    // the closing fence by length, so a 4-backtick block can carry a 3-backtick run.
    const payload = ['--- a/content', '+++ b/content', '@@ -1 +1 @@', '-```', '+```ts'].join('\n')
    expect(findPatchPayload(fenced(payload, 'diff', '````'))).toBe(`${payload}\n`)
  })
})

// ---------------------------------------------------------------------------
// C1, P2, P3 — the rejections
// ---------------------------------------------------------------------------
describe('rejections', () => {
  it('rejects header paths other than a/content and b/content (C1)', () => {
    const wrong = ['--- a/i', '+++ b/i', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(codes(fenced(wrong))).toContain('C1')
    expect(check(fenced(wrong)).status).toBe('invalid')
  })

  it('rejects a payload with no header block (C1)', () => {
    expect(codes(fenced('@@ -1 +1 @@\n-old\n+new'))).toContain('C1')
  })

  it('rejects a wholly empty fenced diff block (C1)', () => {
    // Not a no-op. The spec names exactly two no-op shapes: no block at all (N1) and a block with
    // valid headers and zero hunks (N2). An empty block is neither, and `header-block` is
    // mandatory in the consumer grammar, so C7's acceptance obligation does not attach to it.
    expect(codes(fenced(''))).toContain('C1')
  })

  it('rejects git index, mode and rename metadata (P2)', () => {
    const withIndex = [
      'diff --git a/content b/content',
      'index 7ebcdab..331da67 100644',
      MINIMAL_PAYLOAD,
    ].join('\n')
    expect(codes(fenced(withIndex))).toContain('P2')

    const withRename = ['similarity index 95%', 'rename from old', MINIMAL_PAYLOAD].join('\n')
    expect(codes(fenced(withRename))).toContain('P2')
  })

  it('does not mistake hunk content beginning with "index" for git metadata (P2)', () => {
    // Inside a hunk every line carries a prefix, so "+index abc..def" is content, not metadata.
    const payload = [
      '--- a/content',
      '+++ b/content',
      '@@ -1 +1 @@',
      '-index 0000000..1111111 100644',
      '+index 2222222..3333333 100644',
    ].join('\n')
    expect(codes(fenced(payload))).not.toContain('P2')
  })

  it('rejects an unpaired surrogate, which has no valid UTF-8 encoding (P3)', () => {
    const payload = ['--- a/content', '+++ b/content', '@@ -1 +1 @@', '-old', '+new\uD800'].join(
      '\n',
    )
    expect(codes(fenced(payload))).toContain('P3')
    expect(check(fenced(payload)).status).toBe('invalid')
  })

  it('accepts a correctly paired surrogate (an ordinary astral character)', () => {
    const payload = ['--- a/content', '+++ b/content', '@@ -1 +1 @@', '-old', '+new 😀'].join('\n')
    expect(codes(fenced(payload))).not.toContain('P3')
  })

  it('warns on CRLF without rejecting or normalising it (P3, PB-1)', () => {
    const payload = ['--- a/content', '+++ b/content', '@@ -1 +1 @@', '-old', '+new'].join('\r\n')
    const emitted = codes(fenced(payload))
    expect(emitted).toContain('P3')
    expect(check(fenced(payload)).status).toBe('valid')
  })

  it('does not evaluate P1 — the reference toolchain emits zero-context hunks (F1)', () => {
    // See docs/SPEC-FEEDBACK-v0.6.0.md F1. T2 normatively defines apply semantics for a
    // zero-context hunk, so rejecting one at the V layer would make T2 unreachable.
    expect(codes(fenced(MINIMAL_PAYLOAD))).not.toContain('P1')
  })
})
