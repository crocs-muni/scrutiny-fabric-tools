/**
 * emit/content.ts — shared content/tag helpers for the emit layer.
 *
 * Implements the frozen conventions of `docs/mirroring/design.md` §4.1 (template
 * rules incl. rule 2a and rule 8) and §3.7 (topic facets) plus the record-card
 * label of rule 8(c). Nothing here talks to the network or to crypto.
 *
 * The rule-2a checker in this file is a deliberate mirror of `../gate/selfConsume.js`
 * (same exemptions, same casefold + separator-insensitive matching) so the emit
 * stage fails early on the exact facts the gate would later report as lost.
 */

import type { SignedEvent } from '../types.js'

/** Rule 8(c): the canonical single-line record-card label. */
const RECORD_CARD_LABEL = 'Record card (JSON): '

/** SCRUTINY v0.8.1 event types emitted by leg 1 (patches are not part of v0). */
export type EventType = 'scrutiny-product' | 'scrutiny-metadata' | 'scrutiny-binding'

const LONG_HEX = /^[0-9a-f]{60,}$/
const TYPE_STRING = /@\d+$/
/** Prefixes whose `i` value is vocabulary (a bounded bucket), not a record fact. */
const COHORT_PREFIXES: Record<string, true> = { 'jcver-lte': true }

export class EmitRuleError extends Error {
  readonly label: string
  readonly facts: string[]
  constructor(label: string, facts: string[]) {
    super(`${label}: rule-2a violation — machine facts missing from prose: ${facts.join(', ')}`)
    this.name = 'EmitRuleError'
    this.label = label
    this.facts = facts
  }
}

export class EmitShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmitShapeError'
  }
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

/** Required `t` tags (TAG-1/TAG-2/TAG-3) plus 1..3 topic facets (§3.7). */
export function baseTags(type: EventType, facets: readonly string[]): string[][] {
  const seen = new Set<string>()
  const out: string[][] = [
    ['t', 'scrutiny-fabric'],
    ['t', type],
    ['t', 'scrutiny-v0.8.1'],
  ]
  seen.add('scrutiny-fabric')
  seen.add(type)
  seen.add('scrutiny-v0.8.1')
  for (const facet of facets) {
    if (seen.has(facet)) continue
    seen.add(facet)
    out.push(['t', facet])
  }
  return out
}

/** `i` tags from non-null values, in the order given; duplicates are dropped. */
export function iTags(values: readonly (string | null | undefined)[]): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const v of values) {
    if (v === null || v === undefined || v.length === 0) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(['i', v])
  }
  return out
}

/** `k` tags — one per distinct `i` prefix, first-seen order (§3.5). */
export function kTagsFor(iTags_: readonly string[][]): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const tag of iTags_) {
    const value = tag[1]
    if (value === undefined) continue
    const colon = value.indexOf(':')
    if (colon <= 0) continue
    const prefix = value.slice(0, colon)
    if (seen.has(prefix)) continue
    seen.add(prefix)
    out.push(['k', prefix])
  }
  return out
}

/** i-tag values (used by the shape assertion). */
function iValues(tags: readonly string[][]): string[] {
  return tags.filter((t) => t[0] === 'i' && typeof t[1] === 'string').map((t) => t[1] as string)
}

// ---------------------------------------------------------------------------
// content assembly (rule 8)
// ---------------------------------------------------------------------------

/**
 * Compose plain-text content: headline first (clients truncate — rule 8a),
 * `- ` bullets, an optional link block, and the single-line record card last
 * (rule 8c). LF only; never fenced blocks or tables (rule 8b).
 */
export function composeContent(spec: {
  headline: string
  bullets?: readonly string[]
  links?: readonly string[]
  card?: Record<string, unknown>
}): string {
  const parts: string[] = [spec.headline.replace(/\s+$/u, '')]
  const bullets = spec.bullets ?? []
  if (bullets.length > 0) {
    parts.push('')
    for (const b of bullets) parts.push(b.startsWith('- ') ? b : `- ${b}`)
  }
  const links = spec.links ?? []
  if (links.length > 0) {
    parts.push('', 'Links:')
    for (const l of links) parts.push(`- ${l}`)
  }
  if (spec.card !== undefined) {
    parts.push('', recordCardLine(spec.card))
  }
  return parts.join('\n')
}

