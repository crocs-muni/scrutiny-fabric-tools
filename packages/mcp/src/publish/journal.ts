/**
 * The run journal (spec §8.5): `<root>/.scrutiny/runs/<plan_hash>.journal`, append-only JSON Lines,
 * fsynced per line. Record lines track each ref's event; approval lines record §7.2 approvals.
 *
 * A crash can leave a torn last line; it is ignored on read, and the state it would have recorded
 * is recovered the same way as a lost ack (§8.4).
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NostrEvent } from '@crocs-muni/scrutiny-fabric'

type RecordState = 'signed' | 'acked' | 'verified' | 'rejected' | 'superseded'

export interface RecordLine {
  readonly type: 'record'
  readonly ref: string
  readonly state: RecordState
  readonly event_id: string
  /** Present on `signed` lines: the exact bytes sent, so resends and verification use them. */
  readonly signed_event?: NostrEvent
  /** The relay's message verbatim, on `rejected` lines. */
  readonly message?: string
  readonly at: string
}

export interface ApprovalLine {
  readonly type: 'approval'
  readonly plan_hash: string
  readonly channel: 'elicitation' | 'chat'
  readonly at: string
  readonly valid_until: string
}

export type JournalLine = RecordLine | ApprovalLine

/** Spec §7.2: an approval is valid for 30 minutes. */
const APPROVAL_WINDOW_MS = 30 * 60 * 1000

function journalPath(root: string, planHash: string): string {
  return join(root, '.scrutiny', 'runs', `${planHash}.journal`)
}

export class Journal {
  readonly #path: string
  readonly #lines: JournalLine[]
  /**
   * The file ends in a partial line: `open` skipped it, so the next `append` must start a new line
   * before its record, or the two would fuse into one unparsable line.
   */
  #needsSeparator: boolean

  private constructor(path: string, lines: JournalLine[], needsSeparator: boolean) {
    this.#path = path
    this.#lines = lines
    this.#needsSeparator = needsSeparator
  }

  static async open(root: string, planHash: string): Promise<Journal> {
    const path = journalPath(root, planHash)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      // No journal yet: a fresh run.
    }
    const lines: JournalLine[] = []
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      try {
        lines.push(JSON.parse(raw) as JournalLine)
      } catch {
        // A torn line from a crash mid-write.
      }
    }
    return new Journal(path, lines, text !== '' && !text.endsWith('\n'))
  }

  get lines(): readonly JournalLine[] {
    return this.#lines
  }

  async append(line: JournalLine): Promise<void> {
    await mkdir(join(this.#path, '..'), { recursive: true })
    const payload = `${this.#needsSeparator ? '\n' : ''}${JSON.stringify(line)}\n`
    const handle = await open(this.#path, 'a')
    try {
      await handle.write(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.#needsSeparator = false
    this.#lines.push(line)
  }

  /** The latest record line per ref. */
  latest(): Map<string, RecordLine> {
    const out = new Map<string, RecordLine>()
    for (const line of this.#lines) if (line.type === 'record') out.set(line.ref, line)
    return out
  }

  /** The signed bytes journalled for an event id. */
  signedEvent(eventId: string): NostrEvent | undefined {
    for (const line of this.#lines) {
      if (line.type === 'record' && line.event_id === eventId && line.signed_event !== undefined) {
        return line.signed_event
      }
    }
    return undefined
  }

  /** The newest approval for `planHash` still inside its window at `nowMs`. */
  validApproval(planHash: string, nowMs: number): ApprovalLine | undefined {
    for (let i = this.#lines.length - 1; i >= 0; i--) {
      const line = this.#lines[i]
      if (line?.type !== 'approval' || line.plan_hash !== planHash) continue
      if (Date.parse(line.valid_until) > nowMs) return line
    }
    return undefined
  }

  async recordApproval(
    planHash: string,
    channel: ApprovalLine['channel'],
    nowMs: number,
  ): Promise<ApprovalLine> {
    const line: ApprovalLine = {
      type: 'approval',
      plan_hash: planHash,
      channel,
      at: new Date(nowMs).toISOString(),
      valid_until: new Date(nowMs + APPROVAL_WINDOW_MS).toISOString(),
    }
    await this.append(line)
    return line
  }
}
