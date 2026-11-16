/**
 * The live `DraftNetwork`: NIP-11 and Blossom probe, publisher-URL download, and a kind-0 lookup.
 * All reads; the signer is only handed to the connection type, which never authenticates a read.
 */

import { verifyUrl } from '../artifacts/url.js'
import type { DraftNetwork } from '../plan/draft.js'
import type { SignerPort } from '../signer/signer.js'
import { probeRelay } from './nip11.js'
import { RelayConnection } from './socket.js'

export function liveDraftNetwork(deps: {
  readonly fetch: typeof fetch
  readonly signer: SignerPort
  /** Unix seconds; the signer's clock, so the skew measured is the skew events will have. */
  readonly now: () => number
}): DraftNetwork {
  return {
    probeRelay: async (url) => {
      const probe = await probeRelay(url, deps)
      if (!probe.reachable) return probe
      // Spec §6.5: NIP-11 *or* the WebSocket failing makes the relay unreachable.
      try {
        ;(await RelayConnection.open({ url, signer: deps.signer, now: deps.now })).close()
        return probe
      } catch {
        return { reachable: false, message: 'NIP-11 answered but the WebSocket did not connect' }
      }
    },
    verifyUrl: (url, x) => verifyUrl(url, x, deps),
    profilePublished: async (relay, pubkey) => {
      let connection: RelayConnection | undefined
      try {
        connection = await RelayConnection.open({ url: relay, signer: deps.signer, now: deps.now })
        const events = await connection.query({ kinds: [0], authors: [pubkey], limit: 1 })
        return events.some((e) => e.kind === 0 && e.pubkey === pubkey)
      } catch {
        return null
      } finally {
        connection?.close()
      }
    },
  }
}
