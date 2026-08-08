/**
 * Branded extension points (D16) claimed by their first consumer.
 *
 * D16 names four branded interfaces (`RelayTransport`, `EventStorage`, `ScrutinySigner`,
 * `TrustProvider`); this file holds the ones an implemented module already consumes: `admit`
 * brought `TrustProvider` (D21), `store` brought `EventStorage` (D15/D37), and `RelayTransport`
 * landed here in Phase 17 (docs/RELAY-TRANSPORT.md). `ScrutinySigner` remains deferred to its
 * first consumer (the CLI, Phase 10).
 *
 * Not a subpath export (see the plan's exports map) — these types are re-exported from the root
 * barrel only.
 */

import type { NostrEvent } from './events.js'

/**
 * `Symbol.for` uses a global registry, so two copies of `core` in one dependency tree still
 * interoperate — the structural fix for NDK #312 (D16).
 */
export const trustSymbol = Symbol.for('@scrutiny-fabric/trust')

/**
 * A synchronous trust predicate over Nostr pubkeys (D21).
 *
 * `isTrusted` MUST be synchronous: `admit` traverses the observed set in one pass, and an async
 * predicate consulted mid-traversal would give torn reads. The mechanism behind trust (allowlist,
 * web-of-trust expansion, a reputation score) is out of scope for the specification (§6.1) and for
 * this interface — it assumes only that a pubkey can be classified trusted or not.
 *
 * `version` and `deltaSince` exist for the incremental recompute Phase 16 introduces
 * (trust-filtered views over trust changes, docs/TRUST-VIEW.md); nothing in the codebase calls
 * them today. `deltaSince` returning `null` means "rebuild from
 * scratch" and MUST be legal — a subtly wrong delta is worse than an occasional full rebuild.
 */
export interface TrustProvider {
  readonly [trustSymbol]: true
  isTrusted(pubkey: string): boolean
  readonly version: number
  deltaSince(v: number): { added: readonly string[]; removed: readonly string[] } | null
}

/**
 * `Symbol.for` uses a global registry — see {@link trustSymbol}'s comment; same rationale (D16).
 */
export const storageSymbol = Symbol.for('@scrutiny-fabric/storage')

/**
 * A NIP-01 relay filter. `query.ts` (Phase 6) builds and returns exactly this type rather than a
 * parallel shape of its own. **Flat**, per Phase 13 (`docs/AUDIT-2026-07-31.md` P2,
 * `PLAN-2026-08-01-rewrite-mandate.md` §1): NIP-01 filters carry single-letter tag filters
 * (`#e`, `#t`, `#i`, `#k`, …) as top-level `#`-prefixed keys, not nested under a `tags` field no
 * relay recognises — a filter shaped the old way silently degrades to "match everything" the moment
 * it reaches a real relay, since NIP-01 ignores unrecognised filter members.
 *
 * A `type` alias, not an `interface`, because only a `type` receives an implicit index signature in
 * TypeScript (confirmed by compiling both under this repo's own `--strict` TS 5.8) — an index
 * signature keyed on the `#${string}` tag pattern could not be added to an `interface` version of
 * this shape.
 * Arrays stay `readonly`, unlike nostr-tools/NDK/nostrify's mutable convention: TypeScript's
 * structural typing already makes this type assignable to and from theirs with zero copying, so
 * matching their mutability would buy nothing while breaking this project's own readonly-everywhere
 * discipline (`StoreState`, `AdmissionIndex`, `Resolution`) for no reason.
 */
export type EventFilter = {
  readonly ids?: readonly string[]
  readonly authors?: readonly string[]
  readonly kinds?: readonly number[]
  readonly since?: number
  readonly until?: number
  readonly limit?: number
  /** NIP-50 free-text search (DQ-3). Relay support is optional; ranking is relay-dependent. */
  readonly search?: string
} & { readonly [key: `#${string}`]: readonly string[] }

