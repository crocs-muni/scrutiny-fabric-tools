/**
 * The engine's draft step (spec §5–§6.2, §6.5): schema → local files → composition → preflight →
 * open questions → plan hash. Nothing is signed. Without `network` the only I/O is reading files
 * under `root`; with it, the relays are probed and publisher URLs downloaded (reads only), which
 * adds `relay.unreachable`, `relay.no_blossom`, `relay.clock_skew` and `artifact.url_mismatch`,
 * and lets `profile.missing` take an already published profile into account.
 */

import { buildBinding, buildMetadata, buildProduct } from '@crocs-muni/scrutiny-fabric'
import { blobUrl } from '../artifacts/blossom.js'
import type { UrlCheck } from '../artifacts/url.js'
import {
  type Card,
  bindingContent,
  composeContent,
  imetaTag,
  lostFacts,
  normalizeProse,
  refPlaceholder,
} from '../compose/content.js'
import {
  MAX_EVENT_BYTES,
  MAX_SINGLE_LETTER_TAGS,
  isKnownPrefix,
  oversizedTagValues,
  signedSize,
  singleLetterTags,
  suggestPrefix,
} from '../preflight/gates.js'
import {
  type OpenQuestion,
  type OpenQuestionCode,
  type Refusal,
  schemaRefusal,
} from '../refusal.js'
import type { RelayLimits, RelayProbe } from '../relay/nip11.js'
import { type FileFacts, MAX_ARTIFACT_BYTES, fileFacts, mediaType } from './files.js'
import { planHash } from './hash.js'
import {
  type MetadataRecord,
  type Plan,
  type PlanRecord,
  type ProductRecord,
  type ProfileRecord,
  parsePlan,
} from './schema.js'

export interface GraphEvent {
  readonly ref: string
  readonly kind: number
  readonly content: string
  readonly tags: readonly (readonly string[])[]
}

export interface GraphBlob {
  readonly x: string
  readonly size: number
  readonly m: string
  readonly via: 'upload' | 'url'
}

/** Spec §5.4: what the user approves. No `created_at`, ids or signatures. */
export interface TemplateGraph {
  readonly planVersion: 1
  readonly pubkey: string | null
  readonly relays: readonly string[]
  readonly events: readonly GraphEvent[]
  readonly blobs: readonly GraphBlob[]
}

export type EventType = 'profile' | 'product' | 'metadata' | 'binding'

export interface Preview {
  readonly counts: Readonly<Record<EventType, number>>
  readonly records: readonly {
    readonly ref: string
    readonly type: EventType
    readonly headline: string
    readonly indexers: readonly string[]
    readonly sources: readonly string[]
    readonly artifacts: readonly {
      readonly path: string
      readonly x: string
      readonly size: number
    }[]
    readonly content: string
  }[]
  readonly graph: readonly { readonly from: string; readonly to: string; readonly label: string }[]
  readonly relays: readonly PreviewRelay[]
  readonly immutable_warning: string
}

/** Probe facts are present only when the draft ran with `network` and the relay answered. */
export interface PreviewRelay {
  readonly url: string
  readonly role: 'primary' | 'mirror'
  readonly reachable?: boolean
  readonly blossom?: boolean
  readonly clock_skew_s?: number | null
  readonly limits?: RelayLimits
}

/** Network reads `draft_plan` may do (spec §6 table: NIP-11, `HEAD /upload`, URL downloads). */
export interface DraftNetwork {
  probeRelay(url: string): Promise<RelayProbe>
  verifyUrl(url: string, x: string): Promise<UrlCheck>
  /** Whether a kind-0 profile by `pubkey` is on `relay`; null when that could not be asked. */
  profilePublished(relay: string, pubkey: string): Promise<boolean | null>
}

/** Over this much clock difference the preview warns, even inside the relay's window. */
const CLOCK_WARN_S = 60

export type Draft =
  | { readonly status: 'invalid'; readonly findings: readonly Refusal[] }
  | {
      readonly status: 'drafted'
      readonly plan: Plan
      readonly graph: TemplateGraph
      readonly plan_hash: string
      /** True iff no open question is blocking. */
      readonly ready: boolean
      readonly preview: Preview
      readonly open_questions: readonly OpenQuestion[]
      readonly findings: readonly []
    }

