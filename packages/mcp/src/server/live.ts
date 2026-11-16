/**
 * The real ports behind `ServerDeps`: OS keystore signer, live relays, Blossom on the primary.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureBlob } from '../artifacts/blossom.js'
import { RelayClient } from '../relay/client.js'
import { liveDraftNetwork } from '../relay/network.js'
import { RelayConnection } from '../relay/socket.js'
import { identityPath } from '../signer/identity.js'
import { KeystoreSigner, osKeystore, osKeystoreAvailable, signerStatus } from '../signer/signer.js'
import type { ServerDeps } from './server.js'

export function liveDeps(): ServerDeps {
  const identity = identityPath(process.platform, process.env, homedir())
  const signer = new KeystoreSigner({ identityPath: identity, store: osKeystore })
  const now = () => Math.floor(Date.now() / 1000)
  return {
    signer,
    signerStatus: () =>
      signerStatus({ identityPath: identity, keystoreAvailable: osKeystoreAvailable }),
    network: liveDraftNetwork({ fetch: globalThis.fetch, signer, now }),
    primary: (url) => new RelayClient({ url, signer, now }),
    // Mirrors get one attempt per event and no resends (spec §8.6).
    mirror: (url) => {
      let connection: Promise<RelayConnection> | null = null
      return {
        publish: async (event) => {
          connection ??= RelayConnection.open({ url, signer, now })
          return (await connection).publish(event)
        },
        close: () => {
          connection?.then(
            (c) => c.close(),
            () => {},
          )
        },
      }
    },
    uploadBlob: (primary, root, upload) =>
      ensureBlob({
        primary,
        blob: upload,
        bytes: async () => new Uint8Array(await readFile(join(root, upload.path))),
        signer,
        now,
        fetch: globalThis.fetch,
      }),
    now,
    clock: Date.now,
  }
}
