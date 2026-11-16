/**
 * The non-secret identity file (spec §11.2): `status` and `draft_plan` read the npub from here, so
 * neither touches the keystore.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { npubEncode } from './keys.js'

export interface Identity {
  readonly pubkey: string
  readonly npub: string
}

/** `%APPDATA%\scrutiny\identity.json` on Windows, `~/.config/scrutiny/identity.json` elsewhere. */
export function identityPath(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const { APPDATA: appData } = env
  const base = platform === 'win32' && appData !== undefined ? appData : join(home, '.config')
  return join(base, 'scrutiny', 'identity.json')
}

/** The stored identity, or null when the file is missing or does not hold a valid pubkey. */
export async function readIdentity(path: string): Promise<Identity | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    const { pubkey } = JSON.parse(raw) as { pubkey?: unknown }
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/u.test(pubkey)) return null
    return { pubkey, npub: npubEncode(pubkey) }
  } catch {
    return null
  }
}

/** Writes atomically (temp file + rename), so a crash never leaves a half-written identity. */
export async function writeIdentity(path: string, pubkey: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = `${JSON.stringify({ version: 1, pubkey, npub: npubEncode(pubkey) }, null, 2)}\n`
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, path)
}
