/**
 * Draft-time relay probe (spec §6.2, §6.5): NIP-11 document, Blossom presence, clock skew. Reads
 * only; nothing is signed, so Blossom is detected without authorisation: khatru answers
 * `HEAD /upload` with 401 when it is mounted, and the relay's other routes answer 404 or 405.
 */

import { httpBase } from './http-base.js'

export interface RelayLimits {
  readonly max_limit?: number
  readonly max_event_tags?: number
  readonly max_message_length?: number
}

export type RelayProbe =
  | {
      readonly reachable: true
      readonly blossom: boolean
      /** Local clock minus the relay's `Date` header, in seconds; null without a usable header. */
      readonly clock_skew_s: number | null
      readonly limits: RelayLimits
      /** How far `created_at` may lag (`past_s`) or lead (`future_s`) the relay's clock. */
      readonly created_at_window: { readonly past_s: number; readonly future_s: number }
    }
  | { readonly reachable: false; readonly message: string }

/**
 * The SCRUTINY relay's windows (`relay/internal/config` `DefaultMaxEventPastAge` = 2 h,
 * `relay.go` `maxFutureAge` = 15 min). NIP-11 does not advertise them there, so they are the
 * fallback when a relay does not send `created_at_lower_limit` / `created_at_upper_limit`.
 */
const DEFAULT_WINDOW = { past_s: 7200, future_s: 900 }

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A plain JSON object, or undefined for anything else (`null`, arrays, scalars). */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The one NIP-11 field this probe reads; the rest of the document is ignored. */
interface RelayInfo {
  readonly limitation?: unknown
}

export async function probeRelay(
  relayUrl: string,
  deps: { readonly fetch: typeof fetch; readonly now: () => number },
): Promise<RelayProbe> {
  const base = httpBase(relayUrl)
  let info: RelayInfo
  let date: string | null
  try {
    const response = await deps.fetch(`${base}/`, {
      headers: { accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok)
      return { reachable: false, message: `NIP-11 answered HTTP ${response.status}` }
    date = response.headers.get('date')
    const parsed: unknown = await response.json()
    const document = asObject(parsed)
    if (document === undefined) {
      return { reachable: false, message: 'NIP-11 document is not a JSON object' }
    }
    info = document
  } catch (cause) {
    return {
      reachable: false,
      message: `NIP-11 failed: ${cause instanceof Error ? cause.message : 'unknown'}`,
    }
  }

  // NIP-11 nests the limits in an object, but a relay may put `null`, an array or a scalar there.
  // A malformed document degrades to the defaults; it must never throw out of the probe, or the
  // draft fails instead of raising the `relay.unreachable` question it owes the user (spec §6.5).
  const limitation = asObject(info.limitation) ?? {}
  const { created_at_lower_limit: lower, created_at_upper_limit: upper } = limitation
  const limits: { -readonly [K in keyof RelayLimits]: RelayLimits[K] } = {}
  for (const key of ['max_limit', 'max_event_tags', 'max_message_length'] as const) {
    const value = num(limitation[key])
    if (value !== undefined) limits[key] = value
  }
  const relayTime = date === null ? Number.NaN : Date.parse(date)

  return {
    reachable: true,
    blossom: await hasBlossom(base, deps.fetch),
    clock_skew_s: Number.isNaN(relayTime) ? null : deps.now() - Math.floor(relayTime / 1000),
    limits,
    created_at_window: {
      past_s: num(lower) ?? DEFAULT_WINDOW.past_s,
      future_s: num(upper) ?? DEFAULT_WINDOW.future_s,
    },
  }
}

async function hasBlossom(base: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn(`${base}/upload`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    })
    return response.status !== 404 && response.status !== 405 && response.status < 500
  } catch {
    return false
  }
}
