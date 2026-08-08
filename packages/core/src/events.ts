/**
 * Event parsing, tag accessors, and `i`/`k` indexer handling.
 *
 * Everything here is a pure read over an event. Nothing in this module rejects an event — that is
 * `validate.ts`'s job — so the accessors are deliberately tolerant and return what is there.
 */

/** A Nostr event as defined by NIP-01. */
export interface NostrEvent {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string
}

/**
 * An event template before signing: no `id`, no `pubkey`, no `sig`.
 *
 * Those three are the injected signer's job (D13). NIP-07's `signEvent` computes all of them, so
 * `window.nostr` consumes this shape unchanged.
 */
export interface UnsignedEvent {
  readonly kind: number
  readonly created_at: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
}

/** The four SCRUTINY event types (§3). */
export type ScrutinyEventType = 'product' | 'metadata' | 'binding' | 'patch'

/**
 * The two event types that carry `i`/`k` indexers — derived from {@link ScrutinyEventType} rather
 * than hand-typed, so a future addition to that union cannot silently drift out of sync here.
 */
export type IndexedEventType = Extract<ScrutinyEventType, 'product' | 'metadata'>

/** The `t` tag identifying each event type. */
export const EVENT_TYPE_TAGS: Readonly<Record<ScrutinyEventType, string>> = Object.freeze({
  product: 'scrutiny-product',
  metadata: 'scrutiny-metadata',
  binding: 'scrutiny-binding',
  patch: 'scrutiny-patch',
})

/** The `t` tag every SCRUTINY event carries (TAG-1). */
export const FABRIC_TAG = 'scrutiny-fabric'

/** Every SCRUTINY event uses this Nostr kind (§3) — short text notes, disambiguated by `t` tags. */
export const SCRUTINY_KIND = 1

/**
 * Version tag grammar (TAG-2, amended in spec v0.7.0 — SPEC-FEEDBACK F14).
 *
 * Unpadded decimal integers encoding MAJOR.MINOR.PATCH (VER-1), with no fixed width and no
 * digit-count ceiling in any field. Retires the old fixed-width `^scrutiny-v\d{3}$` form outright —
 * no dual-path acceptance of it anywhere, since no real corpus exists to preserve compatibility
 * with.
 */
export const VERSION_TAG_PATTERN = /^scrutiny-v(\d+)\.(\d+)\.(\d+)$/

/** Indexer prefix grammar (IR-1): lowercase ASCII. */
export const INDEXER_PREFIX_PATTERN = /^[a-z0-9-]+$/

const TYPE_BY_TAG: ReadonlyMap<string, ScrutinyEventType> = new Map(
  Object.entries(EVENT_TYPE_TAGS).map(([type, tag]) => [tag, type as ScrutinyEventType]),
)

/**
 * All values of a given tag name, i.e. `tag[1]` for every tag whose `tag[0]` matches.
 *
 * Tags with no value are skipped rather than yielding `undefined`.
 */
export function tagValues(event: NostrEvent, name: string): string[] {
  const out: string[] = []
  for (const tag of event.tags) {
    if (tag[0] === name && tag[1] !== undefined) out.push(tag[1])
  }
  return out
}

/** Every `t` tag value on the event. */
export function tTags(event: NostrEvent): string[] {
  return tagValues(event, 't')
}

/** A parsed NIP-10 marked `e` tag: `["e", <id>, <relay>, <marker>, <author-hint>]`. */
export interface ETagRef {
  readonly id: string
  /** Advisory (BD-8). The empty string means "no hint" — never treat it as a relay URL. */
  readonly relay: string
  /** NIP-10 marker, typically `root`, `reply`, or `link`. Absent on unmarked `e` tags. */
  readonly marker?: string
  /**
   * Advisory author hint (BD-12). A mismatch against the referenced event's real `pubkey` does not
   * invalidate the referencing event, and trust decisions MUST use the verified pubkey instead.
   */
  readonly authorHint?: string
}

/** Every `e` tag on the event, in document order. */
export function eTags(event: NostrEvent): ETagRef[] {
  const out: ETagRef[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'e' || tag[1] === undefined) continue
    const marker = tag[3]
    const authorHint = tag[4]
    out.push({
      id: tag[1],
      relay: tag[2] ?? '',
      ...(marker !== undefined && marker !== '' ? { marker } : {}),
      ...(authorHint !== undefined && authorHint !== '' ? { authorHint } : {}),
    })
  }
  return out
}

/** Every `e` tag carrying a given NIP-10 marker. */
export function eTagsWithMarker(event: NostrEvent, marker: string): ETagRef[] {
  return eTags(event).filter((e) => e.marker === marker)
}

/** The id an event's `e root` marker points at, if any. Shared by `resolve.ts` and `admit.ts`. */
export function rootTarget(event: NostrEvent): string | undefined {
  return eTagsWithMarker(event, 'root')[0]?.id
}

/**
 * Deduplicate events by id, first occurrence wins.
 *
 * Nostr ids are content hashes, so two events sharing an id are byte-identical (D18) — "first
 * observed wins" and "any observed wins" agree. Shared by `resolve.ts` and `admit.ts`, both of
 * which need this as the entry point to a pure function over an "observed set" modelled as an
 * array (see either module's own doc comment for why the parameter is an array, not a `Set`).
 */
