/**
 * Conformance-vector loader.
 *
 * Vectors live in the spec repo and are vendored here at a pinned checksum (D33). **The corpus does
 * not exist yet** — §11 still lists test vectors as future work and there is no Appendix G — so
 * this returns an empty list when `vectors/` is absent or empty and the suite stays green. It picks
 * the corpus up with no further change once the files land.
 *
 * `node:fs` is confined to the test tree. `src/` stays free of Node globals, which
 * `tsconfig.build.json` enforces with `"types": []` so that a stray `node:` import fails the build
 * rather than shipping.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VECTOR_DIR = fileURLToPath(new URL('../vectors', import.meta.url))

export interface VectorFile {
  readonly file: string
  /** Parsed contents. Shape is per-category and validated by the suite that consumes it. */
  readonly data: unknown
}

/** Every `vectors/*.json`, or an empty list if the directory is absent or holds none. */
export function loadVectors(): VectorFile[] {
  let names: string[]
  try {
    names = readdirSync(VECTOR_DIR).filter((n) => n.endsWith('.json'))
  } catch (error) {
    // ENOENT is the expected state before the corpus exists. Anything else is a real problem —
    // a permissions error or a corrupt checkout must not masquerade as "no vectors to run".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  return names.sort().map((file) => ({
    file,
    data: JSON.parse(readFileSync(join(VECTOR_DIR, file), 'utf8')),
  }))
}
