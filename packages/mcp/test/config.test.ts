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

describe('loadConfig', () => {
  it('defaults to the public relay and no signer', () => {
    expect(loadConfig({})).toStrictEqual({
      relayUrl: DEFAULT_RELAY_URL,
      signerUri: undefined,
      devKey: undefined,
    })
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

  it('accepts a NIP-46 bunker URI', () => {
    const uri = `bunker://${'ab'.repeat(32)}?relay=wss://relay.example`
    expect(loadConfig({ SCRUTINY_SIGNER_URI: uri }).signerUri).toBe(uri)
  })

  it('rejects a signer URI that is not a bunker', () => {
    expect(() => loadConfig({ SCRUTINY_SIGNER_URI: 'nostrconnect://abc' })).toThrow(
      /SCRUTINY_SIGNER_URI: must be a bunker:\/\/ URI \(NIP-46\)/u,
    )
  })

  it('accepts hex and nsec1 dev keys, normalising hex case', () => {
    expect(loadConfig({ NSEC: HEX_KEY }).devKey).toStrictEqual({
      material: HEX_KEY,
      form: 'hex',
      source: 'NSEC',
    })
    expect(loadConfig({ NSEC: NSEC_KEY }).devKey).toStrictEqual({
      material: NSEC_KEY,
      form: 'nsec1',
      source: 'NSEC',
    })
    expect(loadConfig({ NSEC: HEX_KEY.toUpperCase() }).devKey?.material).toBe(HEX_KEY)
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
    expect(loadConfig({ NSEC_FILE: file }).devKey).toStrictEqual({
      material: HEX_KEY,
      form: 'hex',
      source: 'NSEC_FILE',
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
