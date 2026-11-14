/**
 * The handler context: one per `buildServer` call, shared by every tool (#108 A4).
 *
 * The seams exist so tests can drive the real handlers without a socket, a bunker or a wall clock,
 * and so the production path stays lazy:
 *
 * - `signer()` resolves the D13 backend on first use and caches it. It is the ONLY path that can
 *   spend a NIP-46 approval round-trip, which is why every handler composes and preflights first;
 * - `relay()` returns one {@link RelayClient} for the session. Constructing it never dials — the
 *   client dials on its first operation — and its NIP-42 signer resolves `signer()` lazily, so a
 *   session whose signer is unconfigured can still read (`verify_event`).
 * - `stamp()` is the monotonic `created_at` source (`nextCreatedAt`, identity/sign.ts): one event
 *   per tool call, and a replaceable profile or two events in the same second still sort.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { UnsignedEvent } from '@scrutiny-fabric/core'
import type { ServerConfig } from '../../config.ts'
import { type Signer, loadSigner } from '../../identity.ts'
import { nextCreatedAt } from '../../identity/sign.ts'
import type { RelayTransport } from '../../identity/transport.ts'
import type { PreflightFinding } from '../../preflight/checkTable.ts'
import { RelayClient } from '../../relay/client.ts'
import type { AuthSigner } from '../../relay/types.ts'

/** What {@link buildServer} receives. Only `config` is required; the rest are test/production seams. */
export interface ToolDeps {
  readonly config: ServerConfig
  /** A prebuilt signer (tests, or a host that resolved one itself); otherwise `loadSigner`. */
  readonly signer?: Signer
  /** A prebuilt relay client (tests over the fake relay); otherwise one for `config.relayUrl`. */
  readonly client?: RelayClient
  /** The NIP-46 relay transport (`src/index.ts` supplies the WebSocket one). */
  readonly transport?: RelayTransport
  /** Clock override in unix seconds; every publish stamps and preflights against it. */
  readonly now?: () => number
}

export interface HandlerContext {
  readonly config: ServerConfig
  /** Resolve the publishing signer; throws `ConfigError` when none is configured. */
  signer(): Promise<Signer>
  /** The session's relay client; never dials until an operation runs. */
  relay(): RelayClient
  /** True only while the client's socket is open — never dials to answer `status`. */
  readonly connected: boolean
  /** The next `created_at`, monotonic within the session and inside the relay's window. */
  stamp(): number
  /** The clock this context stamps and preflights against. */
  now(): number
}

export function createContext(deps: ToolDeps): HandlerContext {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  let client: RelayClient | undefined = deps.client
  let pending: Promise<Signer> | undefined =
    deps.signer === undefined ? undefined : Promise.resolve(deps.signer)
  let lastStamp: number | undefined

  async function signer(): Promise<Signer> {
    if (deps.signer !== undefined) return deps.signer
    // A rejected handshake is retryable (the bunker may come back); a rejected promise would cache
    // the failure for the whole session, so clear it and let the next call try again.
    pending ??= loadSigner(deps.config, deps.transport).catch((cause: unknown) => {
      pending = undefined
      throw cause
    })
    return await pending
  }

  const authSigner: AuthSigner = {
    // NIP-42 only: reads are ungated (gate.go:10), so a read-only session never reaches this.
    sign: async (template: UnsignedEvent) => (await signer()).sign(template),
  }

  function relay(): RelayClient {
    client ??= new RelayClient({ relayUrl: deps.config.relayUrl, signer: authSigner })
    return client
  }

  return {
    config: deps.config,
    signer,
    relay,
    get connected() {
      return client?.connected ?? false
    },
    stamp() {
      const stamp = nextCreatedAt(lastStamp, now())
      lastStamp = stamp
      return stamp
    },
    now,
  }
}

// ---------------------------------------------------------------------------
// result shapes shared by every handler
// ---------------------------------------------------------------------------

/** A plain text result. `isError` is the MCP-level failure flag, not a publish verdict. */
export function textResult(text: string, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] }
}

/** A JSON result; pretty-printed so the model can read one field at a time. */
export function jsonResult(value: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(value, null, 2), isError)
}

/**
 * The refusal text: one block per finding, each naming the schema field, the problem and the fix,
 * plus any warnings. "nothing was signed" is stated explicitly — the refusal happens before the
 * signer exists, and the model must not assume a retry already cost an approval.
 */
function formatRefusal(
  tool: string,
  findings: readonly PreflightFinding[],
  warnings: readonly string[] = [],
): string {
  const lines = [`${tool} refused — nothing was signed.`]
  for (const finding of findings) {
    lines.push('', `${finding.field}: ${finding.problem}`, `  fix: ${finding.fix}`)
  }
  if (warnings.length > 0) {
    lines.push('', 'warnings:')
    for (const warning of warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

/** Refuse before any signer round-trip. The caller never touches `ctx.signer()` on this path. */
export function refuse(
  tool: string,
  findings: readonly PreflightFinding[],
  warnings: readonly string[] = [],
): CallToolResult {
  return textResult(formatRefusal(tool, findings, warnings), true)
}

/** Report a failure that is not the user's input: configuration, relay, or a server bug. */
export function failure(tool: string, cause: unknown): CallToolResult {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return textResult(`${tool} failed — ${reason}`, true)
}
