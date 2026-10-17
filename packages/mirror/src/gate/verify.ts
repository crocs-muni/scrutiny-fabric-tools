/**
 * gate/verify.ts — per-event verification for the mirror gate (stage 2, fail-closed).
 *
 * Every check here is about SHAPE, CRYPTOGRAPHY, TAG INVARIANTS and CONTENT HYGIENE.
 * Nothing here interprets a record or re-derives a scientific claim.
 *
 * Rule map (design.md §4.1 rule 8 + §3 + README "Frozen decisions"):
 *   SHAPE / ID-MISMATCH / SIG-INVALID / KIND   NIP-01 + SIG-1
 *   TAG-1 / TAG-2 / TAG-3                      exactly one scrutiny-fabric, one
 *                                              scrutiny-v0.8.1, one event-type t
 *   IX-2 / K-COVER / K-FORMAT / ITAG-FORMAT    i≤64, k ⊇ distinct i prefixes,
 *                                              kebab tag names
 *   BD-E-ROOT / BD-E-LINK / REFS-LINE          bindings: one e root + one e link,
 *                                              content carries the Refs: line (8d)
 *   IMETA / IMETA-X / IMETA-SIZE / IMETA-URL   imeta completeness (IM-1)
 *   PLACEHOLDER-URL                            «…»/placeholder/example hosts
 *   CONTENT-EMPTY
 *
 * NOTE (biome D12): `packages/*\/src/**` may not import `node:crypto`. The NIP-01
 * id check therefore goes through nostr-tools' own `getEventHash`, which is
 * sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content])) — the exact
 * serialization this gate asserts (see `nip01Serialize`, exported for tests).
 */

import type { Event as NostrEvent } from 'nostr-tools/pure'
import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import type { SignedEvent } from '../types.js'

/** One gate finding. `event` is the event id when recoverable, else a line label. */
export interface GateError {
  event: string | null
  code: string
  detail: string
}

export const SCRUTINY_FABRIC_TAG = 'scrutiny-fabric'
export const SCRUTINY_VERSION_TAG = 'scrutiny-v0.8.1'
/** Event type tags this v0 gate admits (patches are outside the v0 gate contract). */
export const EVENT_TYPE_TAGS = [
  'scrutiny-product',
  'scrutiny-metadata',
  'scrutiny-binding',
  'scrutiny-patch',
] as const
export type GateEventType = (typeof EVENT_TYPE_TAGS)[number]
const EVENT_TYPE_SET: Record<string, true> = {
  'scrutiny-product': true,
  'scrutiny-metadata': true,
  'scrutiny-binding': true,
  'scrutiny-patch': true,
}

/** IX-2 / PR-2 / MD-2: at most 64 `i` tags per event. */
export const MAX_I_TAGS = 64

/** Rule 8(d): every binding's content carries this exact line. */
export const REFS_LINE_RE = /^Refs:\s+root [0-9a-f]{64} link [0-9a-f]{64}$/m
/** Same line with captures, used only to cross-check the e-tag targets. */
const REFS_LINE_CAPTURE_RE = /^Refs:\s+root ([0-9a-f]{64}) link ([0-9a-f]{64})$/m

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
/** i value: `<kebab-prefix>:<non-empty, whitespace-free value>` (IR-1). */
const ITAG_VALUE_RE = /^[a-z][a-z0-9-]*:\S+$/
/** tag (i/k) name: kebab-case, lowercase alphanumeric + dashes. */
const KEBAB_RE = /^[a-z][a-z0-9-]*$/

/** Literal markers that betoken an unresolved template value. */
export const PLACEHOLDER_MARKERS = ['«', 'placeholder'] as const
/**
 * Example hosts (RFC 2606 + `.example` TLD) are never allowed in gate output:
 * `blossom.sec-certs-mirror.example` and friends are placeholders, not mirror hosts.
 */
const EXAMPLE_HOST_RE = /\.example\b|\bexample\.(?:org|com|net|edu)\b/i

/** The NIP-01 canonical serialization the id is the sha256 of. */
export function nip01Serialize(event: SignedEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
}

/** Distinct `t` values carried by an event. */
export function tagValues(event: SignedEvent, name: string): string[] {
  const out: string[] = []
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === 'string') out.push(tag[1])
  }
  return out
}

/** Event-type `t` value, when exactly one of the admitted types is present. */
export function eventTypeOf(event: SignedEvent): GateEventType | null {
  const found = tagValues(event, 't').filter((v) => EVENT_TYPE_SET[v] === true)
  const only = found.length === 1 ? found[0] : undefined
  return (only as GateEventType | undefined) ?? null
}

