/**
 * seccerts-crosslinks.ts — the card↔cert cross-link pair set for this leg
 * (decision 2026-10-11, update-semantics.md §Verified-fact 1).
 *
 * Selection from ground-truth/crosslink-matrix.json (measured 2026-10-11 against the JSON):
 *  - the 4 demo pairs ALREADY live on the relay from leg 1 (advisorySpine.ts SPINE_CROSSLINKS):
 *    c008↔9b8e2c2e7f69fdbb (SERTIT-091), c026↔d8473663e3e82527 (BSI-DSZ-CC-0868-2014),
 *    c046↔a43ba4af9421da93 (BSI-DSZ-CC-0869-2015), c071↔f29f88756682e034 (NSCIB-CC-22-180212-2-CR).
 *    These are adopted as ledger seeds and MUST NOT be re-emitted — pair selection here takes
 *    the same cert dgst (spine wins over the matrix rank-1, e.g. c046).
 *  - every other matrix CARD with ≥1 `high` candidate and a site `jcard` (cNNN) gets exactly the
 *    FIRST `high` candidate in the matrix's own candidate array order — leg-1's documented rule
 *    (loaders/jcalgtest.ts: "rank-1 HIGH candidate … array order is the matrix's rank order"), so
 *    this leg partitions the identical set leg 1 operated on (measured: 62 cards carry ≥1 high;
 *    9 have `jcard = null`, 3 are demo cards whose spine pair is already live ⇒ 50 matrix-new +
 *    8 jcard-null cards still emittable via leg-1's cardKeyOf atr/name anchors + 4 seeded = 62).
 *  - matrix cards with NO leg-1 card Product anchor (jcard:) are NOT dropped here: down-stream
 *    (plan/seed) resolution tries jcard → atr → name exactly as leg-1's cardKeyOf/matchCard;
 *    the pair is planned against the identity that resolves.
 *  - evidence strings ride verbatim from the matrix candidate rows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SecCertsCrosslink } from './seccerts-types.js'

/** The 4 seeded demo pairs (advisorySpine.ts SPINE_CROSSLINKS, leg-1 live on the relay). */
const SPINE_PAIRS: Readonly<Record<string, string>> = {
  'jcard:c008': '9b8e2c2e7f69fdbb',
  'jcard:c026': 'd8473663e3e82527',
  'jcard:c046': 'a43ba4af9421da93',
  'jcard:c071': 'f29f88756682e034',
}

interface MatrixCandidate {
  dgst: string
  cert_id: string | null
  scheme?: string | null
  confidence: string
  score?: number | null
  rank?: number | null
  evidence?: string[]
  name?: string | null
}

interface MatrixCard {
  jcard: string | null
  card_name?: string | null
  atr?: string | null
  candidates?: MatrixCandidate[]
}

interface MatrixDoc {
  cards: MatrixCard[]
}

/** Ledger anchor for a card: `jcard:<id>` / `atr:<hex>` / `name:<lower>` per leg-1 cardKeyOf. */
function cardAnchorKey(card: MatrixCard): string | null {
  if (card.jcard !== null) return `jcard:${card.jcard}`
  const atr = card.atr
  if (typeof atr === 'string' && /^[0-9a-f]*$/iu.test(atr.trim().toLowerCase()) && atr.length >= 8) {
    return `atr:${atr.trim().toLowerCase()}`
  }
  const name = card.card_name
  if (typeof name === 'string' && name !== '') return `name:${name.trim().toLowerCase()}`
  return null
}

export function loadCrosslinks(opts: { groundTruthDir: string }): {
  pairs: SecCertsCrosslink[]
  warnings: string[]
} {
  const path = join(opts.groundTruthDir, 'crosslink-matrix.json')
  const doc = JSON.parse(readFileSync(path, 'utf8')) as MatrixDoc
  const warnings: string[] = []
  const pairs: SecCertsCrosslink[] = []

  const pick = (c: MatrixCard): MatrixCandidate | null => {
    const spineDgst = c.jcard === null ? undefined : SPINE_PAIRS[`jcard:${c.jcard}`]
    if (spineDgst !== undefined) {
      const inMatrix = (c.candidates ?? []).find((p) => p.dgst === spineDgst)
      if (inMatrix !== undefined) return inMatrix
      warnings.push(
        `crosslink seed ${c.jcard ?? '?'}: spine cert ${spineDgst} not in this matrix revision — kept as seeded pair from advisorySpine`,
      )
      return {
        dgst: spineDgst,
        cert_id: null,
        confidence: 'high',
        score: null,
        evidence: ['seeded from leg-1 advisorySpine.ts SPINE_CROSSLINKS'],
      }
    }
    return (c.candidates ?? []).find((p) => p.confidence === 'high') ?? null
  }

  for (const card of doc.cards) {
    const row = pick(card)
    if (row === null) continue
    const anchor = cardAnchorKey(card)
    if (anchor === null) {
      warnings.push(
        `crosslink skipped (no identity anchor — no jcard, no ATR, no name): ${row.cert_id ?? row.dgst} candidate of an unlabelled card`,
      )
      continue
    }
    pairs.push({
      corpus: 'seccerts/cc',
      cardKey: anchor,
      cardName: card.card_name ?? anchor,
      cardAtr: card.atr ?? null,
      certDgst: row.dgst,
      certId: row.cert_id ?? null,
      scheme: row.scheme ?? null,
      evidence: row.evidence ?? [],
      score: row.score ?? null,
    })
  }
  return { pairs, warnings }
}
