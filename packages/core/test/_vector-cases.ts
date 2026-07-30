/**
 * Shared shapes and helpers for running the vendored Appendix G conformance vectors.
 *
 * `loadVectors()` (`_vectors.ts`) returns one `{file, data}` per `vectors/*.json`, parsed but
 * uninterpreted — this file adds the per-category structure (G.2) and a couple of helpers the
 * three consuming suites (`validate-vectors.test.ts`, `patch.test.ts`, `resolve-vectors.test.ts`)
 * all need: pulling a named file's `cases` out of the loader's generic result, and a random
 * permutation generator for G.3's confluence requirement on `chain` cases.
 */

import type { NostrEvent } from '../src/events.js'
import type { VectorFile } from './_vectors.js'

/** Pull one file's typed `cases` array out of the loader's result. `[]` if the file is absent. */
export function vectorCases<T>(vectors: readonly VectorFile[], file: string): readonly T[] {
  const found = vectors.find((v) => v.file === file)
  if (found === undefined) return []
  return (found.data as { cases: readonly T[] }).cases
}

// ---------------------------------------------------------------------------
// validity.json
// ---------------------------------------------------------------------------

export interface ValidityCase {
  readonly name: string
  readonly rule: string
  readonly why: string
  readonly event: NostrEvent
  readonly observed?: readonly NostrEvent[]
  readonly expect: {
    readonly status: 'valid' | 'invalid' | 'pending' | 'not-scrutiny'
    readonly mustEmit?: readonly string[]
    readonly mustNotEmit?: readonly string[]
    readonly awaiting?: readonly string[]
  }
}

// ---------------------------------------------------------------------------
// application.json
// ---------------------------------------------------------------------------

export interface ApplyCase {
  readonly kind: 'apply'
  readonly name: string
  readonly rule: string
  readonly why: string
  readonly content: string
  readonly payload: string
  readonly options?: { readonly maxHunks?: number; readonly maxWork?: number }
  readonly expect: {
    readonly outcome: 'applied' | 'noop' | 'halt'
    /** Normative for `applied`. */
    readonly content?: string
    /** G.3: advisory only, never asserted for equality — halt reasons are not normative. */
    readonly reason?: string
  }
}

export interface ChainCase {
  readonly kind: 'chain'
  readonly name: string
  readonly rule: string
  readonly why: string
  readonly rootId: string
  readonly events: readonly NostrEvent[]
  /** Already shaped as `ResolveOptions` (`{apply: {...}}`) — pass straight through to `resolve`. */
  readonly options?: { readonly apply?: { readonly maxHunks?: number; readonly maxWork?: number } }
  readonly expect: {
    /** G.2: pins only the fields the case is about — never asserted as a full-object match. */
    readonly chain?: Record<string, unknown> & { readonly status: string }
    readonly overlays?: readonly (Record<string, unknown> & { readonly id: string })[]
    readonly annotations?: readonly string[]
    readonly noAnnotations?: readonly string[]
  }
}

export type ApplicationCase = ApplyCase | ChainCase

/**
 * G.3 — every `chain` case's expectation MUST hold under any permutation of its `events` array,
 * not merely the order given. Exhaustive permutation is infeasible past a handful of events, so
 * this returns the given order, the fully-reversed order (the cheapest way to disturb every
 * relative pairing at once), and a fixed number of random shuffles — the same sampling shape
 * `resolve-property.test.ts`'s G1 gate already uses for the general confluence property.
 */
export function permutationsOf<T>(items: readonly T[], randomCount = 8): T[][] {
  const perms: T[][] = [[...items], [...items].reverse()]
  for (let i = 0; i < randomCount; i++) {
    const shuffled = [...items]
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1))
      ;[shuffled[j], shuffled[k]] = [shuffled[k] as T, shuffled[j] as T]
    }
    perms.push(shuffled)
  }
  return perms
}
