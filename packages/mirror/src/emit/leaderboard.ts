/**
 * emit/leaderboard.ts — derived leaderboard Metadata (design §2.7, §4.3.12, §9 Q3).
 *
 * A signed cache / citation anchor, never the critical path: recomputed on each
 * import as a new root event (supersession recorded in the content — i tags are
 * immutable, IX-3), carrying `alg:<family>` + the cohort bucket + one `jcard:` per
 * member (≤ 62 members).
 */

import type { LeaderboardRecord, SignedEvent } from '../types.js'
import {
  assertEventShape,
  assertRule2a,
  baseTags,
  composeContent,
  iTags,
  kTagsFor,
} from './content.js'
import type { Signer } from './keys.js'

/** Metric key → `alg:` family slug. Only metrics with a frozen mapping are emitted. */
const METRIC_FAMILY: Readonly<Record<string, string>> = {
  sign_ecdsa_p256_sha1_ms: 'ecdsa',
}

const MAX_MEMBERS = 62

export interface LeaderboardInput {
  leaderboard: LeaderboardRecord
  /** Facets beyond the corpus facet (default `jcalgtest`). */
  facets?: readonly string[]
  /** Event id of the edition this one supersedes (null/absent for the first edition). */
  supersedes?: string | null
}

function metricLabel(metric: string): string {
  if (metric === 'sign_ecdsa_p256_sha1_ms') return 'Fastest ECDSA sign (P-256, SHA-1)'
  return metric
}

/** Build the leaderboard Metadata event. */
export function buildLeaderboard(
  input: LeaderboardInput,
  createdAt: number,
  signer: Signer,
): SignedEvent {
  const lb = input.leaderboard
  const label = `leaderboard:${lb.metric}`
  const family = METRIC_FAMILY[lb.metric]
  const top = lb.top.slice(0, MAX_MEMBERS)
  const supersedes = input.supersedes ?? null

  const iList = iTags([
    family === undefined ? null : `alg:${family}`,
    lb.cohortBucket,
    ...top.map(([, jcard]) => (jcard === null ? null : `jcard:${jcard}`)),
  ])
  const rankedLines = top.map(
    ([rank, jcard, name, ms]) =>
      `${rank}. ${name} — ${ms} ms/op${jcard === null ? '' : ` — jcard:${jcard}`}.`,
  )
  const excludedLine =
    lb.excluded.length === 0
      ? 'Excluded: none recorded for this cohort.'
      : `Excluded (disclosed, never silently skipped): ${lb.excluded.map((e) => `${e.reason} (n = ${e.count})`).join('; ')}.`

  const headline =
    `${metricLabel(lb.metric)} — JavaCard cohort ${lb.cohortBucket}, snapshot ${lb.snapshot}` +
    `${supersedes === null ? ' (first edition).' : ` (supersedes the previous edition ${supersedes}).`}`
  const secondLine =
    `${top.length} ranked card${top.length === 1 ? '' : 's'} for metric ${lb.metric}` +
    `${top[0] === undefined ? '' : `; fastest: ${top[0][2]} — ${top[0][3]} ms/op`}.`

  const content = composeContent({
    headline: `${headline}\n${secondLine}`,
    bullets: [
      `Metric: ${lb.metric} — ECDSA SHA-1 sign in the P-256 curve context, read from DATAFIXED "operation stats (ms/op) / avg op" values (the client already subtracted the baseline; never subtract twice). ALGSUPPORT timings are not comparable and are never used.`,
      `Cohort: cards declaring JavaCard ≤ 3.0.5 (cohort bucket ${lb.cohortBucket}); ranked ascending; n = ${top.length} card${top.length === 1 ? '' : 's'}.`,
      ...rankedLines,
      excludedLine,
      'Derivation: DATAFIXED runs only; cards whose ECDSA operations failed (NO_SUCH_ALGORITHM / CANT_BE_MEASURED / ILLEGAL_VALUE) carry no metric and are excluded by construction.',
      'Supersession: recomputed at every import as a new root event; the previous edition is superseded (kind-5 deleted by this publisher) — never patched, because i tags are immutable (IX-3).',
      'Caveat: cross-run comparability is limited (transport T=0/T=1, reader and host influence); treat this leaderboard as a signed cache and cross-check against the raw run record cards (§9 Q3).',
      `Snapshot: ${lb.snapshot}; derived artifact, not part of the original dataset.`,
    ],
    links: [
      'Source profile folder: https://github.com/crocs-muni/jcalgtest_results/tree/master/javacard/Profiles/performance/fixed',
      'Methodology: https://www.fi.muni.cz/~xsvenda/jcalgtest/knowledgebase.html',
      'Mirrored by scrutiny-mirror; derived artifact — the ranking is computed by the mirror, not published by JCAlgTest.',
    ],
    card: {
      type: 'jcalgtest-leaderboard@1',
      metric: lb.metric,
      cohort: lb.cohortBucket,
      snapshot: lb.snapshot,
      top,
      members: top.length,
      supersedes,
    },
  })

  const tags = [
    ...baseTags('scrutiny-metadata', input.facets ?? ['jcalgtest']),
    ...iList,
    ...kTagsFor(iList),
  ]
  const event = signer.sign({ kind: 1, created_at: createdAt, tags, content })
  assertEventShape(event, label)
  assertRule2a(event, label)
  return event
}
