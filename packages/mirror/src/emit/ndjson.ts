/**
 * emit/ndjson.ts — artifact writer for a signed batch.
 *
 * Writes `artifacts/<corpus>.ndjson` (one compact signed event per line, LF, in the
 * order produced by `emitSourceBundle`) plus `manifest.json` matching the frozen
 * `Manifest` type. Deterministic bytes: same batch → same files.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Manifest, SignedEvent } from '../types.js'

export interface WriteArtifactsOptions {
  /** Corpus slug for the default filename (default: `manifest.corpus`). */
  corpus?: string
  /** Output directory (default: `artifacts`). */
  outDir?: string
  /** NDJSON filename override (default: `<corpus>.ndjson`). */
  filename?: string
}

export interface WrittenArtifacts {
  ndjsonPath: string
  manifestPath: string
  /** Manifest exactly as written to disk. */
  manifest: Manifest
}

/** One compact JSON line per event, LF-terminated (empty input → empty string). */
export function serializeNdjson(events: readonly SignedEvent[]): string {
  return events.length === 0 ? '' : `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
}

/** Write the batch to disk; returns the paths and the manifest as written. */
export function writeArtifacts(
  result: { events: readonly SignedEvent[]; manifest: Manifest },
  opts: WriteArtifactsOptions = {},
): WrittenArtifacts {
  const corpus = opts.corpus ?? result.manifest.corpus
  const outDir = resolve(opts.outDir ?? 'artifacts')
  const filename = opts.filename ?? `${corpus}.ndjson`
  const ndjsonPath = join(outDir, filename)
  const manifestPath = join(outDir, 'manifest.json')

  mkdirSync(outDir, { recursive: true })
  const manifest: Manifest = {
    ...result.manifest,
    corpus,
    files: { ndjson: relative(process.cwd(), ndjsonPath).replace(/\\/gu, '/') },
  }
  writeFileSync(ndjsonPath, serializeNdjson(result.events), 'utf8')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { ndjsonPath, manifestPath, manifest }
}
