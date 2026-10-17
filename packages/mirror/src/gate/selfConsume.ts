/**
 * gate/selfConsume.ts — rule-2a self-consume check (design.md §4.1 rule 2a).
 *
 * The mirror must not hide machine facts in tags/record-card only: every string
 * scalar in the `Record card (JSON):` line, and every `i` tag value, must also be
 * findable as prose in the same event's content. This module extracts those facts
 * and reports the ones missing from prose.
 *
 * Matching policy (deliberately narrower than "any whitespace-separated token"):
 *  1. casefold substring of prose, then
 *  2. a separator-insensitive fallback (non-alphanumerics stripped on both sides),
 *     which accepts the spelled-out forms rule 2a asks for — e.g. an ATR written
 *     `3b fa 18 …` satisfies `atr:3bfa18…`, and `NXP Semiconductors` satisfies
 *     `vendor:nxp-semiconductors`.
 * Nothing else is relaxed; genuinely absent facts are reported.
 *
 * Documented exemptions (machine-only strings that carry no human-searchable fact):
 *  - `«`-bearing values: an unresolved template value; the URL scan reports it.
 *  - 60+ char lowercase hex: event ids / sha256 digests (published as link/refs hex).
 *  - `@<n>` type strings: the record-card `type` discriminator (e.g. `…@1`).
 *  - `jcver-lte` i values: the cohort *bucket* is vocabulary, not a record fact.
 *
 * BOTH the canonical single-line label (rule 8c) and nothing else are consumed: the
 * legacy fenced ` ```json ` cards predate rule 8c, so their scalars are not facts
 * this gate can hold to rule 2a (they are a known rule-8c deviation, reported in
 * SELFTEST.md, and are NOT silently accepted as prose).
 */

import { RECORD_CARD_LABEL } from '../emit/content.js'
import type { SignedEvent } from '../types.js'
import type { GateError } from './verify.js'

export interface LostFact {
  event: string
  fact: string
}

export interface SelfConsumeResult {
  lostFacts: LostFact[]
  errors: GateError[]
}

const LONG_HEX = /^[0-9a-f]{60,}$/
const TYPE_STRING = /@\d+$/
const COHORT_PREFIXES: Record<string, true> = { 'jcver-lte': true }

function isExemptFact(value: string, prefix: string | null): boolean {
  if (value.includes('«')) return true
  if (LONG_HEX.test(value)) return true
  if (TYPE_STRING.test(value)) return true
  if (prefix !== null && COHORT_PREFIXES[prefix] === true) return true
  return false
}

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

/**
 * Check one event's prose against its machine facts.
 * Returns `lostFacts` (facts present in tags/record-card but not in prose) and
 * `errors` for a malformed labeled record card.
 */
export function selfConsume(event: SignedEvent, label?: string): SelfConsumeResult {
  const lostFacts: LostFact[] = []
  const errors: GateError[] = []
  const where = label ?? event.id

  const proseLines: string[] = []
  let cardRaw: string | null = null
  for (const line of event.content.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(RECORD_CARD_LABEL)) {
      proseLines.push(line)
      continue
    }
    if (cardRaw !== null) {
      errors.push({
        event: where,
        code: 'SELFCONSUME-CARD',
        detail: 'more than one `Record card (JSON):` line in content (rule 8c)',
      })
      continue
    }
    cardRaw = trimmed.slice(RECORD_CARD_LABEL.length)
  }

  let card: unknown = null
  if (cardRaw !== null) {
    try {
      card = JSON.parse(cardRaw)
    } catch (e) {
      errors.push({
        event: where,
        code: 'SELFCONSUME-CARD',
        detail: `record-card JSON does not parse: ${(e as Error).message}`,
      })
    }
  }

  const facts: Array<{ fact: string; prefix: string | null }> = []
  if (card !== null) {
    const strings: string[] = []
    collectStrings(card, strings)
    for (const s of strings) {
      if (s.length >= 4) facts.push({ fact: s, prefix: null })
    }
  }
  for (const tag of event.tags) {
    if (tag[0] !== 'i' || typeof tag[1] !== 'string') continue
    const colon = tag[1].indexOf(':')
    if (colon <= 0) continue
    facts.push({ fact: tag[1].slice(colon + 1), prefix: tag[1].slice(0, colon) })
  }

  const prose = proseLines.join('\n')
  const haystack = prose.toLowerCase()
  const haystackLoose = haystack.replace(/[^a-z0-9]+/g, '')
  const reported = new Set<string>()
  for (const { fact, prefix } of facts) {
    if (isExemptFact(fact, prefix)) continue
    const needle = fact.toLowerCase()
    if (haystack.includes(needle)) continue
    const needleLoose = needle.replace(/[^a-z0-9]+/g, '')
    if (needleLoose.length > 0 && haystackLoose.includes(needleLoose)) continue
    const key = `${where}\u0000${fact}`
    if (reported.has(key)) continue
    reported.add(key)
    lostFacts.push({ event: where, fact })
  }

  return { lostFacts, errors }
}