export interface DraftInput {
  /** Absolute path of the data folder; every plan path resolves under it. */
  readonly root: string
  readonly plan: unknown
  /** The signer identity (hex) at draft time, from the non-secret identity file; null when none. */
  readonly pubkey: string | null
  /** Omitted: an offline draft (no relay or URL questions). */
  readonly network?: DraftNetwork
}

const GROUP_ORDER: Readonly<Record<EventType, number>> = {
  profile: 0,
  product: 1,
  metadata: 2,
  binding: 3,
}

const IMMUTABLE_WARNING = 'Indexers and artifacts cannot be changed after publishing (IX-3, MD-5).'

/** `binding:<metadata ref>><product ref>`: unique per bind_to target, and sorts by its metadata. */
function bindingRef(metadataRef: string, productRef: string): string {
  return `binding:${metadataRef}>${productRef}`
}

function question(
  code: OpenQuestionCode,
  blocking: boolean,
  ref: string | null,
  field: string | null,
  text: string,
  why: string,
  options: readonly string[] = [],
): OpenQuestion {
  return { code, blocking, ref, field, question: text, why, ask_user: true, options }
}

interface ArtifactUse {
  readonly field: string
  readonly path: string
  readonly url: string | undefined
  readonly use: 'artifact' | 'picture'
  readonly alt: string
}

/** A hashed file plus its media type, ready to cite. */
interface ReadyArtifact extends Omit<ArtifactUse, 'url'> {
  readonly url: string
  /** `upload` when the server derived the Blossom URL, `url` when the publisher gave one. */
  readonly via: 'upload' | 'url'
  readonly x: string
  readonly size: number
  readonly m: string
  readonly ext: string
}

function artifactUses(record: PlanRecord, label: string): ArtifactUse[] {
  if (record.type === 'profile') {
    return record.picture === undefined
      ? []
      : [
          {
            field: `${label}.picture.path`,
            path: record.picture.path,
            url: record.picture.url,
            use: 'picture',
            alt: '',
          },
        ]
  }
  if (record.type === 'product') return []
  return record.artifacts.map((a, i) => ({
    field: `${label}.artifacts[${i}].path`,
    path: a.path,
    url: a.url,
    use: 'artifact' as const,
    alt: normalizeProse(a.alt),
  }))
}

