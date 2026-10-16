/**
 * Relay capability probe — read-only reconnaissance before the first publish (and for the ledger's
 * `relays` table).
 *
 * What it does, in order:
 * 1. NIP-11 fetch (`Accept: application/nostr+json`) → supported NIPs, relay name;
 * 2. one websocket, five read-only REQs — `#t` facet, exact `#i`, `#k` facet, kind-5 `#e`, and a
 *    NIP-50 `search` filter (accepted vs `unrecognised filter item` captured verbatim);
 * 3. optional NIP-42 AUTH: ONLY the kind:22242 handshake is ever sent, and only when a key is
 *    given. This module never publishes a test event (no kind-1 writes, no kind-5 writes).
 *
 * `writeProbeResult` persists the JSON report as `artifacts/probe-<ts>.json`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildAuthEvent } from './auth'

export interface ProbeEntry {
  name: string
  filter: Record<string, unknown>
  /** False when the relay actively objected (CLOSED / NOTICE "unrecognised …"); silence counts as accepted. */
  accepted: boolean
  events_returned: number
  notice: string | null
  ms: number
}

export interface AuthProbe {
  /** True when a key was provided (the handshake was armed). */
  attempted: boolean
  challenge_received: boolean
  /** null when not attempted / no verdict arrived. */
  ok: boolean | null
  msg: string | null
}

export interface ProbeResult {
  relay: string
  probed_at: string
  nip11_doc_present: boolean
  supported_nips: number[] | null
  nip11_name: string | null
  /** Websocket reached the relay. */
  connected: boolean
  per_probe: ProbeEntry[]
  auth: AuthProbe
  verdict: string
}

export interface RelayProbeOptions {
  relay: string
  /** Signing key (hex or nsec1…) — enables the NIP-42 AUTH attempt. Omit to stay anonymous. */
  keyHex?: string
  /** Websocket + NIP-11 budget. Default 8000 ms. */
  timeoutMs?: number
  /** Per-filter collection window. Default 2000 ms. */
  perProbeMs?: number
  /** Grace period for the relay's OK after our AUTH response. Default 1500 ms. */
  authWaitMs?: number
  log?: (line: string) => void
}

const PROBES: Array<{ name: string; filter: Record<string, unknown> }> = [
  { name: 'facet-t', filter: { kinds: [1], '#t': ['jcalgtest'], limit: 3 } },
  { name: 'i-exact', filter: { kinds: [1], '#i': ['i-nonexistent-x1'] } },
  { name: 'k-facet', filter: { kinds: [1], '#k': ['vendor'] } },
  { name: 'kind5-e', filter: { kinds: [5], '#e': ['0'.repeat(64)] } },
  { name: 'search', filter: { kinds: [1], search: '__scrutiny_probe_unlikely__' } },
]

async function fetchNip11(
  relay: string,
  timeoutMs: number,
): Promise<{ present: boolean; supportedNips: number[] | null; name: string | null }> {
  const url = relay.replace(/^ws/, 'http')
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { present: false, supportedNips: null, name: null }
    const doc = (await response.json()) as Record<string, unknown>
    const rawNips = doc['supported_nips']
    const supportedNips = Array.isArray(rawNips)
      ? rawNips.filter((n): n is number => typeof n === 'number')
      : null
    const name = typeof doc['name'] === 'string' ? (doc['name'] as string) : null
    return { present: true, supportedNips, name }
  } catch {
    return { present: false, supportedNips: null, name: null }
  }
}

interface ActiveProbe {
  subId: string
  onEvent(): void
  onEose(): void
  onClosed(msg: string): void
  onNotice(text: string): void
}

/** One websocket shared by every filter; NIP-01 message routing + NIP-42 handshake state. */
class ProbeSession {
  private readonly relay: string
  private readonly key: string | null
  private readonly log: (line: string) => void
  private readonly ws: WebSocket

  private opened = false
  private closed = false
  private connectError = 'connect failed'
  private readonly openPromise: Promise<boolean>

  private current: ActiveProbe | null = null

  private authChallenge: string | null = null
  private authEventId: string | null = null
  private authSettled = false
  private authOk: boolean | null = null
  private authMsg: string | null = null
  private authWaiters: Array<() => void> = []

