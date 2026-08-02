/**
 * Tests for noble-signer.ts.
 *
 * Uses Node.js built-in test runner with type-stripping (Node 22+).
 * No network, no relay I/O — pure unit tests.
 */

import { strict as assert } from 'node:assert'
import { before, describe, it } from 'node:test'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { utf8ToBytes } from '@noble/hashes/utils'
import type { NostrEvent, UnsignedEvent } from '@scrutiny-fabric/core/events.js'
import { serializeForId } from '@scrutiny-fabric/core/id.js'
import { createSigner, generateSecretKey, secretKeyToHex, verifyEvent } from './noble-signer.ts'

describe('noble-signer', () => {
  let signer: ReturnType<typeof createSigner>
  let fixedSk: Uint8Array
  let fixedSkHex: string

  before(() => {
    // Use a deterministic secret key for reproducible tests
    fixedSk = new Uint8Array(32)
    for (let i = 0; i < 32; i++) fixedSk[i] = i + 1
    fixedSkHex = secretKeyToHex(fixedSk)
    signer = createSigner(fixedSkHex)
  })

  it('sign→verify round-trip returns true', () => {
    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1700000000,
      tags: [['t', 'scrutiny-fabric']],
      content: 'test event',
    }
    const signed = signer.sign(template)
    assert.ok(verifyEvent(signed), 'verified event')
    assert.strictEqual(signed.pubkey, signer.publicKey)
    assert.ok(signed.sig.length > 0, 'signature present')
    assert.ok(signed.id.length === 64, 'id is 64 hex chars')
  })

  it('tampered content → verify false', () => {
    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1700000000,
      tags: [['t', 'scrutiny-fabric']],
      content: 'original',
    }
    const signed = signer.sign(template)
    // Tamper with content by creating a new event
    const tampered = { ...signed, content: 'tampered' }
    assert.strictEqual(verifyEvent(tampered), false, 'tampered content fails verification')
  })

  it('wrong pubkey → verify false', () => {
    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1700000000,
      tags: [['t', 'scrutiny-fabric']],
      content: 'test',
    }
    const signed = signer.sign(template)
    // Use a different pubkey by creating a new event
    const wrongSk = generateSecretKey()
    const withWrongPubkey = { ...signed, pubkey: bytesToHex(schnorr.getPublicKey(wrongSk)) }
    assert.strictEqual(verifyEvent(withWrongPubkey), false, 'wrong pubkey fails verification')
  })

  it('tampered id → verify false', () => {
    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1700000000,
      tags: [['t', 'scrutiny-fabric']],
      content: 'test',
    }
    const signed = signer.sign(template)
    // Tamper with id (flip one hex char) by creating a new event
    const tamperedId = `0${signed.id.slice(1)}`
    const withTamperedId = { ...signed, id: tamperedId }
    assert.strictEqual(verifyEvent(withTamperedId), false, 'tampered id fails verification')
  })

  it('golden vector test against known NIP-01/BIP-340 data', () => {
    // This test uses a fixed secret key and verifies that the computed id is stable.
    // The secret key is deterministic (bytes 0x01..0x20), so the id should be constant.
    // Note: Signatures are NOT deterministic by default (BIP-340 allows random nonces),
    // so we only check that the signature verifies, not that it's identical across runs.
    //
    // We verify that:
    // 1. The id is correctly computed as SHA-256(serializeForId(event))
    // 2. The signature verifies against that id and the public key
    // 3. Id and pubkey are deterministic (signature may vary due to random nonce)

    const skHex = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
    const testSigner = createSigner(skHex)

    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1234567890,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['t', 'scrutiny-v001'],
        ['t', 'scrutiny-product'],
        ['i', 'cpe:2.3:h:vendor:product:-:*:*:*:*:*:*:*'],
      ],
      content: '{"name":"Golden Product","version":"1.0.0"}',
    }

    const signed1 = testSigner.sign(template)
    const signed2 = testSigner.sign(template)

    // Determinism: id and pubkey are deterministic (signature may vary due to random nonce)
    assert.strictEqual(signed1.id, signed2.id, 'id is deterministic')
    assert.strictEqual(signed1.pubkey, signed2.pubkey, 'pubkey is deterministic')

    // Verify the id computation matches manual calculation
    // Need to include pubkey in serialization (same as what sign() does internally)
    const eventWithPubkey = { ...template, pubkey: signed1.pubkey } as NostrEvent
    const serialized = serializeForId(eventWithPubkey)
    const expectedId = bytesToHex(sha256(utf8ToBytes(serialized)))
    assert.strictEqual(
      signed1.id.toLowerCase(),
      expectedId.toLowerCase(),
      'id matches SHA-256 of serialized',
    )

    // Verify signature using low-level API
    // Note: Use serialized for hash, not event.id (see verifyEvent for explanation)
    const idHash = sha256(utf8ToBytes(serialized))
    const pubKeyBytes = hexToBytes(signed1.pubkey)
    const sigBytes = hexToBytes(signed1.sig)
    assert.ok(schnorr.verify(sigBytes, idHash, pubKeyBytes), 'BIP-340 verification passes')

    // High-level verifyEvent also passes
    assert.ok(verifyEvent(signed1), 'verifyEvent returns true')

    // Log the golden values for reference (id is stable, sig varies)
    // console.log('Golden test values:')
    // console.log('  Secret key:', skHex)
    // console.log('  Public key:', signed1.pubkey)
    // console.log('  Event id:', signed1.id)
    // console.log('  Signature:', signed1.sig)
  })

  it('generated secret key produces valid signer', () => {
    const sk = generateSecretKey()
    const skHex = secretKeyToHex(sk)
    const testSigner = createSigner(skHex)

    const template: UnsignedEvent = {
      kind: 1,
      created_at: Date.now(),
      tags: [],
      content: 'test',
    }

    const signed = testSigner.sign(template)
    assert.ok(verifyEvent(signed), 'event signed with generated key verifies')
    assert.strictEqual(signed.pubkey, testSigner.publicKey)
  })

  it('empty tags array signs correctly', () => {
    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1700000000,
      tags: [],
      content: 'no tags',
    }
    const signed = signer.sign(template)
    assert.ok(verifyEvent(signed), 'event with empty tags verifies')
  })

  it('complex nested tags sign correctly', () => {
    const template: UnsignedEvent = {
      kind: 1,
      created_at: 1700000000,
      tags: [
        ['t', 'scrutiny-fabric'],
        ['e', 'abc123', 'wss://relay.example.com', 'root', 'def456'],
        ['p', 'author123'],
        ['i', 'cve:CVE-2024-1234'],
        ['k', 'cve'],
      ],
      content: 'complex event with multiple tag types',
    }
    const signed = signer.sign(template)
    assert.ok(verifyEvent(signed), 'complex event verifies')
  })
})