export async function draftPlan(input: DraftInput): Promise<Draft> {
  const parsed = parsePlan(input.plan)
  if (!parsed.ok) return { status: 'invalid', findings: parsed.findings }
  const { plan } = parsed

  const primary = plan.relays[0]
  const refCount = new Map<string, number>()
  for (const r of plan.records) refCount.set(r.ref, (refCount.get(r.ref) ?? 0) + 1)
  const products = new Set(plan.records.filter((r) => r.type === 'product').map((r) => r.ref))

  const findings: Refusal[] = []
  const global: OpenQuestion[] = []
  const perRecord: OpenQuestion[] = []
  /** Artifacts that hashed, have a mapped type and a resolvable URL, per record index. */
  const ready = new Map<number, ReadyArtifact[]>()

  if (plan.relays.length === 0) {
    global.push(
      question(
        'relay.missing',
        true,
        null,
        'relays',
        'Which relay should these events be published to? The first one listed is the primary.',
        'A plan needs at least one destination relay; the primary also hosts uploaded files.',
      ),
    )
  }
  if (input.pubkey === null) {
    global.push(
      question(
        'signer.missing',
        true,
        null,
        null,
        'No signing key is set up. Run `keygen` (or `import`) in a terminal, then draft again.',
        'Events are signed with the publisher key held in the OS keystore; the agent never handles it.',
      ),
    )
  }
  const probes = new Map<string, RelayProbe>()
  if (input.network !== undefined) {
    const network = input.network
    const results = await Promise.all(plan.relays.map((url) => network.probeRelay(url)))
    plan.relays.forEach((url, i) => {
      const probe = results[i]
      if (probe !== undefined) probes.set(url, probe)
    })
  }
  const primaryProbe = primary === undefined ? undefined : probes.get(primary)
  if (primaryProbe?.reachable === false) {
    global.push(
      question(
        'relay.unreachable',
        true,
        null,
        'relays[0]',
        `The primary relay ${primary} did not answer (${primaryProbe.message}). Check the URL, or choose another primary?`,
        'The primary relay gates publishing and hosts uploaded files.',
      ),
    )
  }
  if (primaryProbe?.reachable === true && primaryProbe.clock_skew_s !== null) {
    const skew = primaryProbe.clock_skew_s
    const { past_s, future_s } = primaryProbe.created_at_window
    const outside = skew > future_s || -skew > past_s
    if (outside || Math.abs(skew) > CLOCK_WARN_S) {
      global.push(
        question(
          'relay.clock_skew',
          outside,
          null,
          'relays[0]',
          `This computer's clock is ${Math.abs(skew)} s ${skew > 0 ? 'ahead of' : 'behind'} the relay. Turn on automatic time sync and draft again?`,
          outside
            ? 'Events are stamped with this clock; the relay would reject them as outside its time window.'
            : 'Events are stamped with this clock; a large difference risks rejection.',
        ),
      )
    }
  }

  const hasProfileRecord = plan.records.some((r) => r.type === 'profile')
  const profileOnRelay =
    hasProfileRecord ||
    input.network === undefined ||
    primary === undefined ||
    input.pubkey === null
      ? null
      : await input.network.profilePublished(primary, input.pubkey)
  if (!hasProfileRecord && profileOnRelay !== true) {
    global.push(
      question(
        'profile.missing',
        false,
        null,
        null,
        'There is no profile record. Lens will show a bare npub as the publisher; add a profile?',
        'A kind-0 profile gives the publisher a name and picture in Lens.',
      ),
    )
  }

  for (const [index, record] of plan.records.entries()) {
    const label = refCount.get(record.ref) === 1 ? `records[${record.ref}]` : `records[${index}]`
    const ask = (
      code: OpenQuestionCode,
      blocking: boolean,
      field: string | null,
      text: string,
      why: string,
      options: readonly string[] = [],
    ) => perRecord.push(question(code, blocking, record.ref, field, text, why, options))

    if (
      (refCount.get(record.ref) ?? 0) > 1 &&
      plan.records.findIndex((r) => r.ref === record.ref) !== index
    ) {
      ask(
        'record.duplicate_ref',
        true,
        `records[${index}].ref`,
        `The ref \`${record.ref}\` is used by more than one record. Rename one of them.`,
        'Refs identify records within a plan and must be unique.',
      )
    }

    if (record.type === 'metadata') {
      if (record.bind_to.length === 0) {
        ask(
          'record.no_product',
          true,
          `${label}.bind_to`,
          `Which product is "${record.headline}" about?`,
          'Lens result cards are products; a metadata record bound to none is never shown.',
          [...products],
        )
      }
      const targets = new Set<string>()
      record.bind_to.forEach((b, i) => {
        if (!products.has(b.ref)) {
          ask(
            'record.dangling_ref',
            true,
            `${label}.bind_to[${i}].ref`,
            `\`${b.ref}\` is not a product in this plan. Which product did you mean?`,
            'bind_to can only point at a product record in the same plan.',
            [...products],
          )
        } else if (targets.has(b.ref)) {
          ask(
            'record.duplicate_ref',
            true,
            `${label}.bind_to[${i}].ref`,
            `\`${b.ref}\` is listed twice in bind_to. Remove the repeat.`,
            'Each bind_to entry becomes one binding event; a repeat would publish a duplicate edge.',
          )
        }
        targets.add(b.ref)
      })
    }

    // Files. Type first: an unmapped extension is not read at all.
    for (const use of artifactUses(record, label)) {
      const media = mediaType(use.path, use.use)
      if (media === undefined) {
        ask(
          'artifact.type',
          true,
          use.field,
          `\`${use.path}\` has a file type that cannot be published here. Convert it, or drop it?`,
          use.use === 'picture'
            ? 'A profile picture must be .png, .jpg, .jpeg or .svg.'
            : 'Artifacts must be .pdf, .json, .txt, .csv, .md or .zip; the type is fixed by extension.',
        )
        continue
      }
      const facts = await fileFacts(input.root, use.path, true)
      if (fileProblem(facts, use.field, use.path, findings, ask)) continue
      if (facts.kind !== 'ok') continue
      if (use.url !== undefined && input.network !== undefined) {
        const check = await input.network.verifyUrl(use.url, facts.x)
        if (check.kind !== 'match') {
          ask(
            'artifact.url_mismatch',
            true,
            use.field.replace(/\.path$/u, '.url'),
            check.kind === 'mismatch'
              ? `${use.url} serves different bytes from \`${use.path}\`. Fix the URL, or upload the local file instead?`
              : `${use.url} could not be checked (${check.message}). Fix the URL, or upload the local file instead?`,
            'A cited URL must serve exactly the local file; its hash is published and permanent.',
          )
          continue
        }
      }
      const url =
        use.url ??
        (primary === undefined ? undefined : blobUrl(primary, { x: facts.x, ext: media.ext }))
      if (url === undefined) continue
      const list = ready.get(index) ?? []
      list.push({
        ...use,
        url,
        via: use.url === undefined ? 'upload' : 'url',
        x: facts.x,
        size: facts.size,
        m: media.m,
        ext: media.ext,
      })
      ready.set(index, list)
    }

    if (record.type !== 'profile') {
      for (const [i, path] of record.sources.entries()) {
        const facts = await fileFacts(input.root, path, false)
        fileProblem(facts, `${label}.sources[${i}]`, path, findings, ask)
      }
      if (record.sources.length === 0) {
        ask(
          'record.no_source',
          false,
          `${label}.sources`,
          `Which local file supports "${record.headline}"?`,
          'Each record should name the files it was drafted from, so the user can check its claims.',
        )
      }
    }
  }

  if (findings.length > 0) return { status: 'invalid', findings }

  const uploads = [...ready.values()].flat().filter((a) => a.via === 'upload')
  if (uploads.length > 0 && primaryProbe?.reachable === true && !primaryProbe.blossom) {
    global.push(
      question(
        'relay.no_blossom',
        true,
        null,
        'relays[0]',
        `The primary relay ${primary} does not accept file uploads. Host these ${uploads.length} file(s) yourself and give their URLs, or drop the artifacts?`,
        'Uploaded files are stored on the primary relay; without Blossom there is nowhere to put them.',
        ['give a URL for each file', 'drop the artifacts'],
      ),
    )
  }

  // Composition.
  const events: (GraphEvent & { readonly type: EventType })[] = []
  const previews: Preview['records'][number][] = []
  const edges: { from: string; to: string; label: string }[] = []
  const blobOrder: ReadyArtifact[] = []
  const gateQuestions: OpenQuestion[] = []

  for (const [index, record] of plan.records.entries()) {
    const label = refCount.get(record.ref) === 1 ? `records[${record.ref}]` : `records[${index}]`
    const artifacts = ready.get(index) ?? []
    const event =
      record.type === 'profile'
        ? profileEvent(record, artifacts[0])
        : indexedEvent(record, artifacts)
    events.push(event)
    previews.push({
      ref: record.ref,
      type: record.type,
      headline: record.type === 'profile' ? record.name : normalizeProse(record.headline),
      indexers: record.type === 'profile' ? [] : record.indexers,
      sources: record.type === 'profile' ? [] : record.sources,
      artifacts: artifacts.map((a) => ({ path: a.path, x: a.x, size: a.size })),
      content: event.content,
    })
    if (record.type !== 'profile') gateQuestions.push(...gates(record, label, event))

    if (record.type === 'metadata') {
      const seen = new Set<string>()
      for (const b of record.bind_to) {
        if (!products.has(b.ref) || seen.has(b.ref)) continue
        seen.add(b.ref)
        const text = normalizeProse(b.label)
        const content = bindingContent(text, b.ref, record.ref)
        const tags = buildBinding(
          { id: refPlaceholder(b.ref) },
          { id: refPlaceholder(record.ref) },
          content,
          0,
        ).template.tags
        const ref = bindingRef(record.ref, b.ref)
        events.push({ ref, type: 'binding', kind: 1, content, tags })
        previews.push({
          ref,
          type: 'binding',
          headline: text,
          indexers: [],
          sources: [],
          artifacts: [],
          content,
        })
        edges.push({ from: record.ref, to: b.ref, label: text })
      }
    }
  }

  const order = (a: { type: EventType; ref: string }, b: { type: EventType; ref: string }) =>
    GROUP_ORDER[a.type] - GROUP_ORDER[b.type] || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
  events.sort(order)
  previews.sort(order)

  for (const event of events) {
    const index = plan.records.findIndex((r) => r.ref === event.ref)
    for (const a of ready.get(index) ?? []) blobOrder.push(a)
  }
  const blobs: GraphBlob[] = []
  const seenBlobs = new Set<string>()
  for (const a of blobOrder) {
    if (seenBlobs.has(a.x)) continue
    seenBlobs.add(a.x)
    blobs.push({
      x: a.x,
      size: a.size,
      m: a.m,
      via: a.via,
    })
  }

  const graph: TemplateGraph = {
    planVersion: 1,
    pubkey: input.pubkey,
    relays: plan.relays,
    events: events.map(({ ref, kind, content, tags }) => ({ ref, kind, content, tags })),
    blobs,
  }
  const openQuestions = [...global, ...perRecord, ...gateQuestions]
  const counts: Record<EventType, number> = { profile: 0, product: 0, metadata: 0, binding: 0 }
  for (const e of events) counts[e.type] += 1

  return {
    status: 'drafted',
    plan,
    graph,
    plan_hash: planHash(graph),
    ready: !openQuestions.some((q) => q.blocking),
    preview: {
      counts,
      records: previews,
      graph: edges.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1)),
      relays: plan.relays.map((url, i) => previewRelay(url, i === 0, probes.get(url))),
      immutable_warning: IMMUTABLE_WARNING,
    },
    open_questions: openQuestions,
    findings: [],
  }
}