export function dedupeById(events: readonly NostrEvent[]): Map<string, NostrEvent> {
  const byId = new Map<string, NostrEvent>()
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event)
  return byId
}

/**
 * Whether the event presents itself as a SCRUTINY event.
 *
 * This is the §3 scope test, not a validity test: it asks only whether the event carries the fabric
 * tag at all. An event failing it is a plain Nostr event, outside this specification — which is a
 * different outcome from being an invalid SCRUTINY event.
 */
export function isScrutinyEvent(event: NostrEvent): boolean {
  return tTags(event).includes(FABRIC_TAG)
}

/**
 * The event's declared type, or `undefined` if it carries zero or several recognised type tags.
 *
 * Returning `undefined` for the several case is deliberate: TAG-3 requires exactly one, so an event
 * with two type tags has no well-defined type and must not be guessed at.
 */
export function scrutinyEventType(event: NostrEvent): ScrutinyEventType | undefined {
  const found = tTags(event).flatMap((t) => {
    const type = TYPE_BY_TAG.get(t)
    return type ? [type] : []
  })
  return found.length === 1 ? found[0] : undefined
}

/** Every `t` tag matching the version grammar. More than one violates TAG-2. */
export function versionTags(event: NostrEvent): string[] {
  return tTags(event).filter((t) => VERSION_TAG_PATTERN.test(t))
}

/** The event's version tag, or `undefined` unless it carries exactly one. */
export function versionTag(event: NostrEvent): string | undefined {
  const found = versionTags(event)
  return found.length === 1 ? found[0] : undefined
}

/** A version tag decomposed into its three fields (VER-1). */
export interface ProtocolVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** Parse a version tag, or `undefined` if it does not match the grammar. */
export function parseVersionTag(tag: string): ProtocolVersion | undefined {
  const match = VERSION_TAG_PATTERN.exec(tag)
  if (match === null) return undefined
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/**
 * Compare two version tags: negative if `a` precedes `b`, zero if equal, positive if `a` follows.
 *
 * VER-1 (amended in spec v0.7.0 — F14): ordering is a per-field numeric tuple comparison, never a
 * lexicographic or wholesale string comparison. The retired three-digit form's "zero-padded, so
 * lexicographic coincides with numeric" claim does not survive an unpadded field — this replaces it
 * rather than layering on top of it. Non-matching tags sort before all valid ones rather than
 * throwing.
 */
export function compareVersionTags(a: string, b: string): number {
  const va = parseVersionTag(a)
  const vb = parseVersionTag(b)
  if (va === undefined) return vb === undefined ? 0 : -1
  if (vb === undefined) return 1
  return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch
}

/** A parsed `i` tag value (§9). */
export interface Indexer {
  /** Lowercase ASCII prefix (IR-1), e.g. `cve`, `cpe`, `cc-cert-id`. */
  readonly prefix: string
  /**
   * The authority's canonical form, verbatim (IR-2).
   *
   * May itself contain colons: `cpe:2.3:h:infineon:...` parses to prefix `cpe` and value
   * `2.3:h:infineon:...`, because IR-3 splits on the first colon only.
   */
  readonly value: string
  /** The original tag value, unmodified. */
  readonly raw: string
}

/**
 * Parse an `i` tag value into prefix and value, splitting on the **first** colon only (IR-3).
 *
 * Returns `undefined` when there is no colon, when the prefix is empty, or when the prefix violates
 * IR-1's grammar. It does **not** check the prefix against §9's registry: IR-4 makes unknown
 * prefixes valid, and treating the registry as a closed set is a documented past failure (R13) —
 * the previous implementation's closed check rejected `pp`, `vendor`, `scheme`, `cc-cert-id`, and
 * `cc-scheme`, all of which appear in real data.
 */
export function parseIndexer(raw: string): Indexer | undefined {
  const colon = raw.indexOf(':')
  if (colon <= 0) return undefined
  const prefix = raw.slice(0, colon)
  if (!INDEXER_PREFIX_PATTERN.test(prefix)) return undefined
  return { prefix, value: raw.slice(colon + 1), raw }
}

/** Every well-formed `i` tag on the event. Malformed values are skipped, not repaired. */
export function indexers(event: NostrEvent): Indexer[] {
  return tagValues(event, 'i').flatMap((raw) => {
    const parsed = parseIndexer(raw)
    return parsed ? [parsed] : []
  })
}

/**
 * The event's `k` tags as a set.
 *
 * PR-4 and MD-4 require consumers to treat `k` as a set: producers MAY emit one `k` per `i`, which
 * duplicates values when several `i` tags share a prefix.
 */
export function indexerKinds(event: NostrEvent): Set<string> {
  return new Set(tagValues(event, 'k'))
}

/**
 * The distinct prefixes present in the event's `i` tags.
 *
 * PR-4/MD-4 let a consumer derive the kind from the `i` prefix, so a missing `k` tag costs
 * discoverability through the `#k` relay filter but never validity.
 */
export function derivedIndexerKinds(event: NostrEvent): Set<string> {
  return new Set(indexers(event).map((i) => i.prefix))
}
