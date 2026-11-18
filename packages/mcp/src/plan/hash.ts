/**
 * Plan hash (spec §5.4): `sha256(JCS(template_graph))`, JCS being RFC 8785 canonical JSON.
 *
 * RFC 8785 serialises strings and numbers exactly as ECMAScript's `JSON.stringify` does, and sorts
 * object keys by UTF-16 code units, which is what `Array.prototype.sort` does on strings by default.
 * So the canonical form is JSON.stringify with recursively sorted keys, plus refusing the values
 * JSON cannot carry. The template graph holds only strings, integers, null, arrays and objects.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('RFC 8785 cannot represent a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  throw new TypeError(`RFC 8785 cannot represent a value of type ${typeof value}`)
}

/** Lowercase hex SHA-256 of the canonical UTF-8 bytes. */
export function planHash(graph: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(graph))))
}
