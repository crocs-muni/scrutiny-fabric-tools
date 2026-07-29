/**
 * Extension points not yet owned by any implemented module.
 *
 * D16 names four branded interfaces (`RelayTransport`, `EventStorage`, `ScrutinySigner`,
 * `TrustProvider`); this file grows to hold whichever of them a module needs first. `admit` is the
 * first consumer, so only `TrustProvider` (D21) lives here so far. The other three belong to
 * `query`/`store`/`build` respectively, whichever phase needs them first.
 *
 * Not a subpath export (see the plan's exports map) — these types are re-exported from the root
 * barrel only.
 */

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
