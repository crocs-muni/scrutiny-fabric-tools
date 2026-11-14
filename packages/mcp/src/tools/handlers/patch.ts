/**
 * `publish_patch` — a prose correction to the resolved tip (#108 A4; PT-1/PT-2/PT-3/E4/P4).
 *
 * Two input forms, both deterministic:
 *
 * - `before` + `after`: core's `buildPatch` produces the unified diff (context widening and the P4
 *   self-check included). This server additionally verifies that `before` IS the content the
 *   target resolves to: a patch against a stale baseline would not apply for anyone else either.
 * - `diff`: a raw unified diff. Core deliberately does not export the applier (D32 —
 *   `packages/core/src/index.ts:61-65`: "`resolve` is the supported way to reach patched
 *   content"), so the diff is checked by *resolving* a synthetic two-event chain built from the
 *   already-fetched root content and the fenced payload. `resolved` means it applies to the tip;
 *   `halted`/`aborted` is refused with the parser's own reason.
 *
 * Chain resolution is a parent walk over `fetchById` (the relay client has no tag query): from the
 * target through `e reply` tags up to the root its `e root` names. `created_at` is fresh, so the
 * walk is bounded at 64 events — a longer chain is refused rather than followed.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  EVENT_TYPE_TAGS,
  FABRIC_TAG,
  type NostrEvent,
  SCRUTINY_KIND,
  type UnsignedEvent,
  VERSION_TAG,
  buildPatch,
  eTagsWithMarker,
  fencePatchPayload,
  resolve,
  scrutinyEventType,
} from '@scrutiny-fabric/core'
import type { z } from 'zod'
import type { PreflightFinding } from '../../preflight/checkTable.ts'
import type { publishPatchInput } from '../schemas.ts'
import { type HandlerContext, failure, refuse } from './context.ts'
import { finishPublish } from './publish.ts'

/** A parent walk longer than this is not a correction chain worth following. */
const MAX_CHAIN_EVENTS = 64

interface ChainSnapshot {
  /** The PT-10 root: a Product or Metadata event. */
  readonly root: NostrEvent
  /** The content the target resolves to — the only valid `before` baseline. */
  readonly resolved: string
}

type ChainLoad =
  | { readonly chain: ChainSnapshot }
  | { readonly findings: readonly PreflightFinding[] }

function targetFinding(problem: string, fix: string): { findings: readonly PreflightFinding[] } {
  return { findings: [{ field: 'target_id', problem, fix }] }
}

/**
 * Fetch the target and walk its `e reply` ancestry to the `e root` it names, then resolve the
 * chain with core's resolver. The resolved content is the patch's baseline (P4's first half).
 */
