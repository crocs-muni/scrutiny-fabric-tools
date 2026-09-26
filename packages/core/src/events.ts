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

/** NIP-09 kind 5 deletions (§10). The single named source, exactly as {@link SCRUTINY_KIND} is for kind 1. */
export const DELETION_KIND = 5

/**
 * Version tag grammar (TAG-2, amended in spec v0.7.0 — F14).
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

/** The id an event's `e reply` marker points at, if any. Shared by `resolve.ts` and `store.ts`. */
export function replyTarget(event: NostrEvent): string | undefined {
  return eTagsWithMarker(event, 'reply')[0]?.id
}

/**
 * NIP-92 media-attachment (`imeta`) tags (§3.1, §4.6). The single named source, exactly as
 * {@link FABRIC_TAG} is for `scrutiny-fabric`.
 */
export const IMETA_TAG = 'imeta'

/**
 * `new URL` is a WHATWG global in every runtime this package targets, but the shipped build
 * withholds both DOM and Node globals (`tsconfig.build.json` sets `"types": []` so a stray
 * `process` or `Buffer` fails the build), so the constructor is declared here with exactly the two
 * members the url gate reads. The parse result is used for validation only — never emitted, never
 * normalized into the output.
 */
declare const URL: new (url: string) => { readonly protocol: string; readonly hostname: string }

/** NIP-94 `x` field grammar on input: a 64-digit hex SHA-256 digest, either case. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i

/**
 * NIP-94 `size` field grammar: a decimal digit string. Never converted to a number — leading
 * zeros and values beyond 2^53 survive losslessly, and conversion is the consumer's choice (the
 * same digit-string posture VER-1 takes).
 */
const SIZE_DECIMAL_PATTERN = /^\d+$/

/**
 * One NIP-92 payload attachment parsed from a single `imeta` tag (§3.1, §4.6).
 *
 * Parsed, not verified: every field is the publisher's *claim*, verbatim from the tag. §4.6's
 * verification obligations (IM-1's hash check, IM-2's size check) need fetched bytes, so this type
 * carries no verdict about them — a missing field means "not declared (in usable form)", never
 * "failed verification".
 */
export interface ArtifactRef {
  /**
   * The tag's first syntactically valid `url` entry, verbatim as declared — never normalized,
   * percent-decoded, or case-folded. Guaranteed to parse as `http:`/`https:` with a non-empty
   * hostname; anything beyond that (dedupe across tags or mirrors, display, fetch) is the
   * consumer's job — collapsing duplicates is a presentation concern (BD-11).
   */
  readonly url: string
  /**
   * The first `m` (MIME type) entry, verbatim. Unvalidated NIP-94 vocabulary; absent when the tag
   * declares no non-empty value.
   */
  readonly mime?: string
  /**
   * The first `x` entry, lowercased — present only when it is a 64-hex SHA-256 digest
   * (`/^[0-9a-f]{64}$/i`); any other value is omitted. IM-1's byte-level comparison against the
   * fetched artifact is the consumer's job.
   */
  readonly sha256?: string
  /**
   * The first `size` entry as decimal *text* (`/^\d+$/`, otherwise omitted). Never `Number`ed:
   * leading zeros and values beyond 2^53 survive losslessly, and an IM-2 consumer's numeric
   * conversion is that consumer's choice (same posture as VER-1's digit strings).
   */
  readonly size?: string
  /**
   * The first `alt` entry, verbatim, with no length guard in core — any display-length policy is
   * consumer-side. Absent when the value is empty.
   */
  readonly alt?: string
}

/**
 * Every `imeta` attachment on the event, in document order — one {@link ArtifactRef} per tag whose
 * name matches {@link IMETA_TAG} exactly (TAG-4).
 *
 * This is the read half of §3.1/§4.6's NIP-92 attachment tier: imeta attachments are OPTIONAL on
 * Products and Metadata (PR-5, MD-5) and need not be referenced in `content` (IM-5). Because §3.1
 * makes NIP-92 itself OPTIONAL, NIP-92's "MUST have a `url`, and at least one other field" is not
 * inherited as a validity rule here: a url-only tag yields a bare ref, and a malformed tag is
 * skipped rather than rejected — nothing in this module rejects (that is `validate.ts`'s job), and
 * no SCRUTINY rule makes a bad imeta tag V-invalid.
 *
 * Grammar (NIP-92's "each entry is a space-delimited key/value pair"): entries after the tag name
 * split on the FIRST space only, so values may contain spaces (see `alt`); keys case-fold to
 * lowercase; values are kept verbatim; empty-string values never claim a key. Within one tag the
 * first occurrence claims each key, except `url`, whose first *syntactically valid* entry wins —
 * IM-3's multi-url mirrors: an unusable mirror is skipped at parse time, while §4.6's "accept the
 * first whose fetched bytes match the declared `x` hash" is fetch-time behaviour this sans-IO
 * module cannot perform. Entries with no embedded space, or a space at offset 0, are skipped.
 * Unrecognised keys — including NIP-94's dim/blurhash/thumb/image/summary/ox/magnet/i/fallback/
 * service — are ignored (TAG-5's tolerant posture).
 *
 * A tag contributes NOTHING — never a partial fabrication — unless some `url` entry parses
 * (`new URL`) with an `http:`/`https:` scheme and a non-empty hostname; protocol-relative,
 * `data:`, `javascript:`, and other-scheme values all fail that gate.
 *
 * Output is one ref per tag, in document order, with no dedupe and no cross-tag normalization —
 * §4.6 mirrors and BD-11 both make that the consumer's job.
 *
 * Non-goals: fetching, hash/size verification, and display. IM-1..IM-4 are NOT discharged here;
 * a consumer that displays or processes these artifacts owes IM-4's "MUST warn before displaying
 * or processing unverified artifacts" itself.
 */
