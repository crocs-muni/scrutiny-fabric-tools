/**
 * `@scrutiny-fabric/core` — reference implementation of the SCRUTINY Fabric protocol.
 *
 * Target specification: **v0.6.0** (`scrutiny-v060`), 134 normative rules.
 *
 * This root barrel is the primary documented import (D5). Subpath exports exist only where they buy
 * a consumer graph exclusion, never as organisation.
 *
 * Two structural properties of this package, both load-bearing:
 *
 * - It contains no cryptography and never handles a secret key (D12). Where a hash is needed, the
 *   caller injects it — see {@link eventIdMatches}.
 * - It performs no IO. Relay access, storage, and signing are the caller's, behind interfaces.
 */

/** The specification version this implementation targets. */
export const SPEC_VERSION = '0.6.0'

/**
 * The version `t` tag this implementation emits (TAG-2, VER-1).
 *
 * The three digits encode MAJOR/MINOR/PATCH, so lexicographic comparison of the suffix coincides
 * with semantic ordering. Note that this is the version we *write*; it is never used to filter
 * events on read, and MUST NOT appear in a relay filter — doing so silently drops every
 * higher-version event, violating VER-4 invisibly.
 */
export const VERSION_TAG = 'scrutiny-v060'
