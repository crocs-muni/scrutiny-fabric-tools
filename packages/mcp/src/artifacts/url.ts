/**
 * Publisher-hosted URL check (spec §9.2): download over HTTPS only, at most 3 redirects, capped at
 * 50 MiB, and compare SHA-256 with the local file. Nothing is uploaded.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MAX_ARTIFACT_BYTES } from '../plan/files.js'

export type UrlCheck =
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly x: string }
  | { readonly kind: 'error'; readonly message: string }

const MAX_REDIRECTS = 3

export async function verifyUrl(
  url: string,
  expectedX: string,
  deps: { readonly fetch: typeof fetch; readonly maxBytes?: number },
): Promise<UrlCheck> {
  const maxBytes = deps.maxBytes ?? MAX_ARTIFACT_BYTES
  let current = url
  for (let hop = 0; ; hop++) {
    if (new URL(current).protocol !== 'https:') {
      return { kind: 'error', message: `${current} is not HTTPS` }
    }
    let response: Response
    try {
      response = await deps.fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      })
    } catch (cause) {
      return {
        kind: 'error',
        message: `download failed: ${cause instanceof Error ? cause.message : 'unknown'}`,
      }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null)
        return { kind: 'error', message: `HTTP ${response.status} without a Location` }
      if (hop === MAX_REDIRECTS)
        return { kind: 'error', message: `more than ${MAX_REDIRECTS} redirects` }
      current = new URL(location, current).href
      continue
    }
    if (!response.ok || response.body === null) {
      return { kind: 'error', message: `HTTP ${response.status}` }
    }
    const hash = sha256.create()
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > maxBytes) return { kind: 'error', message: `larger than ${maxBytes} bytes` }
      hash.update(chunk)
    }
    const x = bytesToHex(hash.digest())
    return x === expectedX ? { kind: 'match' } : { kind: 'mismatch', x }
  }
}
