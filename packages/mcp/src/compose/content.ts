/**
 * Rule 8 content and the rule 2a check (spec §5.3), following the mirror
 * (`packages/mirror/src/emit/content.ts`), which cannot be imported from here: it is a private,
 * bun-typed package. Structure and the 2a matching rules are the mirror's; the plan schema already
 * guarantees single-line headline and bullets, so no newline handling is needed here.
 *
 * The server checks rule 2a and reports what is missing; it never rewrites the agent's prose
 * (spec §5.2 `card`). The prototype appended "Facts:" bullets instead, which the spec dropped.
 */

/** Rule 8(c): the canonical single-line record-card label. */
const RECORD_CARD_LABEL = 'Record card (JSON): '

/** Typographic quotes, folded to ASCII at the emit boundary (mirror `plan.ts`). */
const TYPO_QUOTES = /[«»“”„]/gu
/**
 * C0 controls and DEL except TAB, LF and CR, replaced by a space. Go relays round-trip some control
 * bytes differently from canonical NIP-01 escaping, so such events cannot be hashed consistently.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes is the point.
const CTRL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu

export function normalizeProse(text: string): string {
  return text.replace(TYPO_QUOTES, '"').replace(CTRL_CHARS, ' ')
}

type CardValue = string | number
export type Card = Readonly<Record<string, CardValue>>

export interface IndexedFields {
  readonly headline: string
  readonly bullets: readonly string[]
  readonly links: readonly string[]
  readonly card: Card
}

/**
 * Headline, blank line, `- ` bullets, blank line + `Links:` block, blank line, one record-card line.
 * Empty blocks are omitted; so is an empty card. LF only, no fences or tables (rule 8a–8c).
 */
export function composeContent(spec: {
  readonly headline: string
  readonly bullets?: readonly string[]
  readonly links?: readonly string[]
  readonly card?: Card
}): string {
  const parts = [spec.headline.replace(/\s+$/u, '')]
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
  if (spec.card !== undefined && Object.keys(spec.card).length > 0) {
    parts.push('', `${RECORD_CARD_LABEL}${JSON.stringify(spec.card)}`)
  }
  return parts.join('\n')
}

/** The `@ref:` token that stands for a parent's event id until it is acked (spec §5.3, §8.2). */
export function refPlaceholder(ref: string): string {
  return `@ref:${ref}`
}

/** Rule 8d: the binding label, then the mandatory `Refs:` line, here with placeholders. */
export function bindingContent(label: string, rootRef: string, linkRef: string): string {
  return `${label}\n\nRefs: root ${refPlaceholder(rootRef)} link ${refPlaceholder(linkRef)}`
}

export interface ImetaRow {
  readonly url: string
  readonly m: string
  readonly x: string
  readonly size: number
  readonly alt: string
}

/** One NIP-92 `imeta` tag, fields in the order url, m, x, size, alt. */
export function imetaTag(row: ImetaRow): string[] {
  return [
    'imeta',
    `url ${row.url}`,
    `m ${row.m}`,
    `x ${row.x}`,
    `size ${row.size}`,
    `alt ${row.alt}`,
  ]
}

// ---------------------------------------------------------------------------
// rule 2a: every machine fact (card scalar, `i` value) must also appear in the prose
// ---------------------------------------------------------------------------

const LONG_HEX = /^[0-9a-f]{60,}$/u
const TYPE_STRING = /@\d+$/u
/** Prefixes whose `i` value is a bounded vocabulary bucket, not a record fact. */
const COHORT_PREFIXES: ReadonlySet<string> = new Set(['jcver-lte'])

function isExempt(value: string, prefix: string | null): boolean {
  return (
    value.includes('«') ||
    LONG_HEX.test(value) ||
    TYPE_STRING.test(value) ||
    (prefix !== null && COHORT_PREFIXES.has(prefix))
  )
}

export type LostFact =
  | { readonly from: 'card'; readonly key: string; readonly value: string }
  | { readonly from: 'indexer'; readonly index: number; readonly value: string }

/**
 * Facts missing from the prose (everything but the card line), matched casefolded and, failing
 * that, with every non-alphanumeric removed. Card scalars shorter than 4 characters are not
 * checked. The spec says every card scalar, so numbers are checked as their decimal spelling; the
 * mirror only ever emitted string facts.
 */
export function lostFacts(
  fields: IndexedFields & { readonly indexers: readonly string[] },
): LostFact[] {
  const prose = composeContent({
    headline: fields.headline,
    bullets: fields.bullets,
    links: fields.links,
  }).toLowerCase()
  const proseLoose = prose.replace(/[^a-z0-9]+/gu, '')
  const present = (fact: string): boolean => {
    const needle = fact.toLowerCase()
    if (prose.includes(needle)) return true
    const loose = needle.replace(/[^a-z0-9]+/gu, '')
    return loose.length > 0 && proseLoose.includes(loose)
  }

  const lost: LostFact[] = []
  for (const [key, raw] of Object.entries(fields.card)) {
    const value = String(raw)
    if (value.length < 4 || isExempt(value, null) || present(value)) continue
    lost.push({ from: 'card', key, value })
  }
  fields.indexers.forEach((raw, index) => {
    const colon = raw.indexOf(':')
    if (colon <= 0) return
    const value = raw.slice(colon + 1)
    if (isExempt(value, raw.slice(0, colon)) || present(value)) return
    lost.push({ from: 'indexer', index, value })
  })
  return lost
}
