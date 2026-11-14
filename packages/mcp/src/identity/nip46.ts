/**
 * Minimal NIP-46 client — the pilot custody path (#108): the key stays in the bunker, this process
 * only holds a disposable client keypair and a NIP-44 conversation with the signer.
 *
 * Scope is deliberately the two RPCs the publisher needs, not the whole method table:
 * `connect`/`get_public_key` establish *which* user key is signing, `sign_event` signs templates.
 * `nip44_encrypt`, `logout`, and `switch_relays` are a family of methods A4 may add once the
 * publisher actually calls them; implementing them now would be untested surface.
 *
 * Two independent authenticity gates, because a relay is an untrusted pipe:
 *
 * 1. Every kind-24133 event is signature- and id-checked *before* its content is decrypted
 *    (NIP-44: "the outer signature MUST be validated before decrypting"), and its author must be
 *    the `remote-signer-pubkey` from the bunker URI.
 * 2. The signed event inside a `sign_event` result is re-verified with core's `eventIdMatches`
 *    plus BIP-340, its pubkey must equal the `get_public_key` answer, and its kind/content/tags/
 *    created_at must equal the template that was sent. A bunker that signs something else — even
 *    competently, with a freshly computed id — is rejected.
 *
 * Transport is injected (`./transport.ts`): A2 defines the seam, A4 supplies the socket.
 */

import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { type NostrEvent, type UnsignedEvent, tagValues } from '@scrutiny-fabric/core'
import { z } from 'zod'
import { decrypt, encrypt, getConversationKey } from './nip44.ts'
import { assertCreatedAtWithinRelayWindow, createDevKeySigner, verifySignedEvent } from './sign.ts'
import type { RelaySocket, RelayTransport } from './transport.ts'

/** NIP-46's request/response event kind. */
export const NIP46_KIND = 24133

const HEX64 = /^[0-9a-f]{64}$/u
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * Machine-readable failure classes. Callers (A4, tests) need to distinguish "the bunker said no"
 * from "nothing ever answered"; matching message prose is not a contract.
 */
export type Nip46FailureReason =
  | 'closed'
  | 'timeout'
  | 'unexpected-author'
  | 'relay-closed'
  | 'send-failed'
  | 'connect-refused'
  | 'auth-required'
  | 'bunker-error'
  | 'invalid-response'
  | 'tampered'
  | 'wrong-user-key'
  | 'stale-template'
  | 'invalid-uri'

export class Nip46Error extends Error {
  readonly reason: Nip46FailureReason

  constructor(reason: Nip46FailureReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'Nip46Error'
    this.reason = reason
  }
}

/** The `bunker://` token's three payloads, validated. */
export interface BunkerUri {
  /** The signer daemon's pubkey (response author and NIP-44 peer), hex. */
  readonly remotePubkey: string
  /** At least one relay; this client uses the first (NIP-46 lets a signer rotate them later). */
  readonly relays: readonly string[]
  /** Optional single-use secret; `nak bunker` authorizes a client that presents a matching one. */
  readonly secret: string | undefined
}

/**
 * `connect`'s result is `"ack"` or, in the client-initiated flow, the secret echoed back;
 * `sign_event` returns a JSON stringified event. Anything else is a protocol error.
 */
const RpcResponse = z.object({
  id: z.string().min(1),
  result: z.string().optional(),
  error: z.string().optional(),
})

function normalizeRelay(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Nip46Error('invalid-uri', `NIP-46: relay parameter "${raw}" is not an absolute URL`)
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Nip46Error(
      'invalid-uri',
      `NIP-46: relay parameter must be ws:// or wss:// — got ${url.protocol}//`,
    )
  }
  return url.href.replace(/\/+$/u, '')
}

/**
 * Percent-decode one query component exactly once, per RFC 3986. `URLSearchParams` would also map
 * `+` to a space (form-urlencoded semantics), which silently changes a secret containing `+`; a
 * bunker URI is a URI, not a form body, so `+` stays a plus and `%2B` also decodes to one.
 */
function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new Nip46Error(
      'invalid-uri',
      'NIP-46: malformed percent-encoding in the bunker URI query — re-copy the URI',
    )
  }
}

/** Every value of `name`, decoded once, in URI order. Empty pairs (`&&`, trailing `&`) are skipped. */
function queryParamValues(search: string, name: string): string[] {
  const values: string[] = []
  const query = search.startsWith('?') ? search.slice(1) : search
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const separator = pair.indexOf('=')
    const key = decodeQueryComponent(separator === -1 ? pair : pair.slice(0, separator))
    if (key !== name) continue
    values.push(decodeQueryComponent(separator === -1 ? '' : pair.slice(separator + 1)))
  }
  return values
}

