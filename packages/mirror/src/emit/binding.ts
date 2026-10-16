/**
 * emit/binding.ts — SCRUTINY Binding builder (design §2, BD-2/BD-3, rule 8d).
 *
 * A Binding is an immutable directed edge Metadata → Product, published as
 * `e root` = Product and `e link` = Metadata. Both `e` tags carry NIP-10 markers
 * (`root` / `link`) with the relay-URL slot empty and the publisher pubkey in the
 * author position; content ends with the mandatory
 * `Refs: root <64hex> link <64hex>` line (design §4.1 rule 8d).
 */

import type { CrosslinkRecord, RunRecord, SignedEvent } from '../types.js'
import { assertEventShape, assertRule2a, baseTags, composeContent } from './content.js'
import type { Signer } from './keys.js'

export interface BindingSpec {
  /** The Product event this edge is rooted at. */
  root: { id: string; label: string }
  /** The Metadata event this edge links to. */
  link: { id: string; label: string }
  /** Topic facets — corpus facet(s), plus `roca` where the edge is ROCA-relevant. */
  facets: readonly string[]
  headline: string
  /** Evidence/provenance/method lines (plain-text bullets). */
  bullets: readonly string[]
  links?: readonly string[]
}

/** Build one signed Binding event. `createdAt` comes from the batch clock. */
export function buildBinding(
  spec: BindingSpec,
  createdAt: number,
  signer: Signer,
  label: string,
): SignedEvent {
  const base = composeContent({
    headline: spec.headline,
    bullets: spec.bullets,
    ...(spec.links === undefined ? {} : { links: spec.links }),
  })
  const content = `${base}\n\nRefs: root ${spec.root.id} link ${spec.link.id}`
  const tags: string[][] = [
    ...baseTags('scrutiny-binding', spec.facets),
    ['e', spec.root.id, '', 'root', signer.pubkey],
    ['e', spec.link.id, '', 'link', signer.pubkey],
  ]
  const event: SignedEvent = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}

/** Card Product → measurement-run Metadata Binding (design §2.5, §2.10.1). */
export function buildRunBinding(
  input: {
    cardName: string
    jcard: string | null
    run: RunRecord
    cardId: string
    runId: string
    snapshot: string
    roca?: boolean
  },
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const { run } = input
  const date = run.run.date ?? '(no date)'
  return buildBinding(
    {
      root: { id: input.cardId, label: input.cardName },
      link: { id: input.runId, label: `${run.kind} ${date}` },
      facets: input.roca === true ? ['jcalgtest', 'roca'] : ['jcalgtest'],
      headline: `${input.cardName} ← ${run.kind} ${date}: the measurement run bound to its card Product.`,
      bullets: [
        `Edge shape: root = card Product (${input.cardName}${input.jcard === null ? '' : `, profile ${input.jcard}`}), link = measurement-run Metadata (${run.kind}); one run CSV → one Metadata → one Binding (design §2.5).`,
        `The run Metadata carries its indexers (jcard, atr${run.jcver === null ? '' : `, jcver:${run.jcver}`}, family alg: tags) and the raw CSV bytes via imeta (sha256 ${run.sha256}, ${run.sizeBytes} bytes).`,
        `Upstream file: ${run.file}; snapshot ${input.snapshot}; mirrored by scrutiny-mirror.`,
      ],
      links: [`Raw CSV: ${run.upstreamUrl}`],
    },
    createdAt,
    signer,
    `run-binding:${run.kind}:${run.file}`,
  )
}

/** Card Product → certificate-record Metadata cross-link (design §2.6, issue #264). */
export function buildCrosslinkBinding(
  input: {
    cross: CrosslinkRecord
    cardName: string
    cardId: string
    certId: string
    snapshot: string
    roca?: boolean
  },
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const { cross } = input
  return buildBinding(
    {
      root: { id: input.cardId, label: input.cardName },
      link: { id: input.certId, label: cross.certId },
      facets: input.roca === true ? ['jcalgtest', 'roca'] : ['jcalgtest'],
      headline: `${input.cardName} — cross-link to certificate record ${cross.certId} (${cross.scheme.toUpperCase()} scheme).`,
      bullets: [
        'Method: JCAlgTest issue #264 — the card name is searched in the sec-certs full text and filtered by CPLC ICType / OperatingSystemID.',
        `Evidence: ${cross.evidence.join('; ')}.`,
        `Certificate record: ${cross.certId}, digest ${cross.certDgst}; the certificate record keeps its own identity — card and TOE are never merged (design §2.10.2).`,
        `Snapshot: ${input.snapshot}; mirrored by scrutiny-mirror from the frozen crosslink matrix.`,
      ],
      links: [`Certificate page: https://sec-certs.org/cc/${cross.certDgst}/`],
    },
    createdAt,
    signer,
    `crosslink-binding:${cross.certDgst}:${input.cardName}`,
  )
}

/** Corpus Product → derived Metadata (snapshot / leaderboard) Binding (design §2.7, §2.10.1). */
export function buildCorpusBinding(
  input: {
    corpusEventId: string
    derivedId: string
    derivedKind: string
    derivedLabel: string
    snapshot: string
    corpusLabel: string
  },
  createdAt: number,
  signer: Signer,
): SignedEvent {
  return buildBinding(
    {
      root: { id: input.corpusEventId, label: input.corpusLabel },
      link: { id: input.derivedId, label: input.derivedLabel },
      facets: ['jcalgtest'],
      headline: `${input.derivedLabel} — derived ${input.derivedKind} bound to the corpus Product.`,
      bullets: [
        `Edge shape: root = corpus Product (${input.corpusLabel}), link = derived ${input.derivedKind} Metadata (${input.derivedLabel}) — corpus Products anchor derived artifacts only (design §2.7, §2.10.2).`,
        'Recomputed on each import: a new derived root supersedes the previous edition; corpus bindings are immutable assertions, corrections are kind-5 + replacement (BD-9).',
        `Snapshot: ${input.snapshot}; mirrored by scrutiny-mirror.`,
      ],
    },
    createdAt,
    signer,
    `corpus-binding:${input.derivedKind}`,
  )
}