  constructor(relay: string, key: string | null, timeoutMs: number, log: (line: string) => void) {
    this.relay = relay
    this.key = key
    this.log = log
    this.ws = new WebSocket(relay)
    this.openPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.connectError = `connect timeout after ${timeoutMs}ms`
        resolve(false)
      }, timeoutMs)
      this.ws.onopen = () => {
        clearTimeout(timer)
        this.opened = true
        resolve(true)
      }
      this.ws.onerror = () => {
        clearTimeout(timer)
        this.connectError = `websocket error connecting to ${relay}`
        resolve(false)
      }
      this.ws.onclose = (ev: CloseEvent) => {
        clearTimeout(timer)
        if (!this.opened) {
          this.connectError =
            this.connectError === 'connect failed'
              ? `closed before open (code ${ev.code})`
              : this.connectError
          resolve(false)
        }
        this.closed = true
        const detail = ev.reason ? `: ${ev.reason}` : ''
        this.current?.onClosed(`connection closed (code ${ev.code}${detail})`)
      }
      this.ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') this.onMessage(ev.data)
      }
    })
  }

  connect(): Promise<boolean> {
    return this.openPromise
  }

  get failure(): string {
    return this.connectError
  }

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // Already closed.
    }
  }

  private send(payload: unknown[]): boolean {
    if (this.closed || this.ws.readyState !== 1) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  runProbe(name: string, filter: Record<string, unknown>, perProbeMs: number): Promise<ProbeEntry> {
    return new Promise<ProbeEntry>((resolve) => {
      const subId = `scrutiny-probe-${name}`
      const started = Date.now()
      let events = 0
      let notice: string | null = null
      let done = false
      const finish = (accepted: boolean): void => {
        if (done) return
        done = true
        this.current = null
        this.send(['CLOSE', subId])
        resolve({
          name,
          filter,
          accepted,
          events_returned: events,
          notice,
          ms: Date.now() - started,
        })
      }
      if (this.closed || !this.opened) {
        notice = 'connection not open'
        finish(false)
        return
      }
      const timer = setTimeout(() => finish(true), perProbeMs)
      this.current = {
        subId,
        onEvent: () => {
          events++
        },
        onEose: () => {
          clearTimeout(timer)
          finish(true)
        },
        onClosed: (msg) => {
          clearTimeout(timer)
          notice = notice ?? msg
          finish(false)
        },
        onNotice: (text) => {
          notice = notice ?? text
          if (/unrecogni[sz]ed|invalid/i.test(text)) {
            clearTimeout(timer)
            finish(false)
          }
        },
      }
      if (!this.send(['REQ', subId, filter])) {
        clearTimeout(timer)
        notice = 'REQ send failed'
        finish(false)
      }
    })
  }

  /** Finish the AUTH exchange (if one happened) and report the handshake state. */
  async settleAuth(waitMs: number): Promise<AuthProbe> {
    const attempted = this.key !== null
    if (this.authChallenge !== null && attempted && !this.authSettled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        this.authWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    let msg: string | null = null
    if (this.authOk === false) msg = this.authMsg ?? 'auth rejected'
    else if (attempted && this.authChallenge === null) msg = 'no AUTH challenge received'
    else if (attempted && this.authOk === null) msg = 'no OK received for AUTH event'
    else if (!attempted && this.authChallenge !== null)
      msg = 'challenge received; no key provided (sent nothing)'
    return {
      attempted,
      challenge_received: this.authChallenge !== null,
      ok: attempted ? this.authOk : null,
      msg,
    }
  }

  private onMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
    const [type, ...rest] = parsed as [string, ...unknown[]]
    if (type === 'AUTH') {
      const challenge = rest[0]
      if (typeof challenge !== 'string' || this.authSettled) return
      this.authChallenge = challenge
      if (this.key === null) {
        this.log('[auth] challenged, no key provided — sending nothing')
        return
      }
      const authEvent = buildAuthEvent(this.relay, challenge, this.key)
      this.authEventId = authEvent.id
      this.log(`[auth] challenged, responding (event ${authEvent.id.slice(0, 12)}…)`)
      this.send(['AUTH', authEvent])
      return
    }
    if (type === 'OK') {
      const [id, ok, msg] = rest as [unknown, unknown, unknown]
      if (typeof id === 'string' && id === this.authEventId) {
        this.authSettled = true
        this.authOk = ok === true
        this.authMsg = typeof msg === 'string' ? msg : ''
        const waiters = this.authWaiters
        this.authWaiters = []
        for (const waiter of waiters) waiter()
      }
      return
    }
    if (type === 'NOTICE') {
      const text = rest[0]
      if (typeof text === 'string') {
        this.log(`[notice] ${text}`)
        this.current?.onNotice(text)
      }
      return
    }
    if (type === 'EVENT' || type === 'EOSE' || type === 'CLOSED') {
      const current = this.current
      const subId = rest[0]
      if (current === null || typeof subId !== 'string' || subId !== current.subId) return
      if (type === 'EVENT') current.onEvent()
      else if (type === 'EOSE') current.onEose()
      else {
        const msg = rest[1]
        current.onClosed(typeof msg === 'string' ? msg : 'closed by relay')
      }
    }
  }
}

