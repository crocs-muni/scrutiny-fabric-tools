/**
 * The run engine (spec §8): one time-boxed slice of a publish run (§6.3). It assumes the plan was
 * approved; obtaining approval is the adapter's job (§7).
 *
 * Order is the template graph's: profile → products → metadata → bindings (§8.1). For each event:
 * blobs first, then `@ref:` placeholders resolved to acked ids, `created_at` from the signer's
 * clock, sign, journal `signed`, send, journal the verdict (§8.2).
 *
 * Invariant A: an event is signed only when every event it references has an `OK true` from the
 * primary (or was found stored there on resume). A rejection stops the run, so nothing that
 * depends on a rejected event is ever signed.
 */

import type { NostrEvent, UnsignedEvent } from '@crocs-muni/scrutiny-fabric'
import { BlossomError } from '../artifacts/blossom.js'
import type { BlobUpload, TemplateGraph } from '../plan/draft.js'
import type { Refusal } from '../refusal.js'
import type { PublishReply } from '../relay/socket.js'
import { sameEvent, verifySignedEvent } from '../signer/event.js'
import { SignerError, type SignerPort } from '../signer/signer.js'
import type { Journal, RecordLine } from './journal.js'

/** Spec §6.3: each call works for 20 s, then returns `partial`. */
export const CALL_BUDGET_MS = 20_000

export interface PrimaryTransport {
  /**
   * Throws `RelayError` when no verdict arrived (after the client's own resends). Aborting `signal`
   * stops the resends: a run that returned `partial` leaves nothing writing to the relay.
   */
  publish(event: NostrEvent, signal?: AbortSignal): Promise<PublishReply>
  /**
   * §8.4/§8.7 reads. Aborting `signal` stops waiting for the answer; the run returns `partial`
   * either way, so a transport may accept it and ignore it.
   */
  fetchByIds(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, NostrEvent>>
}

export interface MirrorTransport {
  /** One attempt, no resends (§8.6). The deadline aborts `signal`, as for the primary. */
  publish(event: NostrEvent, signal?: AbortSignal): Promise<PublishReply>
}

export interface RunInput {
  readonly planHash: string
  readonly graph: TemplateGraph
  readonly uploads: readonly BlobUpload[]
  readonly journal: Journal
  readonly signer: SignerPort
  readonly primary: PrimaryTransport
  readonly mirrors: ReadonlyMap<string, MirrorTransport>
  readonly uploadBlob: (
    upload: BlobUpload,
  ) => Promise<{ readonly state: 'present' | 'uploaded'; readonly url: string }>
  /** Unix seconds: the signer's clock, used for `created_at`. */
  readonly now: () => number
  /** Milliseconds, for the deadline. */
  readonly clock: () => number
  /** In `clock()` milliseconds; nothing new is signed once it has passed. */
  readonly deadline: number
  /** `notifications/cancelled`: finish the event in flight, then stop. */
  readonly signal?: AbortSignal
  readonly onProgress?: (done: number, total: number) => void
  /** The primary's NIP-11 `max_limit`, for fetch-back batches. */
  readonly maxLimit?: number
}

type RecordState = 'verified' | 'acked' | 'pending' | 'rejected' | 'skipped'

export interface RecordResult {
  readonly ref: string
  event_id: string | null
  state: RecordState
  ack: PublishReply | null
  readonly mirrors: Record<string, PublishReply>
  readonly blobs: {
    readonly x: string
    readonly url: string
    readonly state: 'uploaded' | 'present'
  }[]
}

export interface RunResult {
  readonly outcome: 'complete' | 'partial' | 'stopped'
  readonly records: readonly RecordResult[]
  readonly progress: { readonly done: number; readonly total: number }
  readonly refusal: Refusal | null
  readonly resume: string | null
}

const RESUME = 'Call publish_plan again with the same plan_hash to continue.'
const PLACEHOLDER = /@ref:((?:profile|product|metadata):[a-z0-9][a-z0-9._-]{0,63})/gu

function refusal(
  code: string,
  source: Refusal['source'],
  problem: string,
  fix: string,
  relayMessage: string | null = null,
): Refusal {
  return { code, field: null, problem, fix, source, relay_message: relayMessage }
}

/** A whole `e`-tag value that is a ref placeholder, as §5.3 composes bindings. */
const PLACEHOLDER_REF = /^@ref:((?:profile|product|metadata):[a-z0-9][a-z0-9._-]{0,63})$/u

/**
 * The refs an event cites as parents (spec §8.2): the `@ref:` values of its `e` tags. Derived from
 * the structure, never by scanning prose — a lookalike token in the content is text the user
 * approved, not a dependency, and treating it as one would skip the event as unacked.
 */
function parentsOf(event: TemplateGraph['events'][number]): string[] {
  const refs = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] !== 'e') continue
    for (const value of tag) {
      const ref = PLACEHOLDER_REF.exec(value)?.[1]
      if (ref !== undefined) refs.add(ref)
    }
  }
  return [...refs]
}

