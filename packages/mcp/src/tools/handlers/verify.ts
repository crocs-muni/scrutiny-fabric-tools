/**
 * `verify_event` and the byte-comparison every publish uses for its inline check (#108 A4).
 *
 * NIP-01 ids are content hashes: an event whose six signed fields all match is byte-identical to
 * the one that was signed, whatever order the relay's JSON encoder emits the keys in. Comparing
 * ids alone would accept a forged stored event with the same id and a different `sig`; comparing
 * `JSON.stringify` would reject a correct event because a relay reordered keys. So the check is
 * field-by-field over the six signed fields — the same six `serializeForId` hashes.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type NostrEvent, computeEventId } from '@scrutiny-fabric/core'
import type { z } from 'zod'
import { sha256Hex, verifySignedEvent } from '../../identity/sign.ts'
import type { RelayClient } from '../../relay/client.ts'
import type { verifyEventInput } from '../schemas.ts'
import { type HandlerContext, failure, jsonResult } from './context.ts'

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/** True when two events are the same NIP-01 bytes: all six signed fields, tag rows included. */
function sameEvent(a: NostrEvent, b: NostrEvent): boolean {
  return (
    a.id === b.id &&
    a.pubkey === b.pubkey &&
    a.created_at === b.created_at &&
    a.kind === b.kind &&
    a.content === b.content &&
    a.sig === b.sig &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => sameValues(tag, b.tags[index] ?? []))
  )
}

export interface StoredCheck {
  readonly verified: boolean
  /** What to do next when `verified` is false; absent on success. */
  readonly note?: string
}

/**
 * Fetch the just-published event back and compare it with what was signed. A failed read is
 * reported, never swallowed: the publish may have landed, and only `verify_event` can tell.
 */
export async function verifyStored(client: RelayClient, signed: NostrEvent): Promise<StoredCheck> {
  try {
    const stored = await client.fetchById(signed.id)
    if (stored === null) {
      return {
        verified: false,
        note: `the relay accepted the event but REQ {"ids":["${signed.id}"]} returned nothing; call verify_event with this id before treating the publish as complete`,
      }
    }
    if (!sameEvent(stored, signed)) {
      return {
        verified: false,
        note: 'the stored event differs from the signed one; call verify_event with this id and compare content, tags and signature before trusting it',
      }
    }
    return { verified: true }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return {
      verified: false,
      note: `the read-back failed (${reason}); call verify_event with this id — the publish outcome is not proven until the relay hands the event back`,
    }
  }
}

/**
 * Fetch one event by id and report what the relay stored, with the two checks a consumer owes:
 * the id must hash from the event's own fields, and the signature must verify (`verifySignedEvent`,
 * SIG-1). A missing event is a normal answer, not an MCP error.
 */
export async function verifyEvent(
  input: z.output<typeof verifyEventInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  let stored: NostrEvent | null
  try {
    stored = await ctx.relay().fetchById(input.event_id)
  } catch (cause) {
    return failure('verify_event', cause)
  }
  if (stored === null) {
    return jsonResult({
      found: false,
      event_id: input.event_id,
      event: null,
      note: 'the relay has no event under this id (EOSE with nothing); check the id, or publish again if it was never accepted',
    })
  }
  const idMatches = stored.id.toLowerCase() === computeEventId(stored, sha256Hex).toLowerCase()
  const signatureValid = verifySignedEvent(stored)
  return jsonResult({
    found: true,
    event_id: input.event_id,
    id_matches: idMatches,
    signature_valid: signatureValid,
    event: stored,
    note:
      idMatches && signatureValid
        ? 'stored bytes match their own id and signature — this is the proof a publish landed'
        : 'the stored event does not verify; treat it as untrusted and republish from a fresh template',
  })
}