async function loadChain(ctx: HandlerContext, targetId: string): Promise<ChainLoad> {
  const client = ctx.relay()
  const target = await client.fetchById(targetId)
  if (target === null) {
    return targetFinding(
      'the relay has no event under this id (EOSE with nothing)',
      'publish the record first, or call verify_event with the same id to confirm it exists',
    )
  }

  const type = scrutinyEventType(target)
  if (type === 'product' || type === 'metadata') {
    return { chain: { root: target, resolved: target.content } }
  }
  if (type !== 'patch') {
    return targetFinding(
      `the target is ${type === undefined ? 'not a SCRUTINY event' : `a ${type} event`}; a patch corrects a Product, a Metadata record, or a Patch tip`,
      'target the resolved tip of a Product or Metadata chain (PT-1, PT-2)',
    )
  }

  const rootId = eTagsWithMarker(target, 'root')[0]?.id
  if (rootId === undefined) {
    return targetFinding(
      'this patch carries no e root tag (PT-1), so the chain it belongs to cannot be resolved',
      'patch the root event itself, or target the tip of a chain whose patches carry e root',
    )
  }

  const events: NostrEvent[] = [target]
  const seen = new Set<string>([target.id])
  let cursor = target
  let root: NostrEvent | undefined
  while (root === undefined) {
    const parentId = eTagsWithMarker(cursor, 'reply')[0]?.id
    if (parentId === undefined) {
      return targetFinding(
        `the chain stops at ${cursor.id}, which carries no e reply tag (PT-2)`,
        'target the resolved tip of a complete chain, or publish the correction as a new root',
      )
    }
    if (seen.has(parentId)) {
      return targetFinding(
        `the chain from ${targetId} loops back to ${parentId}`,
        'this relay data cannot be resolved (PT-9 forbids re-parenting); do not patch it',
      )
    }
    if (events.length >= MAX_CHAIN_EVENTS) {
      return targetFinding(
        `the chain from ${targetId} is longer than ${MAX_CHAIN_EVENTS} events`,
        'patch the current tip directly, or publish a new root for the corrected record',
      )
    }
    seen.add(parentId)
    const parent = await client.fetchById(parentId)
    if (parent === null) {
      return targetFinding(
        `the e reply target ${parentId} is not on this relay, so the chain is incomplete`,
        'the relay cannot resolve the chain; publish the missing ancestor, or target the root',
      )
    }
    events.push(parent)
    if (parent.id === rootId) {
      root = parent
      break
    }
    if (scrutinyEventType(parent) !== 'patch') {
      return targetFinding(
        `e root ${rootId} is not on this chain: ${parentId} is ${scrutinyEventType(parent) ?? 'not a SCRUTINY event'}, not a patch`,
        'the e root tag points at an event the chain never reaches (PT-10); refuse to guess and re-target',
      )
    }
    cursor = parent
  }

  if (root === undefined) {
    // Unreachable: the loop returns a finding on every path that does not assign `root`. Kept so
    // the narrowing below is type-visible rather than an assertion.
    return targetFinding(
      `the chain from ${targetId} never reached e root ${rootId}`,
      'target the root event itself, or a tip whose ancestry is complete on this relay',
    )
  }

  const rootType = scrutinyEventType(root)
  if (rootType !== 'product' && rootType !== 'metadata') {
    return targetFinding(
      `e root ${rootId} is ${rootType ?? 'not a SCRUTINY event'}, but PT-10 requires a Product or Metadata`,
      'target a chain whose root is a Product or Metadata event',
    )
  }

  const resolution = resolve(rootId, events)
  if (resolution.chain.status !== 'resolved') {
    const detail =
      resolution.chain.status === 'halted'
        ? `the chain halts at ${resolution.chain.haltedAt} (${resolution.chain.reason})`
        : resolution.chain.status === 'aborted'
          ? `the chain hits the ${resolution.chain.limit} ceiling at ${resolution.chain.abortedAt}`
          : `the chain is ${resolution.chain.status}`
    return targetFinding(
      `the chain does not resolve: ${detail}`,
      'there is no reliable baseline to patch; resolve the conflict first (a fork is settled by a kind 5 deletion, guide §6)',
    )
  }
  return { chain: { root, resolved: resolution.chain.content } }
}

/** PT-3/E4 payload check for the raw-`diff` form: one fenced block that applies to the tip. */
function dryRunDiff(
  root: NostrEvent,
  resolved: string,
  fenced: string,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  // The synthetic events exist only inside `resolve`; ids are never signed or published. The root
  // keeps its real id and tags so `scrutinyEventType` sees a Product/Metadata, and its content is
  // the resolved tip content — the baseline an applying consumer would use.
  const syntheticRoot: NostrEvent = { ...root, content: resolved }
  const syntheticPatch: NostrEvent = {
    id: '11'.repeat(32),
    pubkey: root.pubkey,
    created_at: root.created_at,
    kind: SCRUTINY_KIND,
    tags: [
      ['t', FABRIC_TAG],
      ['t', VERSION_TAG],
      ['t', EVENT_TYPE_TAGS.patch],
      ['e', root.id, '', 'root', ''],
      ['e', root.id, '', 'reply', ''],
    ],
    content: fenced,
    sig: '',
  }
  const resolution = resolve(root.id, [syntheticRoot, syntheticPatch])
  if (resolution.chain.status === 'resolved') return { ok: true }
  if (resolution.chain.status === 'halted') {
    return { ok: false, detail: `the payload halts the chain (${resolution.chain.reason})` }
  }
  if (resolution.chain.status === 'aborted') {
    return { ok: false, detail: `the payload hits the ${resolution.chain.limit} ceiling` }
  }
  return { ok: false, detail: `the chain resolved ${resolution.chain.status}` }
}

