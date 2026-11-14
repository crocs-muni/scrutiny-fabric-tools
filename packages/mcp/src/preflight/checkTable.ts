/**
 * The preflight check table of #108 — every gate that can be decided before a signature is spent.
 *
 * It runs on the *composed* template, after the builders have derived the tags and before the
 * signer is touched, and it reports findings as `{field, problem, fix}` so a refusal reads as an
 * instruction: the model gets the schema field it must change and what to change it to.
 *
 * Gate inventory (issue #108, "Composition is deterministic"):
 *
 * | Gate | What it checks | Order |
 * | --- | --- | --- |
 * | accepted `t` tags | the server always sets them; this verifies the composed set, it validates nothing user-supplied | 1 |
 * | single-letter tag budget | `i` + distinct `k` + `e` + `t` + `imeta` rows against the relay's 64-tag ceiling | 2 |
 * | RL-1 sizes | signed-event size (JSON + {@link SIGNED_ENVELOPE_BYTES}) and per-tag-value bytes | 3 |
 * | clock | `created_at` inside the relay's freshness window ({@link assertCreatedAtWithinRelayWindow}) | 4 |
 * | `i` prefixes | vocabulary warnings only — the registry is open (IR-4), so an unknown prefix publishes | 5 |
 *
 * `imeta` shape is not re-checked here: the tool schema pins it (`src/tools/schemas.ts:50-72`), and
 * a second checker would be a second contract.
 */

import {
  DELETION_KIND,
  EVENT_TYPE_TAGS,
  FABRIC_TAG,
  INDEXER_PREFIX_PATTERN,
  SCRUTINY_KIND,
  type UnsignedEvent,
  VERSION_TAG,
} from '@scrutiny-fabric/core'
import { assertCreatedAtWithinRelayWindow } from '../identity/sign.ts'

/** One refusal reason: the field to change, what is wrong, and the fix. */
export interface PreflightFinding {
  readonly field: string
  readonly problem: string
  readonly fix: string
}

export interface PreflightResult {
  /** Refusals. Non-empty means the event must not be signed. */
  readonly findings: readonly PreflightFinding[]
  /** Advisory notes (unknown indexer prefixes, budget pressure). Never block a publish. */
  readonly warnings: readonly string[]
}

/**
 * Bytes the signer adds once it fills in `id`, `pubkey` and `sig` — three fixed-width hex fields
 * plus their JSON keys, separators and quotes. Core keeps the same constant private
 * (`packages/core/src/build.ts:49-54,85`); it is restated here because RL-1's ceiling must be
 * checked on the composed template, before the signer exists.
 */
const SIGNED_ENVELOPE_BYTES = 285

/** RL-1's whole-event ceiling (§5.4; core `build.ts:43`). */
const MAX_EVENT_BYTES = 65_536
/** RL-1's per-tag-value ceiling (`strfry maxTagValSize`; core `build.ts:44`). */
const MAX_TAG_VALUE_BYTES = 1024

/**
 * The relay counts every `i`, derived `k`, `e`, `t` and `imeta` tag against one 64-tag ceiling
 * (`relay/internal/relay/relay.go:44`; guide §4). The mirror's own budget is 60 to stay clear of
 * stock relay policies in the 60–100 band (`packages/mirror/src/emit/seccerts/roots.ts:110-119`).
 */
export const RELAY_TAG_CEILING = 64
export const MIRROR_TAG_BUDGET = 60

const TYPE_TAGS: ReadonlySet<string> = new Set(Object.values(EVENT_TYPE_TAGS))

/**
 * Known `i` prefixes — spec §9's baseline plus the prefixes in practice across the mirror
 * (`jcard`/`atr`/`cplc`/`jcver`/`jcver-lte`/`alg` in `emit/cardProduct.ts:74-80`,
 * `pp` in `emit/seccerts/roots.ts:476-488`, `cavp` in `:880`) and the issue #108 seed
 * (`fips-t`, `ghsa`, `cavac`). The publisher guide's §4 table is generated from this list and a
 * test pins the two together; the registry itself is open (IR-4) and a vocabulary file is pending
 * (#48), so an unknown prefix is a WARNING and never a refusal.
 */