/**
 * Parse `bunker://<remote-signer-pubkey>?relay=<wss://…>&secret=<hex>`.
 *
 * `URL` lowercases the host, which is correct for hex pubkeys. `npub` is not accepted: NIP-46
 * says "all pubkeys specified in this NIP are in hex format", and accepting both spellings would
 * leave two identities to keep in sync.
 */
export function parseBunkerUri(uri: string): BunkerUri {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Nip46Error(
      'invalid-uri',
      'NIP-46: invalid bunker URI — expected bunker://<remote-signer-pubkey>?relay=wss://…',
    )
  }
  if (url.protocol !== 'bunker:') {
    throw new Nip46Error(
      'invalid-uri',
      `NIP-46: expected a bunker:// URI, got ${url.protocol}// — nostrconnect:// is the client-initiated flow and belongs in the client UI, not in server config`,
    )
  }
  const remotePubkey = url.hostname
  if (!HEX64.test(remotePubkey)) {
    throw new Nip46Error(
      'invalid-uri',
      `NIP-46: bunker URI host must be the remote-signer pubkey as 64-char hex — got "${remotePubkey}"`,
    )
  }
  const relays = queryParamValues(url.search, 'relay').map(normalizeRelay)
  if (relays.length === 0) {
    throw new Nip46Error(
      'invalid-uri',
      'NIP-46: bunker URI needs at least one relay= parameter, e.g. ?relay=wss://…',
    )
  }
  // `|| undefined`: `?secret=` is an absent secret, not an empty one.
  const secret = queryParamValues(url.search, 'secret')[0] || undefined
  return { remotePubkey, relays, secret }
}

export interface BunkerSignerOptions {
  /** The full `bunker://` token from `SCRUTINY_SIGNER_URI`. */
  readonly uri: string
  /** Injected by A4 (WebSocket) or by tests (in-memory fake). */
  readonly transport: RelayTransport
  /**
   * The NIP-44 *local* private key; generated when omitted. ECDH pairs it with the bunker's
   * `remotePubkey` — the same direction as `nostr-tools.getConversationKey(sec, pub)` and nak's
   * `computeConversationKey(sec, remote)`. Never leaves this process.
   */
  readonly localSecretKey?: Uint8Array
  /** Sent as `optional_client_metadata.name`, so the bunker UI can label the approval prompt. */
  readonly appName?: string
  /** Per-RPC deadline. A human approval can be slow; 60 s is the default. */
  readonly requestTimeoutMs?: number
}

