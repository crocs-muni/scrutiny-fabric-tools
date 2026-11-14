/**
 * Rule 8 composition and rule 2a checking — the MCP server's port of mirror
 * `packages/mirror/src/emit/content.ts:134-262` (#108 A4).
 *
 * The mirror is a bun-shaped private package (`tsconfig` types: ["bun"], `exports` at dist), so it
 * cannot be imported from this Node server; the functions are ported byte-for-byte instead. The
 * port is the contract: any divergence here is a divergence between the MCP server's events and the
 * mirror's, which is exactly what rule 8 exists to prevent.
 *
 * - `composeContent` keeps the mirror's ordering (headline, blank, bullets, blank + `Links:`, blank,
 *   one `Record card (JSON): …` line last), LF only, no fences or tables (rule 8a/8b/8c).
 * - `lostFacts` is the mirror's rule 2a haystack check unchanged: casefold and separator-insensitive
 *   matching, card strings shorter than 4 characters unchecked, four documented exemptions.
 * - Control-character and typographic-quote normalization is the mirror's `plan.ts:20-31` emit-boundary
 *   step, applied here at the same boundary (see {@link normalizeProse}).
 */

/** Rule 8(c): the canonical single-line record-card label. */
export const RECORD_CARD_LABEL = 'Record card (JSON): '

const LONG_HEX = /^[0-9a-f]{60,}$/u
const TYPE_STRING = /@\d+$/u
/** Prefixes whose `i` value is vocabulary (a bounded bucket), not a record fact. */
const COHORT_PREFIXES: Record<string, true> = { 'jcver-lte': true }

/** Typographic quotes, normalized to ASCII at the emit boundary (mirror `plan.ts:20`). */
const TYPO_QUOTES = /[«»“”„]/gu
/**
 * C0 control bytes and DEL, except `\n`, replaced with a space (mirror `plan.ts:21-27`).
 *
 * The mirror comment explains why this is not cosmetic: upstream text carries control bytes, and
 * Go-based relays round-trip `\u0002` differently than the canonical nostr-tools escaping, so such
 * events cannot be hashed consistently and kind-1 writes are permanently invalid. CR is stripped
 * too and CRLF folded to LF by {@link normalizeProse}, keeping rule 8's "LF only".
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rule 8 strips C0 control bytes at the emit boundary — matching them is the whole point.
const CTRL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu
const CRLF = /\r\n?/gu

/** An event synthesized by this server failed rule 2a after restatement — a server bug, not input. */
export class CompositionError extends Error {
  /** The facts that are still missing from the prose. */
  readonly missing: readonly string[]

  constructor(label: string, missing: readonly string[]) {
    super(
      `${label}: internal composition error — rule 2a facts still missing from prose after ` +
        `restatement: ${missing.join(', ')}. This is a server bug (#108 A4); nothing was signed.`,
    )
    this.name = 'CompositionError'
    this.missing = missing
  }
}

/**
 * Normalize one user-supplied prose string at the emit boundary: CRLF → LF, typographic quotes →
 * `"`, C0 control bytes (except `\n`) → space. Ported from mirror `plan.ts:20-31`.
 */
export function normalizeProse(text: string): string {
  return text.replace(CRLF, '\n').replace(TYPO_QUOTES, '"').replace(CTRL_CHARS, ' ')
}

/** Normalize to one line: a bullet is one fact per line (rule 8b), so continuation newlines join. */
export function oneLine(text: string): string {
  return normalizeProse(text)
    .replace(/[ \t]*\n[ \t]*/gu, ' ')
    .trimEnd()
}

/** Rule 8(c): `Record card (JSON): {compact single-line JSON}`. */
function recordCardLine(card: Record<string, unknown>): string {
  return `${RECORD_CARD_LABEL}${JSON.stringify(card)}`
}

/**
 * Compose plain-text content exactly as the mirror does: headline first (clients truncate —
 * rule 8a), `- ` bullets, an optional link block, and the single-line record card last (rule 8c).
 * LF only; never fenced blocks or tables (rule 8b). Callers normalize their fields first
 * ({@link normalizeProse}/{@link oneLine}); this function is the faithful structural port.
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

// ---------------------------------------------------------------------------
// rule 2a — machine facts must also be prose (ported from mirror content.ts:171-262)
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
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(RECORD_CARD_LABEL)) {
      proseLines.push(line)
      continue
    }
    if (cardRaw !== null) {
      throw new CompositionError(label, [`more than one '${RECORD_CARD_LABEL.trim()}' line`])
    }
    cardRaw = trimmed.slice(RECORD_CARD_LABEL.length)
  }
  let card: unknown = null
  if (cardRaw !== null) {
    try {
      card = JSON.parse(cardRaw)
    } catch (cause) {
      throw new CompositionError(label, [
        `record-card JSON does not parse: ${cause instanceof Error ? cause.message : 'unknown'}`,
      ])
    }
  }
  return { prose: proseLines.join('\n'), card }
}

/**
 * Facts present in the record card / `i` tags but missing from prose (rule 2a). The mirror's
 * checker, unchanged: matching is casefold and separator-insensitive, card strings shorter than 4
 * characters are not facts, and the four documented exemptions apply.
 */
export function lostFacts(
  content: string,
  tags: readonly (readonly string[])[],
  label: string,
): string[] {
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
  const haystackLoose = haystack.replace(/[^a-z0-9]+/gu, '')
  const lost: string[] = []
  const reported = new Set<string>()
  for (const { fact, prefix } of facts) {
    if (isExemptFact(fact, prefix)) continue
    const needle = fact.toLowerCase()
    if (haystack.includes(needle)) continue
    const needleLoose = needle.replace(/[^a-z0-9]+/gu, '')
    if (needleLoose.length > 0 && haystackLoose.includes(needleLoose)) continue
    if (reported.has(fact)) continue
    reported.add(fact)
    lost.push(fact)
  }
  return lost
}

/**
 * Fail when rule 2a facts are still missing from prose. In the compose path this runs on the
 * content *after* restatement: a non-empty result there means the server's own restatement logic
 * is wrong, so it throws {@link CompositionError} — a signed event that fails the mirror gate must
 * never be the outcome.
 */
export function assertNoLostFacts(
  content: string,
  tags: readonly (readonly string[])[],
  label: string,
): void {
  const missing = lostFacts(content, tags, label)
  if (missing.length > 0) throw new CompositionError(label, missing)
}
