/**
 * Deterministic content for the #108 tool inputs: restate-and-verify (rule 2a), binding content
 * (rule 8d), and NIP-92 `imeta` rows (#108 "Composition is deterministic").
 *
 * Rule 2a is enforced by construction rather than by refusal. The mirror's answer to a card scalar
 * or `i` value that never made it into prose was `lostFacts` → gate failure (mirror
 * `gate/selfConsume.ts`, `emit/content.ts:222-262`); a tool that refused the same payload would
 * force the agent to rewrite prose until a substring check happened to pass — a second, drifting
 * composition loop in the model's context. So this server appends the missing facts itself:
 *
 * - missing card scalars → one final `Facts: <key>=<value>; …` bullet;
 * - missing `i` spellings → one final `Identifiers: <prefix>:<value>; …` bullet.
 *
 * The issue's rule 2a states that every machine fact must also appear in prose; it does not say the
 * author's sentence must be the one carrying it. The ported `lostFacts` check runs again on the
 * appended content before signing — it must find nothing, or the server has a composition bug
 * ({@link CompositionError}, never a publish).
 */

import {
  CompositionError,
  assertNoLostFacts,
  composeContent,
  lostFacts,
  normalizeProse,
  oneLine,
} from './content.ts'

/** One `imeta` row from the tool schema; rendered as one NIP-92 tag per row. */
export interface ComposeImeta {
  readonly url: string
  readonly m: string
  readonly x: string
  readonly size: number
  readonly alt: string
}

/** The fields shared by `publish_product` and `publish_metadata`. */
export interface IndexedComposeInput {
  readonly headline: string
  readonly bullets?: readonly string[] | undefined
  /** `links` entries from the tool schema: `label: url`, or the URL alone when no label. */
  readonly links?:
    | readonly { readonly url: string; readonly label?: string | undefined }[]
    | undefined
  readonly card?: Readonly<Record<string, string | number | boolean>> | undefined
  readonly indexers: readonly string[]
}

export interface ComposedContent {
  /** The final content: user prose, any restatement bullets, links, record card. */
  readonly content: string
  /** The restatement bullets the server added, in emission order. Empty when nothing was lost. */
  readonly appended: readonly string[]
}

/** Card values are scalars: one line, normalized like the prose that must restate them. */
function normalizeCard(
  card: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(card)) {
    out[key] = typeof value === 'string' ? oneLine(value) : value
  }
  return out
}

/** A link line as the mirror renders it: `label: url`, or the URL alone (rule 8's `Links:` block). */
function linkLine(link: { readonly url: string; readonly label?: string | undefined }): string {
  return link.label === undefined ? link.url : `${oneLine(link.label)}: ${link.url}`
}

/**
 * Build the restatement bullets for `lost`. Card entries come in card order; indexer spellings come
 * in input order, so the appended block is deterministic for a given input.
 */
function restatementBullets(
  lost: readonly string[],
  card: Readonly<Record<string, string | number | boolean>> | undefined,
  indexers: readonly string[],
): string[] {
  const missing = new Set(lost)
  const bullets: string[] = []
  const cardFacts: string[] = []
  for (const [key, value] of Object.entries(card ?? {})) {
    if (typeof value !== 'string' || !missing.has(value)) continue
    cardFacts.push(`${key}=${value}`)
  }
  if (cardFacts.length > 0) bullets.push(`Facts: ${cardFacts.join('; ')}`)
  const spellings = indexers.filter((raw) => {
    const colon = raw.indexOf(':')
    return colon > 0 && missing.has(raw.slice(colon + 1))
  })
  if (spellings.length > 0) bullets.push(`Identifiers: ${spellings.join('; ')}`)
  return bullets
}

/**
 * Compose a Product or Metadata record's content from structured fields.
 *
 * Normalization happens once, here, at the emit boundary (mirror `plan.ts:20-31`): CRLF → LF,
 * typographic quotes → ASCII, C0 control bytes → space. The headline may carry a newline — the
 * mirror does exactly that for its two-line headline (`emit/seccerts/roots.ts:669-676`) — while
 * bullets and labels are joined to one line (rule 8b: one fact per line).
 *
 * Throws {@link CompositionError} if a fact is still missing after restatement: that means the
 * server's own restatement logic is wrong, and a signed event that fails the mirror gate must never
 * be the outcome.
 */
export function composeIndexed(input: IndexedComposeInput, label: string): ComposedContent {
  const headline = normalizeProse(input.headline)
  const bullets = (input.bullets ?? []).map(oneLine).filter((bullet) => bullet !== '')
  const links = (input.links ?? []).map(linkLine)
  const card = input.card === undefined ? undefined : normalizeCard(input.card)
  const tags = input.indexers.map((raw) => ['i', raw] as const)

  const base = composeContent({
    headline,
    bullets,
    links,
    ...(card === undefined ? {} : { card }),
  })
  const lost = lostFacts(base, tags, label)
  if (lost.length === 0) return { content: base, appended: [] }

  const appended = restatementBullets(lost, card, input.indexers)
  const content = composeContent({
    headline,
    bullets: [...bullets, ...appended],
    links,
    ...(card === undefined ? {} : { card }),
  })
  assertNoLostFacts(content, tags, label)
  return { content, appended }
}

/**
 * Binding content: the label as headline, the optional bullets, then the mandatory rule-8d line
 * `Refs: root <64hex> link <64hex>` (mirror `emit/binding.ts:40`; gate `verify.ts:57`). A Binding
 * carries no card and no `i` tags, so rule 2a has nothing to restate.
 */
export function composeBindingContent(
  label: string,
  bullets: readonly string[] | undefined,
  rootId: string,
  linkId: string,
): string {
  const base = composeContent({
    headline: oneLine(label),
    bullets: (bullets ?? []).map(oneLine).filter((bullet) => bullet !== ''),
  })
  return `${base}\n\nRefs: root ${rootId} link ${linkId}`
}

/** One NIP-92 tag per artifact row, in the guide's field order (§5; mirror `roots.ts:621-628`). */
export function imetaTags(rows: readonly ComposeImeta[] | undefined): string[][] {
  return (rows ?? []).map((row) => [
    'imeta',
    `url ${row.url}`,
    `m ${row.m}`,
    `x ${row.x}`,
    `size ${row.size}`,
    `alt ${oneLine(row.alt)}`,
  ])
}