function previewRelay(url: string, primary: boolean, probe: RelayProbe | undefined): PreviewRelay {
  const role = primary ? 'primary' : 'mirror'
  if (probe === undefined) return { url, role }
  if (!probe.reachable) return { url, role, reachable: false }
  return {
    url,
    role,
    reachable: true,
    blossom: probe.blossom,
    clock_skew_s: probe.clock_skew_s,
    limits: probe.limits,
  }
}

/** Records a file problem as a finding or a question; returns true when the file is unusable. */
function fileProblem(
  facts: FileFacts,
  field: string,
  path: string,
  findings: Refusal[],
  ask: (
    code: OpenQuestionCode,
    blocking: boolean,
    field: string,
    text: string,
    why: string,
  ) => void,
): boolean {
  switch (facts.kind) {
    case 'ok':
    case 'exists':
      return false
    case 'outside':
      findings.push(
        schemaRefusal(
          'schema.path_outside_root',
          field,
          `\`${path}\` resolves outside the data folder`,
          'Use a path relative to the data folder that stays inside it.',
        ),
      )
      return true
    case 'missing':
      ask(
        'artifact.missing_file',
        true,
        field,
        `\`${path}\` does not exist in the data folder. Fix the path, or drop it?`,
        'Every file a record cites must exist locally; its hash is taken from the local bytes.',
      )
      return true
    case 'too_large':
      ask(
        'artifact.too_large',
        true,
        field,
        `\`${path}\` is ${facts.size} bytes, over the ${MAX_ARTIFACT_BYTES}-byte limit. Host it elsewhere and give its URL, split it, or drop it?`,
        'The relay accepts uploads up to 50 MiB.',
      )
      return true
    default: {
      const exhaustive: never = facts
      return exhaustive
    }
  }
}

