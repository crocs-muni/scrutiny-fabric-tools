#!/usr/bin/env node
/**
 * Put a publisher key in the platform keystore, under the identity it belongs to.
 *
 * The keystore account is the npub, not a label, because `SCRUTINY_SIGNER=keyring://…/<npub>`
 * is only a safety property if the entry lives under the identity it holds: the server reads the
 * key, derives its pubkey and refuses to start when the two disagree. Publishing under an
 * unintended identity is permanent, so this script is the place where that mistake is cheapest
 * to catch.
 *
 *   node scripts/store-key.mjs --new        generate a key, show it once, store it
 *   node scripts/store-key.mjs --import     read a key from stdin, store it
 *
 * Neither form passes key material on the command line: `--new` never has one to pass, and
 * `--import` reads stdin, which keeps the secret out of shell history and process arguments.
 */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'

const SERVICE = 'scrutiny-fabric'

const require = createRequire(import.meta.url)
const { Entry } = require('@napi-rs/keyring')

const HEX64 = /^[0-9a-f]{64}$/iu
const NSEC = /^nsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/u
const NCRYPTSEC = /^ncryptsec1/u

/**
 * What a human got wrong is almost never the key — it is the pipe: PowerShell can hand a native
 * program UTF-16 (null bytes between characters), a BOM, or a trailing blank line. Normalise those
 * before judging the value, and when the value still cannot be used, describe its shape instead of
 * echoing it, so the fix is obvious without the secret touching the screen.
 */
function normaliseInput(raw) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping exactly these two is the point.
  return raw.replace(/[\uFEFF\u0000]/gu, '').trim()
}

/** Describe a rejected value without disclosing it: length and the family it looks like. */
function describe(material) {
  const family = NCRYPTSEC.test(material)
    ? 'a NIP-49 encrypted key (ncryptsec1…)'
    : material.startsWith('nsec1')
      ? 'an nsec1… value with the wrong length'
      : material.startsWith('npub1')
        ? 'an npub1… public key (the public half, not the secret)'
        : 'neither hex nor bech32'
  return `${material.length} characters, ${family}`
}

function fail(message) {
  console.error(`store-key: ${message}`)
  process.exit(1)
}

/** Accept the two forms a publisher might hold; return the 32 secret bytes. */
function secretBytes(material) {
  const trimmed = normaliseInput(material)
  if (HEX64.test(trimmed)) return Uint8Array.from(Buffer.from(trimmed, 'hex'))
  if (NSEC.test(trimmed)) {
    let decoded
    try {
      decoded = bech32.decodeToBytes(trimmed)
    } catch {
      // The decoder names the offending string, and the string is the key.
      fail('that nsec1… value failed its checksum — check for a mistyped or truncated character')
    }
    if (decoded.prefix !== 'nsec') fail(`expected nsec1…, got ${decoded.prefix}1…`)
    return decoded.bytes
  }
  fail(
    `that value is ${describe(trimmed)} — expected 64-char hex or a bech32 nsec1… key (the value itself is never echoed)`,
  )
}

function npubOf(pubkeyHex) {
  return bech32.encode('npub', bech32.toWords(Buffer.from(pubkeyHex, 'hex')))
}

function hexOf(bytes) {
  return Buffer.from(bytes).toString('hex')
}

const mode = process.argv[2]
if (mode !== '--new' && mode !== '--import') {
  fail('usage: node scripts/store-key.mjs --new | --import')
}

/** Read all of stdin; the caller pipes a key in so it never touches argv or history. */
async function readStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write('paste the nsec or hex key, then press Enter and Ctrl+Z/Ctrl+D:\n')
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return normaliseInput(Buffer.concat(chunks).toString('utf8'))
}

/**
 * PowerShell's pipeline to a native program is the one fragile hop in this flow (encoding, BOM,
 * line endings). `SCRUTINY_KEY_IMPORT` is the escape hatch for that: a single variable in one
 * short-lived shell, cleared immediately after, instead of a byte stream whose encoding we do not
 * control. It is for import only — the server never reads a key from the environment.
 */
const fromEnv = process.env.SCRUTINY_KEY_IMPORT?.trim()
const material =
  mode === '--new'
    ? hexOf(randomBytes(32))
    : fromEnv !== undefined && fromEnv !== ''
      ? fromEnv
      : await readStdin()
if (material === '') fail('no key was read from stdin')
if (NCRYPTSEC.test(material)) {
  fail(
    'that is a NIP-49 encrypted key — decrypt it first (nak key decrypt), or pass the plaintext ' +
      'key; the passphrase never goes through this script',
  )
}

const secret = secretBytes(material)
const pubkeyHex = hexOf(schnorr.getPublicKey(secret))
const npub = npubOf(pubkeyHex)

// Store the form the operator supplied, so `keyring://…` and the entry agree byte for byte;
// a generated key is stored as hex.
new Entry(SERVICE, npub).setPassword(mode === '--new' ? hexOf(secret) : material)

console.log('\nstored in the platform keystore')
console.log(`  service: ${SERVICE}`)
console.log(`  account: ${npub}`)
console.log(`  pubkey:  ${pubkeyHex}`)
console.log('\npoint the server at it:\n')
console.log(`  SCRUTINY_SIGNER=keyring://${SERVICE}/${npub}\n`)

if (mode === '--new') {
  console.log('BACK THIS UP NOW — it is shown once and the keystore is not a backup:')
  console.log(`  nsec: ${bech32.encode('nsec', bech32.toWords(secret))}`)
  console.log(`  hex:  ${hexOf(secret)}`)
  console.log('\nuntil you store it somewhere safe, losing this machine loses the identity.\n')
} else {
  console.log('the key you pasted is already in your own backup; nothing was echoed here.\n')
}