export const KNOWN_INDEXER_PREFIXES: readonly string[] = [
  // spec §9 baseline
  'cve',
  'cwe',
  'cpe',
  'purl',
  'cc',
  'fips',
  'fcc-id',
  'swid',
  'gtin',
  // conventions in use (mirror + issue #108)
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

const KNOWN_PREFIX_SET: ReadonlySet<string> = new Set(KNOWN_INDEXER_PREFIXES)

/** UTF-8 byte length. Relay limits are byte limits; `String.length` counts UTF-16 units. */
function utf8Bytes(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

interface TagCounts {
  readonly i: number
  readonly k: number
  readonly e: number
  readonly t: number
  readonly imeta: number
  readonly singleLetter: number
}

function countTags(tags: UnsignedEvent['tags']): TagCounts {
  let i = 0
  let e = 0
  let t = 0
  let imeta = 0
  const k = new Set<string>()
  for (const tag of tags) {
    const name = tag[0]
    if (name === 'i') i += 1
    else if (name === 'k') {
      const value = tag[1]
      if (value !== undefined) k.add(value)
    } else if (name === 'e') e += 1
    else if (name === 't') t += 1
    else if (name === 'imeta') imeta += 1
  }
  return { i, k: k.size, e, t, imeta, singleLetter: i + k.size + e + t + imeta }
}

/** First `max` characters of a value, for a message that stays readable (values are user content). */
function preview(value: string, max = 48): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Gate 1 — the composed event carries exactly the three required `t` tags and nothing else. */
function checkAcceptedTags(event: UnsignedEvent): PreflightFinding[] {
  if (event.kind === DELETION_KIND) {
    const eTags = event.tags.filter((tag) => tag[0] === 'e').length
    if (eTags === 1) return []
    return [
      {
        field: 'target_id',
        problem: `a kind 5 deletion must carry exactly one e tag, and the composed event carries ${eTags}`,
        fix: 'report a server bug (#108 A4): the deletion template is built from a single target id',
      },
    ]
  }
  if (event.kind !== SCRUTINY_KIND) return []

  const tValues = event.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1] ?? '')
  const fabric = tValues.filter((value) => value === FABRIC_TAG).length
  const version = tValues.filter((value) => value === VERSION_TAG).length
  const types = tValues.filter((value) => TYPE_TAGS.has(value))
  const unexpected = tValues.filter(
    (value) => value !== FABRIC_TAG && value !== VERSION_TAG && !TYPE_TAGS.has(value),
  )
  const findings: PreflightFinding[] = []
  if (fabric !== 1 || version !== 1 || types.length !== 1 || unexpected.length > 0) {
    findings.push({
      field: 'tags',
      problem: `the composed event's t tags are wrong (${fabric}× ${FABRIC_TAG}, ${version}× ${VERSION_TAG}, ${types.length} type tag${unexpected.length === 0 ? '' : `, unexpected ${unexpected.join(', ')}`}); the server sets them from the builder, so nothing user-supplied produced this`,
      fix: 'report a server bug (#108 A4) — do not hand-build the event; the relay rejects a kind 1 event without exactly one accepted scrutiny t tag',
    })
  }
  return findings
}

/** Gate 2 — the relay's hidden single-letter tag ceiling. */
function checkTagBudget(event: UnsignedEvent): {
  findings: PreflightFinding[]
  warnings: string[]
} {
  if (event.kind !== SCRUTINY_KIND) return { findings: [], warnings: [] }
  const counts = countTags(event.tags)
  const breakdown = `i ${counts.i} + k ${counts.k} + e ${counts.e} + t ${counts.t} + imeta ${counts.imeta}`
  if (counts.singleLetter > RELAY_TAG_CEILING) {
    const excess = counts.singleLetter - RELAY_TAG_CEILING
    const indexers = event.tags
      .filter((tag) => tag[0] === 'i')
      .map((tag) => tag[1] ?? '')
      .filter((value) => value !== '')
    const drop = indexers
      .slice(Math.max(0, indexers.length - excess))
      .map((v) => `"${preview(v, 64)}"`)
    return {
      findings: [
        {
          field: 'indexers',
          problem: `the composed event would carry ${counts.singleLetter} single-letter tags (${breakdown}); the relay counts them all against one ceiling of ${RELAY_TAG_CEILING} (relay/internal/relay/relay.go:44) and rejects the event outright`,
          fix: `drop ${excess} indexer${excess === 1 ? '' : 's'} before publishing — ${drop.length === 0 ? 'shorten the content or attachments' : drop.join(', ')}; i tags are immutable after publish (IX-3), and the mirror keeps the total at ${MIRROR_TAG_BUDGET} (packages/mirror/src/emit/seccerts/roots.ts:110-119)`,
        },
      ],
      warnings: [],
    }
  }
  if (counts.singleLetter > MIRROR_TAG_BUDGET) {
    return {
      findings: [],
      warnings: [
        `${counts.singleLetter} single-letter tags (${breakdown}) is above the mirror's budget of ${MIRROR_TAG_BUDGET} (packages/mirror/src/emit/seccerts/roots.ts:110-119); stock relay policies sit in the 60–100 band. Trim indexers the record is not *about* (IX-4).`,
      ],
    }
  }
  return { findings: [], warnings: [] }
}

