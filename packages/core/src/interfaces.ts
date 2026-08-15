/**
 * Extension points not yet owned by any implemented module.
 *
 * D16 names four branded interfaces (`RelayTransport`, `EventStorage`, `ScrutinySigner`,
 * `TrustProvider`); this file grows to hold whichever of them a module needs first. `admit` was the
 * first consumer (`TrustProvider`, D21); `store` is the second (`EventStorage`, D15/D37).
 * `RelayTransport`/`ScrutinySigner` belong to whichever of `query`/`build` needs them first.
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
 * `version` and `deltaSince` exist for Phase 5's incremental recompute against `trustEpoch` (D24)
 * and are not called anywhere in Phase 4. `deltaSince` returning `null` means "rebuild from
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
 * TypeScript (confirmed by compiling both under this repo's own `--strict` TS 5.8) — `` { [key:
 * `#${string}`]: readonly string[] } `` could not be added to an `interface` version of this shape.
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
