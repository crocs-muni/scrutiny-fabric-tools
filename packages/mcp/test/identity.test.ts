import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { signerStatus } from '../src/identity.ts'

/** 32 × 0x01 — a valid secp256k1 scalar; the pubkey below is its BIP-340 x-only key. */
const HEX_KEY = '01'.repeat(32)
const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'

/** The same scalar as a bech32 `nsec1…` key, to prove both dev forms decode identically. */
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
})
