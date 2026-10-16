/**
 * emit/snapshot.ts — dataset snapshot Metadata (design §2.7, §4.3.11).
 *
 * One snapshot Metadata per import per corpus, bound to the corpus Product by the
 * caller: counts, tool/source, pinned dataset hash, provenance. No `i` tags
 * (snapshots are corpus-anchored, §2.7).
 */

import type { SignedEvent, SnapshotRecord } from '../types.js'
import { assertEventShape, assertRule2a, baseTags, composeContent } from './content.js'
import type { Signer } from './keys.js'

export interface SnapshotInput {
  snapshot: SnapshotRecord
  /** Facets beyond the corpus facet (default `jcalgtest`). */
  facets?: readonly string[]
}

/** Build the dataset snapshot Metadata event. */
export function buildSnapshot(
  input: SnapshotInput,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const snap = input.snapshot
  const label = `snapshot:${snap.corpus}`
  const { counts } = snap

  const content = composeContent({
    headline: `Dataset snapshot — ${snap.corpus} corpus import, snapshot ${snap.snapshot} (${snap.tool}).`,
    bullets: [
      `Counts of this import: ${counts.cards} card Products, ${counts.runs} measurement runs, ${counts.crossings} card-to-certificate cross-links.`,
      `Source: ${snap.source}; tool ${snap.tool}.`,
      `Dataset pin: sha256 ${snap.datasetSha256} over the normalized source listing used for this import (recompute locally from the upstream repository).`,
      'Retention: every import publishes a new snapshot root event; superseded snapshots stay as history and are never patched (i tags are immutable, IX-3).',
      'Provenance: public JCAlgTest / jcalgtest_results data (CroCS, Masaryk University; MIT tooling), mirrored by scrutiny-mirror; upstream cadence is per-commit.',
    ],
    links: [
      `Dataset: ${snap.source}`,
      'Mirrored by scrutiny-mirror; not authored or endorsed by CroCS.',
    ],
    card: {
      type: 'dataset-snapshot@1',
      corpus: snap.corpus,
      snapshot: snap.snapshot,
      tool: snap.tool,
      counts,
      dataset_sha256: snap.datasetSha256,
      source: snap.source,
    },
  })

  const tags = baseTags('scrutiny-metadata', input.facets ?? ['jcalgtest'])
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}
