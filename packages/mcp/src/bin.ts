#!/usr/bin/env node
/**
 * Package binary. With a subcommand it runs the key-management CLI (spec §11.1). Without one it
 * will run the MCP server on stdio (spec §13.1), which arrives in §18 step 5; until then it prints
 * usage.
 */

import { homedir } from 'node:os'
import { runCli } from './cli/main.js'
import { terminalIo } from './cli/terminal.js'
import { identityPath } from './signer/identity.js'
import { osKeystore } from './signer/signer.js'

process.exitCode = await runCli(process.argv.slice(2), terminalIo(), {
  store: osKeystore,
  identityPath: identityPath(process.platform, process.env, homedir()),
})
