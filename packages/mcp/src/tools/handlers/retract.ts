/**
 * `retract` — NIP-09 kind 5 deletion for an event this key authored (#108 A4; DEL-1, DEL-11).
 *
 * The pilot relay stores a deletion and never acts on it (`relay/internal/gate/gate.go:138-140`),
 * so this is a correction of record, not an erasure: the target stays fetchable and Lens marks it
 * retracted client-side. The content carries the human reason, which is the only part a reader
 * sees when the retraction is rendered.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DELETION_KIND, type UnsignedEvent } from '@scrutiny-fabric/core'
import type { z } from 'zod'
import { normalizeProse } from '../../compose/index.ts'
import type { retractInput } from '../schemas.ts'
import type { HandlerContext } from './context.ts'
import { finishPublish } from './publish.ts'

/** kind 5 with exactly one `e` tag (DEL-1) and the reason as content (the schema requires one). */
export async function retract(
  input: z.output<typeof retractInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  const template: UnsignedEvent = {
    kind: DELETION_KIND,
    created_at: ctx.stamp(),
    tags: [['e', input.target_id]],
    content: normalizeProse(input.reason).trim(),
  }
  return await finishPublish(ctx, 'retract', template)
}
