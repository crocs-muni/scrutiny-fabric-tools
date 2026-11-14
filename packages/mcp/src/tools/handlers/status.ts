/**
 * `status` — the first-call report (#108 A4).
 *
 * `signerStatus` stays synchronous and side-effect-free (identity.ts), so this handler never spends
 * a bunker approval to answer a status question. `connected` is the relay client's real socket
 * state: false before the session's first relay operation, true only once a socket has reached
 * `open` (A3's `RelayClient.connected`), and false again after a lost connection.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SERVER_NAME, SERVER_VERSION } from '../../config.ts'
import { signerStatus } from '../../identity.ts'
import type { HandlerContext } from './context.ts'
import { textResult } from './context.ts'

export function status(ctx: HandlerContext): CallToolResult {
  const signer = signerStatus(ctx.config)
  const lines = [
    `server: ${SERVER_NAME} ${SERVER_VERSION}`,
    `relay: ${ctx.config.relayUrl}`,
    // `detail` is the only signer text: the URI's `secret` param never leaves config.ts.
    `signer: ${signer.detail}`,
    `connected: ${ctx.connected ? 'yes' : 'no'}`,
  ]
  if (signer.pubkey !== undefined) lines.push(`pubkey: ${signer.pubkey}`)
  return textResult(lines.join('\n'))
}
