/**
 * emit/deletion.ts — kind-5 (NIP-09) retraction builder (update-semantics §10).
 *
 * A deletion carries only the fabric + version `t` tags (never a SCRUTINY type tag): it is not
 * a v0.8.1 SCRUTINY event, it retracts one. `createdAt` comes from the caller's batch clock.
 */
import type { SignedEvent } from '../types.js'
import { FABRIC_VERSION_TAG } from './content.js'
import type { Signer } from './keys.js'

/** Sign a NIP-09 deletion of `targetId` (fabric + version `t` tags only — no SCRUTINY type tag). */
export function buildDeletion(
  targetId: string,
  content: string,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  return signer.sign({
    kind: 5,
    created_at: createdAt,
    tags: [
      ['t', 'scrutiny-fabric'],
      ['t', FABRIC_VERSION_TAG],
      ['e', targetId],
    ],
    content,
  })
}
