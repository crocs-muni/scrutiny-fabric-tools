/**
 * NIP-01 event-id serialization and the recompute half of SIG-1.
 *
 * This module is why `core` can check that an event's `id` matches its contents while containing no
 * cryptography: the hash is a parameter (D12, D14). There is no code path here that accepts a
 * secret key, and none that imports a crypto library.
 */

import type { NostrEvent } from './events.js'

/**
 * A SHA-256 implementation supplied by the caller.
 *
 * Takes the canonical serialization and returns its SHA-256 as **lowercase hex**. The
 * implementation is responsible for UTF-8 encoding the string before hashing — that is the encoding
 * NIP-01 specifies.
 *
 * With `@noble/hashes`:
 *
 * ```ts
 * import { sha256 } from '@noble/hashes/sha2'
 * import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
 *
 * const hash: Sha256Hex = (s) => bytesToHex(sha256(utf8ToBytes(s)))
 * ```
 */
export type Sha256Hex = (serialized: string) => string

/**
 * The NIP-01 canonical serialization an event's `id` is the SHA-256 of.
 *
 * NIP-01 defines this as the JSON array `[0, pubkey, created_at, kind, tags, content]` with no
 * whitespace.
 *
 * **`JSON.stringify` is the correct implementation, not an approximation.** This was investigated
 * twice and the "write a custom serializer" conclusion retracted both times (R11). NIP-01's rule —
 * seven short escapes, all other characters verbatim — exists to defeat encoder-specific escaping
 * such as Go's HTML escaping or .NET's non-ASCII escaping, both of which `JSON.stringify` avoids.
 * `nostr-tools`' `serializeEvent` *is* `JSON.stringify`, which makes this correct by ecosystem
 * definition: matching the ecosystem is the actual requirement, since a serialization disagreement
 * shows up as an id mismatch on every event.
 *
 * The one real asymmetry is lone surrogates, which have no valid UTF-8 encoding; `validate.ts`
 * rejects those in patch payloads under P3.
 */
export function serializeForId(event: NostrEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
}

/**
 * Compute the NIP-01 event id for an event's current contents.
 *
 * Public because the bulk publisher needs ids *before* signing (D14): Bindings reference their
 * endpoints by id, and patch N+1's `e reply` references patch N's id. Without local id computation
 * a 20k-event corpus must be serialised through the signer one event at a time — tolerable for a
 * CLI holding a raw key, brutal over NIP-46.
 *
 * The `id` field of the passed event is ignored; only the six signed fields participate.
 */
export function computeEventId(event: NostrEvent, sha256: Sha256Hex): string {
  return sha256(serializeForId(event))
}

/**
 * Whether the event's declared `id` matches the SHA-256 of its own contents.
 *
 * This is one of the two checks SIG-1 requires, and the one that is easy to omit. Verifying the
 * signature alone is **not** sufficient: the signature commits to the `id`, which is a hash, so a
 * relay can alter `content` or `tags` while keeping the original `id` and `sig`, and a
 * signature-only check still passes. Only recomputing catches it.
 *
 * The other half — that `sig` is a valid Schnorr signature over `id` for `pubkey` — needs
 * cryptography and therefore lives outside this package, in the `verify` function the caller
 * supplies at store construction (D18). SIG-1 applies to **every event consumed**, including kind 5
 * deletions and kind 1040 attestations, not only events carrying a `scrutiny-fabric` tag: an
 * unverified deletion is indistinguishable from a forged one.
 *
 * Comparison is case-insensitive on the hex, since NIP-01 ids are conventionally lowercase but the
 * comparison should not turn on that.
 */
export function eventIdMatches(event: NostrEvent, sha256: Sha256Hex): boolean {
  return event.id.toLowerCase() === computeEventId(event, sha256).toLowerCase()
}
