import { describe, expect, it } from 'vitest'
import { validateEvent } from '../src/validate.js'
import {
  MINIMAL_PAYLOAD,
  PK_FOREIGN,
  PK_OTHER,
  PK_ROOT,
  baseTags,
  binding,
  codesOf,
  ev,
  fenced,
  lookup,
  metadata,
  patch,
  product,
} from './_fixtures.js'

describe('scope (§3)', () => {
  it('reports a plain Nostr event as out of scope, not invalid', () => {
    // §3: events without the fabric tag are not SCRUTINY events at all. Calling them invalid
    // would misattribute a scope boundary as a defect.
    expect(validateEvent(ev({ content: 'just a note' })).status).toBe('not-scrutiny')
  })

  it('accepts a well-formed Product', () => {
    const result = validateEvent(product())
    expect(result.status).toBe('valid')
  })
})

describe('§3 tag invariants', () => {
  it('rejects a duplicated fabric tag (TAG-1)', () => {
    const e = product({ tags: [...baseTags('product'), ['t', 'scrutiny-fabric']] })
    expect(codesOf(e)).toContain('TAG-1')
  })

  it('rejects a missing or duplicated version tag (TAG-2)', () => {
    expect(
      codesOf(
        product({
          tags: [
            ['t', 'scrutiny-fabric'],
            ['t', 'scrutiny-product'],
          ],
        }),
      ),
    ).toContain('TAG-2')
    expect(
      codesOf(product({ tags: [...baseTags('product'), ['t', 'scrutiny-v0.6.1']] })),
    ).toContain('TAG-2')
  })

  it('rejects zero or several event-type tags (TAG-3)', () => {
    expect(
      codesOf(product({ tags: [...baseTags('product'), ['t', 'scrutiny-metadata']] })),
    ).toContain('TAG-3')
  })

  it('warns on the underscored variant that killed the previous implementation (TAG-4)', () => {
    const e = product({ tags: [...baseTags('product'), ['t', 'scrutiny_v032']] })
    expect(codesOf(e)).toContain('TAG-4')
  })

  it('ignores unknown tags rather than rejecting them (TAG-5)', () => {
    const e = product({
      tags: [...baseTags('product'), ['nonce', '9000'], ['zzz', 'whatever'], ['t', 'other-topic']],
    })
    expect(validateEvent(e).status).toBe('valid')
  })
})

describe('version handling (§3)', () => {
  it('admits a higher-version event that still satisfies every V invariant (VER-2, VER-4)', () => {
    // The failure this guards is the dead engine's: it put the version tag into the relay filter
    // and silently dropped every higher-version event, violating VER-4 invisibly.
    const e = product({
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', 'scrutiny-v0.99.0'],
        ['t', 'scrutiny-product'],
      ],
    })
    const result = validateEvent(e)
    expect(result.status).toBe('valid')
    expect(codesOf(e)).not.toContain('VER-3')
  })

  it('refuses to render a higher-version event whose type it cannot recognise (VER-3)', () => {
    const e = ev({
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', 'scrutiny-v0.99.0'],
        ['t', 'scrutiny-attestation'],
      ],
    })
    const codes = codesOf(e)
    expect(codes).toContain('VER-3')
    expect(codes).toContain('TAG-3')
    expect(validateEvent(e).status).toBe('invalid')
  })

  it('does not emit VER-3 for a same-or-lower version with an unrecognised type', () => {
    const e = ev({
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', 'scrutiny-v0.6.1'],
        ['t', 'scrutiny-attestation'],
      ],
    })
    expect(codesOf(e)).not.toContain('VER-3')
  })
})

describe('§4.1 / §4.2 Product and Metadata', () => {
  it('requires content (PR-1, MD-1)', () => {
    expect(codesOf(product({ content: undefined as unknown as string }))).toContain('PR-1')
    expect(codesOf(metadata({ content: undefined as unknown as string }))).toContain('MD-1')
  })

  it('warns past 64 i or k tags without rejecting (PR-2, PR-3)', () => {
    const many = Array.from({ length: 65 }, (_, n) => ['i', `cve:CVE-${n}`])
    const e = product({ tags: [...baseTags('product'), ...many, ['k', 'cve']] })
    const result = validateEvent(e)
    expect(codesOf(e)).toContain('PR-2')
    expect(result.status).toBe('valid')
  })

  it('warns when a k tag is missing for a present i prefix (PR-4, MD-4)', () => {
    const e = product({ tags: [...baseTags('product'), ['i', 'cve:CVE-1']] })
    expect(codesOf(e)).toContain('PR-4')
    expect(validateEvent(e).status).toBe('valid')
  })

  it('rejects an i tag whose prefix is not lowercase ASCII (IR-1)', () => {
    expect(codesOf(product({ tags: [...baseTags('product'), ['i', 'CVE:CVE-1']] }))).toContain(
      'IR-1',
    )
    expect(codesOf(product({ tags: [...baseTags('product'), ['i', 'nocolon']] }))).toContain('IR-1')
  })

  it('accepts unregistered i prefixes (IR-4)', () => {
    const e = product({
      tags: [
        ...baseTags('product'),
        ['i', 'cc-cert-id:BSI-DSZ-CC-0814-2012'],
        ['k', 'cc-cert-id'],
        ['i', 'pp:BSI-CC-PP-0084'],
        ['k', 'pp'],
      ],
    })
    expect(validateEvent(e).status).toBe('valid')
  })
})

