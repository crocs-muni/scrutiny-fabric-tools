# Reference Signer Example

A copy-paste reference implementation of a Nostr signer for the SCRUTINY Fabric protocol, using [@noble/curves](https://github.com/paulmillr/noble-curves) and [@noble/hashes](https://github.com/paulmillr/noble-hashes).

## What this is

This example shows how to:
1. **Sign** unsigned event templates (`UnsignedEvent = {kind, created_at, tags, content}`) into full `NostrEvent` objects with `id`, `pubkey`, and `sig`.
2. **Verify** signed events by recomputing the NIP-01 id and checking the BIP-340 Schnorr signature.

The implementation plugs directly into `createStore({ verify: verifyEvent })` from `@scrutiny-fabric/core`.

## Why this is an example, not a package

- **D12**: The core packages (`packages/*/src`) must remain crypto-free. Signing requires secp256k1/Schnorr cryptography, which would violate that invariant.
- **D6**: Consumers should not be forced to depend on a specific crypto library. This is a reference you can copy, adapt, or replace entirely.
- **D13**: Core's `build.ts` emits *unsigned* templates; the signer injects `id`, `pubkey`, and `sig`.

Copy this folder out if you want to use it. Do not add it as a dependency.

## Install

```bash
pnpm add @noble/curves @noble/hashes
```

## Usage

### Basic signing

```ts
import { createSigner } from './noble-signer.js'
import { buildProduct } from '@scrutiny-fabric/core/build.js'

// Create a signer (generates a random key — for production, inject your own)
const signer = createSigner()

// Build an unsigned template
const { template } = buildProduct(
  '{"name":"My Product","version":"1.0.0"}',
  Date.now(),
  ['cpe:2.3:h:vendor:product:-:*:*:*:*:*:*:*']
)

// Sign it
const event = signer.sign(template)
console.log('Signed event:', event)
// { id: '...', pubkey: '...', sig: '...', kind: 1, created_at: ..., tags: [...], content: '...' }
```

### Verifying events in a store

```ts
import { createStore } from '@scrutiny-fabric/core/store.js'
import { verifyEvent } from './noble-signer.js'

const store = createStore({
  verify: verifyEvent, // Matches CreateStoreOptions.verify shape exactly
})

await store.add([event])
```

### Using your own secret key

```ts
import { createSigner, generateSecretKey, secretKeyToHex } from './noble-signer.js'

// Generate once and store securely (NEVER commit to version control!)
const sk = generateSecretKey()
const skHex = secretKeyToHex(sk)
console.log('Store this securely:', skHex)

// Later, inject it
const signer = createSigner(skHex)
```

## API

### `createSigner(secretKey?: string | Uint8Array)`

Create a signer instance.

- **`secretKey`**: 32-byte secret key as hex string or `Uint8Array`. If omitted, generates a fresh random key (ephemeral — not for production).
- **Returns**: `{ publicKey: string, sign(template: UnsignedEvent): NostrEvent }`

### `verifyEvent(event: NostrEvent): boolean`

Verify a signed event. Performs both SIG-1 checks:
1. Recompute the event id via `serializeForId` + SHA-256 and compare.
2. Verify the Schnorr signature over the id hash.

Matches `CreateStoreOptions.verify` shape exactly.

### `generateSecretKey(): Uint8Array`

Generate a fresh random 32-byte secret key. Ephemeral only.

### `secretKeyToHex(skBytes: Uint8Array): string`

Convert a raw secret key to hex string for storage/export.

## ⚠️ Security warnings

1. **Never put a secret key into core code.** The `@scrutiny-fabric/core` package is crypto-free by design (D12). Keys belong in your application layer, not in protocol logic.

2. **Never commit secret keys to version control.** The example generates ephemeral keys for convenience, but production usage requires secure key storage (environment variables, KMS, HSM, etc.).

3. **`created_at` is publish time, NOT fact time.** Historical facts go in `content`, not in `created_at` (CA-1).

## Testing

```bash
pnpm typecheck
pnpm test
```

Tests run with Node.js built-in test runner (no extra deps). They cover:
- Sign→verify round-trip
- Tampered content/pubkey/id detection
- Golden vector determinism check
- Edge cases (empty tags, complex nested tags)
