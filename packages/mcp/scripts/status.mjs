#!/usr/bin/env node
/**
 * Ask the running configuration "who will sign, and with which identity?" — the same `status`
 * call an MCP host makes, without making a human hand-quote JSON-RPC in a shell.
 *
 *   node scripts/status.mjs
 *
 * It spawns the server exactly as a host would, sends `initialize` + `tools/call status`, prints
 * the server's own text and exits with the server's verdict:
 *
 *   0  a signer is configured and the identity check passed
 *   1  the setup would refuse every publish (`signer: none`, or a failed identity check)
 *   2  the process refused to start (a configuration error — the message names the variable)
 *
 * A configuration error ends the child before any JSON-RPC reply, so the child's `exit` settles
 * whatever is pending: without that, the await never resolves and Node reports an unsettled
 * top-level await instead of the message that says what is wrong.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const server = spawn(process.execPath, ['--experimental-strip-types', ENTRY], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let stderr = ''
const pending = new Map()

function settleAll(error) {
  for (const settle of pending.values()) settle({ error: { message: error } })
  pending.clear()
}

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const settle = pending.get(message.id)
    if (settle !== undefined) {
      pending.delete(message.id)
      settle(message)
    }
  }
})
server.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})
server.on('exit', (code) => {
  const detail = stderr.trim()
  settleAll(detail === '' ? `the server exited (code ${code}) before answering` : detail)
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method}: no answer within 30 s`)), 30_000)
    timer.unref()
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'scrutiny-status', version: '0' },
  })
  if (init.error !== undefined) throw new Error(init.error.message)

  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const answer = await request('tools/call', { name: 'status', arguments: {} })
  if (answer.error !== undefined) throw new Error(answer.error.message)

  const text = answer.result?.content?.[0]?.text
  if (text === undefined) throw new Error('the server answered without a status text')

  console.log(text)
  // `signer: none` is a setup that refuses every publish, so it is a failure like any other.
  const unset = /\bsigner: none\b/u.test(text)
  process.exitCode = answer.result?.isError === true || unset ? 1 : 0
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 2
} finally {
  server.stdin.end()
  server.kill()
}