export function imetaArtifacts(event: NostrEvent): ArtifactRef[] {
  const out: ArtifactRef[] = []
  for (const tag of event.tags) {
    if (tag[0] !== IMETA_TAG) continue
    let url: string | undefined
    const claimed = new Map<string, string>()
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i]
      if (entry === undefined) continue
      const sp = entry.indexOf(' ')
      if (sp <= 0) continue
      const key = entry.slice(0, sp).toLowerCase()
      const value = entry.slice(sp + 1)
      if (value === '') continue
      if (key === 'url') {
        if (url === undefined && isHttpUrlValue(value)) url = value
      } else if (!claimed.has(key)) {
        claimed.set(key, value)
      }
    }
    if (url === undefined) continue
    const mime = claimed.get('m')
    const x = claimed.get('x')
    const size = claimed.get('size')
    const alt = claimed.get('alt')
    out.push({
      url,
      ...(mime !== undefined ? { mime } : {}),
      ...(x !== undefined && SHA256_HEX_PATTERN.test(x) ? { sha256: x.toLowerCase() } : {}),
      ...(size !== undefined && SIZE_DECIMAL_PATTERN.test(size) ? { size } : {}),
      ...(alt !== undefined ? { alt } : {}),
    })
  }
  return out
}

/** The url gate: an `http:`/`https:` scheme and a non-empty hostname; nothing more is asserted. */
function isHttpUrlValue(value: string): boolean {
  let parsed: { readonly protocol: string; readonly hostname: string }
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
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

/** Legacy version tags accepted as their semver meaning (TAG-2). The
 * fixed-width v0.7.0 retirement assumed no real corpus existed — the
 * scrutiny-mvp demo relay disproves that (`scrutiny-v059` data in active
 * dev use). Grandfathered entry; new corpora must use the semver grammar.
 * Remove when the demo corpus is regenerated or retired. */
export const LEGACY_VERSION_TAGS: ReadonlyMap<string, ProtocolVersion> = new Map([
  ['scrutiny-v059', { major: '0', minor: '5', patch: '9' }],
])

/** Every `t` tag matching the version grammar OR the legacy map. More than one violates TAG-2. */
export function versionTags(event: NostrEvent): string[] {
  return tTags(event).filter((t) => VERSION_TAG_PATTERN.test(t) || LEGACY_VERSION_TAGS.has(t))
}

/** The event's version tag, or `undefined` unless it carries exactly one. */
export function versionTag(event: NostrEvent): string | undefined {
  const found = versionTags(event)
  return found.length === 1 ? found[0] : undefined
}

/**
 * A version tag decomposed into its three fields (VER-1).
 *
 * Fields are kept as decimal **text**, never converted to `Number`: §3 imposes no digit-count
 * ceiling on any field, and `Number` would silently lose integer precision above 2^53 —
 * `Number('9007199254740993') === Number('9007199254740992')`. Callers needing arithmetic convert
 * explicitly and own that choice; ordering ({@link compareVersionTags}) never pays it.
 */
export interface ProtocolVersion {
  readonly major: string
  readonly minor: string
  readonly patch: string
}

/** Parse a version tag (legacy aliases included), or `undefined` if it matches neither grammar. */
export function parseVersionTag(tag: string): ProtocolVersion | undefined {
  const legacy = LEGACY_VERSION_TAGS.get(tag)
  if (legacy !== undefined) return legacy
  const match = VERSION_TAG_PATTERN.exec(tag)
  if (match === null) return undefined
  const [, major, minor, patch] = match
  // Stryker disable next-line ConditionalExpression: `noUncheckedIndexedAccess` type-narrowing —
  // VERSION_TAG_PATTERN's three capture groups always yield defined strings on a non-null match,
  // so this guard is unreachable at runtime but required for TS to see defined types.
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return { major, minor, patch }
}

/**
 * Arbitrary-precision numeric comparison of one unpadded decimal field: strip leading zeros (so
 * `007` and `7` compare equal — the grammar admits them even though producers emit unpadded),
 * then longer digit string wins, then lexicographic. The canonical width-independent algorithm —
 * `cmp`-style digit-string comparison used by Go's `x/mod/semver` (`compareInt`), RPM's
 * `rpmvercmp`, and glibc's `strverscmp` for exactly this problem.
 */
function compareVersionField(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '')
  const y = b.replace(/^0+(?=\d)/, '')
  if (x.length !== y.length) return x.length < y.length ? -1 : 1
  if (x === y) return 0
  return x < y ? -1 : 1
}

/**
 * Compare two version tags: negative if `a` precedes `b`, zero if equal, positive if `a` follows.
 *
 * VER-1 (amended in spec v0.7.0 — F14): ordering is a per-field numeric tuple comparison, never a
 * lexicographic or wholesale string comparison. The retired three-digit form's "zero-padded, so
 * lexicographic coincides with numeric" claim does not survive an unpadded field — this replaces it
 * rather than layering on top of it. Per-field comparison is width-independent by construction
 * (see `compareVersionField`) — `scrutiny-v9007199254740993.0.0` sorts strictly after
 * `scrutiny-v9007199254740992.0.0`, which `Number`-based comparison could not tell apart.
 * Non-matching tags sort before all valid ones rather than throwing.
 */
export function compareVersionTags(a: string, b: string): number {
  const va = parseVersionTag(a)
  const vb = parseVersionTag(b)
  if (va === undefined) return vb === undefined ? 0 : -1
  if (vb === undefined) return 1
  return (
    compareVersionField(va.major, vb.major) ||
    compareVersionField(va.minor, vb.minor) ||
    compareVersionField(va.patch, vb.patch)
  )
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
