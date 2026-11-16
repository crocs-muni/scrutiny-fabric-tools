/**
 * The two record shapes every engine result speaks (spec §6.5, §10). Codes are stable API; tests
 * assert `code` and `field`, never `problem`/`fix`/`question` wording.
 */

/** Spec §10: the single error record shape. */
export interface Refusal {
  readonly code: string
  /** `relays[0]`, `records[product:ex-100].indexers[1]`, or null when no field is at fault. */
  readonly field: string | null
  readonly problem: string
  readonly fix: string
  readonly source: 'schema' | 'gate' | 'relay' | 'signer' | 'approval' | 'artifact' | 'internal'
  /** The relay's reply verbatim, when a relay said it. */
  readonly relay_message: string | null
}

/** Spec §6.5: the server's half of the interview. */
export interface OpenQuestion {
  readonly code: OpenQuestionCode
  readonly blocking: boolean
  readonly ref: string | null
  readonly field: string | null
  readonly question: string
  readonly why: string
  readonly ask_user: boolean
  readonly options: readonly string[]
}

/**
 * Step 1 raises the codes it can decide from the plan, the files and the signer identity. The
 * relay-probe codes of §6.5 (`relay.unreachable`, `relay.no_blossom`, `relay.clock_skew`,
 * `artifact.url_mismatch`) arrive with the relay client (§18 step 3).
 */
export type OpenQuestionCode =
  | 'relay.missing'
  | 'signer.missing'
  | 'record.no_product'
  | 'record.dangling_ref'
  | 'record.duplicate_ref'
  | 'record.rule_2a'
  | 'record.budget'
  | 'record.indexer_prefix_unknown'
  | 'record.no_source'
  | 'artifact.missing_file'
  | 'artifact.too_large'
  | 'artifact.type'
  | 'profile.missing'

export function schemaRefusal(
  code: 'schema.invalid' | 'schema.path_outside_root',
  field: string | null,
  problem: string,
  fix: string,
): Refusal {
  return { code, field, problem, fix, source: 'schema', relay_message: null }
}
