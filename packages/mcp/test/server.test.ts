/**
 * End-to-end wiring over an in-memory transport: registration, `tools/list` shape, the `status`
 * happy path, and the rejections a hostile prompt would try. No sockets and no child process —
 * {@link buildServer} is transport-free by design, so this is the whole server minus stdio.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_RELAY_URL, type ServerConfig, loadConfig } from '../src/config.ts'
import { INSTRUCTIONS, PUBLISHER_GUIDE_URI, buildServer } from '../src/tools/register.ts'

const GUIDE_PATH = new URL('../docs/publisher-guide.md', import.meta.url)

const ID_A = 'a'.repeat(64)
const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'

/** Every #108 tool, in the order the issue's table lists them. */
const TOOL_NAMES = [
  'set_profile',
  'publish_product',
  'publish_metadata',
  'publish_binding',
  'publish_patch',
  'retract',
  'verify_event',
  'status',
]

const PRODUCT_ARGS = {
  headline: 'TROPIC01 secure element',
  indexers: ['cpe:2.3:h:tropic-square:tropic01:-:*:*:*:*:*:*:*'],
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function connect(config: ServerConfig = loadConfig({})): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = buildServer({ config })
  const client = new Client({ name: 'test-host', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return client
}

/**
 * `Client.callTool` also models experimental task results; every tool here answers synchronously,
 * so a task result is a bug worth failing on rather than a shape to unwrap.
 */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const reply = await client.callTool({ name, arguments: args })
  if (!('content' in reply)) {
    throw new Error(`${name} answered with a task result, not a CallToolResult`)
  }
  // The runtime guard above cannot narrow away the task-result member: both sides of the SDK's
  // union carry an index signature, so the assertion restates the check for the type system.
  return reply as CallToolResult
}

function textOf(result: CallToolResult): string {
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`)
  }
  return block.text
}

describe('tools/list', () => {
  it('advertises the eight #108 tools with strict object schemas', async () => {
    const { tools } = await connect().then((client) => client.listTools())

    expect(tools.map((tool) => tool.name)).toStrictEqual(TOOL_NAMES)

    for (const tool of tools) {
      // Strictness is the advertised contract: an agent reading the schema learns `content` and
      // `nsec` are not parameters, not merely that they would be ignored.
      expect(tool.inputSchema.type).toBe('object')
      // `additionalProperties` is not in the SDK's declared shape, so assert on the wire JSON.
      expect(JSON.stringify(tool.inputSchema)).toContain('"additionalProperties":false')
      expect(tool.description?.length ?? 0).toBeGreaterThan(40)
    }

    const status = tools.find((tool) => tool.name === 'status')
    expect(status?.inputSchema.properties).toStrictEqual({})
    expect(status?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((tool) => tool.name === 'retract')?.annotations?.destructiveHint).toBe(true)
  })

  it('delivers the playbook instructions to the host', async () => {
    expect(await connect().then((client) => client.getInstructions())).toBe(INSTRUCTIONS)
  })
})

describe('status', () => {
  it('reports the relay and an unconfigured signer', async () => {
    const result = await call(await connect(), 'status', {})
    const text = textOf(result)
    expect(result.isError).toBeFalsy()
    expect(text).toContain(`relay: ${DEFAULT_RELAY_URL}`)
    expect(text).toContain('signer: none — set SCRUTINY_KEYRING')
    expect(text).toContain('connected: no')
    expect(text).not.toContain('pubkey:')
  })

  it('reports the derived pubkey for a dev key without leaking the key', async () => {
    const result = await call(await connect(loadConfig({ NSEC: HEX_KEY })), 'status', {})
    const text = textOf(result)
    expect(text).toContain(`pubkey: ${HEX_PUBKEY}`)
    expect(text).toContain('signer: dev key (NSEC)')
    expect(text).not.toContain(HEX_KEY)
  })
})

describe('resources', () => {
  const sha256 = (value: string | Uint8Array): string =>
    createHash('sha256').update(value).digest('hex')

  it('lists and serves the publisher guide byte-identically', async () => {
    const client = await connect()
    const { resources } = await client.listResources()
    const listed = resources.find((resource) => resource.uri === PUBLISHER_GUIDE_URI)
    expect(listed?.mimeType).toBe('text/markdown')
    expect(listed?.name).toBe('publisher-guide')

    const read = await client.readResource({ uri: PUBLISHER_GUIDE_URI })
    const block = read.contents[0]
    if (block === undefined || !('text' in block)) {
      throw new Error(`expected a text resource, got ${JSON.stringify(read.contents)}`)
    }
    expect(block.uri).toBe(PUBLISHER_GUIDE_URI)
    // The served bytes are the file's bytes, not a re-encoded copy.
    expect(sha256(block.text)).toBe(sha256(readFileSync(GUIDE_PATH)))
  })
})

describe('publishing tools', () => {
  it('refuses to publish when no signer is configured', async () => {
    const result = await call(await connect(), 'publish_product', PRODUCT_ARGS)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no signer configured')
    expect(textOf(result)).toContain('SCRUTINY_SIGNER_URI')
  })

  it('rejects a free-form content argument on the wire', async () => {
    const result = await call(await connect(), 'publish_product', {
      ...PRODUCT_ARGS,
      content: 'agent-authored event text',
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('content')
  })

  it('rejects an nsec argument on the wire', async () => {
    for (const value of [NSEC, 'ab'.repeat(32)]) {
      const result = await call(await connect(), 'publish_product', {
        ...PRODUCT_ARGS,
        nsec: value,
      })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('nsec')
    }
  })

  it('rejects a malformed event id before any handler runs', async () => {
    const result = await call(await connect(), 'retract', {
      target_id: ID_A.toUpperCase(),
      reason: 'reason text',
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('64-char lowercase hex event id')
  })
})
