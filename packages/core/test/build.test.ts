/**
 * The Phase 6 gate, items BQ-3/BQ-4/BQ-5 (`docs/QUERY-BUILD.md` §5) plus unit coverage for the
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
import { applyPatchContent } from '../src/patch.js'
import { findFencedBlocks } from '../src/validate.js'
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
        ['t', 'scrutiny-v061'],
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
      ['t', 'scrutiny-v061'],
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
      ['t', 'scrutiny-v061'],
      ['t', 'scrutiny-product'],
      ['i', 'not-a-valid-indexer'],
    ])
  })
})

describe('buildBinding', () => {
  it('emits root/link e tags in §4.3’s exact shape', () => {
    const { template, issues } = buildBinding(
      { id: 'aaa111', relay: 'wss://relay.example', authorPubkey: 'vendor_pk' },
      { id: 'bbb222', authorPubkey: 'researcher_pk' },
      'Vulnerability: ROCA affects this chip.',
      1714000020,
    )
    expect(template.tags).toEqual([
      ['t', 'scrutiny-fabric'],
      ['t', 'scrutiny-v061'],
      ['t', 'scrutiny-binding'],
      ['e', 'aaa111', 'wss://relay.example', 'root', 'vendor_pk'],
      ['e', 'bbb222', '', 'link', 'researcher_pk'],
    ])
    expect(issues).toEqual([])
  })

  it('omitted relay/authorPubkey become "" (BD-8/BD-12 advisory, not required)', () => {
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
        const { template, issues } = buildPatch(ROOT, REPLY, a, b, 1)
        expect(issues).toEqual([])
        const check = applyPatchContent(a, template.content)
        const reproduced =
          check.status === 'applied' || check.status === 'noop' ? check.content : undefined
        expect(reproduced).toBe(b)
      }),
      { numRuns: 2_000 },
    )
  })

  it('reports a P4 warning, built directly, when the hunk is genuinely ambiguous in "before"', () => {
    // ambiguousPatchPair (shared with _a-build-coverage.ts's own P4 emission) is built directly, not
    // sampled — verified against patch.ts before this case existed, per its own doc comment.
    const { before, after } = ambiguousPatchPair()
    const { template, issues } = buildPatch(ROOT, REPLY, before, after, 1)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('P4')
    expect(issues[0]?.severity).toBe('warning') // TR-1: P4 is A-layer, never `error`
    // The template is still returned — a SHOULD, not a rejection (D34/TR-1).
    expect(template.content.length).toBeGreaterThan(0)
  })

  it('is a no-op, with no P4 issue, whenever before === after', () => {
    fc.assert(
      fc.property(repeatyContent, (content) => {
        const { issues } = buildPatch(ROOT, REPLY, content, content, 1)
        expect(issues).toEqual([])
      }),
      { numRuns: 500 },
    )
  })

  it('threads the context parameter through to makePatch (P1)', () => {
    const { template } = buildPatch(ROOT, REPLY, 'a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n', 1, 0)
    expect(template.content).toContain('-c')
    expect(template.content).toContain('+C')
    // Zero context: no unchanged lines carried alongside the hunk.
    expect(template.content).not.toContain('\n a\n')
  })
})