/**
 * The persistence port (D15/D37) — `store`'s first real consumer, the way `TrustProvider` was
 * `admit`'s. Sync-or-async return types throughout: the in-memory default (v0.1) resolves
 * immediately, and a future IndexedDB/SQLite adapter needs the same shape to be genuinely async
 * without a breaking change to callers — the entire point D15 is making. `includeDeleted` copies
 * welshman's repository shape: `isDeleted()` is a predicate over an always-retained event, never a
 * removal, which is what keeps DEL-4's audit-preservation guarantee achievable.
 */
export interface EventStorage {
  readonly [storageSymbol]: true
  put(events: readonly NostrEvent[]): Promise<void> | void
  query(
    filters: readonly EventFilter[],
    options?: { readonly includeDeleted?: boolean },
  ): Promise<readonly NostrEvent[]> | readonly NostrEvent[]
  get(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, NostrEvent>> | ReadonlyMap<string, NostrEvent>
}

/**
 * `Symbol.for` uses a global registry — see {@link trustSymbol}'s comment; same rationale (D16).
 */
export const transportSymbol = Symbol.for('@scrutiny-fabric/transport')

/**
 * The relay I/O port (D16) — the last of the four branded interfaces `core` declares, and the only
 * one with no implementation shipped anywhere, by design (D6): `core` never depends on a relay
 * library, so an adapter is always a copy-paste `examples/adapters/*` file, CI-tested but never
 * published. Callback plus an explicit unsubscribe closure, matching what nostr-tools, NDK,
 * applesauce, and nostrify all expose internally — a thin pass-through per adapter, never a
 * push-to-pull bridge.
 */
export interface RelayTransport {
  readonly [transportSymbol]: true

  /**
   * Subscribe across one or more relays under one logical subscription. `onEvent`'s second
   * parameter is the relay that delivered this particular copy of the event — present because
   * `store.ts`'s `IngestMeta.source` (D19) is reserved per ingest batch, and a multi-relay
   * `request()` is the only place that ever knows which relay a given event actually came from;
   * discarding that fact here makes `source` permanently unpopulatable for the multi-relay case.
   * This is not relay-provenance-for-censorship-detection (R9 rejected building that feature) — it
   * is not discarding a data point already free at the point it is produced.
   *
   * `onEose` fires once per relay, at whatever time that relay individually finishes replaying its
   * stored events for this subscription's filters — matching NIP-01's `EOSE` semantics, which are
   * per-relay per-subscription, never a combined signal. A caller that wants "every relay is now
   * live" derives it by counting distinct `relay` values against `relays.length`.
   *
   * Returns an explicit unsubscribe closure, `() => void`, rather than an object with a `.close()`
   * method or an `EventEmitter` — matches D16's callback-plus-unsubscribe precedent throughout.
   */
  request(
    relays: readonly string[],
    filters: readonly EventFilter[],
    onEvent: (event: NostrEvent, relay: string) => void,
    onEose?: (relay: string) => void,
  ): () => void

  /**
   * Mirrors NIP-01's `OK` message exactly, never a collapsed boolean. Every relay named in `relays`
   * MUST have a corresponding key in the resolved map — a relay that never sends `OK` before the
   * adapter's own deadline is reported as `{ ok: false, reason: 'timeout' }` (or an equivalently
   * descriptive string), never by omission. `reason` stays a plain, open `string` either way: a
   * relay's own rejection message (the fourth element of its `OK` frame) is free text, and a
   * timeout reason belongs in that same open vocabulary rather than a separate closed union.
   */
  publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly ok: boolean; readonly reason?: string }>>

  /**
   * NIP-45 `COUNT` is genuinely optional relay-side, so this stays an optional method, not
   * required-and-throwing. A relay present in `relays` but missing from the resolved map's keys, or
   * present with value `undefined`, means that relay did not answer `COUNT` — distinct from a real
   * count of `0`.
   */
  count?(
    relays: readonly string[],
    filters: readonly EventFilter[],
  ): Promise<ReadonlyMap<string, number | undefined>>
}
