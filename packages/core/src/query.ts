/**
 * §8 discovery and traversal — filter builders and result classifiers.
 *
 * Pure and synchronous: this module returns plain NIP-01 filter objects and classifies already-
 * fetched events. It never touches a relay — that is `RelayTransport`'s job, not this module's — and
 * it never calls {@link issue}: every rule it owns (DQ-1…4, BD-8) is D-layer, with no rejection or
 * annotation disposition to emit (see `docs/QUERY-BUILD.md` §1.4/§4, the same shape as `admit.ts`'s
 * AG3 partition).
 */

import { EVENT_TYPE_TAGS, FABRIC_TAG, eTags, scrutinyEventType } from './events.js'
import type { NostrEvent, ScrutinyEventType } from './events.js'
import type { EventFilter } from './interfaces.js'

/** Every SCRUTINY event uses this Nostr kind (§3). */
const SCRUTINY_KIND = 1

/** NIP-09 kind 5 deletions (§10). */
const DELETION_KIND = 5

// ---------------------------------------------------------------------------
// §8.1 — discovery
// ---------------------------------------------------------------------------

/**
 * §8.1 steps 1–2 — exact or broadened indexer lookup.
 *
 * Always includes `#t: ["scrutiny-fabric"]` (DQ-1). One indexer produces the "exact" shape; several
 * produce the "broader" shape — both are the same filter, since §8.1's own text describes multiple
 * `#i` values in one filter (Nostr's OR semantics), not multiple filter objects.
 */
export function indexerFilter(indexer: string | readonly string[]): EventFilter {
  const values = Array.isArray(indexer) ? indexer : [indexer]
  return {
    kinds: [SCRUTINY_KIND],
    tags: { '#t': [FABRIC_TAG], '#i': [...values] },
  }
}

/** §8.1 step 3 (DQ-3) — the NIP-50 free-text fallback. Verifying results is the caller's job. */
export function searchFilter(query: string): EventFilter {
  return {
    kinds: [SCRUTINY_KIND],
    tags: { '#t': [FABRIC_TAG] },
    search: query,
  }
}

/**
 * §8.1 step 4 — full scan. Defaults to both Product and Metadata; narrow to one when the target type
 * is known. Bindings and Patches are intentionally unreachable here — they carry no `i` tags, so a
 * full scan is not how they are discovered (§8.1's own text).
 */
export function fullScanFilter(types?: readonly ('product' | 'metadata')[]): EventFilter {
  const selected =
    types !== undefined && types.length > 0 ? types : (['product', 'metadata'] as const)
  return {
    kinds: [SCRUTINY_KIND],
    tags: { '#t': selected.map((t) => EVENT_TYPE_TAGS[t]) },
  }
}

// ---------------------------------------------------------------------------
// §8.2 — traversal
// ---------------------------------------------------------------------------

/**
 * §8.2 — Bindings referencing a Product or Metadata event, in either direction. The caller
 * distinguishes direction by inspecting the `e` tag marker on each result — {@link classifyByRole}.
 */
export function bindingsReferencing(eventId: string): EventFilter {
  return {
    kinds: [SCRUTINY_KIND],
    tags: { '#t': [EVENT_TYPE_TAGS.binding], '#e': [eventId] },
  }
}

/**
 * §8.2 (DQ-2) — deletions targeting a given event. No `#t` filter: kind 5 events do not carry a
 * `scrutiny-fabric` tag (§3.2), so including one would silently return zero results.
 */
export function deletionsFor(eventId: string): EventFilter {
  return {
    kinds: [DELETION_KIND],
    tags: { '#e': [eventId] },
  }
}

/** One event's role relative to a queried anchor id — {@link classifyByRole}'s per-result output. */
export interface RoleMatch {
  readonly event: NostrEvent
  /** The NIP-10 marker (`root`, `link`, `reply`, …) the matching `e` tag carries. */
  readonly marker: string
}

/**
 * DQ-4 — classify `{"#e": [anchorId]}` traversal results by role.
 *
 * Stated once in the general form, since §8.2's Binding examples (`root`/`link`) and a Patch's own
 * `root`/`reply` markers are the same shape: filter by the expected `scrutiny-*` type (kind 1 alone
 * does not distinguish a Binding from a Patch), then report which marker each surviving event's `e`
 * tag naming `anchorId` carries. An unmarked `e` tag naming the anchor is excluded — DQ-4 asks for a
 * *role*, and an unmarked tag carries none.
 */
export function classifyByRole(
  events: readonly NostrEvent[],
  anchorId: string,
  expectedType?: ScrutinyEventType,
): RoleMatch[] {
  const out: RoleMatch[] = []
  for (const event of events) {
    if (expectedType !== undefined && scrutinyEventType(event) !== expectedType) continue
    const match = eTags(event).find((tag) => tag.id === anchorId && tag.marker !== undefined)
    if (match?.marker !== undefined) out.push({ event, marker: match.marker })
  }
  return out
}
