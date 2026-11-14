/**
 * Dev-key signing and signature verification — the sanctioned port of `examples/signers/` (D6).
 *
 * #108 A2 replaces the scaffold's pubkey-only stub with this backend for `NSEC`/`NSEC_FILE`, the
 * dev-grade path; the pilot path remains a NIP-46 bunker that never puts key material in this
 * process. Both backends expose one `sign(unsigned)` shape, so A4's publisher never learns which
 * one it holds (D13).
 *
 * Crypto comes exclusively from the `@noble` stack, as `examples/signers/noble-signer.ts` argues
 * (D6): @noble/curves for BIP-340, @noble/hashes for SHA-256. Core is not reimplemented here — the
 * canonical NIP-01 serialization and event id come from `@scrutiny-fabric/core`, which is crypto-
 * free by design (D12) and exports `serializeForId`, `computeEventId` and `eventIdMatches` for
 * exactly this caller.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  type NostrEvent,
  type Sha256Hex,
  type UnsignedEvent,
  computeEventId,
  eventIdMatches,
} from '@scrutiny-fabric/core'

const HEX64 = /^[0-9a-f]{64}$/u
const HEX128 = /^[0-9a-f]{128}$/u

/**
 * The relay's freshness window, spelled out because a signer that hands the relay an event it will
 * reject has already burned the bunker round-trip. Values mirror the deployed gate:
 *
 * - `maxFutureAge = 15 * time.Minute` in `relay/internal/relay/relay.go`.
 * - `SCRUTINY_MAX_EVENT_PAST_AGE` defaults to `2h` in `relay/README.md`; a deployment may widen it
 *   for backfills, which is why the past side names the variable in its error.
 *
 * No network call is involved: the comparison is against this machine's clock, so the error can
 * say *how far* the clock (or template) is off.
 */
export const RELAY_MAX_PAST_AGE_SECONDS = 2 * 60 * 60
export const RELAY_MAX_FUTURE_AGE_SECONDS = 15 * 60

/** A `created_at` the relay gate would reject — raised before signing, never after. */
export class CreatedAtWindowError extends Error {
  /** Signed seconds: positive means ahead of the local clock, negative means behind it. */
  readonly offsetSeconds: number

  constructor(offsetSeconds: number, detail: string) {
    super(detail)
    this.name = 'CreatedAtWindowError'
    this.offsetSeconds = offsetSeconds
  }
}

/**
 * Reject a template the relay would refuse, naming the measured offset (relay gate paths above).
 *
 * `now` is a parameter so tests are not coupled to the wall clock; every production caller omits
 * it. A past timestamp is usually a stale template, a future one is usually a skewed clock, and
 * the message says which side and by how much rather than "invalid created_at".
 */
export function assertCreatedAtWithinRelayWindow(
  createdAt: number,
  now: number = Math.floor(Date.now() / 1000),
): void {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error(`created_at must be a non-negative integer unix timestamp — got ${createdAt}`)
  }
  const offset = createdAt - now
  if (offset > RELAY_MAX_FUTURE_AGE_SECONDS) {
    throw new CreatedAtWindowError(
      offset,
      `created_at is ${offset} s ahead of this machine's clock; the relay accepts at most ${RELAY_MAX_FUTURE_AGE_SECONDS} s into the future (maxFutureAge, relay/internal/relay/relay.go) — check this machine’s clock`,
    )
  }
  if (offset < -RELAY_MAX_PAST_AGE_SECONDS) {
    throw new CreatedAtWindowError(
      offset,
      `created_at is ${-offset} s behind this machine's clock; the relay rejects events older than ${RELAY_MAX_PAST_AGE_SECONDS} s (SCRUTINY_MAX_EVENT_PAST_AGE default, relay/README.md) — use a fresh template, or check this machine’s clock if it should be current`,
    )
  }
}

