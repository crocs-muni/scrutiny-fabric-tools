/**
 * emit/corpusProduct.ts — the corpus-level Product (design §2.7, §9 Q2).
 *
 * One Product per corpus anchors the derived artifacts (dataset snapshots,
 * leaderboards) via Bindings. It carries **no `i` tags** — corpus discovery rides
 * the topic facets and the binding graph, never an indexer (§9 Q2 verdict).
 */

import type { SignedEvent } from '../types.js'
import { assertEventShape, assertRule2a, baseTags, composeContent } from './content.js'
import type { Signer } from './keys.js'

export interface CorpusProductInput {
  /** Corpus slug, e.g. `jcalgtest`. */
  corpus: string
  /** Human label, e.g. `JCAlgTest card corpus`. */
  label: string
  /** Import snapshot date (ISO). */
  snapshot: string
  /** Upstream project URL. */
  source: string
  /** Coverage counts of this import. */
  counts: { cards: number; runs: number; crossings: number }
}

/** Build the corpus Product event (root, no `i` tags, facet-tagged). */
export function buildCorpusProduct(
  input: CorpusProductInput,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const label = `corpus-product:${input.corpus}`
  const headline = `${input.label} — mirrored JavaCard algorithm-support and performance profiles (import snapshot ${input.snapshot}).`
  const content = composeContent({
    headline,
    bullets: [
      `What it is: per-card algorithm support and performance measurements measured on physical JavaCard smart cards with the JCAlgTest suite; repository datasource ${input.source}.`,
      `Coverage of this import: ${input.counts.cards} card Products, ${input.counts.runs} measurement runs, ${input.counts.crossings} card-to-certificate cross-links (snapshot ${input.snapshot}).`,
      'How to read it: each card is a Product; every measurement run is a Metadata bound to that card; dataset snapshots and derived leaderboards are Metadata bound to this corpus Product (traverse this event id with a #e filter to list them).',
      'Negative results are content too: cards whose runs measured no support for a family are stated in the run notes, never omitted.',
      "Provenance: public JCAlgTest / jcalgtest_results data (CroCS, Masaryk University; MIT-licensed tooling), mirrored by scrutiny-mirror; values are the contributors' measurements, reproduced verbatim.",
    ],
    links: [
      `Repository: ${input.source}`,
      'Support matrix: https://www.fi.muni.cz/~xsvenda/jcalgtest/table.html',
      'Mirrored by scrutiny-mirror; not authored or endorsed by CroCS or the card vendors.',
    ],
  })
  const tags = baseTags('scrutiny-product', ['jcalgtest'])
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}
