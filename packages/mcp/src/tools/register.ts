/**
 * The v1 tool surface of #108 — registry, handler wiring and the guide resource.
 *
 * Scope split: A3 composed nothing and A4 owns everything a call does — compose content from the
 * structured fields, run the preflight table, sign through the D13 port and publish over the A3
 * relay client. Everything here is transport-free: {@link buildServer} never opens a socket, which
 * is why tests drive it over an in-memory transport instead of a real stdio pair.
 *
 * The tool descriptions are part of the contract, not decoration: for a harness with no separate
 * playbook they *are* the playbook (report §8.5), which is why each one carries its rule IDs.
 */

import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { SERVER_NAME, SERVER_VERSION } from '../config.ts'
import { type HandlerContext, type ToolDeps, createContext } from './handlers/context.ts'
import { publishPatch } from './handlers/patch.ts'
import { publishBinding, publishMetadata, publishProduct, setProfile } from './handlers/publish.ts'
import { retract } from './handlers/retract.ts'
import { status } from './handlers/status.ts'
import { verifyEvent } from './handlers/verify.ts'
import * as schemas from './schemas.ts'

export type { ToolDeps } from './handlers/context.ts'

interface ToolSpec<S extends z.ZodType> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: S
  readonly annotations: ToolAnnotations
  readonly run: (
    input: z.output<S>,
    ctx: HandlerContext,
  ) => CallToolResult | Promise<CallToolResult>
}

/** A tool after its input type is erased — what the loop in {@link buildServer} consumes. */
export interface RegisteredTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType
  readonly annotations: ToolAnnotations
  /**
   * Re-parses even though the SDK validates first: a direct call (tests, or an embedding host)
   * must reject exactly what the wire path rejects.
   */
  readonly call: (args: unknown, ctx: HandlerContext) => CallToolResult | Promise<CallToolResult>
}

function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): RegisteredTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    annotations: spec.annotations,
    call: (args, ctx) => spec.run(spec.input.parse(args), ctx),
  }
}

/** Writes are additive except `retract`; only `verify_event` and `status` are read-only. */
const ADDS_EVENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}

const TOOL_SPECS = [
  defineTool({
    name: 'set_profile',
    title: 'Set publisher profile',
    description:
      'Publish kind 0 profile metadata (NIP-01 replaceable) for the signing key — one profile per ' +
      'publisher, re-publishing replaces it. Content is the NIP-01 profile JSON ({name, ' +
      'display_name, about, picture}) built from these fields. Feeds the Lens publisher chip, so ' +
      '`name` is the short handle a reader sees next to every event.',
    input: schemas.setProfileInput,
    annotations: { ...ADDS_EVENT, idempotentHint: true },
    run: setProfile,
  }),
  defineTool({
    name: 'publish_product',
    title: 'Publish a Product',
    description:
      'Publish a root Product event (kind 1, t=scrutiny-product). Identify the artefact with `i` ' +
      'indexers — they are immutable after publish (IX-3), so publish a new root rather than ' +
      'correcting them. Content is composed by the server (rule 8); never send raw text.',
    input: schemas.publishProductInput,
    annotations: ADDS_EVENT,
    run: publishProduct,
  }),
  defineTool({
    name: 'publish_metadata',
    title: 'Publish Metadata under a Product',
    description:
      'Publish a Metadata record (kind 1, t=scrutiny-metadata) — specification, test report, SBOM, ' +
      'advisory — as a child of a Product via publish_binding. `meta_subtype` becomes the Lens ' +
      'compatibility tag ["meta","<subtype>"]; Lens result cards are product cards, so a record ' +
      'with no product root is invisible in the results rail.',
    input: schemas.publishMetadataInput,
    annotations: ADDS_EVENT,
    run: publishMetadata,
  }),
  defineTool({
    name: 'publish_binding',
    title: 'Bind a record to a root',
    description:
      'Publish a Binding (kind 1, t=scrutiny-binding): `e root` + `e link` with NIP-10 markers ' +
      '(BD-1..BD-10). Content is the label, any bullets, and the mandatory `Refs: root … link …` ' +
      'line (rule 8d). `label` is the verb Lens shows in the files rail and is clipped to 28 chars. ' +
      'A binding is immutable — express a change with a Patch, not a second binding.',
    input: schemas.publishBindingInput,
    annotations: ADDS_EVENT,
    run: publishBinding,
  }),
  defineTool({
    name: 'publish_patch',
    title: 'Patch event content',
    description:
      'Publish a Patch (kind 1, t=scrutiny-patch) that corrects the content of `target_id`, the ' +
      'resolved tip. Send either `before`+`after` (the server diffs them; `before` must be the ' +
      'content target_id resolves to) or a unified `diff`; the server fences the payload per E4, ' +
      'resolves the chain, and enforces P1/P3/P4 determinism, so a patch that would not apply ' +
      'cleanly is rejected rather than published.',
    input: schemas.publishPatchInput,
    annotations: ADDS_EVENT,
    run: publishPatch,
  }),
  defineTool({
    name: 'retract',
    title: 'Retract an event',
    description:
      'Publish a kind 5 deletion for an event this key authored. DEL-11: the relay stores the ' +
      'deletion and never acts on it — the event stays fetchable and Lens marks it retracted, so ' +
      'this is a correction of record, not an erasure. Requires the exact event id.',
    input: schemas.retractInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: retract,
  }),
  defineTool({
    name: 'verify_event',
    title: 'Verify a published event',
    description:
      'Fetch an event back from the relay with REQ {"ids":[…]} and return what the relay stored, ' +
      'with its id-check and signature-check status. Use it after every publish: a stored, ' +
      'byte-identical event — not a local echo — is the proof that the publish landed.',
    input: schemas.verifyEventInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true, // opens a relay connection — hosts gate approval on this hint
    },
    run: verifyEvent,
  }),
  defineTool({
    name: 'status',
    title: 'Server status',
    description:
      'Report the relay URL in use, which signer backend is configured, the signing pubkey when ' +
      'it is known before connecting, and whether a relay socket is connected. Use it as the ' +
      'first call: a `signer: none` line means publishing tools will refuse until the host is ' +
      'configured.',
    input: schemas.statusInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (_input, ctx) => status(ctx),
  }),
] as const satisfies readonly RegisteredTool[]

