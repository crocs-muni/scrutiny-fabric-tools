/**
 * emit/seccerts/plan.ts — leg-2 planning entry point: SecCertsBundle → DesiredState.
 *
 * Pure projection consumed by the emit engine: the engine diffs `roots` against the ledger,
 * classifies per update-semantics §2 (C1–C5 / R1–R5), signs, publishes and writes ledger rows.
 * Planning itself never signs, never reads a clock, never touches a ledger — `importStamp`
 * only feeds the snapshot content of the current run.
 *
 * Quote normalization: a handful of source strings (7 French PP titles, e.g.
 * `« Protection Profile for Signature Activation Protocol … »`) contain guillemets — the SAME
 * marker the gate scans for as an unresolved-template placeholder (gate/verify.ts). Rule 8's
 * plain-text convention normalizes exotic quotes to ASCII, applied HERE once at the plan
 * boundary so prose and the embedded record-card JSON stay byte-consistent (rule 2a + gate).
 */
import type { DesiredState, SecCertsBundle } from '../../loaders/seccerts-types.js'
import { planRelations } from './relations.js'
import { MIRROR_IMPORT_STAMP, planRoots } from './roots.js'

const TYPO_QUOTES = /[«»“”„]/gu
// C1 control chars other than \n are mirrored AS BYTES from sec-certs' raw text in ~16 of the
// corpus records — Go-based relays (Go json codecs round-trip `\u0002` differently than the
// canonical nostr-tools escaping) cannot hash such events consistently, so kind-1 writes are
// permanently invalid ("id is computed incorrectly"). Rule 8's plain-text convention removes
// them at this boundary (content-only; never in the upstream documents themselves).
const CTRL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu

function plainQuotes(text: string): string {
  return text.replace(TYPO_QUOTES, '"').replace(CTRL_CHARS, ' ')
}

function cleanValue(value: unknown): unknown {
  if (typeof value === 'string') return plainQuotes(value)
  if (Array.isArray(value)) return value.map(cleanValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanValue(v)]))
  }
  return value
}

/**
 * Content-faithful quote cleanup: the `Record card (JSON): …` line is parsed → cleaned →
 * re-stringified (never blindly regex-replaced, which would break JSON string quoting);
 * every other content line is plain prose already.
 */
function sanitizeRootContent(content: string): string {
  const out: string[] = []
  for (const line of content.split('\n')) {
    if (line.startsWith('Record card (JSON): ')) {
      const raw = line.slice('Record card (JSON): '.length)
      try {
        out.push(`Record card (JSON): ${JSON.stringify(cleanValue(JSON.parse(raw)))}`)
        continue
      } catch {
        // fall through to plain prose cleaning — a malformed card line is the builders' bug,
        // not something the sanitizer should hide.
      }
    }
    out.push(plainQuotes(line))
  }
  return out.join('\n')
}

export function planBundle(
  bundle: SecCertsBundle,
  importStamp: string = MIRROR_IMPORT_STAMP,
): DesiredState {
  const cves = new Set<string>()
  for (const r of bundle.cc) for (const c of r.cves) cves.add(`cve:${c.cve}`)
  for (const r of bundle.eucc) for (const c of r.cves) cves.add(`cve:${c.cve}`)
  for (const r of bundle.fips) for (const c of r.cves) cves.add(`cve:${c.cve}`)
  for (const m of bundle.maintenance) for (const cve of m.cves) cves.add(`cve:${cve}`)

  const roots = planRoots(bundle, importStamp).map((root) => ({
    ...root,
    content: sanitizeRootContent(root.content),
  }))
  const relations = planRelations(bundle).map((relation) => ({
    ...relation,
    headline: plainQuotes(relation.headline),
    bullets: relation.bullets.map(plainQuotes),
    links: relation.links.map(plainQuotes),
  }))

  // Desired-state dedupe is a HARD error (amended syncer semantics 2026-10-11): every
  // (corpus, sourceId, role) root and every relationId maps to exactly one desired row —
  // a silent overwrite would publish both events while the ledger keeps only the last.
  const seenRoots = new Set<string>()
  for (const root of roots) {
    const key = `${root.corpus}:${root.sourceId}:${root.role}`
    if (seenRoots.has(key)) throw new Error(`planBundle: duplicate desired root ${key}`)
    seenRoots.add(key)
  }
  const seenRelations = new Set<string>()
  for (const relation of relations) {
    const key = `${relation.corpus}:${relation.relationId}`
    if (seenRelations.has(key)) throw new Error(`planBundle: duplicate desired relation ${key}`)
    seenRelations.add(key)
  }

  return {
    roots,
    relations,
    sourceIdsByCorpus: {
      'seccerts/cc': bundle.cc.map((r) => r.sourceId),
      'seccerts/eucc': bundle.eucc.map((r) => r.sourceId),
      'seccerts/pp': bundle.pp.map((r) => r.sourceId),
      'seccerts/fips': bundle.fips.map((r) => r.sourceId),
      'seccerts/maintenance': bundle.maintenance.map((r) => r.sourceId),
      'seccerts/global': [...cves].sort(),
    },
  }
}