function resolve(value: string, ids: ReadonlyMap<string, string>): string {
  return value.replace(PLACEHOLDER, (whole, ref: string) => ids.get(ref) ?? whole)
}

function isoNow(): string {
  return new Date().toISOString()
}

type Waited<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'deadline' }

/**
 * Starts `start(signal)` and waits for it until the deadline, measured before it starts. Work still
 * pending at the deadline is aborted, so what the call started — the client's resends above all —
 * does not outlive the call. A success is never aborted.
 */
function untilDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  input: RunInput,
): Promise<Waited<T>> {
  const remaining = input.deadline - input.clock()
  if (remaining <= 0) return Promise.resolve({ kind: 'deadline' })
  const controller = new AbortController()
  const promise = start(controller.signal)
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      controller.abort()
      resolveWait({ kind: 'deadline' })
    }, remaining)
    promise.then(
      (value: T) => {
        clearTimeout(timer)
        resolveWait({ kind: 'value', value })
      },
      (error: unknown) => {
        clearTimeout(timer)
        rejectWait(error)
      },
    )
  })
}

export async function runPlan(input: RunInput): Promise<RunResult> {
  const { graph, journal } = input
  const total = graph.events.length
  const records = new Map<string, RecordResult>(
    graph.events.map((e) => [
      e.ref,
      { ref: e.ref, event_id: null, state: 'pending', ack: null, mirrors: {}, blobs: [] },
    ]),
  )
  /** ref → id of its event acked by the primary. */
  const acked = new Map<string, string>()
  const latest = journal.latest()

  const result = (
    outcome: RunResult['outcome'],
    stop: Refusal | null = null,
    resumable = outcome !== 'complete',
  ): RunResult => ({
    outcome,
    records: [...records.values()],
    progress: { done: acked.size, total },
    refusal: stop,
    resume: resumable ? RESUME : null,
  })
  const set = (ref: string, patch: Partial<Pick<RecordResult, 'event_id' | 'state' | 'ack'>>) => {
    const record = records.get(ref)
    if (record !== undefined) Object.assign(record, patch)
  }

  // Carry over what earlier calls settled.
  for (const [ref, line] of latest) {
    if (line.state === 'acked' || line.state === 'verified') {
      acked.set(ref, line.event_id)
      set(ref, { event_id: line.event_id, state: line.state })
    }
  }

  // §8.4: signed but never acked. Ask the primary first; never resend stale bytes blindly.
  const unacked = [...latest.values()].filter((l) => l.state === 'signed')
  if (unacked.length > 0) {
    let waitedRead: Waited<Map<string, NostrEvent>>
    try {
      waitedRead = await untilDeadline(
        (signal) =>
          input.primary.fetchByIds(
            unacked.map((l) => l.event_id),
            signal,
          ),
        input,
      )
    } catch (cause) {
      return result(
        'stopped',
        refusal(
          'relay.read_failed',
          'relay',
          `could not ask the primary relay which unacknowledged events it stored: ${cause instanceof Error ? cause.message : 'unknown'}`,
          'Check the connection and call publish_plan again.',
        ),
      )
    }
    if (waitedRead.kind === 'deadline') return result('partial')
    const stored = waitedRead.value
    for (const line of unacked) {
      const found = stored.get(line.event_id)
      if (found !== undefined) {
        // §8.4 step 2: stored ⇒ acked. Byte comparison and the signature check belong to §8.7,
        // which reports "acked, not verified"; gating the ack on them here would re-sign an event
        // the relay already holds and publish a second event for one ref.
        await journal.append({
          type: 'record',
          ref: line.ref,
          state: 'acked',
          event_id: line.event_id,
          at: isoNow(),
        })
        acked.set(line.ref, line.event_id)
        set(line.ref, { event_id: line.event_id, state: 'acked' })
      } else {
        // Not stored: by invariant A nothing references it, so a fresh signature forks nothing.
        await journal.append({
          type: 'record',
          ref: line.ref,
          state: 'superseded',
          event_id: line.event_id,
          at: isoNow(),
        })
      }
    }
    input.onProgress?.(acked.size, total)
  }

  // Primary pass.
  const uploaded = new Set<string>()
  for (const event of graph.events) {
    if (acked.has(event.ref)) continue
    if (input.signal?.aborted) return result('stopped', cancelled())
    if (input.clock() >= input.deadline) return result('partial')

    const parents = parentsOf(event)
    if (parents.some((p) => !acked.has(p))) {
      // Unreachable while rejections stop the run; kept so invariant A never rests on that alone.
      set(event.ref, { state: 'skipped' })
      continue
    }

    for (const upload of input.uploads.filter((u) => u.ref === event.ref)) {
      if (uploaded.has(upload.x)) continue
      if (input.clock() >= input.deadline) return result('partial')
      try {
        const blob = await input.uploadBlob(upload)
        // §7/§8: an upload can outlast the cancel; stop before this event is signed and published.
        if (input.signal?.aborted) return result('stopped', cancelled())
        records.get(event.ref)?.blobs.push({ x: upload.x, url: blob.url, state: blob.state })
        uploaded.add(upload.x)
        input.onProgress?.(acked.size, total)
      } catch (cause) {
        // §8.2: a blob failure stops the run before any event citing it is signed.
        return result(
          'stopped',
          cause instanceof BlossomError
            ? cause.refusal
            : refusal(
                'artifact.upload_failed',
                'artifact',
                `uploading ${upload.path} failed`,
                'Call publish_plan again to retry.',
              ),
        )
      }
    }

    // §5.4/§8.2: only this event's own parents resolve. A token naming anything else — an
    // agent-authored lookalike in the prose, an `i` value, an `alt` — stays literal, so the
    // signed bytes never wander from the bytes whose hash the user approved.
    const own = new Map<string, string>()
    for (const parent of parents) {
      const id = acked.get(parent)
      if (id !== undefined) own.set(parent, id)
    }
    const template: UnsignedEvent = {
      kind: event.kind,
      created_at: input.now(),
      tags: event.tags.map((tag) => tag.map((v) => resolve(v, own))),
      content: resolve(event.content, own),
    }
    let signed: NostrEvent
    try {
      signed = await input.signer.sign(template)
    } catch (cause) {
      if (cause instanceof SignerError) return result('stopped', cause.refusal)
      throw cause
    }
    await journal.append({
      type: 'record',
      ref: event.ref,
      state: 'signed',
      event_id: signed.id,
      signed_event: signed,
      at: isoNow(),
    })
    set(event.ref, { event_id: signed.id, state: 'pending' })

    let waited: Waited<PublishReply>
    try {
      waited = await untilDeadline((signal) => input.primary.publish(signed, signal), input)
    } catch (cause) {
      return result(
        'stopped',
        refusal(
          'relay.no_ack',
          'relay',
          `the primary relay gave no verdict for ${event.ref}: ${cause instanceof Error ? cause.message : 'unknown'}`,
          'Call publish_plan again; the event is checked on the relay before anything is resent.',
        ),
      )
    }
    if (waited.kind === 'deadline') return result('partial')

    const reply = waited.value
    set(event.ref, { ack: reply })
    if (!reply.ok) {
      await journal.append({
        type: 'record',
        ref: event.ref,
        state: 'rejected',
        event_id: signed.id,
        message: reply.message,
        at: isoNow(),
      })
      set(event.ref, { state: 'rejected' })
      for (const other of graph.events) {
        if (parentsOf(other).includes(event.ref)) set(other.ref, { state: 'skipped' })
      }
      return result('stopped', rejection(event.ref, reply.message))
    }
    await journal.append({
      type: 'record',
      ref: event.ref,
      state: 'acked',
      event_id: signed.id,
      at: isoNow(),
    })
    acked.set(event.ref, signed.id)
    set(event.ref, { state: 'acked' })
    input.onProgress?.(acked.size, total)
  }

  // §8.6 mirrors: same signed bytes, one attempt each, never gating, never journalled.
  for (const event of graph.events) {
    const id = acked.get(event.ref)
    const signed = id === undefined ? undefined : journal.signedEvent(id)
    if (signed === undefined) continue
    for (const [url, mirror] of input.mirrors) {
      // §7/§8: a mirror write is the next write after the cancel; stop before it.
      if (input.signal?.aborted) return result('stopped', cancelled())
      let waitedMirror: Waited<PublishReply>
      try {
        waitedMirror = await untilDeadline((signal) => mirror.publish(signed, signal), input)
      } catch (cause) {
        waitedMirror = {
          kind: 'value',
          value: { ok: false, message: cause instanceof Error ? cause.message : 'no reply' },
        }
      }
      if (waitedMirror.kind === 'deadline') return result('partial')
      const record = records.get(event.ref)
      if (record !== undefined) record.mirrors[url] = waitedMirror.value
    }
  }

  // §8.7 fetch-back verification.
  const toVerify = graph.events.filter((e) => records.get(e.ref)?.state === 'acked')
  const batch = Math.min(input.maxLimit ?? 500, 500)
  for (let i = 0; i < toVerify.length; i += batch) {
    if (input.clock() >= input.deadline) return result('partial')
    const slice = toVerify.slice(i, i + batch)
    let waitedVerify: Waited<Map<string, NostrEvent>>
    try {
      waitedVerify = await untilDeadline(
        (signal) =>
          input.primary.fetchByIds(
            slice.map((e) => acked.get(e.ref) ?? ''),
            signal,
          ),
        input,
      )
    } catch {
      continue // Published, not proven: reported as `acked`.
    }
    if (waitedVerify.kind === 'deadline') return result('partial')
    const stored = waitedVerify.value
    for (const event of slice) {
      const id = acked.get(event.ref) ?? ''
      const journalled = journal.signedEvent(id)
      const found = stored.get(id)
      if (journalled === undefined || found === undefined) continue
      if (!sameEvent(found, journalled) || !verifySignedEvent(found)) continue
      await journal.append({
        type: 'record',
        ref: event.ref,
        state: 'verified',
        event_id: id,
        at: isoNow(),
      } satisfies RecordLine)
      set(event.ref, { state: 'verified' })
    }
  }

  return result('complete')
}

function cancelled(): Refusal {
  return refusal(
    'run.cancelled',
    'internal',
    'the run was cancelled',
    'Call publish_plan again to continue.',
  )
}

/** §8.3: the relay's message verbatim; `blocked: not an allowed publisher` has its own code. */
function rejection(ref: string, message: string): Refusal {
  if (message.startsWith('blocked: not an allowed publisher')) {
    return refusal(
      'relay.not_allowed',
      'relay',
      `the primary relay refused ${ref}: this key is not on its allowlist`,
      'Send your npub (run `whoami`) to the relay operator, then call publish_plan again.',
      message,
    )
  }
  return refusal(
    'relay.rejected',
    'relay',
    `the primary relay rejected ${ref}`,
    'Read the relay message, fix the cause, and call publish_plan again.',
    message,
  )
}