describe('§4.3 Binding', () => {
  const p = product()
  const m = metadata({ pubkey: PK_FOREIGN })

  it('accepts a correctly typed Binding once both endpoints are observed', () => {
    const b = binding(p.id, m.id)
    expect(validateEvent(b, lookup(p, m)).status).toBe('valid')
  })

  it('holds a Binding pending while an endpoint is unobserved, without rejecting it (BD-6)', () => {
    const b = binding(p.id, m.id)
    const result = validateEvent(b, lookup(p))
    expect(result.status).toBe('pending')
    if (result.status === 'pending') expect(result.awaiting).toEqual([m.id])
    expect(codesOf(b, lookup(p))).toContain('BD-6')
  })

  it('holds pending when no observed set is supplied at all', () => {
    expect(validateEvent(binding(p.id, m.id)).status).toBe('pending')
  })

  it('requires exactly one e root and one e link (BD-1, BD-2, BD-10)', () => {
    const noRoot = ev({ tags: [...baseTags('binding'), ['e', m.id, '', 'link', PK_FOREIGN]] })
    expect(codesOf(noRoot)).toContain('BD-1')

    const noLink = ev({ tags: [...baseTags('binding'), ['e', p.id, '', 'root', PK_ROOT]] })
    expect(codesOf(noLink)).toContain('BD-2')

    const twoRoots = binding(p.id, m.id, [['e', p.id, '', 'root', PK_ROOT]])
    expect(codesOf(twoRoots)).toContain('BD-10')
  })

  it('rejects a Binding whose root endpoint is not a Product (BD-3, BD-5, BD-7)', () => {
    const b = binding(m.id, m.id)
    const codes = codesOf(b, lookup(m))
    expect(codes).toContain('BD-3')
    expect(codes).toContain('BD-5')
    expect(codes).toContain('BD-7')
    expect(validateEvent(b, lookup(m)).status).toBe('invalid')
  })

  it('rejects a Binding whose link endpoint is not Metadata (BD-4)', () => {
    const p2 = product()
    const b = binding(p.id, p2.id)
    expect(codesOf(b, lookup(p, p2))).toContain('BD-4')
  })

  it('does not invalidate a Binding over an author-hint mismatch (BD-12)', () => {
    const b = ev({
      tags: [
        ...baseTags('binding'),
        ['e', p.id, '', 'root', PK_OTHER],
        ['e', m.id, '', 'link', PK_FOREIGN],
      ],
    })
    const result = validateEvent(b, lookup(p, m))
    expect(codesOf(b, lookup(p, m))).toContain('BD-12')
    expect(result.status).toBe('valid')
  })
})

describe('§4.4 Patch', () => {
  const root = product()

  it('accepts a root-author patch carrying a conformant payload', () => {
    const e = patch(root.id, root.id, fenced(MINIMAL_PAYLOAD))
    expect(validateEvent(e, lookup(root)).status).toBe('valid')
  })

  it('accepts a prose-only patch as a no-op (E7, N1)', () => {
    const e = patch(root.id, root.id, 'Deprecating this entry. No content change.')
    expect(validateEvent(e, lookup(root)).status).toBe('valid')
  })

  it('requires exactly one e root and one e reply (PT-1, PT-2)', () => {
    const noRoot = ev({ tags: [...baseTags('patch'), ['e', root.id, '', 'reply', PK_ROOT]] })
    expect(codesOf(noRoot)).toContain('PT-1')

    const noReply = ev({ tags: [...baseTags('patch'), ['e', root.id, '', 'root', PK_ROOT]] })
    expect(codesOf(noReply)).toContain('PT-2')
  })

  it('holds a patch pending while its root is unobserved, and never caches that (UR-2, UR-3)', () => {
    // Without the root's pubkey the patch cannot be classified as root-author or foreign at all,
    // so discarding it would break confluence: the same event set would yield different state
    // depending on delivery order.
    const e = patch(root.id, root.id, fenced(MINIMAL_PAYLOAD))
    const result = validateEvent(e)
    expect(result.status).toBe('pending')
    if (result.status === 'pending') expect(result.awaiting).toEqual([root.id])
  })

  it('rejects overlay-to-overlay reply (PT-7)', () => {
    const overlay = patch(root.id, root.id, '', { pubkey: PK_FOREIGN })
    const second = patch(root.id, overlay.id, '', { pubkey: PK_OTHER })
    expect(codesOf(second, lookup(root, overlay))).toContain('PT-7')
  })

  it('allows a foreign patch replying to the root or to a root-author patch', () => {
    const rootAuthored = patch(root.id, root.id, '', { pubkey: PK_ROOT })
    const toRoot = patch(root.id, root.id, '', { pubkey: PK_FOREIGN })
    const toRootAuthored = patch(root.id, rootAuthored.id, '', { pubkey: PK_FOREIGN })

    expect(validateEvent(toRoot, lookup(root, rootAuthored)).status).toBe('valid')
    expect(validateEvent(toRootAuthored, lookup(root, rootAuthored)).status).toBe('valid')
  })

  it('does not apply PT-7 to a root-author patch, whose lineage is PT-6 at the A layer', () => {
    const foreign = patch(root.id, root.id, '', { pubkey: PK_FOREIGN })
    const rootAuthorReplyingToForeign = patch(root.id, foreign.id, '', { pubkey: PK_ROOT })
    expect(codesOf(rootAuthorReplyingToForeign, lookup(root, foreign))).not.toContain('PT-7')
  })
})
