import type { NostrEvent, UnsignedEvent } from '@crocs-muni/scrutiny-fabric'
import { hexToBytes } from '@noble/hashes/utils.js'
import { signEvent } from '../src/signer/event.js'
import { publicKeyHex } from '../src/signer/keys.js'
import type { SignerPort } from '../src/signer/signer.js'

/** A signer over a fixed test key that records every template it signs. */
export function testSigner(secretHex = '01'.repeat(32)): SignerPort & { calls: UnsignedEvent[] } {
  const secret = hexToBytes(secretHex)
  const calls: UnsignedEvent[] = []
  return {
    calls,
    publicKey: async () => publicKeyHex(secret),
    sign: async (template): Promise<NostrEvent> => {
      calls.push(template)
      return signEvent(template, secret)
    },
  }
}

/** A signed kind-1 event to publish in relay tests. */
export function sampleEvent(content = 'hello', createdAt = 1_800_000_000): NostrEvent {
  return signEvent(
    { kind: 1, created_at: createdAt, tags: [['t', 'scrutiny-fabric']], content },
    hexToBytes('01'.repeat(32)),
  )
}
