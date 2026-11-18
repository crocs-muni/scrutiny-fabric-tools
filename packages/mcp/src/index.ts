/**
 * @crocs-muni/scrutiny-fabric-mcp engine (spec docs/specs/mcp-publishing.md §4). Step 1 of §18: the pure draft
 * step. The MCP server and the CLI are thin adapters added in later steps.
 */

export {
  type Draft,
  type DraftInput,
  type DraftNetwork,
  type EventType,
  type GraphBlob,
  type GraphEvent,
  type Preview,
  type PreviewRelay,
  type TemplateGraph,
  draftPlan,
} from './plan/draft.js'
export { planHash } from './plan/hash.js'
export type { Plan } from './plan/schema.js'
export type { OpenQuestion, OpenQuestionCode, Refusal } from './refusal.js'
export type { SignerPort } from './signer/signer.js'
export { liveDraftNetwork } from './relay/network.js'
export { RelayClient } from './relay/client.js'
export { type PublishReply, RelayError } from './relay/socket.js'
export { BlossomError, ensureBlob } from './artifacts/blossom.js'
export type { BlobUpload } from './plan/draft.js'
export { Journal } from './publish/journal.js'
export {
  CALL_BUDGET_MS,
  type MirrorTransport,
  type PrimaryTransport,
  type RecordResult,
  type RunInput,
  type RunResult,
  runPlan,
} from './publish/run.js'
