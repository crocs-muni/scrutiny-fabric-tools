/**
 * Reference signer implementation for SCRUTINY Fabric using @noble/curves + @noble/hashes.
 *
 * This is a **copy-paste reference**, not a published dependency (D6). Consumers may adopt this
 * exact code, adapt it to their own crypto stack, or use an entirely different library — the core
 * packages never depend on any specific signing implementation.
 *
 * **Why this lives in `examples/`, not `packages/`:**
 * - D12: `packages/* /src` must remain crypto-free. Signing requires secp256k1/schnorr, which would
 *   violate that invariant if imported from core.
 * - D13: `build.ts` emits UNSIGNED templates (`UnsignedEvent = {kind, created_at, tags, content}`);
 *   the signer injects `id`, `pubkey`, and `sig`.
 * - D18: The `verify` function here matches `CreateStoreOptions.verify` shape exactly, so it plugs
 *   straight into `createStore({ verify })`.
 *
 * Never put a secret key into core code or commit one to version control. This example generates
 * one on first run if none is provided, but production usage should inject a securely stored key.
 */

import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import type { NostrEvent, UnsignedEvent } from '@scrutiny-fabric/core/events.js'
import { serializeForId } from '@scrutiny-fabric/core/id.js'

/**
 * Create a signer instance.
 *
 * @param secretKey - 32-byte secret key in hex string format. If omitted, a fresh random key is
 *   generated. **Warning:** Generated keys are ephemeral; for production, inject a securely stored
 *   key rather than generating one at runtime.
 * @returns An object with `publicKey` (hex string) and `sign(template)` method.
 *
 * **D13 compliance:** The `sign` method receives an `UnsignedEvent` and returns a full `NostrEvent`
 * with `id`, `pubkey`, and `sig` injected.
 *
 * **CA-1 note:** `created_at` is the publish time, NOT the timestamp of the fact being recorded.
 * Historical facts belong in the `content` field, not in `created_at`.
 */
export function createSigner(secretKey?: string | Uint8Array): {
  publicKey: string
  sign(template: UnsignedEvent): NostrEvent
} {
  let skBytes: Uint8Array

  if (secretKey === undefined) {
    // Generate a fresh random secret key (ephemeral — not for production use)
    skBytes = schnorr.utils.randomPrivateKey()
  } else if (typeof secretKey === 'string') {
    skBytes = hexToBytes(secretKey)
  } else {
    skBytes = secretKey
  }

  const publicKey = bytesToHex(schnorr.getPublicKey(skBytes))

  /**
   * Sign an unsigned event template.
   *
   * Computes the NIP-01 event id via `serializeForId` + SHA-256, then BIP-340 Schnorr-signs the
   * 32-byte id hash. Returns the complete `NostrEvent` ready for publication.
   *
   * @param template - The unsigned event from `buildProduct`, `buildPatch`, etc.
   * @returns A fully signed `NostrEvent` with `id`, `pubkey`, and `sig` fields populated.
   */
  function sign(template: UnsignedEvent): NostrEvent {
    // Full-shaped event for the id computation — serializeForId reads only the serialized
    // fields (id/sig ignored), so placeholder values keep this honest without a cast.
    const eventForId: NostrEvent = {
      ...template,
      pubkey: publicKey,
      id: '',
      sig: '',
    }
    // Serialize per NIP-01 and compute id hash
    const serialized = serializeForId(eventForId)
    const idHash = sha256(utf8ToBytes(serialized))
    const id = bytesToHex(idHash)

    // BIP-340 Schnorr signature over the 32-byte id hash
    const sigBytes = schnorr.sign(idHash, skBytes)
    const sig = bytesToHex(sigBytes)

    // Structurally satisfies NostrEvent — no assertion needed.
    return {
      ...template,
      id,
      pubkey: publicKey,
      sig,
    }
  }

  return { publicKey, sign }
}

/**
 * Verify a signed Nostr event.
 *
 * Performs both checks required by SIG-1:
 * 1. Recompute the event id via `serializeForId` + SHA-256 and compare against the declared `id`.
 * 2. Verify the Schnorr signature over the id hash using the event's `pubkey`.
 *
 * @param event - The signed event to verify.
 * @returns `true` if both checks pass, `false` otherwise.
 *
 * **D18 compliance:** This function matches the `CreateStoreOptions.verify` shape exactly:
 * `(event: NostrEvent) => boolean`. Plug it directly into `createStore({ verify: verifyEvent })`.
 *
 * **D12/D13 context:** Core packages export `serializeForId` precisely so callers can implement
 * verification without duplicating the serialization logic. The cryptographic primitives live here
 * in `examples/`, never in `packages/* /src`.
 */
export function verifyEvent(event: NostrEvent): boolean {
  // One hash serves both checks: the declared id must equal sha256(serialized), and the
  // signature is verified over that same 32-byte hash.
  const serialized = serializeForId(event)
  const idHash = sha256(utf8ToBytes(serialized))
  const computedId = bytesToHex(idHash)

  if (computedId.toLowerCase() !== event.id.toLowerCase()) {
    return false
  }
  try {
    const pubKeyBytes = hexToBytes(event.pubkey)
    const sigBytes = hexToBytes(event.sig)
    return schnorr.verify(sigBytes, idHash, pubKeyBytes)
  } catch {
    return false
  }
}

/**
 * Convert a raw 32-byte secret key to hex string.
 *
 * Utility for testing or when you need to persist/load keys. Never log or commit secret keys.
 */
export function secretKeyToHex(skBytes: Uint8Array): string {
  return bytesToHex(skBytes)
}

/**
 * Generate a fresh random 32-byte secret key.
 *
 * **Warning:** Ephemeral key only. For production, use a secure key storage mechanism instead.
 */
export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomPrivateKey()
}
