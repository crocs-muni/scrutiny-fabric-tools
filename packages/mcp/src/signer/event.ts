/**
 * NIP-01 signing: id = sha256 of core's canonical serialisation, sig = BIP-340 over the id.
 * `created_at` is the caller's (spec §11.3); this function never reads a clock.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { type NostrEvent, type UnsignedEvent, computeEventId } from '@scrutiny-fabric/core'
import { publicKeyHex } from './keys.js'

const sha256Hex = (serialized: string): string => bytesToHex(sha256(utf8ToBytes(serialized)))

export function signEvent(template: UnsignedEvent, secret: Uint8Array): NostrEvent {
  const pubkey = publicKeyHex(secret)
  const unsigned = {
    pubkey,
    created_at: template.created_at,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  }
  const id = computeEventId({ ...unsigned, id: '', sig: '' }, sha256Hex)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret))
  return { id, ...unsigned, sig }
}
