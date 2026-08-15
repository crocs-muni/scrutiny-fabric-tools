/**
 * The Phase 6 gate, items BQ-3/BQ-4/BQ-5 (`#39` §5) plus unit coverage for the
 * non-Patch builders.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildBinding,
  buildMetadata,
  buildPatch,
  buildProduct,
  fenceLength,
  fencePatchPayload,
} from '../src/build.js'
import { diffHunks, occurrences, toLines, widenContext } from '../src/patch-matcher.js'
import { applyPatchContent } from '../src/patch.js'
import { findFencedBlocks } from '../src/validate.js'
import { VERSION_TAG } from '../src/version.js'
import { ambiguousPatchPair } from './_a-build-coverage.js'
import { distinctPair, repeatyContent } from './_generators.js'

const ROOT: import('../src/build.js').EndpointRef = { id: 'a'.repeat(64) }
const REPLY: import('../src/build.js').EndpointRef = { id: 'b'.repeat(64) }

describe('buildProduct / buildMetadata', () => {
  it('emits the base tags and no id/pubkey/sig (D13)', () => {
    const { template, issues } = buildProduct('A product.', 1714000000)
    expect(template).toEqual({
      kind: 1,
      created_at: 1714000000,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', VERSION_TAG],
        ['t', 'scrutiny-product'],
      ],
      content: 'A product.',
    })
    expect(issues).toEqual([])
    expect(template).not.toHaveProperty('id')
    expect(template).not.toHaveProperty('pubkey')
    expect(template).not.toHaveProperty('sig')
  })

  it('derives k tags from the distinct i-tag prefixes, never hand-supplied separately (PR-4/MD-4)', () => {
    const { template } = buildMetadata('CVE-2017-15361 (ROCA).', 1714000010, [
      'cve:CVE-2017-15361',
      'cwe:CWE-310',
    ])
    expect(template.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-metadata'],
      ['i', 'cve:CVE-2017-15361'],
      ['i', 'cwe:CWE-310'],
      ['k', 'cve'],
      ['k', 'cwe'],
    ])
  })

  it('a malformed indexer is still tagged as i, but derives no k for it', () => {
    const { template } = buildProduct('x', 1, ['not-a-valid-indexer'])
    expect(template.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-product'],
      ['i', 'not-a-valid-indexer'],
    ])
  })
})

describe('buildBinding', () => {
  it('emits root/link e tags in §4.3’s exact shape', () => {
    const { template, issues } = buildBinding(
      { id: 'aaa111', relay: 'wss://relay.example', authorHint: 'vendor_pk' },
      { id: 'bbb222', authorHint: 'researcher_pk' },
      'Vulnerability: ROCA affects this chip.',
      1714000020,
    )
    expect(template.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', VERSION_TAG],
      ['t', 'scrutiny-binding'],
      ['e', 'aaa111', 'wss://relay.example', 'root', 'vendor_pk'],
      ['e', 'bbb222', '', 'link', 'researcher_pk'],
    ])
    expect(issues).toEqual([])
  })

  it('omitted relay/authorHint become "" (BD-8/BD-12 advisory, not required)', () => {
    const { template } = buildBinding({ id: 'r' }, { id: 'l' }, 'edge', 1)
    expect(template.tags[3]).toEqual(['e', 'r', '', 'root', ''])
    expect(template.tags[4]).toEqual(['e', 'l', '', 'link', ''])
  })
})

describe('fenceLength (E4)', () => {
  it('is 3 for a payload with no backticks', () => {
    expect(fenceLength('--- a/content\n+++ b/content\n')).toBe(3)
  })

  it('is max(3, N+1) for an embedded run', () => {
    expect(fenceLength('```\n')).toBe(4)
    expect(fenceLength('````\n')).toBe(5)
    expect(fenceLength('``\n')).toBe(3) // N=2 → max(3,3)=3
  })
})

describe('BQ-3 — fencePatchPayload round-trips through the real consumer-side parser', () => {
  const SAFE = fc
    .array(fc.constantFrom('x', 'y', 'z', ' ', '_'), { maxLength: 10 })
    .map((chars) => chars.join(''))
  const runLength = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(2, 3, 4) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 6 }) },
  )

  it('computes exactly max(3, k+1) and never closes early on an embedded k-run', () => {
    fc.assert(
      fc.property(runLength, SAFE, SAFE, (k, pre, post) => {
        const payload = `--- a/content\n+++ b/content\n@@ -1 +1 @@\n-old\n+${pre}${'`'.repeat(k)}${post}\n`
        expect(fenceLength(payload)).toBe(Math.max(3, k + 1))

        const content = fencePatchPayload(payload)
        const blocks = findFencedBlocks(content)
        expect(blocks).toHaveLength(1)
        expect(blocks[0]?.fenceChar).toBe('`')
        expect(blocks[0]?.closed).toBe(true)
        expect(blocks[0]?.payload).toBe(payload)
      }),
      { numRuns: 2_000 },
    )
  })
})

describe('BQ-4/BQ-5 — buildPatch’s P4 self-check and round trip', () => {
  it('reports no issue and round-trips over an unambiguous pair', () => {
    fc.assert(
      fc.property(distinctPair, ({ a, b }) => {
        const { template, issues } = buildPatch({
          root: ROOT,
          reply: REPLY,
          before: a,
          after: b,
          createdAt: 1,
        })
        expect(issues).toEqual([])
        const check = applyPatchContent(a, template.content)
        const reproduced =
          check.status === 'applied' || check.status === 'noop' ? check.content : undefined
        expect(reproduced).toBe(b)
      }),
      { numRuns: 2_000 },
    )
  })

  it('reports a P4 warning, built directly, when widening budget is already spent', () => {
    // ambiguousPatchPair (shared with _a-build-coverage.ts's own P4 emission) is built directly, not
    // sampled. Post-Phase-18 the ambiguity itself no longer reaches P4 — the widening loop resolves
    // context 1 to a unique window by §2.3's length argument. P4 is therefore reached exactly as
    // #42 §6 says it can be: through the maxWidenWork ceiling. A zero budget makes
    // the very first widening trial exhausted, so the genuinely-ambiguous payload falls through to
    // the existing P4 self-check, wording unchanged.
    const { before, after } = ambiguousPatchPair()
    const { template, issues } = buildPatch({
      root: ROOT,
      reply: REPLY,
      before,
      after,
      createdAt: 1,
      context: 3,
      maxWidenWork: 0,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('P4')
    expect(issues[0]?.severity).toBe('warning') // TR-1: P4 is A-layer, never `error`
    // The template is still returned — a SHOULD, not a rejection (D34/TR-1).
    expect(template.content.length).toBeGreaterThan(0)
  })

  it('is a no-op, with no P4 issue, whenever before === after', () => {
    fc.assert(
      fc.property(repeatyContent, (content) => {
        const { issues } = buildPatch({
          root: ROOT,
          reply: REPLY,
          before: content,
          after: content,
          createdAt: 1,
        })
        expect(issues).toEqual([])
      }),
      { numRuns: 500 },
    )
  })

  it('threads the context parameter through to makePatch (P1)', () => {
    const { template } = buildPatch({
      root: ROOT,
      reply: REPLY,
      before: 'a\nb\nc\nd\ne\n',
      after: 'a\nb\nC\nd\ne\n',
      createdAt: 1,
      context: 0,
    })
    expect(template.content).toContain('-c')
    expect(template.content).toContain('+C')
    // Zero context: no unchanged lines carried alongside the hunk.
    expect(template.content).not.toContain('\n a\n')
  })
})

describe('Phase 18 — producer-side context widening (#42)', () => {
  it('§5’s worked example resolves at context 4, and buildPatch emits no issue', () => {
    // 17 lines, the same pair the mini-spec traces: two identical `c1/c2/c3/old/c1/c2/c3` windows
    // around the two `old` tokens; only the first is edited.
    const lines = [
      'head',
      'c1',
      'c2',
      'c3',
      'old',
      'c1',
      'c2',
      'c3',
      'mid',
      'c1',
      'c2',
      'c3',
      'old',
      'c1',
      'c2',
      'c3',
      'tail',
    ]
    const before = `${lines.join('\n')}\n`
    const afterLines = before.split('\n')
    afterLines[4] = 'new' // §5: "line 5's `old` becomes `new`" (1-indexed)
    const after = afterLines.join('\n')

    const res = widenContext(before, after, 3, 1 << 20)
    expect(res.context).toBe(4)
    expect(res.exhausted).toBe(false)

    const { issues } = buildPatch({ root: ROOT, reply: REPLY, before, after, createdAt: 1 })
    expect(issues).toEqual([]) // no P4 — the unwidened pipeline would have warned here
  })

  it('ceiling: the search stops at maxWidenWork before fullContext, with the unchanged P4 fallback', () => {
    // §2.3 proves full-file context always resolves, so exhaustion is reachable only through the
    // ceiling: blank-line-heavy content at a tiny budget stops on the first trial's own scan cost
    // (F12's per-element floor — a byte-charged ceiling would not see this scan at all).
    const before = `${Array.from({ length: 600 }, () => 'x').join('\n')}\n`
    const afterLines = before.split('\n')
    afterLines[300] = 'y'
    const after = afterLines.join('\n')

    const res = widenContext(before, after, 3, 100)
    expect(res.exhausted).toBe(true)
    expect(res.context).toBeLessThan(600)

    const { template, issues } = buildPatch({
      root: ROOT,
      reply: REPLY,
      before,
      after,
      createdAt: 1,
      context: 3,
      maxWidenWork: 100,
    })
    expect(template.content.length).toBeGreaterThan(0) // always returned — P4 is a SHOULD (TR-1)
    const p4 = issues.filter((i) => i.code === 'P4')
    expect(p4).toHaveLength(1)
    expect(p4[0]?.message.startsWith('self-verification failed before publishing')).toBe(true)
    expect(p4[0]?.severity).toBe('warning')
  })

  it('§2.2 regression: a first hunk whose replacement duplicates a later hunk’s pattern is not declared unique early', () => {
    // Edit 1 replaces two lines with three that spell out edit 2's own surroundings ('B','w','k');
    // edit 2 changes line 8 'w' → 'W'. Three unchanged lines keep the edits in separate hunks at
    // context 1 (gap must exceed 2 × context to avoid jsdiff merging them). Against the static
    // pre-patch lines, both patterns occur exactly once — the check §2.2 exists to defeat would
    // report "resolved".
    const before = `${['u', 'A1', 'A2', 'g1', 'g2', 'g3', 'B', 'w', 'k', 'e'].join('\n')}\n`
    const after = `${['u', 'B', 'w', 'k', 'g1', 'g2', 'g3', 'B', 'W', 'k', 'e'].join('\n')}\n`

    const hunksAt1 = diffHunks(before, after, 1)
    expect(hunksAt1.length).toBeGreaterThanOrEqual(2)
    const beforeLines = toLines(before)
    const staticVerdict = hunksAt1.every(
      (h) => h.oldPat.length === 0 || occurrences(beforeLines, h.oldPat).count === 1,
    )
    expect(staticVerdict).toBe(true) // i.e. the unthreaded check would have reported resolved

    // The T3-threaded truth: after splicing hunk 1, hunk 2's pattern occurs twice — the trial widens.
    const res = widenContext(before, after, 1, 1 << 20)
    expect(res.exhausted).toBe(false)
    expect(res.context).toBeGreaterThan(1)

    const { issues } = buildPatch({ root: ROOT, reply: REPLY, before, after, createdAt: 1 })
    expect(issues.filter((i) => i.code === 'P4')).toEqual([])
  })
})
