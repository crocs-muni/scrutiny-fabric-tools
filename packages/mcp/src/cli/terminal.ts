/**
 * The real terminal behind `CliIo`. Prompts go to stderr so stdout stays clean for the npub and
 * the backup; typed characters are never echoed.
 */

import type { CliIo } from './main.js'

const ENTER = new Set(['\r', '\n'])
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const BACKSPACE = new Set(['\u007f', '\b'])

function promptHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  stdin.resume()
  return new Promise((resolve, reject) => {
    let typed = ''
    const finish = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      if (error === undefined) resolve(typed)
      else reject(error)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ENTER.has(ch)) return finish()
        if (ch === CTRL_C || ch === CTRL_D) return finish(new Error('cancelled'))
        if (BACKSPACE.has(ch)) typed = typed.slice(0, -1)
        else typed += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function terminalIo(): CliIo {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin,
    promptHidden,
  }
}