/** The patch template for the raw-`diff` form; core's `buildPatch` cannot be used without `after`. */
function diffTemplate(
  rootId: string,
  targetId: string,
  fenced: string,
  createdAt: number,
): UnsignedEvent {
  return {
    kind: SCRUTINY_KIND,
    created_at: createdAt,
    tags: [
      ['t', FABRIC_TAG],
      ['t', VERSION_TAG],
      ['t', EVENT_TYPE_TAGS.patch],
      ['e', rootId, '', 'root', ''],
      ['e', targetId, '', 'reply', ''],
    ],
    content: fenced,
  }
}

/**
 * Publish a Patch. Validation order: input form → chain fetch → baseline/apply check → preflight →
 * sign → publish → verify. Nothing here reaches the signer before the relay has confirmed the
 * target exists and the payload applies to what it resolves to.
 */
export async function publishPatch(
  input: z.output<typeof publishPatchInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  const tool = 'publish_patch'
  const findings: PreflightFinding[] = []

  const hasBefore = input.before !== undefined
  const hasAfter = input.after !== undefined
  if (hasBefore !== hasAfter) {
    findings.push({
      field: hasBefore ? 'after' : 'before',
      problem: '`before` and `after` are a pair; exactly one was supplied',
      fix: 'send both `before` (the resolved tip content) and `after` (its replacement), or send a unified `diff` alone',
    })
  }
  if (input.diff !== undefined && (hasBefore || hasAfter)) {
    findings.push({
      field: 'diff',
      problem: 'both a unified `diff` and a `before`/`after` pair were supplied',
      fix: 'send one form only: `before`+`after`, or `diff`',
    })
  }
  if (input.diff === undefined && !hasBefore) {
    findings.push({
      field: 'diff',
      problem: 'no patch payload was supplied',
      fix: 'send `before`+`after` (the server diffs them) or a unified `diff`',
    })
  }
  if (findings.length > 0) return refuse(tool, findings)

  let chain: ChainSnapshot
  try {
    const loaded = await loadChain(ctx, input.target_id)
    if ('findings' in loaded) return refuse(tool, loaded.findings)
    chain = loaded.chain
  } catch (cause) {
    return failure(`${tool} (relay read)`, cause)
  }

  let template: UnsignedEvent
  if (input.diff !== undefined) {
    // CRLF would make the payload's line endings disagree with the LF-terminated diffs `makePatch`
    // produces, and core's fence/apply machinery assumes LF (`packages/core/src/build.ts:229-236`).
    const fenced = fencePatchPayload(input.diff.replace(/\r\n?/gu, '\n'))
    const applied = dryRunDiff(chain.root, chain.resolved, fenced)
    if (!applied.ok) {
      return refuse(tool, [
        {
          field: 'diff',
          problem: `the diff does not apply cleanly to the resolved tip: ${applied.detail} (P4)`,
          fix: 'regenerate the diff against the content target_id resolves to; the server refuses a patch that would not apply rather than publishing it',
        },
      ])
    }
    template = diffTemplate(chain.root.id, input.target_id, fenced, ctx.stamp())
  } else {
    const before = input.before ?? ''
    const after = input.after ?? ''
    if (before !== chain.resolved) {
      return refuse(tool, [
        {
          field: 'before',
          problem:
            'the supplied `before` is not the content target_id resolves to, so the patch would apply against a stale baseline',
          fix: "target the resolved tip and pass the content it resolves to verbatim; for a patch tip that is the chain's resolved content, not the patch event's own fenced diff. Alternatively send `diff`, which the server checks against the resolved tip itself",
        },
      ])
    }
    const built = buildPatch({
      root: { id: chain.root.id },
      reply: { id: input.target_id },
      before,
      after,
      createdAt: ctx.stamp(),
    })
    const p4 = built.issues.filter(
      (finding) => finding.severity === 'error' || finding.code === 'P4',
    )
    if (p4.length > 0) {
      return refuse(tool, [
        {
          field: 'after',
          problem: `the built patch fails its P4 self-check: ${p4.map((finding) => finding.message).join('; ')}`,
          fix: 'check that `before` is the resolved content and `after` is its exact replacement; a patch that would not apply is refused, not published',
        },
      ])
    }
    template = built.template
  }

  return await finishPublish(ctx, tool, template)
}
