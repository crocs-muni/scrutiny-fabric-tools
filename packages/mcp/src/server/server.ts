/**
 * The MCP adapter (spec §6, §7, §12): four tools over the engine, approval by elicitation with a
 * chat fallback, and the guidance surfaces. The engine knows nothing about MCP; this module knows
 * nothing about relays or keys beyond the ports in `ServerDeps`.
 */

import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  type CallToolResult,
  LATEST_PROTOCOL_VERSION,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { approvalCode, renderSummary } from '../approval/summary.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../package.js'
import { type BlobUpload, type Draft, type DraftNetwork, draftPlan } from '../plan/draft.js'
import { Journal } from '../publish/journal.js'
import { withRunLock } from '../publish/lock.js'
import {
  CALL_BUDGET_MS,
  type MirrorTransport,
  type PrimaryTransport,
  runPlan,
} from '../publish/run.js'
import type { Refusal } from '../refusal.js'
import { sameEvent, verifySignedEvent } from '../signer/event.js'
import { npubEncode } from '../signer/keys.js'
import type { SignerPort, SignerStatus } from '../signer/signer.js'
import {
  GUIDE_URI,
  INSTRUCTIONS,
  NEXT_STEP,
  PUBLISHER_GUIDE,
  TOOL_DESCRIPTIONS,
  publishPrompt,
} from './guidance.js'
import { loadPlan, planPath, readPlanFile, savePlan } from './plans.js'
import {
  type PublishOutput,
  draftInput,
  draftOutput,
  publishInput,
  publishOutput,
  statusInput,
  statusOutput,
  verifyInput,
  verifyOutput,
} from './schemas.js'

const SERVER_NAME = PACKAGE_NAME
const VERSION = PACKAGE_VERSION

type Closable<T> = T & { close(): void }

/** Everything the adapter needs from the outside world. Tests inject fakes. */
export interface ServerDeps {
  readonly signer: SignerPort
  readonly signerStatus: () => Promise<SignerStatus>
  readonly network: DraftNetwork
  readonly primary: (url: string) => Closable<PrimaryTransport>
  readonly mirror: (url: string) => Closable<MirrorTransport>
  readonly uploadBlob: (
    primary: string,
    root: string,
    upload: BlobUpload,
  ) => Promise<{ readonly state: 'present' | 'uploaded'; readonly url: string }>
  /** Unix seconds: the signer's clock. */
  readonly now: () => number
  /** Milliseconds. */
  readonly clock: () => number
  /** Per-call budget of publish_plan (spec §6.3); tests shorten it. */
  readonly callBudgetMs?: number
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

function text(value: string): CallToolResult['content'] {
  return [{ type: 'text', text: value }]
}

function refusal(
  code: string,
  source: Refusal['source'],
  problem: string,
  fix: string,
  field: string | null = null,
): Refusal {
  return { code, field, problem, fix, source, relay_message: null }
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  )
  const approvalChannel = (): 'elicitation' | 'chat' =>
    server.server.getClientCapabilities()?.elicitation === undefined ? 'chat' : 'elicitation'
  /**
   * `root\0plan_hash` of plans whose summary and approval code this process has returned (spec §7):
   * only for these is an `approval_code` accepted, on any channel.
   */
  const chatOffered = new Set<string>()

  async function pubkeyOrNull(): Promise<string | null> {
    try {
      return await deps.signer.publicKey()
    } catch {
      return null
    }
  }

  // --- status -----------------------------------------------------------------------------------
  server.registerTool(
    'status',
    {
      description: TOOL_DESCRIPTIONS.status,
      inputSchema: statusInput,
      outputSchema: statusOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const signer = await deps.signerStatus()
      const out = {
        server: { name: SERVER_NAME, version: VERSION },
        signer,
        protocol: { mcp: LATEST_PROTOCOL_VERSION, approval_channel: approvalChannel() },
      }
      return {
        content: text(
          `signer: ${signer.state}${signer.npub === null ? '' : ` (${signer.npub})`}; approval: ${out.protocol.approval_channel}`,
        ),
        structuredContent: out,
      }
    },
  )

