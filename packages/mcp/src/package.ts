/** The package's own name and version, read from package.json so messages pin what is installed. */

import { createRequire } from 'node:module'

const manifest = createRequire(import.meta.url)('../package.json') as {
  readonly name: string
  readonly version: string
}

export const PACKAGE_NAME = manifest.name
export const PACKAGE_VERSION = manifest.version
/** The exact-version `npx` spec the CLI hints use (spec §13.2 pins exact versions). */
export const NPX_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`
