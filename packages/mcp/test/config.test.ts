import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_RELAY_URL, loadConfig } from '../src/config.ts'

/** Byte-for-byte valid dev key material (never used to sign anything here). */
const HEX_KEY = '01'.repeat(32)
/** The same 32 bytes, bech32-encoded as an `nsec1…` key. */
const NSEC_KEY = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
  scratch.push(dir)
  const file = join(dir, name)
  writeFileSync(file, contents, 'utf8')
  return file
}

const HEX_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const KEYRING_URI = `keyring://scrutiny-fabric/${HEX_PUBKEY}`

describe('loadConfig', () => {
  it('defaults to the public relay and no signer', () => {
    expect(loadConfig({})).toStrictEqual({
      relayUrl: DEFAULT_RELAY_URL,
      signer: undefined,
      localKey: undefined,
    })
  })

  it('reads the key from the injected OS store under the identity the URI names', () => {
    const calls: Array<[string, string]> = []
    const config = loadConfig({ SCRUTINY_SIGNER: KEYRING_URI }, (service, account) => {
      calls.push([service, account])
      return HEX_KEY
    })
    // The account IS the pubkey: a label could not prove which key the entry holds.
    expect(calls).toEqual([['scrutiny-fabric', HEX_PUBKEY]])
    expect(config.signer).toStrictEqual({
      kind: 'keyring',
      service: 'scrutiny-fabric',
      account: HEX_PUBKEY,
    })
    expect(config.localKey).toStrictEqual({
      material: HEX_KEY,
      form: 'hex',
      source: 'keyring',
      expectPubkey: HEX_PUBKEY,
    })
  })

  it('prefers the named identity over NSEC and reports a missing entry without echoing it', () => {
    const config = loadConfig(
      { SCRUTINY_SIGNER: KEYRING_URI, NSEC: 'cd'.repeat(32) },
      () => HEX_KEY,
    )
    expect(config.localKey?.source).toBe('keyring')

    expect(() => loadConfig({ SCRUTINY_SIGNER: KEYRING_URI }, () => null)).toThrow(
      /SCRUTINY_SIGNER/u,
    )
    expect(() => loadConfig({ SCRUTINY_SIGNER: KEYRING_URI }, () => '   ')).toThrow(
      /not in the OS secret store/u,
    )
    expect(() =>
      loadConfig({ SCRUTINY_SIGNER: 'keyring://scrutiny-fabric' }, () => HEX_KEY),
    ).toThrow(/needs a service and an identity/u)
    expect(() =>
      loadConfig({ SCRUTINY_SIGNER: 'keyring://scrutiny-fabric/publisher' }, () => HEX_KEY),
    ).toThrow(/must be the identity it holds/u)
  })

  it('treats a store read failure as an outage, not a silent miss', () => {
    const boom = () => {
      throw new Error('keyring locked')
    }
    expect(() => loadConfig({ SCRUTINY_SIGNER: KEYRING_URI }, boom)).toThrow(/OS secret store/u)
  })

  it('does not touch the store when a signer daemon is configured', () => {
    const config = loadConfig(
      { SCRUTINY_SIGNER: `bunker://${'ab'.repeat(32)}?relay=wss://relay.example&secret=t` },
      () => {
        throw new Error('must not be read')
      },
    )
    expect(config.localKey).toBeUndefined()
  })

  it('normalises the relay URL to an endpoint without a trailing slash', () => {
    expect(loadConfig({ SCRUTINY_RELAY_URL: 'ws://127.0.0.1:7777/' }).relayUrl).toBe(
      'ws://127.0.0.1:7777',
    )
  })

  it('rejects a non-WebSocket relay URL', () => {
    expect(() => loadConfig({ SCRUTINY_RELAY_URL: 'https://relay.example' })).toThrow(ConfigError)
    expect(() => loadConfig({ SCRUTINY_RELAY_URL: 'https://relay.example' })).toThrow(
      /SCRUTINY_RELAY_URL: must be ws:\/\/ \(local relay\) or wss:\/\//u,
    )
  })

  it('accepts a NIP-46 bunker URI as the signer plan', () => {
    const uri = `bunker://${'ab'.repeat(32)}?relay=wss://relay.example`
    expect(loadConfig({ SCRUTINY_SIGNER: uri }).signer).toStrictEqual({ kind: 'bunker', uri })
  })

  it('rejects a signer scheme it cannot honour', () => {
    expect(() => loadConfig({ SCRUTINY_SIGNER: 'nostrconnect://abc' })).toThrow(
      /unsupported scheme nostrconnect:\/\//u,
    )
  })

  it('accepts hex and nsec1 dev keys, normalising hex case', () => {
    expect(loadConfig({ NSEC: HEX_KEY }).localKey).toStrictEqual({
      material: HEX_KEY,
      form: 'hex',
      source: 'env',
    })
    expect(loadConfig({ NSEC: NSEC_KEY }).localKey).toStrictEqual({
      material: NSEC_KEY,
      form: 'nsec1',
      source: 'env',
    })
    expect(loadConfig({ NSEC: HEX_KEY.toUpperCase() }).localKey?.material).toBe(HEX_KEY)
  })

  it('rejects junk key material without echoing it', () => {
    const junk = 'definitely-not-a-key'
    let error: unknown
    try {
      loadConfig({ NSEC: junk })
    } catch (cause) {
      error = cause
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variable).toBe('NSEC')
    // The message reaches terminals and agent transcripts: a secret echoed once is leaked.
    expect((error as ConfigError).message).not.toContain(junk)
  })

  it('reads NSEC_FILE and reports its source', () => {
    const file = tempFile('nsec.txt', `${HEX_KEY}\n`)
    expect(loadConfig({ NSEC_FILE: file }).localKey).toStrictEqual({
      material: HEX_KEY,
      form: 'hex',
      source: 'file',
    })
  })

  it('rejects an empty NSEC_FILE', () => {
    const file = tempFile('nsec.txt', '   \n')
    expect(() => loadConfig({ NSEC_FILE: file })).toThrow(/NSEC_FILE: .* is empty/u)
  })

  it('rejects NSEC_AGE_FILE instead of silently ignoring it', () => {
    expect(() => loadConfig({ NSEC_AGE_FILE: 'key.age' })).toThrow(
      /NSEC_AGE_FILE: age-encrypted keys are unsupported/u,
    )
  })
})
