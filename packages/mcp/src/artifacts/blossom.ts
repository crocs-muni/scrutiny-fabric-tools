/**
 * Blossom client (spec §9.3), used by the run engine before an event citing the blob is signed.
 *
 * 1. `HEAD /<x>`: present → done (uploads are idempotent by hash).
 * 2. `PUT /upload`, authorised by a kind-24242 event signed with the publisher key, tags
 *    `t upload`, `x`, `expiration` (now + 300) and `server` (URL form).
 * 3. The returned descriptor's `sha256` must equal `x`.
 *
 * The URL the plan cites is fixed by the client, `https://<primary-host>/<x><ext>`; the relay
 * serves a blob by hash whatever extension a request uses.
 */

import type { Refusal } from '../refusal.js'
import { httpBase } from '../relay/http-base.js'
import type { SignerPort } from '../signer/signer.js'

export interface BlobRef {
  readonly x: string
  readonly size: number
  readonly m: string
  /** URL extension with its dot, from the extension map (spec §9.1). */
  readonly ext: string
}

export class BlossomError extends Error {
  readonly refusal: Refusal
  constructor(refusal: Refusal) {
    super(refusal.problem)
    this.name = 'BlossomError'
    this.refusal = refusal
  }
}

const AUTH_TTL_S = 300

export function blobUrl(primary: string, blob: Pick<BlobRef, 'x' | 'ext'>): string {
  return `${httpBase(primary)}/${blob.x}${blob.ext}`
}

function fail(
  code: string,
  problem: string,
  fix: string,
  relayMessage: string | null = null,
): BlossomError {
  return new BlossomError({
    code,
    field: null,
    problem,
    fix,
    source: 'artifact',
    relay_message: relayMessage,
  })
}

export async function ensureBlob(opts: {
  readonly primary: string
  readonly blob: BlobRef
  readonly bytes: () => Promise<Uint8Array>
  readonly signer: SignerPort
  /** Unix seconds, the signer's clock. */
  readonly now: () => number
  readonly fetch: typeof fetch
}): Promise<{ readonly state: 'present' | 'uploaded'; readonly url: string }> {
  const base = httpBase(opts.primary)
  const url = blobUrl(opts.primary, opts.blob)

  try {
    const head = await opts.fetch(`${base}/${opts.blob.x}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    })
    if (head.ok) return { state: 'present', url }
  } catch {
    // Treated as absent: the upload below will say whether the server is reachable.
  }

  const now = opts.now()
  const auth = await opts.signer.sign({
    kind: 24242,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['x', opts.blob.x],
      ['expiration', String(now + AUTH_TTL_S)],
      ['server', base],
    ],
    content: `Upload ${opts.blob.x}`,
  })
  const body = await opts.bytes()
  let response: Response
  try {
    response = await opts.fetch(`${base}/upload`, {
      method: 'PUT',
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(auth), 'utf8').toString('base64')}`,
        'content-type': opts.blob.m,
        'x-sha-256': opts.blob.x,
      },
      body,
      signal: AbortSignal.timeout(300_000),
    })
  } catch (cause) {
    throw fail(
      'artifact.upload_failed',
      `uploading ${opts.blob.x} failed: ${cause instanceof Error ? cause.message : 'unknown'}`,
      'Check the connection and call publish_plan again to resume.',
    )
  }
  if (!response.ok) {
    const reason = response.headers.get('x-reason')
    throw fail(
      'artifact.upload_failed',
      `the Blossom server refused ${opts.blob.x} with HTTP ${response.status}`,
      'Read the relay message; if the key is not allowlisted, send the npub to the relay operator.',
      reason,
    )
  }
  let descriptor: unknown
  try {
    descriptor = await response.json()
  } catch {
    descriptor = null
  }
  const returned = (descriptor as { sha256?: unknown } | null)?.sha256
  if (returned !== opts.blob.x) {
    throw fail(
      'artifact.upload_mismatch',
      `the Blossom server stored a blob whose sha256 is not ${opts.blob.x}`,
      'Do not publish events citing this blob; report it to the relay operator.',
    )
  }
  return { state: 'uploaded', url }
}
