/**
 * The plan schema (spec §5.2). No field accepts event content, raw tags, a kind, an id,
 * `created_at` or key material, and unknown fields are refused (strict objects throughout).
 *
 * Shape errors are returned as `schema.invalid` refusals whose `field` names the record by its ref
 * (`records[product:ex-100].bullets[1]`) when the ref is usable, else by index (`records[3].ref`).
 * Conditions the user can settle in the interview (missing relays, dangling refs, …) are not schema
 * errors; they are open questions raised later (spec §6.5).
 */

import { z } from 'zod'
import { type Refusal, schemaRefusal } from '../refusal.js'

const REF = /^(profile|product|metadata):[a-z0-9][a-z0-9._-]{0,63}$/u
const SINGLE_LINE = /^[^\r\n]*$/u
/** IR-1 prefix, a colon, a non-empty value; one line. */
const INDEXER = /^[a-z0-9-]+:[^\r\n]+$/u

const line = (min: number, max: number) =>
  z.string().min(min).max(max).regex(SINGLE_LINE, 'must be a single line')
const url = (scheme: RegExp) =>
  z
    .string()
    .regex(scheme)
    .refine((v) => URL.canParse(v), 'must be a valid URL')

const httpsUrl = url(/^https:\/\/\S+$/u)
/** `wss://` anywhere; plain `ws://` only on a loopback host, for a relay run on this machine. */
const relayUrl = z
  .string()
  .refine(
    (v) =>
      /^wss?:\/\/\S+$/u.test(v) &&
      URL.canParse(v) &&
      (v.startsWith('wss://') || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(v).hostname)),
    'must be wss://, or ws:// on a loopback host',
  )
const relPath = line(1, 1024)
const ref = z.string().regex(REF)

const SUBTYPES = [
  'specification',
  'test',
  'report',
  'advisory',
  'sbom',
  'maintenance',
  'target',
] as const

const indexed = {
  headline: line(1, 200),
  bullets: z.array(line(0, 500)).max(20).default([]),
  links: z.array(url(/^https?:\/\/\S+$/u)).default([]),
  indexers: z.array(z.string().regex(INDEXER, 'must be `prefix:value`')).min(1),
  card: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  sources: z.array(relPath).default([]),
}

const profileRecord = z.strictObject({
  ref,
  type: z.literal('profile'),
  name: line(1, 100),
  display_name: line(1, 100).optional(),
  about: z.string().max(2000).optional(),
  picture: z.strictObject({ path: relPath, url: httpsUrl.optional() }).optional(),
})

const productRecord = z.strictObject({ ref, type: z.literal('product'), ...indexed })

const metadataRecord = z.strictObject({
  ref,
  type: z.literal('metadata'),
  ...indexed,
  subtype: z.enum(SUBTYPES),
  identifier: line(1, 200).optional(),
  artifacts: z
    .array(z.strictObject({ path: relPath, url: httpsUrl.optional(), alt: line(1, 60) }))
    .default([]),
  bind_to: z.array(z.strictObject({ ref, label: line(1, 28) })).default([]),
})

const planSchema = z.strictObject({
  planVersion: z.literal(1),
  relays: z.array(relayUrl).max(8).default([]),
  records: z
    .array(z.discriminatedUnion('type', [profileRecord, productRecord, metadataRecord]))
    .min(1),
})

export type Plan = z.output<typeof planSchema>
export type PlanRecord = Plan['records'][number]
export type ProfileRecord = z.output<typeof profileRecord>
export type ProductRecord = z.output<typeof productRecord>
export type MetadataRecord = z.output<typeof metadataRecord>

/** `wss://host/` and `wss://host` are one relay; the trailing slash of an empty path is dropped. */
function normalizeRelay(raw: string): string {
  return raw.endsWith('/') && new URL(raw).pathname === '/' ? raw.slice(0, -1) : raw
}

/** Converts a schema path into the spec's field notation, naming records by ref when possible. */
function fieldOf(path: readonly PropertyKey[], raw: unknown): string | null {
  if (path.length === 0) return null
  const [head, index, ...rest] = path
  let out: string
  if (head === 'records' && typeof index === 'number') {
    out = `records[${recordLabel(raw, index)}]`
  } else {
    out = String(head)
    if (index !== undefined) rest.unshift(index)
  }
  for (const part of rest) out += typeof part === 'number' ? `[${part}]` : `.${String(part)}`
  return out
}

/** A record's ref when it is well-formed and agrees with its type, else its index. */
function recordLabel(raw: unknown, index: number): string {
  const records = (raw as { records?: unknown } | null)?.records
  const record: unknown = Array.isArray(records) ? records[index] : undefined
  if (typeof record !== 'object' || record === null) return String(index)
  const { ref: r, type } = record as { ref?: unknown; type?: unknown }
  return typeof r === 'string' && REF.test(r) && r.startsWith(`${String(type)}:`)
    ? r
    : String(index)
}

export type ParsedPlan =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly findings: readonly Refusal[] }

export function parsePlan(raw: unknown): ParsedPlan {
  const result = planSchema.safeParse(raw)
  if (!result.success) {
    const findings = result.error.issues.flatMap((issue) => {
      const keys = issue.code === 'unrecognized_keys' ? issue.keys : [undefined]
      return keys.map((key) =>
        schemaRefusal(
          'schema.invalid',
          fieldOf(key === undefined ? issue.path : [...issue.path, key], raw),
          key === undefined ? issue.message : `unknown field \`${key}\``,
          key === undefined
            ? 'Correct this field to match the plan schema (spec §5.2).'
            : 'Remove the field. Event content, tags, kinds, ids, timestamps and keys are derived by the server.',
        ),
      )
    })
    return { ok: false, findings }
  }

  const plan = { ...result.data, relays: result.data.relays.map(normalizeRelay) }
  const findings: Refusal[] = []

  const seenRelays = new Set<string>()
  plan.relays.forEach((relay, i) => {
    if (seenRelays.has(relay)) {
      findings.push(
        schemaRefusal('schema.invalid', `relays[${i}]`, 'duplicate relay', 'List each relay once.'),
      )
    }
    seenRelays.add(relay)
  })

  let profiles = 0
  plan.records.forEach((record, i) => {
    if (!record.ref.startsWith(`${record.type}:`)) {
      findings.push(
        schemaRefusal(
          'schema.invalid',
          `records[${i}].ref`,
          `ref \`${record.ref}\` does not start with \`${record.type}:\``,
          `Use a ref of the form \`${record.type}:<slug>\`.`,
        ),
      )
    }
    if (record.type === 'profile' && ++profiles > 1) {
      findings.push(
        schemaRefusal(
          'schema.invalid',
          fieldOf(['records', i], raw),
          'a plan holds at most one profile',
          'Keep one profile record.',
        ),
      )
    }
  })

  return findings.length > 0 ? { ok: false, findings } : { ok: true, plan }
}