export const TOOLS: readonly RegisteredTool[] = TOOL_SPECS

/**
 * `instructions` is the short playbook the host injects into the model's context once (#108
 * "Tool surface", report §8.5). The long version lives in the publisher guide (#109), served as
 * the `scrutiny://publisher-guide` resource.
 */
export const INSTRUCTIONS = [
  'Publish SCRUTINY Fabric events to a relay.',
  'Pass structured fields only: the server composes content deterministically (rule 8) and keeps',
  'every machine fact in the prose (rule 2a), so never assemble event text yourself.',
  'Never send key material. Signing goes through the signer port (D13): SCRUTINY_SIGNER_URI for a',
  'NIP-46 bunker, NSEC/NSEC_FILE for dev only — a key in a tool argument is a leak.',
  'A green publish is an event you fetched back with verify_event, not a local success message.',
  'Field semantics: issue #108. Publisher guide: #109.',
].join('\n')

/** The MCP resource URI of the long-form publisher guide (`docs/publisher-guide.md`, #109). */
export const PUBLISHER_GUIDE_URI = 'scrutiny://publisher-guide'

function readPublisherGuide(): string {
  // Read at buildServer, not at module load: the build is pure, and the guide is content, not code.
  return readFileSync(new URL('../../docs/publisher-guide.md', import.meta.url), 'utf8')
}

/**
 * Build a fully registered server. Pure: no transport, no network, no key read — the caller
 * attaches a transport (`src/index.ts` uses stdio, tests use an in-memory pair).
 */
export function buildServer(deps: ToolDeps): McpServer {
  const ctx = createContext(deps)
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      (args) => tool.call(args, ctx),
    )
  }
  const guide = readPublisherGuide()
  server.registerResource(
    'publisher-guide',
    PUBLISHER_GUIDE_URI,
    {
      title: 'Publisher guide',
      description:
        'How to map vendor data onto the tool fields: composition rules, indexers, artifacts, ' +
        'lifecycle and the verification loop (#109).',
      mimeType: 'text/markdown',
    },
    () => ({
      contents: [{ uri: PUBLISHER_GUIDE_URI, mimeType: 'text/markdown', text: guide }],
    }),
  )
  return server
}
