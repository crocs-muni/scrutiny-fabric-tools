/**
 * Tool input and output schemas (spec §6). Every tool declares an `outputSchema`, and every result
 * carries `structuredContent` that conforms to it; the SDK validates both sides.
 */

import { z } from 'zod'

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u)

const refusalSchema = z.object({
  code: z.string(),
  field: z.string().nullable(),
  problem: z.string(),
  fix: z.string(),
  source: z.enum(['schema', 'gate', 'relay', 'signer', 'approval', 'artifact', 'internal']),
  relay_message: z.string().nullable(),
})

const openQuestionSchema = z.object({
  code: z.string(),
  blocking: z.boolean(),
  ref: z.string().nullable(),
  field: z.string().nullable(),
  question: z.string(),
  why: z.string(),
  ask_user: z.boolean(),
  options: z.array(z.string()),
})

const replySchema = z.object({ ok: z.boolean(), message: z.string() })

// --- inputs -------------------------------------------------------------------------------------

export const statusInput = z.strictObject({})

export const draftInput = z.strictObject({
  root: z.string().min(1).describe('Absolute path of the data folder.'),
  plan: z.record(z.string(), z.unknown()).optional().describe('The plan, inline (spec §5.2).'),
  path: z
    .string()
    .optional()
    .describe('A plan file relative to root, typically .scrutiny/plans/draft.json.'),
})

export const publishInput = z.strictObject({
  root: z.string().min(1),
  plan_id: hex64,
  plan_hash: hex64,
  approval_code: z
    .string()
    .optional()
    .describe('Only on hosts without dialogs: the code the user replied with.'),
})

export const verifyInput = z.strictObject({
  relays: z.array(z.string()).max(8).optional(),
  event_ids: z.array(hex64).max(500).optional(),
  root: z.string().optional(),
  plan_hash: hex64.optional(),
})

// --- outputs ------------------------------------------------------------------------------------

export const statusOutput = z.object({
  server: z.object({ name: z.string(), version: z.string() }),
  signer: z.object({
    state: z.enum(['ready', 'missing', 'unavailable']),
    npub: z.string().nullable(),
    fix: z.string().nullable(),
  }),
  protocol: z.object({ mcp: z.string(), approval_channel: z.enum(['elicitation', 'chat']) }),
})

export const draftOutput = z.object({
  plan_id: hex64.nullable(),
  plan_hash: hex64.nullable(),
  ready: z.boolean(),
  preview: z
    .object({
      counts: z.record(z.string(), z.number()),
      records: z.array(z.record(z.string(), z.unknown())),
      graph: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
      relays: z.array(z.record(z.string(), z.unknown())),
      immutable_warning: z.string(),
    })
    .nullable(),
  open_questions: z.array(openQuestionSchema),
  findings: z.array(refusalSchema),
  next_step: z.string(),
})

export const publishOutput = z.object({
  plan_hash: z.string(),
  approval: z
    .object({ channel: z.enum(['elicitation', 'chat']), at: z.string(), valid_until: z.string() })
    .nullable(),
  outcome: z.enum(['complete', 'partial', 'stopped']).nullable(),
  records: z.array(
    z.object({
      ref: z.string(),
      event_id: z.string().nullable(),
      state: z.enum(['verified', 'acked', 'pending', 'rejected', 'skipped']),
      ack: replySchema.nullable(),
      mirrors: z.record(z.string(), replySchema),
      blobs: z.array(
        z.object({ x: z.string(), url: z.string(), state: z.enum(['uploaded', 'present']) }),
      ),
    }),
  ),
  progress: z.object({ done: z.number(), total: z.number() }),
  refusal: refusalSchema.nullable(),
  resume: z.string().nullable(),
  next_step: z.string(),
  /** Chat fallback only (§7): the summary to show and the code the user replies with. */
  approval_summary: z.string().nullable(),
  approval_code: z.string().nullable(),
})

export const verifyOutput = z.object({
  results: z.array(
    z.object({
      relay: z.string(),
      event_id: z.string(),
      stored: z.boolean(),
      id_valid: z.boolean().nullable(),
      sig_valid: z.boolean().nullable(),
      byte_identical: z.boolean().nullable(),
    }),
  ),
  refusal: refusalSchema.nullable(),
})

export type PublishOutput = z.infer<typeof publishOutput>
