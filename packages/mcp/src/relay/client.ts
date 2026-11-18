/**
 * A lazily dialled relay with the reconnect policy of spec §8.3: when no OK arrives in time or the
 * socket drops, reconnect and resend the same signed bytes, at most three times, after 1 s, 4 s and
 * 10 s. The relay deduplicates by id, so a resend can never create a second event. A relay verdict
 * (`OK true` or `OK false`) is returned at once and never retried here.
 */

import type { NostrEvent } from '@crocs-muni/scrutiny-fabric'
import type { SignerPort } from '../signer/signer.js'
import { type PublishReply, RelayConnection, RelayError, type RelayTimeouts } from './socket.js'

const RESEND_DELAYS_MS: readonly number[] = [1000, 4000, 10_000]

export interface RelayClientOptions {
  readonly url: string
  readonly signer: SignerPort
  readonly now: () => number
  readonly timeouts?: RelayTimeouts
  readonly sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The back-off delay, cut short when `signal` aborts: an abort while waiting out the last 10 s must
 * not hold the caller. The caller stops on the next attempt, when it sees the abort.
 */
function sleepUntilAborted(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal === undefined) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolveWait, rejectWait) => {
    const onAbort = () => resolveWait()
    signal.addEventListener('abort', onAbort, { once: true })
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolveWait()
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectWait(cause)
      },
    )
  })
}

export class RelayClient {
  readonly #options: RelayClientOptions
  #connection: Promise<RelayConnection> | null = null

  constructor(options: RelayClientOptions) {
    this.#options = options
  }

  /** Resends the same bytes at most three times; an aborted `signal` stops the resends at once. */
  async publish(event: NostrEvent, signal?: AbortSignal): Promise<PublishReply> {
    const sleep = this.#options.sleep ?? realSleep
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted === true) throw new RelayError('closed', 'the publish was aborted')
      try {
        return await (await this.#connect()).publish(event)
      } catch (cause) {
        if (signal?.aborted === true) throw cause
        const delay = RESEND_DELAYS_MS[attempt]
        if (!(cause instanceof RelayError) || !cause.retryable || delay === undefined) throw cause
        this.#drop()
        await sleepUntilAborted(delay, signal, sleep)
      }
    }
  }

  async fetchByIds(ids: readonly string[]): Promise<Map<string, NostrEvent>> {
    return (await this.#connect()).fetchByIds(ids)
  }

  async query(filter: Readonly<Record<string, unknown>>): Promise<NostrEvent[]> {
    return (await this.#connect()).query(filter)
  }

  close(): void {
    this.#drop()
  }

  #connect(): Promise<RelayConnection> {
    if (this.#connection === null) {
      const pending = RelayConnection.open(this.#options)
      this.#connection = pending
      pending.then(
        (c) => {
          if (c.closed && this.#connection === pending) this.#connection = null
        },
        () => {
          if (this.#connection === pending) this.#connection = null
        },
      )
      return pending
    }
    return this.#connection.then((c) => {
      if (!c.closed) return c
      this.#connection = null
      return this.#connect()
    })
  }

  #drop(): void {
    const current = this.#connection
    this.#connection = null
    current?.then(
      (c) => c.close(),
      () => {},
    )
  }
}