/** Rule 8(c): `Record card (JSON): {compact single-line JSON}`. */
export function recordCardLine(card: Record<string, unknown>): string {
  return `${RECORD_CARD_LABEL}${JSON.stringify(card)}`
}

// ---------------------------------------------------------------------------
// rule 2a — machine facts must also be prose
// ---------------------------------------------------------------------------

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) collectStrings(v, out)
  }
}

function isExemptFact(value: string, prefix: string | null): boolean {
  if (value.includes('«')) return true
  if (LONG_HEX.test(value)) return true
  if (TYPE_STRING.test(value)) return true
  if (prefix !== null && COHORT_PREFIXES[prefix] === true) return true
  return false
}

/** Split content into prose (rule-2a haystack) and the parsed record card. */
function splitContent(content: string, label: string): { prose: string; card: unknown } {
  const proseLines: string[] = []
  let cardRaw: string | null = null
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(RECORD_CARD_LABEL)) {
      proseLines.push(line)
      continue
    }
    if (cardRaw !== null) {
      throw new EmitShapeError(
        `${label}: more than one '${RECORD_CARD_LABEL.trim()}' line (rule 8c)`,
      )
    }
    cardRaw = trimmed.slice(RECORD_CARD_LABEL.length)
  }
  let card: unknown = null
  if (cardRaw !== null) {
    try {
      card = JSON.parse(cardRaw)
    } catch (e) {
      throw new EmitShapeError(`${label}: record-card JSON does not parse: ${(e as Error).message}`)
    }
  }
  return { prose: proseLines.join('\n'), card }
}

/** Facts present in the record card / `i` tags but missing from prose (rule 2a). */
export function lostFacts(content: string, tags: readonly string[][], label: string): string[] {
  const { prose, card } = splitContent(content, label)
  const facts: Array<{ fact: string; prefix: string | null }> = []
  if (card !== null) {
    const strings: string[] = []
    collectStrings(card, strings)
    for (const s of strings) {
      if (s.length >= 4) facts.push({ fact: s, prefix: null })
    }
  }
  for (const tag of tags) {
    if (tag[0] !== 'i') continue
    const value = tag[1]
    if (typeof value !== 'string') continue
    const colon = value.indexOf(':')
    if (colon <= 0) continue
    facts.push({ fact: value.slice(colon + 1), prefix: value.slice(0, colon) })
  }

  const haystack = prose.toLowerCase()
  const haystackLoose = haystack.replace(/[^a-z0-9]+/g, '')
  const lost: string[] = []
  const reported = new Set<string>()
  for (const { fact, prefix } of facts) {
    if (isExemptFact(fact, prefix)) continue
    const needle = fact.toLowerCase()
    if (haystack.includes(needle)) continue
    const needleLoose = needle.replace(/[^a-z0-9]+/g, '')
    if (needleLoose.length > 0 && haystackLoose.includes(needleLoose)) continue
    if (reported.has(fact)) continue
    reported.add(fact)
    lost.push(fact)
  }
  return lost
}

/** Fail early on rule-2a violations (brief: "throw on violation"). */
export function assertRule2a(event: { content: string; tags: string[][] }, label: string): void {
  const missing = lostFacts(event.content, event.tags, label)
  if (missing.length > 0) throw new EmitRuleError(label, missing)
}

/** Structural invariants shared by every emitted event (gate re-checks these). */
export function assertEventShape(
  event: { content: string; tags: string[][] },
  label: string,
): void {
  const t = event.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1])
  const types = t.filter(
    (v) => v === 'scrutiny-product' || v === 'scrutiny-metadata' || v === 'scrutiny-binding',
  )
  if (t.filter((v) => v === 'scrutiny-fabric').length !== 1)
    throw new EmitShapeError(`${label}: expected exactly one scrutiny-fabric tag`)
  if (t.filter((v) => v === 'scrutiny-v0.8.1').length !== 1)
    throw new EmitShapeError(`${label}: expected exactly one scrutiny-v0.8.1 tag`)
  if (types.length !== 1)
    throw new EmitShapeError(`${label}: expected exactly one event-type tag, found ${types.length}`)
  const is = iValues(event.tags)
  if (is.length > 64) throw new EmitShapeError(`${label}: ${is.length} i tags exceeds the 64 cap`)
  const kSet = new Set(event.tags.filter((tag) => tag[0] === 'k').map((tag) => tag[1]))
  for (const value of is) {
    const colon = value.indexOf(':')
    if (colon <= 0)
      throw new EmitShapeError(`${label}: i value has no kebab prefix: ${JSON.stringify(value)}`)
    const prefix = value.slice(0, colon)
    if (!kSet.has(prefix)) throw new EmitShapeError(`${label}: k set misses i prefix '${prefix}'`)
  }
  if (event.content.trim().length === 0) throw new EmitShapeError(`${label}: empty content`)
}

