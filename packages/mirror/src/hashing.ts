/**
 * hashing.ts — the mirror's single SHA-256 hex primitive.
 *
 * Hashes via `@noble/hashes` rather than `node:crypto`: `packages/*\/src/**` bans direct crypto
 * imports (D12, biome `noRestrictedImports`), and `@noble/hashes` already ships with the package.
 */
import { sha256 } from '@noble/hashes/sha2.js'

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return Buffer.from(sha256(bytes)).toString('hex')
}
