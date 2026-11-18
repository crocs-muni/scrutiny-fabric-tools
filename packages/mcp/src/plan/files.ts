/**
 * Local file facts (spec §5.1, §9.1): every `sources` and artifact `path` is resolved under `root`
 * and must stay inside it, lexically and after following links. `x` is SHA-256 of the bytes, `m`
 * comes from a fixed extension map with no content sniffing.
 */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** 50 MiB; matches the relay's `SCRUTINY_BLOB_MAX_BYTES` default (spec §9.4). */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
}
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/** The MIME type and URL extension for an artifact, or undefined when the extension is not mapped. */
export function mediaType(
  path: string,
  use: 'artifact' | 'picture',
): { m: string; ext: string } | undefined {
  const ext = extname(path).toLowerCase()
  const m = (use === 'picture' ? IMAGE_TYPES : DOCUMENT_TYPES)[ext]
  return m === undefined ? undefined : { m, ext: ext === '.jpeg' ? '.jpg' : ext }
}

export type FileFacts =
  | { readonly kind: 'ok'; readonly x: string; readonly size: number }
  | { readonly kind: 'exists' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'too_large'; readonly size: number }

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Resolves `path` under `root`. Sources are only checked for existence; artifacts and pictures are
 * also size-checked and hashed (`hash: true`).
 */
export async function fileFacts(root: string, path: string, hash: boolean): Promise<FileFacts> {
  if (isAbsolute(path)) return { kind: 'outside' }
  const lexical = resolve(root, path)
  if (!inside(resolve(root), lexical)) return { kind: 'outside' }

  let real: string
  try {
    real = await realpath(lexical)
  } catch {
    return { kind: 'missing' }
  }
  if (!inside(await realpath(root), real)) return { kind: 'outside' }

  const info = await stat(real)
  if (!info.isFile()) return { kind: 'missing' }
  if (!hash) return { kind: 'exists' }
  if (info.size > MAX_ARTIFACT_BYTES) return { kind: 'too_large', size: info.size }

  const h = sha256.create()
  for await (const chunk of createReadStream(real)) h.update(chunk as Uint8Array)
  return { kind: 'ok', x: bytesToHex(h.digest()), size: info.size }
}