/** Gate 3 — RL-1: the signed event's size and every tag value's size. */
function checkSizes(event: UnsignedEvent): PreflightFinding[] {
  const findings: PreflightFinding[] = []
  const total = utf8Bytes(JSON.stringify(event)) + SIGNED_ENVELOPE_BYTES
  if (total > MAX_EVENT_BYTES) {
    findings.push({
      field: 'content',
      problem:
        `the signed event would be about ${total} bytes; RL-1's recommended maximum is ${MAX_EVENT_BYTES} ` +
        `(§5.4; ${SIGNED_ENVELOPE_BYTES} bytes of it are the signer's id/pubkey/sig envelope)`,
      fix: 'shorten `bullets`/`headline`, or move the bulk into an `imeta` attachment — a 2 MB SBOM belongs at a URL with its hash, not in prose (§4.6, IM-1)',
    })
  }
  for (const tag of event.tags) {
    const name = tag[0] ?? ''
    for (const value of tag) {
      const bytes = utf8Bytes(value)
      if (bytes <= MAX_TAG_VALUE_BYTES) continue
      const field = name === 'i' ? 'indexers' : name === 'imeta' ? 'imeta' : 'tags'
      findings.push({
        field,
        problem: `a ${name === '' ? 'tag' : `\`${name}\` tag`} value is ${bytes} bytes; RL-1's recommended maximum is ${MAX_TAG_VALUE_BYTES} bytes per tag value (strfry maxTagValSize; packages/core/src/build.ts:44)`,
        fix:
          field === 'indexers'
            ? "shorten the identifier to the authority's canonical spelling — an `i` value is a spelling, not a payload (IR-2)"
            : field === 'imeta'
              ? 'shorten the `alt` label (Lens renders it verbatim and caps it at 60 characters, guide §5)'
              : 'shorten the value',
      })
      // One finding per offending tag value is enough: the field and the limit are the message.
      break
    }
  }
  return findings
}

/** Gate 4 — the relay's freshness window, reused from the signer's own pre-signing guard. */
function checkClock(event: UnsignedEvent, now: number): PreflightFinding[] {
  try {
    assertCreatedAtWithinRelayWindow(event.created_at, now)
    return []
  } catch (cause) {
    return [
      {
        field: 'created_at',
        problem: cause instanceof Error ? cause.message : String(cause),
        fix: 'enable NTP on the publishing machine and publish again — `created_at` is stamped at publish time and is part of the signed event id, so a clock fix means a fresh publish, not an edit (guide §7.6)',
      },
    ]
  }
}

/** Gate 5 — `i` prefix vocabulary: warnings only, because the registry is open (IR-4). */
function checkIndexerPrefixes(event: UnsignedEvent): string[] {
  if (event.kind !== SCRUTINY_KIND) return []
  const warnings: string[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'i') continue
    const value = tag[1]
    if (value === undefined) continue
    const colon = value.indexOf(':')
    const prefix = colon > 0 ? value.slice(0, colon) : ''
    if (prefix === '' || !INDEXER_PREFIX_PATTERN.test(prefix)) {
      warnings.push(
        `indexer "${preview(value)}" does not have a valid \`<prefix>:<value>\` spelling (IR-1); it publishes verbatim as an opaque i tag, but no k tag is derived and Lens cannot facet it. Use a prefix from guide §4 where one covers the fact`,
      )
      continue
    }
    if (KNOWN_PREFIX_SET.has(prefix)) continue
    warnings.push(
      `indexer prefix "${prefix}" is not in the server's known-prefix list (spec §9 + mirror practice, issue #108); the registry is open (IR-4), so this publishes, but Lens will not facet it until the vocabulary lands (#48)`,
    )
  }
  return warnings
}

/**
 * Run every gate on a composed template. Pure apart from the clock read (`now` is injectable so
 * tests are not coupled to the wall clock) and the reused freshness assertion.
 */
export function checkTable(
  event: UnsignedEvent,
  options: { readonly now?: number } = {},
): PreflightResult {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const budget = checkTagBudget(event)
  const findings = [
    ...checkAcceptedTags(event),
    ...budget.findings,
    ...checkSizes(event),
    ...checkClock(event, now),
  ]
  return { findings, warnings: [...budget.warnings, ...checkIndexerPrefixes(event)] }
}
