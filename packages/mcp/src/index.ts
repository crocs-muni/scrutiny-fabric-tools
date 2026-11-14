#!/usr/bin/env node
/**
 * Stdio entry point — host-agnostic by construction (#108): any MCP host that can spawn a process
 * speaks this server, so nothing here is host-specific.
 *
 * stdout is the JSON-RPC channel. Every diagnostic goes to stderr; one stray `console.log` on
 * stdout corrupts the stream and the host reports a protocol error instead of the real problem.
 *
 * Not imported by anything, including tests: importing this module would open a stdio session.
 * Tests call `buildServer` and attach their own transport.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig } from './config.ts'
import { buildServer } from './tools/register.ts'

try {
  const config = loadConfig()
  const server = buildServer({ config })
  await server.connect(new StdioServerTransport())
} catch (error) {
  if (error instanceof ConfigError) {
    // Exit 2: a host distinguishes "misconfigured" from "crashed while serving" by the code.
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  throw error
}