function profileEvent(
  record: ProfileRecord,
  picture: ReadyArtifact | undefined,
): GraphEvent & { readonly type: 'profile' } {
  // Key order is fixed (name, display_name, about, picture): it is part of the hashed content.
  const body = {
    name: normalizeProse(record.name),
    ...(record.display_name === undefined
      ? {}
      : { display_name: normalizeProse(record.display_name) }),
    ...(record.about === undefined ? {} : { about: normalizeProse(record.about) }),
    ...(picture === undefined ? {} : { picture: picture.url }),
  }
  return { ref: record.ref, type: 'profile', kind: 0, content: JSON.stringify(body), tags: [] }
}

function normalizedCard(card: Card): Card {
  return Object.fromEntries(
    Object.entries(card).map(([k, v]) => [k, typeof v === 'string' ? normalizeProse(v) : v]),
  )
}

function indexedFields(record: ProductRecord | MetadataRecord) {
  return {
    headline: normalizeProse(record.headline),
    bullets: record.bullets.map(normalizeProse).filter((b) => b.trim() !== ''),
    links: record.links,
    card: normalizedCard(record.card),
  }
}

function indexedEvent(
  record: ProductRecord | MetadataRecord,
  artifacts: readonly ReadyArtifact[],
): GraphEvent & { readonly type: 'product' | 'metadata' } {
  const content = composeContent(indexedFields(record))
  if (record.type === 'product') {
    const { tags } = buildProduct(content, 0, record.indexers).template
    return { ref: record.ref, type: 'product', kind: 1, content, tags }
  }
  // Tags the core builders do not emit, appended after them (spec §5.3).
  const appended: string[][] = [['meta', record.subtype]]
  if (record.identifier !== undefined)
    appended.push(['identifier', normalizeProse(record.identifier)])
  for (const a of artifacts)
    appended.push(imetaTag({ url: a.url, m: a.m, x: a.x, size: a.size, alt: a.alt }))
  const { tags } = buildMetadata(content, 0, record.indexers).template
  return { ref: record.ref, type: 'metadata', kind: 1, content, tags: [...tags, ...appended] }
}