  // --- draft_plan -------------------------------------------------------------------------------
  server.registerTool(
    'draft_plan',
    {
      description: TOOL_DESCRIPTIONS.draft_plan,
      inputSchema: draftInput,
      outputSchema: draftOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const invalid = (finding: Refusal) => {
        const out = {
          plan_id: null,
          plan_hash: null,
          ready: false,
          preview: null,
          open_questions: [],
          findings: [finding],
          next_step: NEXT_STEP.invalid,
        }
        return { content: text(`refused: ${finding.code}`), structuredContent: out }
      }
      if (!isAbsolute(args.root)) {
        return invalid(
          refusal(
            'schema.invalid',
            'schema',
            'root must be an absolute path',
            'Pass the absolute path of the data folder.',
            'root',
          ),
        )
      }
      if ((args.plan === undefined) === (args.path === undefined)) {
        return invalid(
          refusal(
            'schema.invalid',
            'schema',
            'give exactly one of plan or path',
            'Pass the plan inline, or a path to a plan file.',
            'plan',
          ),
        )
      }
      let raw: unknown = args.plan
      if (args.path !== undefined) {
        const read = await readPlanFile(args.root, args.path)
        if (read.kind !== 'ok') {
          return invalid(
            read.kind === 'outside'
              ? refusal(
                  'schema.path_outside_root',
                  'schema',
                  'the plan file is outside the data folder',
                  'Use a path inside root.',
                  'path',
                )
              : refusal(
                  'schema.invalid',
                  'schema',
                  'the plan file cannot be read as JSON',
                  'Check the path and the JSON.',
                  'path',
                ),
          )
        }
        raw = read.plan
      }

      const draft = await draftPlan({
        root: args.root,
        plan: raw,
        pubkey: await pubkeyOrNull(),
        network: deps.network,
      })
      const out = draftResult(draft)
      if (draft.status === 'drafted') {
        await savePlan(args.root, draft.plan_hash, { plan: draft.plan, ready: draft.ready })
      }
      return {
        content: text(
          draft.status === 'drafted'
            ? `plan ${draft.plan_hash}: ${draft.ready ? 'ready' : `${draft.open_questions.length} open question(s)`}`
            : `${draft.findings.length} finding(s)`,
        ),
        structuredContent: out,
      }
    },
  )