/**
 * Verify one stored event. Returns every finding, in a stable order; an empty
 * array means the event passes this gate's per-event checks.
 */
export function verifyStoredEvent(value: unknown, label?: string): GateError[] {
  const errors: GateError[] = []
  if (typeof value !== 'object' || value === null) {
    return [{ event: label ?? null, code: 'SHAPE', detail: 'event is not a JSON object' }]
  }
  const raw = value as Partial<SignedEvent>
  const where = label ?? (typeof raw.id === 'string' ? raw.id : null)
  const push = (code: string, detail: string): void => {
    errors.push({ event: where, code, detail })
  }

  // ---- shape -------------------------------------------------------------
  if (typeof raw.id !== 'string' || !HEX64.test(raw.id)) push('SHAPE', 'id is not 64-hex')
  if (typeof raw.pubkey !== 'string' || !HEX64.test(raw.pubkey))
    push('SHAPE', 'pubkey is not 64-hex')
  if (typeof raw.sig !== 'string' || !HEX128.test(raw.sig)) push('SHAPE', 'sig is not 128-hex')
  if (typeof raw.created_at !== 'number' || !Number.isFinite(raw.created_at)) {
    push('SHAPE', 'created_at is not a finite number')
  }
  if (typeof raw.kind !== 'number') push('SHAPE', 'kind is not a number')
  if (typeof raw.content !== 'string') push('SHAPE', 'content is not a string')
  if (
    !Array.isArray(raw.tags) ||
    !raw.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  ) {
    push('SHAPE', 'tags are not string[][]')
  }
  if (errors.length > 0) return errors

  const event = raw as SignedEvent

  // ---- kind --------------------------------------------------------------
  // IX-2 admits kind 1 and kind 5 only: the mirror never publishes any other's profile.
  // Kind-5 (NIP-09 deletion) additionally must carry at least one `e` reference and never an
  // event-type t tag (its payload is the deletion list alone).
  if (event.kind === 5) {
    const eRefs = event.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string')
    if (eRefs.length === 0) push('KIND-5-REFS', 'kind-5 deletion with no e references')
  } else if (event.kind !== 1) {
    push('KIND', `kind is ${event.kind}, expected 1`)
  }

  // ---- id + signature (SIG-1) -------------------------------------------
  let computedId: string | null = null
  try {
    computedId = getEventHash(event as unknown as NostrEvent)
  } catch {
    computedId = null
  }
  if (computedId === null) {
    push('ID-MISMATCH', 'NIP-01 serialization is not computable (invalid field types)')
  } else if (computedId !== event.id) {
    push(
      'ID-MISMATCH',
      `id ${event.id} != sha256(NIP-01 serialize([0,pubkey,created_at,kind,tags,content])) ${computedId}`,
    )
  } else {
    let sigOk = false
    try {
      sigOk = verifyEvent(event as unknown as NostrEvent)
    } catch {
      sigOk = false
    }
    if (!sigOk) push('SIG-INVALID', 'BIP-340 schnorr verification failed over the event id')
  }

  // ---- tag invariants ----------------------------------------------------
  const tvals = tagValues(event, 't')
  const fabric = tvals.filter((v) => v === SCRUTINY_FABRIC_TAG).length
  if (fabric !== 1) {
    push('TAG-1', `expected exactly one '${SCRUTINY_FABRIC_TAG}' t tag, found ${fabric}`)
  }
  const version = tvals.filter((v) => v === SCRUTINY_VERSION_TAG).length
  if (version !== 1) {
    push('TAG-2', `expected exactly one '${SCRUTINY_VERSION_TAG}' t tag, found ${version}`)
  }
  const typeTags = tvals.filter((v) => EVENT_TYPE_SET[v] === true)
  if (event.kind === 1 && typeTags.length !== 1) {
    const patchNote =
      typeTags.length === 0 && tvals.includes('scrutiny-patch')
        ? ' (scrutiny-patch is outside the v0 gate contract)'
        : ''
    push(
      'TAG-3',
      `expected exactly one event-type t tag in {${EVENT_TYPE_TAGS.join(', ')}}, found ${typeTags.length}${patchNote}`,
    )
  }
  const eventType = typeTags.length === 1 ? (typeTags[0] as GateEventType) : null

  // ---- i / k discipline (IX-2, §3.5) ------------------------------------
  const ivals = tagValues(event, 'i')
  if (ivals.length > MAX_I_TAGS)
    push('IX-2', `${ivals.length} i tags exceeds the ${MAX_I_TAGS} cap`)

  const prefixes = new Set<string>()
  for (const v of ivals) {
    if (!ITAG_VALUE_RE.test(v)) {
      push('ITAG-FORMAT', `i value is not '<kebab-prefix>:<value>': ${JSON.stringify(v)}`)
      continue
    }
    prefixes.add(v.slice(0, v.indexOf(':')))
  }
  const seen = new Set<string>()
  for (const v of ivals) {
    if (seen.has(v)) push('ITAG-DUP', `duplicate i value: ${v}`)
    seen.add(v)
  }
  const kvals = new Set(tagValues(event, 'k'))
  for (const p of prefixes) {
    if (!kvals.has(p)) push('K-COVER', `k set does not cover i prefix '${p}'`)
  }
  for (const kv of kvals) {
    if (!KEBAB_RE.test(kv)) push('K-FORMAT', `k value is not kebab-case: ${JSON.stringify(kv)}`)
  }

  // ---- content -----------------------------------------------------------
  if (event.content.trim().length === 0) push('CONTENT-EMPTY', 'content is empty')

  // ---- bindings (BD-1/BD-2, rule 8d) ------------------------------------
  if (eventType === 'scrutiny-binding') {
    const eTags = event.tags.filter((t) => t[0] === 'e')
    const roots = eTags.filter((t) => t[3] === 'root')
    const links = eTags.filter((t) => t[3] === 'link')
    if (roots.length !== 1) {
      push('BD-E-ROOT', `expected exactly one e tag marked 'root', found ${roots.length}`)
    }
    if (links.length !== 1) {
      push('BD-E-LINK', `expected exactly one e tag marked 'link', found ${links.length}`)
    }
    for (const tag of eTags) {
      if (typeof tag[1] !== 'string' || !HEX64.test(tag[1])) {
        push('BD-E-ID', `e tag target is not 64-hex: ${JSON.stringify(tag[1] ?? null)}`)
      }
    }
    if (!REFS_LINE_RE.test(event.content)) {
      push(
        'REFS-LINE',
        "binding content lacks a 'Refs: root <64hex> link <64hex>' line (design §4.1 rule 8d)",
      )
    } else {
      const m = REFS_LINE_CAPTURE_RE.exec(event.content)
      if (m && roots.length === 1 && roots[0]?.[1] !== m[1]) {
        push('REFS-TARGET', 'Refs root hex does not match the e(root) target id')
      }
      if (m && links.length === 1 && links[0]?.[1] !== m[2]) {
        push('REFS-TARGET', 'Refs link hex does not match the e(link) target id')
      }
    }
  }

  // ---- imeta completeness (IM-1) ----------------------------------------
  for (const tag of event.tags) {
    if (tag[0] !== 'imeta') continue
    const fields: Record<string, string> = {}
    for (const p of tag.slice(1)) {
      const sp = p.indexOf(' ')
      if (sp > 0) fields[p.slice(0, sp)] = p.slice(sp + 1)
    }
    const { url, m: mime, x, size } = fields
    if (!url || !mime || !x || !size) {
      push('IMETA', `imeta tag is missing one of url/m/x/size: ${JSON.stringify(tag)}`)
    }
    if (x && !HEX64.test(x)) push('IMETA-X', `imeta x is not 64-hex: ${x}`)
    if (size && !/^\d+$/.test(size)) push('IMETA-SIZE', `imeta size is not an integer: ${size}`)
    if (url && !/^https?:\/\/\S+$/.test(url)) push('IMETA-URL', `imeta url is not http(s): ${url}`)
  }

  // ---- placeholder hygiene (rule: no unresolved/example URLs anywhere) --
  const urlHaystack = [event.content, ...event.tags.flat()].join('\n')
  const markerScan = eventType === 'scrutiny-product' || eventType === 'scrutiny-metadata'
  let match: string | null = null
  if (markerScan) {
    const lower = urlHaystack.toLowerCase()
    for (const marker of PLACEHOLDER_MARKERS) {
      if (lower.includes(marker.toLowerCase())) {
        match = marker
        break
      }
    }
  }
  if (match === null) {
    const hit = EXAMPLE_HOST_RE.exec(urlHaystack)
    if (hit) match = hit[0]
  }
  if (match !== null) {
    push(
      'PLACEHOLDER-URL',
      `content/attachments contain a placeholder or example-URL token (${JSON.stringify(match)}); mirrored events must cite real source URLs only`,
    )
  }

  return errors
}