/**
 * The monotonic stamp a sequential publisher should use.
 *
 * Core has no such helper: its builders are pure, and the mirror's batch clock is local to its
 * selftest. A4 publishes one event per tool call, so the next template must sort after the previous
 * one even when both land in the same second (`kind: 0` is replaceable, deletions are not). Returns
 * `max(now, previous + 1)` and runs the same relay-window guard, so a long batch fails loudly
 * before it drifts past the future limit instead of being rejected event by event.
 */
export function nextCreatedAt(
  previous: number | undefined,
  now: number = Math.floor(Date.now() / 1000),
): number {
  const createdAt = previous === undefined ? now : Math.max(now, previous + 1)
  assertCreatedAtWithinRelayWindow(createdAt, now)
  return createdAt
}

/** NIP-01's `id` is `sha256(serializeForId(event))`, hex; core takes the hash as a parameter. */
export const sha256Hex: Sha256Hex = (serialized) => bytesToHex(sha256(utf8ToBytes(serialized)))

/** The D13 signer: `publicKey` plus `sign(template)` that injects `id`/`pubkey`/`sig`. */
export interface DevKeySigner {
  /** BIP-340 x-only pubkey, lowercase hex. */
  readonly publicKey: string
  /** Fill the three signed fields. Rejects first if the relay gate would reject `created_at`. */
  sign(template: UnsignedEvent): NostrEvent
}

/**
 * Build a signer from 32 secret-key bytes. The reference implementation this ports accepts a hex
 * string too; the MCP server decodes `NSEC`/`NSEC_FILE` in `config.ts`, so bytes are the only form
 * that reaches a signing module here and the secret is never re-encoded.
 */
export function createDevKeySigner(secretKey: Uint8Array): DevKeySigner {
  if (secretKey.length !== 32) {
    throw new Error(`expected 32 secret-key bytes, got ${secretKey.length}`)
  }
  let publicKey: string
  try {
    publicKey = bytesToHex(schnorr.getPublicKey(secretKey))
  } catch {
    // Includes the out-of-range scalar case; never echo the material, it is the one secret here.
    throw new Error('not a valid secp256k1 secret — regenerate it')
  }

  function sign(template: UnsignedEvent): NostrEvent {
    // Before signing, not after: a NIP-46 bunker would have prompted the user for nothing.
    assertCreatedAtWithinRelayWindow(template.created_at)
    // serializeForId reads the six NIP-01 fields only, so placeholders keep this cast-free.
    const eventForId: NostrEvent = { ...template, pubkey: publicKey, id: '', sig: '' }
    const id = computeEventId(eventForId, sha256Hex)
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
    return { ...template, id, pubkey: publicKey, sig }
  }

  return { publicKey, sign }
}

function isTagList(value: unknown): value is readonly (readonly string[])[] {
  return (
    Array.isArray(value) &&
    value.every((tag) => Array.isArray(tag) && tag.every((entry) => typeof entry === 'string'))
  )
}

/**
 * Structural NIP-01 check. Separate from {@link verifySignedEvent} because a hostile relay frame
 * should be *dropped*, not reported as an id mismatch, while a signed result from a signer is a
 * protocol failure worth naming.
 */
export function isSignedEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<Record<keyof NostrEvent, unknown>>
  return (
    typeof event.id === 'string' &&
    HEX64.test(event.id) &&
    typeof event.pubkey === 'string' &&
    HEX64.test(event.pubkey) &&
    typeof event.created_at === 'number' &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at >= 0 &&
    typeof event.kind === 'number' &&
    Number.isSafeInteger(event.kind) &&
    event.kind >= 0 &&
    isTagList(event.tags) &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string' &&
    HEX128.test(event.sig)
  )
}

/**
 * The full SIG-1 check: the declared `id` must hash from the event's own six fields (a
 * signature-only check cannot see a relay that rewrote `content`), and `sig` must be a valid
 * BIP-340 signature over that id by `pubkey`. Used on every bunker response before its content is
 * trusted or decrypted (NIP-44's "the outer signature MUST be validated before decrypting").
 */
export function verifySignedEvent(event: unknown): event is NostrEvent {
  if (!isSignedEvent(event)) return false
  if (!eventIdMatches(event, sha256Hex)) return false
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}
