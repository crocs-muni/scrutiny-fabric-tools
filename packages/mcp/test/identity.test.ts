import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { signerStatus } from '../src/identity.ts'

/** 32 × 0x01 — a valid secp256k1 scalar; the pubkey below is its BIP-340 x-only key. */
const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'

/** A second valid scalar as a bech32 `nsec1…` key (decodes to 67dea2ed…, not the hex vector). */
const NSEC_KEY = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'
const NSEC_PUBKEY = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'

describe('signerStatus', () => {
  it('reports no signer when nothing is configured', () => {
    const status = signerStatus(loadConfig({}))
    expect(status.mode).toBe('none')
    expect(status.pubkey).toBeUndefined()
    expect(status.detail).toMatch(/^none — set SCRUTINY_SIGNER_URI/u)
  })

  it('derives the x-only pubkey from a hex dev key', () => {
    const status = signerStatus(loadConfig({ NSEC: HEX_KEY }))
    expect(status).toStrictEqual({
      mode: 'dev-key',
      pubkey: HEX_PUBKEY,
      detail: 'dev-key (NSEC) — dev-grade only; the pilot path is a NIP-46 bunker (#108)',
    })
  })

  it('derives the pubkey from an nsec1 dev key', () => {
    expect(signerStatus(loadConfig({ NSEC: NSEC_KEY })).pubkey).toBe(NSEC_PUBKEY)
  })

  it('prefers the bunker and never echoes its secret param', () => {
    const secret = 'top-secret-bunker-token'
    const signerUri = `bunker://${'ab'.repeat(32)}?relay=wss://relay.example&secret=${secret}`
    const status = signerStatus(loadConfig({ SCRUTINY_SIGNER_URI: signerUri, NSEC: HEX_KEY }))
    expect(status.mode).toBe('nip46')
    expect(status.pubkey).toBeUndefined()
    expect(status.detail).not.toContain(secret)
    expect(signerUri).toContain(secret)
  })

  it('rejects a dev key that is a valid hex64 but not a scalar', () => {
    expect(() => signerStatus(loadConfig({ NSEC: '00'.repeat(32) }))).toThrow(
      /not a valid secp256k1 secret/u,
    )
  })

  it('never echoes key material when the bech32 checksum fails', () => {
    // Config shape-check passes (nsec1 + bech32 charset); the checksum is the first failure.
    // @scure/base names the input string in its error — the string IS the key (#108 review).
    const corrupted = `nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe0`
    let message = ''
    try {
      signerStatus(loadConfig({ NSEC: corrupted }))
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).not.toBe('')
    expect(message).not.toContain(corrupted)
    expect(message).not.toContain('nsec1vl029')
    expect(message).toMatch(/mistyped or truncated/u)
  })

  it('pilot mode ignores dev material entirely (no startup failure, no key in memory)', () => {
    const signerUri = `bunker://${'ab'.repeat(32)}?relay=wss://relay.example&secret=tok`
    const config = loadConfig({
      SCRUTINY_SIGNER_URI: signerUri,
      NSEC: HEX_KEY,
      NSEC_FILE: 'definitely-not-a-file',
    })
    expect(config.devKey).toBeUndefined()
    expect(signerStatus(config).mode).toBe('nip46')
  })
})
