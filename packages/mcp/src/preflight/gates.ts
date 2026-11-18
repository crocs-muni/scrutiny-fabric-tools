/**
 * Relay gates decidable before anything is signed (spec §6.5 `record.budget`, `record.indexer_prefix_unknown`),
 * run on the final composed tag set, after the MCP's appended tags.
 */

import { INDEXER_PREFIX_PATTERN } from '@crocs-muni/scrutiny-fabric'

/**
 * The relay's indexable-tag ceiling (`relay/internal/relay/relay.go` `maxIndexableTags`). khatru's
 * `PreventTooManyIndexableTags` counts only tags whose name is one character, so `imeta`, `meta`
 * and `identifier` are free; the prototype counted `imeta` and was wrong.
 */
export const MAX_SINGLE_LETTER_TAGS = 64
/** RL-1: whole signed event, and per tag value (strfry `maxEventSize`, `maxTagValSize`). */
export const MAX_EVENT_BYTES = 65_536
const MAX_TAG_VALUE_BYTES = 1024
/**
 * Bytes the signer adds (`id`, `pubkey`, `sig` with keys and punctuation); the same constant as
 * core's private one in `build.ts`.
 */
const SIGNED_ENVELOPE_BYTES = 285
/** A 10-digit `created_at`, the width every timestamp has until 2286. */
const CREATED_AT_PLACEHOLDER = 9_999_999_999
/** A ref placeholder becomes a 64-hex event id at signing time; measure it at that width. */
const REF_TOKEN = /@ref:(?:profile|product|metadata):[a-z0-9][a-z0-9._-]{0,63}/gu
const EVENT_ID_WIDTH = 'x'.repeat(64)

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

const asSigned = (s: string) => s.replace(REF_TOKEN, EVENT_ID_WIDTH)

export interface TemplateEvent {
  readonly kind: number
  readonly content: string
  readonly tags: readonly (readonly string[])[]
}

/** Size of the event once stamped and signed, with every ref placeholder at id width. */
export function signedSize(event: TemplateEvent): number {
  const stamped = {
    kind: event.kind,
    created_at: CREATED_AT_PLACEHOLDER,
    tags: event.tags.map((t) => t.map(asSigned)),
    content: asSigned(event.content),
  }
  return utf8Bytes(JSON.stringify(stamped)) + SIGNED_ENVELOPE_BYTES
}

export function singleLetterTags(event: TemplateEvent): number {
  return event.tags.filter((t) => t[0]?.length === 1).length
}

/** Indices of tags with a value over the per-value ceiling, measured as signed. */
export function oversizedTagValues(event: TemplateEvent): number[] {
  const out: number[] = []
  event.tags.forEach((tag, i) => {
    if (tag.some((v) => utf8Bytes(asSigned(v)) > MAX_TAG_VALUE_BYTES)) out.push(i)
  })
  return out
}

/**
 * Prefixes seen in the spec §9 baseline and in mirror practice. The registry is open (IR-4), so an
 * unknown prefix is a non-blocking question, never a refusal.
 */
export const KNOWN_INDEXER_PREFIXES: readonly string[] = [
  'cve',
  'cwe',
  'cpe',
  'purl',
  'cc',
  'fips',
  'fcc-id',
  'swid',
  'gtin',
  'vendor',
  'part',
  'doc',
  'report',
  'test',
  'advisory',
  'firmware',
  'atr',
  'cplc',
  'jcard',
  'jcver',
  'jcver-lte',
  'alg',
  'scheme',
  'eal',
  'pp',
  'cavac',
  'cavp',
  'ghsa',
  'fips-t',
]
const KNOWN = new Set(KNOWN_INDEXER_PREFIXES)

export function isKnownPrefix(prefix: string): boolean {
  return INDEXER_PREFIX_PATTERN.test(prefix) && KNOWN.has(prefix)
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(
          (prev[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    }
    prev = row
  }
  return prev[b.length] ?? 0
}

/** The closest known prefix within edit distance 2, if exactly one is closest. */
export function suggestPrefix(prefix: string): string | undefined {
  let best: string | undefined
  let bestDistance = 3
  let tie = false
  for (const known of KNOWN_INDEXER_PREFIXES) {
    const d = editDistance(prefix, known)
    if (d < bestDistance) {
      best = known
      bestDistance = d
      tie = false
    } else if (d === bestDistance) {
      tie = true
    }
  }
  return tie ? undefined : best
}
