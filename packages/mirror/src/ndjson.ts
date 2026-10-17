/**
 * ndjson.ts — signed-event NDJSON reader shared by the CLI and the emit stages
 * (the artifact writer lives in `emit/ndjson.ts`).
 *
 * One compact JSON `SignedEvent` per line; blank lines are skipped; a malformed line is a hard
 * error carrying `<path>:<line>`.
 */
import { readFileSync } from 'node:fs'

import type { SignedEvent } from './types.js'

/** Message of an unknown thrown value: `Error.message`, else `String(value)`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read one NDJSON event list; a malformed line is a hard error with its line number. */
export function readNdjson(path: string): SignedEvent[] {
  const events: SignedEvent[] = []
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed) as SignedEvent)
    } catch (err) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${errorMessage(err)}`)
    }
  }
  return events
}