/** What the facade and A4 see: the signer's identity plus the D13 `sign` shape, now async. */
export interface BunkerSigner {
  /** The signer daemon's pubkey, not the user's. */
  readonly remotePubkey: string
  /** The user pubkey the bunker reports from `get_public_key`. */
  readonly publicKey: string
  sign(template: UnsignedEvent): Promise<NostrEvent>
  /** Unsubscribe, fail in-flight requests, and close the relay socket. Idempotent. */
  close(): void
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (result: string) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/**
 * Connect, authorize, and learn the user pubkey. The returned signer round-trips every template
 * through `sign_event`; nothing is cached, so a bunker-side approval cannot be replayed silently.
 */
export async function createBunkerSigner(options: BunkerSignerOptions): Promise<BunkerSigner> {
  const bunker = parseBunkerUri(options.uri)
  const relayUrl = bunker.relays[0]
  if (relayUrl === undefined) {
    // parseBunkerUri already guarantees one; this keeps `noUncheckedIndexedAccess` honest.
    throw new Nip46Error('invalid-uri', 'NIP-46: bunker URI has no relay')
  }
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const localSecretKey = options.localSecretKey ?? randomBytes(32)
  const remotePubkeyBytes = hexToBytes(bunker.remotePubkey)
  let conversationKey: Uint8Array
  try {
    conversationKey = getConversationKey(localSecretKey, remotePubkeyBytes)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Nip46Error(
      'invalid-uri',
      `NIP-46: bunker URI host ${bunker.remotePubkey} is not a valid secp256k1 pubkey (${reason})`,
    )
  }
  const client = createDevKeySigner(localSecretKey)

  const socket: RelaySocket = await options.transport.connect(relayUrl)
  const pending = new Map<string, PendingRequest>()
  let closed = false

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  /**
   * A kind-24133 event addressed to this client but authored by anyone except the configured
   * bunker cannot be decrypted with the conversation key, so it cannot be attributed to a pending
   * request. It is recorded and merely enriches the next timeout: rejecting every in-flight request
   * on an unauthenticated frame would let any relay observer who saw the client pubkey fail a
   * legitimate signing round-trip at will.
   */
  let unexpectedAuthor: string | undefined
  let undecryptableFromBunker = false

  function handleEvent(value: unknown): void {
    if (!verifySignedEvent(value)) return
    if (value.kind !== NIP46_KIND) return
    if (!tagValues(value, 'p').includes(client.publicKey)) return
    if (value.pubkey !== bunker.remotePubkey) {
      unexpectedAuthor = value.pubkey
      return
    }

    let envelope: z.infer<typeof RpcResponse>
    try {
      envelope = RpcResponse.parse(JSON.parse(decrypt(value.content, conversationKey)))
    } catch {
      // Authenticated author, but the ciphertext does not open with the conversation key. Record
      // it so a timeout can say "wrong key" instead of "bunker asleep"; the request id is inside
      // the ciphertext, so guessing which pending request it belonged to could fail the wrong one.
      undecryptableFromBunker = true
      return
    }

    const request = pending.get(envelope.id)
    if (request === undefined) return
    pending.delete(envelope.id)
    clearTimeout(request.timer)

    if (envelope.result === 'auth_url' && envelope.error !== undefined) {
      request.reject(
        new Nip46Error(
          'auth-required',
          `NIP-46: bunker requires interactive authorization — open ${envelope.error} in the bunker’s own UI, approve, then retry`,
        ),
      )
      return
    }
    if (envelope.error !== undefined) {
      request.reject(
        new Nip46Error(
          'bunker-error',
          `NIP-46: ${request.method} failed in the bunker: ${envelope.error}`,
        ),
      )
      return
    }
    if (envelope.result === undefined) {
      request.reject(
        new Nip46Error(
          'invalid-response',
          `NIP-46: ${request.method} response carried neither a result nor an error`,
        ),
      )
      return
    }
    request.resolve(envelope.result)
  }

  const subscriptionId = `nip46-${bytesToHex(randomBytes(8))}`

  const unsubscribe = socket.onMessage((frame) => {
    switch (frame[0]) {
      case 'EVENT':
        handleEvent(frame[2])
        break
      case 'CLOSED':
        if (frame[1] === subscriptionId) {
          rejectAll(
            new Nip46Error(
              'relay-closed',
              `NIP-46: relay ${relayUrl} closed the subscription: ${String(frame[2] ?? '')}`,
            ),
          )
        }
        break
      default:
        // EOSE, NOTICE, OK, AUTH: not part of the NIP-46 exchange. AUTH-only relays will surface
        // as a connect timeout, which names the relay in its message.
        break
    }
  })

  /** Unsubscribe, fail in-flight requests, and close the socket — once, whatever the exit path. */
  function teardown(): void {
    if (closed) return
    closed = true
    unsubscribe()
    rejectAll(new Nip46Error('closed', 'NIP-46: signer was closed'))
    try {
      socket.send(JSON.stringify(['CLOSE', subscriptionId]))
    } catch {
      // The socket may already be gone; `close()` below is the actual teardown.
    }
    socket.close()
  }

  function sendRequest(method: string, params: readonly string[]): Promise<string> {
    if (closed) return Promise.reject(new Nip46Error('closed', 'NIP-46: signer is closed'))
    const id = bytesToHex(randomBytes(8))
    const content = encrypt(JSON.stringify({ id, method, params }), conversationKey)
    const event = client.sign({
      kind: NIP46_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', bunker.remotePubkey]],
      content,
    })
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const timer = setTimeout(() => {
      pending.delete(id)
      const timeoutReason: Nip46FailureReason =
        unexpectedAuthor === undefined ? 'timeout' : 'unexpected-author'
      reject(
        new Nip46Error(
          timeoutReason,
          [
            `NIP-46: ${method} timed out after ${timeoutMs} ms on ${relayUrl} — is the bunker running, connected to that relay, and authorized for this client?`,
            ...(unexpectedAuthor === undefined
              ? []
              : [
                  `A kind-24133 response addressed to this client was authored by ${unexpectedAuthor}, not the configured bunker ${bunker.remotePubkey} — check SCRUTINY_SIGNER_URI.`,
                ]),
            ...(undecryptableFromBunker
              ? [
                  'A response from the configured bunker did not decrypt with the NIP-44 conversation key — the URI pubkey and the local secret may belong to different keypairs.',
                ]
              : []),
          ].join(' '),
        ),
      )
    }, timeoutMs)
    pending.set(id, { method, resolve, reject, timer })
    try {
      socket.send(JSON.stringify(['EVENT', event]))
    } catch (cause) {
      pending.delete(id)
      clearTimeout(timer)
      const reason = cause instanceof Error ? cause.message : String(cause)
      reject(
        new Nip46Error(
          'send-failed',
          `NIP-46: failed to publish ${method} to ${relayUrl}: ${reason}`,
        ),
      )
    }
    return promise
  }

  const connectParams = [bunker.remotePubkey]
  if (bunker.secret !== undefined) connectParams.push(bunker.secret)
  if (options.appName !== undefined) {
    // Positions: [remote, secret?, perms?, metadata?]. An empty secret/perms slot is how the
    // metadata reaches position four without inventing a permission grant.
    if (bunker.secret === undefined) connectParams.push('')
    connectParams.push('')
    connectParams.push(JSON.stringify({ name: options.appName }))
  }

  try {
    // Direction matters: *requests* are p-tagged to the remote signer; *responses* are p-tagged
    // to the client pubkey (NIP-46 "Response Events"), so that is what this client subscribes to.
    // The filter cannot be trusted to be enforced by the relay; handleEvent re-checks both `#p`
    // and `authors`, so a filter-ignoring relay still cannot inject an event the client acts on.
    socket.send(
      JSON.stringify([
        'REQ',
        subscriptionId,
        { kinds: [NIP46_KIND], authors: [bunker.remotePubkey], '#p': [client.publicKey] },
      ]),
    )
    const connectResult = await sendRequest('connect', connectParams)
    // `nak bunker` answers "ack" when the presented secret is authorized (or the user approves);
    // it answers with the secret itself in the client-initiated flow. Both mean "authorized".
    if (connectResult !== 'ack' && connectResult !== bunker.secret) {
      throw new Nip46Error(
        'connect-refused',
        `NIP-46: bunker refused connect — expected "ack"${bunker.secret === undefined ? '' : ' or the URI secret'}, got ${JSON.stringify(connectResult).slice(0, 120)}. A bunker:// secret is single-use: nak rotates it after the first successful connection, so re-copy the URI`,
      )
    }

    // Only a signed kind-24133 event whose content opens with this conversation key reaches
    // `sendRequest` with a result. There is no plaintext `get_public_key` path: a bare hex string
    // in an event content fails NIP-44 decryption in handleEvent and is dropped, never adopted.
    const userPubkey = await sendRequest('get_public_key', [])
    if (!HEX64.test(userPubkey)) {
      // Length only: never echo bunker-controlled content into a host-visible error.
      throw new Nip46Error(
        'invalid-response',
        `NIP-46: get_public_key response is not a 64-char hex pubkey (${userPubkey.length} chars) — refusing it`,
      )
    }

    async function sign(template: UnsignedEvent): Promise<NostrEvent> {
      // Same guard as the dev-key path: never spend a human approval on an event the relay's
      // freshness gate will reject (relay/internal/relay/relay.go, relay/README.md).
      try {
        assertCreatedAtWithinRelayWindow(template.created_at)
      } catch (cause) {
        throw new Nip46Error(
          'stale-template',
          cause instanceof Error ? cause.message : 'created_at outside the relay window',
          { cause },
        )
      }
      const result = await sendRequest('sign_event', [JSON.stringify(template)])
      let parsed: unknown
      try {
        parsed = JSON.parse(result)
      } catch {
        throw new Nip46Error(
          'invalid-response',
          'NIP-46: sign_event returned a result that is not JSON',
        )
      }
      if (!verifySignedEvent(parsed)) {
        throw new Nip46Error(
          'tampered',
          'NIP-46: sign_event returned an event whose id or signature does not verify — ' +
            'refusing it (the relay or bunker altered it in flight)',
        )
      }
      if (parsed.pubkey !== userPubkey) {
        throw new Nip46Error(
          'wrong-user-key',
          `NIP-46: sign_event returned an event signed by ${parsed.pubkey}, but the connected ` +
            `user key is ${userPubkey} — refusing it`,
        )
      }
      if (
        parsed.kind !== template.kind ||
        parsed.created_at !== template.created_at ||
        parsed.content !== template.content ||
        JSON.stringify(parsed.tags) !== JSON.stringify(template.tags)
      ) {
        // No event content in the message: it is bunker-controlled text and this error can be
        // rendered by a host. kind + created_at identify the template without echoing it.
        throw new Nip46Error(
          'tampered',
          [
            'NIP-46: sign_event returned an event that does not match the requested template',
            `(kind ${template.kind}, created_at ${template.created_at}) — content or tags changed`,
            'inside the bunker',
          ].join(' '),
        )
      }
      return parsed
    }

    return {
      remotePubkey: bunker.remotePubkey,
      publicKey: userPubkey,
      sign,
      close: teardown,
    }
  } catch (error) {
    // A failed handshake must not leak a socket or a live subscription; success hands both to the
    // returned signer's `close()`.
    teardown()
    throw error
  }
}
