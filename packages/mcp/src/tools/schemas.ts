/**
 * Tool input schemas — the publisher template (#108, "Composition is deterministic").
 *
 * Three properties are load-bearing, and every schema below preserves them:
 *
 * - **Structured fields only.** No tool takes a `content` string. The server composes content
 *   with mirror `composeContent` semantics (rule 8: headline first, `- ` bullets, a link block,
 *   one single-line record card, LF only, no fences on roots), so an agent cannot drift from the
 *   convention by writing prose.
 * - **Every object is strict, nested ones included.** Unknown keys are *rejected*, not stripped,
 *   so a free-form `content` and a smuggled `nsec` fail loudly instead of being silently ignored.
 * - **No secret is an argument.** Signing is the signer port's job (D13); key material passed as
 *   a tool argument crosses the model context, which is an exfiltration path (report §8.3).
 *
 * Only rule-derived maxima are declared (IX-2's 64 indexers, Lens's 60-char `alt`, RL-1's 1024
 * bytes per tag value). Everything else is left to the preflight gates in A3 so this file stays a
 * template rather than a second, drifting contract.
 */

import { z } from 'zod'

/** A sha256-shaped value: NIP-01 event ids and NIP-92 artifact hashes are both 32 bytes hex. */
const HEX64 = /^[0-9a-f]{64}$/u
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu

const eventId = z.string().regex(HEX64, 'must be a 64-char lowercase hex event id (NIP-01)')

/** RL-1's per-tag-value ceiling; `i` values are tag values, whatever their prefix. */
const indexerValue = z.string().min(1).max(1024)

const indexers = z
  .array(indexerValue)
  .min(1)
  .max(64)
  .describe(
    'raw `i` values in canonical prefix spelling (cve:, cwe:, cpe:, purl:, cc:, fips:, atr:, vendor:, …). ' +
      'IX-2 caps this at 64, but the relay counts every single-letter tag (i+k+e+t+imeta) against a ' +
      '64 budget, so preflight trims below this — i values are immutable after publish (IX-3)',
  )

const link = z
  .object({
    url: z
      .url({ protocol: /^https?$/u })
      .describe('absolute http(s) URL; Lens Files come from imeta, not from prose links'),
    label: z.string().min(1).optional().describe('display text; the URL is shown when omitted'),
  })
  .strict()

const mimeType = z
  .string()
  .regex(MIME, 'must be a MIME type such as application/pdf')
  .describe('NIP-92 `m`; Lens picks the file icon from it')

const imetaRow = z
  .object({
    url: z
      .url({ protocol: /^https?$/u })
      .describe('artifact http(s) URL — this server does not host bytes (#81, no Blossom)'),
    m: mimeType,
    x: z.string().regex(HEX64, 'must be the artifact SHA-256 as 64 lowercase hex'),
    size: z.number().int().nonnegative().describe('artifact size in bytes'),
    alt: z.string().min(1).max(60).describe('≤60 chars — Lens artifacts.ts renders it verbatim'),
  })
  .strict()

const imeta = z
  .array(imetaRow)
  .describe(
    'NIP-92 attachments; the hash is the only defense against substitution, and i/imeta on a ' +
      'root are immutable (IX-3/MD-5)',
  )

/** Rule 8c renders this as one compact JSON line; rule 2a requires every scalar in the prose too. */
const card = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe(
    'flat record card; the server re-states every scalar in prose by construction (rule 2a)',
  )

const bullets = z
  .array(z.string().min(1))
  .describe('`- ` bullets, one fact each; no tables or fenced blocks in root content (rule 8b)')

const headline = z
  .string()
  .min(1)
  .describe('first content line — clients truncate, so front-load the identifying fact (rule 8a)')

export const META_SUBTYPES = [
  'specification',
  'test',
  'report',
  'advisory',
  'sbom',
  'maintenance',
] as const

const metaSubtype = z
  .enum(META_SUBTYPES)
  .describe(
    'emits the Lens compatibility tag ["meta","<subtype>"]: the only deterministic metadata ' +
      'subtype Lens reads today, where only report|target|maintenance|sbom|advisory exist (report §5)',
  )

/** Shared field set of the two indexed event types (PR-1/MD-1: `i`+`k` go together). */
const indexedFields = {
  headline,
  bullets: bullets.optional(),
  links: z.array(link).optional().describe('prose links; artifacts belong in imeta'),
  indexers,
  card: card.optional(),
  imeta: imeta.optional(),
}

/** kind 0, NIP-01 replaceable — one profile per publisher key, re-publishing replaces it. */
export const setProfileInput = z
  .object({
    name: z.string().min(1).describe('short handle; the Lens publisher chip renders it'),
    display_name: z.string().min(1).optional(),
    about: z.string().min(1).optional(),
    picture_url: z
      .url({ protocol: /^https?$/u })
      .optional()
      .describe('absolute http(s) URL; other schemes are rejected — clients render this image'),
  })
  .strict()

export const publishProductInput = z.object(indexedFields).strict()

export const publishMetadataInput = z
  .object({ ...indexedFields, meta_subtype: metaSubtype })
  .strict()

const endpointRef = z
  .object({
    id: eventId.describe('event id the marker points at'),
    relay: z
      .url()
      .optional()
      .describe('advisory relay hint (BD-8); treat an empty hint as unknown'),
    author: z
      .string()
      .regex(HEX64, 'must be a 64-char lowercase hex pubkey')
      .optional()
      .describe('advisory author hint (BD-8)'),
  })
  .strict()

export const publishBindingInput = z
  .object({
    root_ref: endpointRef.describe('the root record — emitted as `e root` (BD-1..BD-10)'),
    link_ref: endpointRef.describe('the linked record — emitted as `e link`'),
    label: z
      .string()
      .min(1)
      .describe('the binding verb, e.g. "certifies"; Lens clips it to 28 chars in the files rail'),
    bullets: bullets.optional(),
  })
  .strict()

export const publishPatchInput = z
  .object({
    target_id: eventId.describe('the event being corrected — the resolved tip, never the root'),
    before: z
      .string()
      .optional()
      .describe(
        'current content, paired with `after`; the server diffs it against the resolved tip',
      ),
    after: z.string().optional().describe('replacement content, paired with `before`'),
    diff: z
      .string()
      .optional()
      .describe(
        'unified diff instead of before/after; the server fences it per E4 with a fence longer ' +
          'than any backtick run in the payload',
      ),
  })
  .strict()

export const retractInput = z
  .object({
    target_id: eventId.describe('the event to delete; kind 5 only counts from the same author'),
    reason: z
      .string()
      .min(1)
      .describe('why — the relay stores the deletion and never acts on it (DEL-11)'),
  })
  .strict()

export const verifyEventInput = z
  .object({
    event_id: eventId.describe('fetched back with REQ {"ids":[…]} — the stored event is the proof'),
  })
  .strict()

/** `status` takes nothing; strictness still rejects a stray argument (e.g. a pasted key). */
export const statusInput = z.object({}).strict()