function buildVerdict(
  connected: boolean,
  connectError: string,
  nip11: { present: boolean; supportedNips: number[] | null },
  perProbe: ProbeEntry[],
  auth: AuthProbe,
): string {
  if (!connected) return `unreachable: ${connectError}`
  const parts: string[] = ['reachable']
  parts.push(
    nip11.present
      ? `nip11 present${nip11.supportedNips === null ? '' : ` (NIPs ${nip11.supportedNips.join(',')})`}`
      : 'nip11 absent',
  )
  const accepted = perProbe.filter((p) => p.accepted).length
  parts.push(`filters accepted ${accepted}/${perProbe.length}`)
  const search = perProbe.find((p) => p.name === 'search')
  if (search !== undefined) {
    parts.push(
      search.accepted ? 'search accepted' : `search rejected (${search.notice ?? 'unknown'})`,
    )
  }
  if (auth.challenge_received) {
    if (!auth.attempted) parts.push('auth challenge seen (no key given)')
    else if (auth.ok === true) parts.push('auth ok')
    else if (auth.ok === false) parts.push(`auth rejected (${auth.msg ?? ''})`)
    else parts.push('auth unresolved')
  } else if (auth.attempted) {
    parts.push('auth not requested')
  } else {
    parts.push('auth not attempted')
  }
  return parts.join('; ')
}

/**
 * Probe `relay` read-only. Only a NIP-42 kind:22242 handshake may be sent, and only with `keyHex`;
 * no kind-1/kind-5 test events are ever published.
 */
export async function relayProbe(opts: RelayProbeOptions): Promise<ProbeResult> {
  const relay = opts.relay
  const key = opts.keyHex ?? null
  const timeoutMs = opts.timeoutMs ?? 8000
  const perProbeMs = opts.perProbeMs ?? 2000
  const authWaitMs = opts.authWaitMs ?? 1500
  const log = opts.log ?? (() => {})

  const nip11 = await fetchNip11(relay, timeoutMs)
  const session = new ProbeSession(relay, key, timeoutMs, log)
  const connected = await session.connect()

  const perProbe: ProbeEntry[] = []
  let auth: AuthProbe
  if (connected) {
    for (const probe of PROBES) {
      perProbe.push(await session.runProbe(probe.name, probe.filter, perProbeMs))
    }
    auth = await session.settleAuth(authWaitMs)
    session.close()
  } else {
    auth = {
      attempted: key !== null,
      challenge_received: false,
      ok: null,
      msg: `connect failed: ${session.failure}`,
    }
    session.close()
  }

  return {
    relay,
    probed_at: new Date().toISOString(),
    nip11_doc_present: nip11.present,
    supported_nips: nip11.supportedNips,
    nip11_name: nip11.name,
    connected,
    per_probe: perProbe,
    auth,
    verdict: buildVerdict(connected, session.failure, nip11, perProbe, auth),
  }
}

/** Persist a probe report as `artifacts/probe-<ts>.json`; returns the path written. */
export function writeProbeResult(result: ProbeResult, artifactsDir = 'artifacts'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(artifactsDir, `probe-${ts}.json`)
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)
  return outPath
}