  // --- publish_plan -----------------------------------------------------------------------------
  server.registerTool(
    'publish_plan',
    {
      description: TOOL_DESCRIPTIONS.publish_plan,
      inputSchema: publishInput,
      outputSchema: publishOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => withRunLock(args.root, args.plan_hash, () => publish(args, extra)),
  )

  async function publish(
    args: z.infer<typeof publishInput>,
    extra: Extra,
  ): Promise<CallToolResult> {
    const started = deps.clock()
    const deadline = started + (deps.callBudgetMs ?? CALL_BUDGET_MS)
    const base = (overrides: Partial<PublishOutput>): PublishOutput => ({
      plan_hash: args.plan_hash,
      approval: null,
      outcome: null,
      records: [],
      progress: { done: 0, total: 0 },
      refusal: null,
      resume: null,
      next_step: NEXT_STEP.stopped,
      approval_summary: null,
      approval_code: null,
      ...overrides,
    })
    const refuse = (r: Refusal, overrides: Partial<PublishOutput> = {}): CallToolResult => ({
      isError: true,
      content: text(
        `refused: ${r.code}${overrides.approval_summary ? `\n\n${overrides.approval_summary}\n\nApproval code: ${overrides.approval_code}` : ''}`,
      ),
      structuredContent: base({ refusal: r, ...overrides }),
    })

    // 1. The plan the user saw, unchanged (spec §6.3).
    const changed = (problem: string) =>
      refuse(
        refusal(
          'plan.changed',
          'approval',
          problem,
          'Call draft_plan again and use the plan_id and plan_hash it returns.',
          'plan_hash',
        ),
      )
    if (args.plan_hash !== args.plan_id) return changed('plan_hash does not equal plan_id')
    const stored = await loadPlan(args.root, args.plan_hash)
    if (stored === null) return changed('no drafted plan with this hash in this folder')
    const pubkey = await pubkeyOrNull()
    const draft = await draftPlan({ root: args.root, plan: stored.plan, pubkey })
    if (draft.status !== 'drafted' || draft.plan_hash !== args.plan_hash) {
      return changed('the plan, its files or the signer identity changed since it was drafted')
    }
    if (!stored.ready || !draft.ready || pubkey === null) {
      return refuse(
        refusal(
          'plan.not_ready',
          'approval',
          'the plan still has blocking open questions',
          'Resolve them with the user and call draft_plan again.',
        ),
      )
    }

    // 2. Approval (spec §7): a valid journalled one, else elicitation, else chat.
    const journal = await Journal.open(args.root, args.plan_hash)
    let approval = journal.validApproval(args.plan_hash, Date.now())
    if (approval === undefined) {
      const published = [...journal.latest().values()].filter(
        (l) => l.state === 'acked' || l.state === 'verified',
      ).length
      const summary = renderSummary({
        graph: draft.graph,
        npub: npubEncode(pubkey),
        planHash: args.plan_hash,
        planPath: planPath(args.root, args.plan_hash),
        published,
      })
      const code = approvalCode(args.plan_hash)
      const offer = `${args.root}\0${args.plan_hash}`
      const askInChat = (r: Refusal) => {
        chatOffered.add(offer)
        return refuse(r, {
          approval_summary: summary,
          approval_code: code,
          next_step: NEXT_STEP.approval,
        })
      }
      if (approvalChannel() === 'elicitation' && !chatOffered.has(offer)) {
        const decision = await elicit(summary, deadline - deps.clock())
        if (decision === 'decline') {
          return refuse(
            refusal(
              'approval.declined',
              'approval',
              'the user declined',
              'Nothing was signed. Revise the plan with the user if needed.',
            ),
          )
        }
        if (decision !== 'approve') {
          // Spec §7: a dialog the host cancelled or never answered is not a decision; fall back to chat.
          chatOffered.add(offer)
          return askInChat(
            refusal(
              'approval.required',
              'approval',
              `the approval dialog got no decision (${decision})`,
              NEXT_STEP.approval,
            ),
          )
        }
        approval = await journal.recordApproval(args.plan_hash, 'elicitation', Date.now())
      } else {
        // Spec §7: accept the code only for an offer this process already returned.
        if (args.approval_code === undefined || !chatOffered.has(offer)) {
          return askInChat(
            refusal(
              'approval.required',
              'approval',
              'the user has not approved this plan yet',
              NEXT_STEP.approval,
            ),
          )
        }
        if (args.approval_code.trim().toUpperCase() !== code) {
          return askInChat(
            refusal(
              'approval.wrong_code',
              'approval',
              'the approval code does not match this plan',
              NEXT_STEP.approval,
              'approval_code',
            ),
          )
        }
        approval = await journal.recordApproval(args.plan_hash, 'chat', Date.now())
      }
    }

    // 3. Run one time-boxed slice (spec §6.3, §8).
    const [primaryUrl, ...mirrorUrls] = draft.graph.relays
    if (primaryUrl === undefined)
      return refuse(
        refusal(
          'plan.not_ready',
          'approval',
          'the plan has no relay',
          'Add a relay and draft again.',
        ),
      )
    const primary = deps.primary(primaryUrl)
    const mirrors = new Map(mirrorUrls.map((url) => [url, deps.mirror(url)] as const))
    const progressToken = extra._meta?.progressToken
    try {
      const run = await runPlan({
        planHash: args.plan_hash,
        graph: draft.graph,
        uploads: draft.uploads,
        journal,
        signer: deps.signer,
        primary,
        mirrors,
        uploadBlob: (upload) => deps.uploadBlob(primaryUrl, args.root, upload),
        now: deps.now,
        clock: deps.clock,
        deadline,
        signal: extra.signal,
        onProgress: (done, total) => {
          if (progressToken === undefined) return
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: done, total },
            })
            .catch(() => {})
        },
      })
      const out = base({
        approval: { channel: approval.channel, at: approval.at, valid_until: approval.valid_until },
        outcome: run.outcome,
        records: run.records.map((r) => ({ ...r, blobs: [...r.blobs], mirrors: { ...r.mirrors } })),
        progress: run.progress,
        refusal: run.refusal,
        resume: run.resume,
        next_step: NEXT_STEP[run.outcome],
      })
      return {
        content: text(
          `${run.outcome}: ${run.progress.done} of ${run.progress.total} events published${run.refusal === null ? '' : `; ${run.refusal.code}`}`,
        ),
        structuredContent: out,
      }
    } finally {
      primary.close()
      for (const mirror of mirrors.values()) mirror.close()
    }
  }

  /** Spec §7.1: the form. Only accept + approve approves; only an explicit decline declines. */
  async function elicit(
    summary: string,
    timeoutMs: number,
  ): Promise<'approve' | 'decline' | 'cancel' | 'no response' | 'no time left in this call'> {
    if (timeoutMs <= 0) return 'no time left in this call'
    try {
      const result = await server.server.elicitInput(
        {
          mode: 'form',
          message: summary,
          requestedSchema: {
            type: 'object',
            properties: {
              decision: { type: 'string', title: 'Decision', enum: ['approve', 'decline'] },
            },
            required: ['decision'],
          },
        },
        { timeout: timeoutMs },
      )
      if (result.action !== 'accept') return result.action
      const { decision } = (result.content ?? {}) as { decision?: unknown }
      return decision === 'approve' ? 'approve' : 'decline'
    } catch {
      return 'no response'
    }
  }

  // --- verify -----------------------------------------------------------------------------------
  server.registerTool(
    'verify',
    {
      description: TOOL_DESCRIPTIONS.verify,
      inputSchema: verifyInput,
      outputSchema: verifyOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      let relays = args.relays ?? []
      let ids = args.event_ids ?? []
      let journal: Journal | undefined
      if (args.root !== undefined && args.plan_hash !== undefined) {
        journal = await Journal.open(args.root, args.plan_hash)
        if (ids.length === 0) {
          ids = [...journal.latest().values()]
            .filter((l) => l.state === 'acked' || l.state === 'verified')
            .map((l) => l.event_id)
        }
        if (relays.length === 0) {
          const stored = await loadPlan(args.root, args.plan_hash)
          const planRelays = (stored?.plan as { relays?: unknown } | undefined)?.relays
          if (Array.isArray(planRelays))
            relays = planRelays.filter((r): r is string => typeof r === 'string')
        }
      }
      if (relays.length === 0 || ids.length === 0) {
        const r = refusal(
          'schema.invalid',
          'schema',
          'nothing to verify',
          'Pass relays and event_ids, or root and plan_hash of a published plan.',
        )
        return {
          isError: true,
          content: text(`refused: ${r.code}`),
          structuredContent: { results: [], refusal: r },
        }
      }
      const results: z.infer<typeof verifyOutput>['results'] = []
      for (const relay of relays) {
        const transport = deps.primary(relay)
        try {
          for (let i = 0; i < ids.length; i += 500) {
            const slice = ids.slice(i, i + 500)
            const found = await transport.fetchByIds(slice)
            for (const id of slice) {
              const event = found.get(id)
              const journalled = journal?.signedEvent(id)
              results.push({
                relay,
                event_id: id,
                stored: event !== undefined,
                id_valid: event === undefined ? null : event.id === id && verifySignedEvent(event),
                sig_valid: event === undefined ? null : verifySignedEvent(event),
                byte_identical:
                  event === undefined || journalled === undefined
                    ? null
                    : sameEvent(event, journalled),
              })
            }
          }
        } catch (cause) {
          const r = refusal(
            'relay.read_failed',
            'relay',
            `could not read from ${relay}: ${cause instanceof Error ? cause.message : 'unknown'}`,
            'Check the relay URL and retry.',
          )
          return {
            isError: true,
            content: text(`refused: ${r.code}`),
            structuredContent: { results, refusal: r },
          }
        } finally {
          transport.close()
        }
      }
      const ok = results.filter((r) => r.stored && r.sig_valid === true).length
      return {
        content: text(`${ok} of ${results.length} stored and valid`),
        structuredContent: { results, refusal: null },
      }
    },
  )

  // --- guidance surfaces ------------------------------------------------------------------------
  server.registerResource(
    'publisher-guide',
    GUIDE_URI,
    {
      title: 'Publisher guide',
      description: 'How to draft a SCRUTINY Fabric publication plan.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: PUBLISHER_GUIDE }],
    }),
  )
  server.registerPrompt(
    'publish',
    {
      description: 'Publish the security data in a folder to SCRUTINY Fabric.',
      argsSchema: { folder: z.string(), relay: z.string() },
    },
    ({ folder, relay }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: publishPrompt(folder, relay) } }],
    }),
  )

  return server
}

function draftResult(draft: Draft): z.infer<typeof draftOutput> {
  if (draft.status === 'invalid') {
    return {
      plan_id: null,
      plan_hash: null,
      ready: false,
      preview: null,
      open_questions: [],
      findings: [...draft.findings],
      next_step: NEXT_STEP.invalid,
    }
  }
  const asking = draft.open_questions.filter((q) => q.ask_user).length
  return {
    plan_id: draft.plan_hash,
    plan_hash: draft.plan_hash,
    ready: draft.ready,
    preview: {
      counts: { ...draft.preview.counts },
      records: draft.preview.records.map((r) => ({ ...r })),
      graph: [...draft.preview.graph],
      relays: draft.preview.relays.map((r) => ({ ...r })),
      immutable_warning: draft.preview.immutable_warning,
    },
    open_questions: draft.open_questions.map((q) => ({ ...q, options: [...q.options] })),
    findings: [],
    next_step: draft.ready && asking === 0 ? NEXT_STEP.ready : NEXT_STEP.questions(asking),
  }
}