/** Rule 2a, vocabulary and RL-1/tag-budget gates on one composed product or metadata event. */
function gates(
  record: ProductRecord | MetadataRecord,
  label: string,
  event: GraphEvent,
): OpenQuestion[] {
  const out: OpenQuestion[] = []
  const ask = (
    code: OpenQuestionCode,
    blocking: boolean,
    field: string,
    text: string,
    why: string,
    options: readonly string[] = [],
  ) => out.push(question(code, blocking, record.ref, field, text, why, options))

  for (const lost of lostFacts({ ...indexedFields(record), indexers: record.indexers })) {
    ask(
      'record.rule_2a',
      true,
      lost.from === 'card' ? `${label}.card.${lost.key}` : `${label}.indexers[${lost.index}]`,
      `"${lost.value}" is in the ${lost.from === 'card' ? 'record card' : 'indexers'} but not in the headline, bullets or links. Mention it in the prose, or remove it?`,
      'Every machine-readable fact must also be readable in the prose (rule 2a); the server does not rewrite prose.',
    )
  }

  record.indexers.forEach((raw, i) => {
    const prefix = raw.slice(0, raw.indexOf(':'))
    if (isKnownPrefix(prefix)) return
    const suggestion = suggestPrefix(prefix)
    const value = raw.slice(prefix.length + 1)
    ask(
      'record.indexer_prefix_unknown',
      false,
      `${label}.indexers[${i}]`,
      suggestion === undefined
        ? `Indexer prefix \`${prefix}:\` is not in the vocabulary. Keep it?`
        : `Indexer prefix \`${prefix}:\` is not in the vocabulary. Did you mean \`${suggestion}:\`?`,
      'Lens and indexers match on known prefixes; unknown ones are kept but rarely found (IR-4).',
      [...(suggestion === undefined ? [] : [`${suggestion}:${value}`]), `keep ${raw}`],
    )
  })

  const letters = singleLetterTags(event)
  if (letters > MAX_SINGLE_LETTER_TAGS) {
    const excess = letters - MAX_SINGLE_LETTER_TAGS
    ask(
      'record.budget',
      true,
      `${label}.indexers`,
      `This record would carry ${letters} single-letter tags; the relay accepts ${MAX_SINGLE_LETTER_TAGS}. Drop at least ${excess} indexer(s). Which?`,
      'The relay rejects events over its indexable-tag ceiling; keep the indexers the record is about (IX-4).',
      record.indexers.slice(-excess),
    )
  }
  if (signedSize(event) > MAX_EVENT_BYTES) {
    ask(
      'record.budget',
      true,
      label,
      `This record would be about ${signedSize(event)} bytes signed; the limit is ${MAX_EVENT_BYTES}. Shorten the card or bullets, or move bulk into an artifact?`,
      'Relays reject events over 64 KiB (RL-1).',
    )
  }
  const iTagPositions = event.tags.flatMap((t, i) => (t[0] === 'i' ? [i] : []))
  const imetaPositions = event.tags.flatMap((t, i) => (t[0] === 'imeta' ? [i] : []))
  for (const position of oversizedTagValues(event)) {
    const name = event.tags[position]?.[0]
    const field =
      name === 'i'
        ? `${label}.indexers[${iTagPositions.indexOf(position)}]`
        : name === 'imeta'
          ? `${label}.artifacts[${imetaPositions.indexOf(position)}]`
          : name === 'identifier'
            ? `${label}.identifier`
            : label
    ask(
      'record.budget',
      true,
      field,
      'A tag value here is over 1024 bytes. Shorten it?',
      'Relays reject any tag value over 1024 bytes (RL-1).',
    )
  }
  return out
}