// ---------------------------------------------------------------------------
// vocabulary helpers
// ---------------------------------------------------------------------------

/** Human-readable labels for the closed alg family list (§3.4). */
export const FAMILY_LABELS: Readonly<Record<string, string>> = {
  'ml-kem': 'ML-KEM',
  'ml-dsa': 'ML-DSA',
  'slh-dsa': 'SLH-DSA',
  lms: 'LMS',
  xmss: 'XMSS',
  falcon: 'Falcon',
  ecdsa: 'ECDSA',
  ecdh: 'ECDH',
  eddsa: 'EdDSA',
  rsa: 'RSA',
  aes: 'AES',
  '3des': '3DES',
  'sha-2': 'SHA-2',
  'sha-3': 'SHA-3',
  hmac: 'HMAC',
  chacha20: 'ChaCha20',
  secp256r1: 'secp256r1 (P-256)',
  secp384r1: 'secp384r1 (P-384)',
  secp521r1: 'secp521r1 (P-521)',
  ed25519: 'Ed25519',
  ed448: 'Ed448',
  x25519: 'X25519',
  x448: 'X448',
}

/** "AES, 3DES, RSA" — the prose spelling rule 2a requires for `alg:` families. */
export function familyList(slugs: readonly string[]): string {
  return slugs.map((slug) => FAMILY_LABELS[slug] ?? slug).join(', ')
}

const JUNK_VENDORS: Record<string, true> = {
  unknown: true,
  'n/a': true,
  na: true,
  none: true,
  'email-protected': true,
}

/**
 * `vendor:` slug (§3.4): lowercase, NFKD→ASCII, whitespace/punctuation runs → '-'.
 * Junk source values (empty, `unknown`, `email-protected` redactions) → null.
 */
export function vendorSlug(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const ascii = raw.normalize('NFKD').replace(/\p{M}/gu, '')
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (slug.length === 0) return null
  if (JUNK_VENDORS[slug] === true) return null
  return slug
}

/** Lowercase continuous ATR hex (separators removed) — design §3.4. Masked/junk → null. */
export function normalizeAtr(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const lower = raw.trim().toLowerCase()
  if (!/^[0-9a-f\s:_-]+$/u.test(lower)) return null
  const hex = lower.replace(/[^0-9a-f]/gu, '')
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  return hex
}

/** "3bfa1800" → "3b fa 18 00" (display form for ATRs in prose). */
export function spacedHex(hex: string): string {
  const pairs = hex.match(/../gu)
  return pairs === null ? hex : pairs.join(' ')
}

/** True when the raw ATR carries masked (`xx`) or all-zero bytes — not an identity anchor. */
export function atrIsMasked(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false
  const lower = raw.toLowerCase()
  if (lower.includes('x')) return true
  const hex = lower.replace(/[^0-9a-f]/gu, '')
  return hex.length > 0 && /^0+$/u.test(hex)
}

/** `jcver-lte` buckets: every frozen cut point C where version ≤ C (§9 Q10). */
export const JCVER_CUT_POINTS: readonly string[] = ['3.0.4', '3.0.5', '3.1']

export function jcverBuckets(version: string | null): string[] {
  if (version === null) return []
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(v)
    if (m === null) return null
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')]
  }
  const target = parse(version)
  if (target === null) return []
  const out: string[] = []
  for (const cut of JCVER_CUT_POINTS) {
    const c = parse(cut)
    if (c === null) continue
    const le =
      target[0] !== c[0]
        ? target[0] < c[0]
        : target[1] !== c[1]
          ? target[1] < c[1]
          : target[2] <= c[2]
    if (le) out.push(`jcver-lte:${cut}`)
  }
  return out
}
