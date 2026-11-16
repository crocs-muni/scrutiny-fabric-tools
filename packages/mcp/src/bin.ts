#!/usr/bin/env node
/**
 * Package binary (spec §13.1). With no subcommand it runs the MCP server on stdio; with one it
 * runs the key-management CLI (spec §11.1). The key is resolved lazily on each call, so a missing
 * key never stops the server (spec §17).
 */

import { homedir } from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { runCli } from './cli/main.js'
import { terminalIo } from './cli/terminal.js'
import { liveDeps } from './server/live.js'
import { createServer } from './server/server.js'
import { identityPath } from './signer/identity.js'
import { osKeystore } from './signer/signer.js'

const args = process.argv.slice(2)
if (args.length === 0) {
  await createServer(liveDeps()).connect(new StdioServerTransport())
} else {
  process.exitCode = await runCli(args, terminalIo(), {
    store: osKeystore,
    identityPath: identityPath(process.platform, process.env, homedir()),
  })
}
