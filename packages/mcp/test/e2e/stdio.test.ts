/**
 * The built binary over stdio, as every host snippet in the README launches it (spec §13.2): no
 * subcommand starts the MCP server, and a machine without a key still answers `status` (spec §17:
 * a missing key never stops the server). Runs against `dist/`, so `pnpm build` must come first.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, it } from 'vitest'

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../../package.json', import.meta.url))

let client: Client

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing; run \`pnpm build\` first.`)
  // A throwaway home, so the identity lookup never sees this machine's real key.
  const home = mkdtempSync(join(tmpdir(), 'scrutiny-stdio-'))
  const { PATH = '', SystemRoot = '' } = process.env
  client = new Client({ name: 'stdio-smoke', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { PATH, SystemRoot, HOME: home, USERPROFILE: home, APPDATA: home },
      stderr: 'pipe',
    }),
  )
}, 60_000)

afterAll(async () => {
  await client?.close()
})

it('lists the four tools and answers status without a key', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toStrictEqual([
    'draft_plan',
    'publish_plan',
    'status',
    'verify',
  ])
  const status = await client.callTool({ name: 'status', arguments: {} })
  const { name, version } = (await import(MANIFEST, { with: { type: 'json' } })).default as {
    name: string
    version: string
  }
  expect(status.structuredContent).toMatchObject({
    server: { name, version },
    signer: { npub: null },
  })
  const { signer } = status.structuredContent as { signer: { state: string } }
  expect(['missing', 'unavailable']).toContain(signer.state)
}, 60_000)
