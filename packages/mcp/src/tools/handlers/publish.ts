/**
 * The four kind-1/kind-0 publish tools: `set_profile`, `publish_product`, `publish_metadata`,
 * `publish_binding` (#108 A4).
 *
 * Every handler follows the same order, and the order is the contract:
 *
 * 1. compose content from structured fields (`src/compose/`, rule 8 + rule 2a restate-and-verify);
 * 2. build the unsigned template with core's builders (`@scrutiny-fabric/core`, D13);
 * 3. run the preflight table on that template — a refusal returns here, before `ctx.signer()`;
 * 4. resolve the signer, sign, publish, and fetch the event back (`verify_event`'s check, inline).
 *
 * Step 3 is why a NIP-46 bunker never prompts for an event the relay would reject.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  type EndpointRef,
  type NostrEvent,
  type UnsignedEvent,
  buildBinding,
  buildMetadata,
  buildProduct,
} from '@scrutiny-fabric/core'
import type { z } from 'zod'
import { composeBindingContent, composeIndexed, imetaTags, oneLine } from '../../compose/index.ts'
import type { Signer } from '../../identity.ts'
import { checkTable } from '../../preflight/checkTable.ts'
import type { PublishResult } from '../../relay/types.ts'
import type {
  publishBindingInput,
  publishMetadataInput,
  publishProductInput,
  setProfileInput,
} from '../schemas.ts'
import { type HandlerContext, failure, jsonResult, refuse, textResult } from './context.ts'
import { verifyStored } from './verify.ts'

/** Append derived tags (imeta rows, the Lens compatibility tag) after the builder's own. */
function appendTags(template: UnsignedEvent, extra: readonly (readonly string[])[]): UnsignedEvent {
  if (extra.length === 0) return template
  return { ...template, tags: [...template.tags, ...extra] }
}

/**
 * Preflight → sign → publish → verify. Shared by every publishing handler so the refusal-before-
 * signer order and the honest report shape cannot drift between tools.
 */
export async function finishPublish(
  ctx: HandlerContext,
  tool: string,
  template: UnsignedEvent,
): Promise<CallToolResult> {
  const preflight = checkTable(template, { now: ctx.now() })
  if (preflight.findings.length > 0) return refuse(tool, preflight.findings, preflight.warnings)
  const warnings = preflight.warnings

  let signer: Signer
  try {
    signer = await ctx.signer()
  } catch (cause) {
    return failure(tool, cause)
  }

  let event: NostrEvent
  try {
    event = await signer.sign(template)
  } catch (cause) {
    return failure(`${tool} (signing)`, cause)
  }

  let verdict: PublishResult
  try {
    verdict = await ctx.relay().publish(event)
  } catch (cause) {
    // The EVENT may have landed and the reply been lost (A3's timeout policy). Republishing would
    // be a guess; the id is the way to find out, so the refusal names it.
    const reason = cause instanceof Error ? cause.message : String(cause)
    return textResult(
      [
        `${tool}: the event was sent but no NIP-20 verdict arrived, so the publish outcome is UNKNOWN.`,
        `event_id: ${event.id}`,
        `relay error: ${reason}`,
        `Do not republish blindly: call verify_event with event_id ${event.id}. If it returns the event, the publish landed.`,
      ].join('\n'),
      true,
    )
  }

  const check = verdict.accepted ? await verifyStored(ctx.relay(), event) : { verified: false }
  const note = verdict.accepted
    ? check.note
    : 'the relay rejected the event, so nothing is stored under this id; read relay_message (guide §7) and publish again after fixing the cause'

  return jsonResult({
    id: event.id,
    accepted: verdict.accepted,
    relay_message: verdict.message,
    verified: check.verified,
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(note === undefined ? {} : { note }),
  })
}

/** NIP-01 profile metadata: the four fields this server accepts, in the order NIP-01 lists them. */
interface ProfileJson {
  readonly name: string
  readonly display_name?: string
  readonly about?: string
  readonly picture?: string
}

/** kind 0 — NIP-01 profile metadata; content is the profile JSON, there are no tags. */
export async function setProfile(
  input: z.output<typeof setProfileInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  const profile: ProfileJson = {
    name: oneLine(input.name),
    // NIP-01's profile field is `picture`; the tool argument is `picture_url` because it is a URL,
    // and the schema confines it to http(s) before it reaches this line.
    ...(input.display_name === undefined ? {} : { display_name: oneLine(input.display_name) }),
    ...(input.about === undefined ? {} : { about: oneLine(input.about) }),
    ...(input.picture_url === undefined ? {} : { picture: input.picture_url }),
  }
  const template: UnsignedEvent = {
    kind: 0,
    created_at: ctx.stamp(),
    tags: [],
    content: JSON.stringify(profile),
  }
  return await finishPublish(ctx, 'set_profile', template)
}

/** kind 1 root Product (TAG-1..3, PR-1..4) — created_at and tags are the server's. */
export async function publishProduct(
  input: z.output<typeof publishProductInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  const composed = composeIndexed(
    {
      headline: input.headline,
      bullets: input.bullets,
      links: input.links,
      card: input.card,
      indexers: input.indexers,
    },
    'publish_product',
  )
  const built = buildProduct(composed.content, ctx.stamp(), input.indexers)
  return await finishPublish(
    ctx,
    'publish_product',
    appendTags(built.template, imetaTags(input.imeta)),
  )
}

/**
 * kind 1 Metadata underneath a Product (MD-1..5). `meta_subtype` becomes Lens's compatibility tag
 * `["meta","<subtype>"]`, emitted last; the tag set is otherwise the Product's.
 */
export async function publishMetadata(
  input: z.output<typeof publishMetadataInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  const composed = composeIndexed(
    {
      headline: input.headline,
      bullets: input.bullets,
      links: input.links,
      card: input.card,
      indexers: input.indexers,
    },
    'publish_metadata',
  )
  const built = buildMetadata(composed.content, ctx.stamp(), input.indexers)
  const tags = [...imetaTags(input.imeta), ['meta', input.meta_subtype]]
  return await finishPublish(ctx, 'publish_metadata', appendTags(built.template, tags))
}

/** Tool `endpointRef` → core's `EndpointRef` (BD-8 relay hint, BD-12 author hint, both advisory). */
function endpointRef(ref: {
  readonly id: string
  readonly relay?: string | undefined
  readonly author?: string | undefined
}): EndpointRef {
  return {
    id: ref.id,
    ...(ref.relay === undefined ? {} : { relay: ref.relay }),
    ...(ref.author === undefined ? {} : { authorHint: ref.author }),
  }
}

/**
 * kind 1 Binding (BD-1..BD-12): `e root` = the root record, `e link` = the linked record, both with
 * NIP-10 markers in the author-hint position, and the mandatory rule-8d `Refs: root … link …` line
 * at the end of the content.
 */
export async function publishBinding(
  input: z.output<typeof publishBindingInput>,
  ctx: HandlerContext,
): Promise<CallToolResult> {
  const content = composeBindingContent(
    input.label,
    input.bullets,
    input.root_ref.id,
    input.link_ref.id,
  )
  const built = buildBinding(
    endpointRef(input.root_ref),
    endpointRef(input.link_ref),
    content,
    ctx.stamp(),
  )
  return await finishPublish(ctx, 'publish_binding', built.template)
}
