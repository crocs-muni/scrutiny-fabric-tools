import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A fresh data folder holding `files` (relative path → contents). */
export function makeRoot(files: Readonly<Record<string, string | Uint8Array>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'scrutiny-mcp-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

export const PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
export const PRIMARY = 'wss://relay.example'

export const PRODUCT = {
  ref: 'product:ex-100',
  type: 'product',
  headline: 'Example Corp EX-100 secure element',
  bullets: ['RISC-V core with hardware crypto accelerator'],
  links: ['https://example.com/ex-100'],
  indexers: ['vendor:example-corp', 'part:EX-100'],
  card: { vendor: 'Example Corp', part: 'EX-100' },
  sources: ['datasheets/ex-100.pdf'],
} as const

export const METADATA = {
  ref: 'metadata:fi-test',
  type: 'metadata',
  subtype: 'test',
  headline: 'EX-100 fault-injection evaluation EX-FI-2026-01',
  bullets: ['Laser fault injection on the boot ROM'],
  indexers: ['part:EX-100', 'test:EX-FI-2026-01'],
  identifier: 'EX-FI-2026-01',
  artifacts: [{ path: 'reports/fi.pdf', alt: 'FI evaluation (PDF)' }],
  bind_to: [{ ref: 'product:ex-100', label: 'Fault-injection test' }],
  sources: ['reports/fi.pdf'],
} as const

export const PROFILE = {
  ref: 'profile:me',
  type: 'profile',
  name: 'examplecorp',
  display_name: 'Example Corp',
  about: 'Secure-element vendor.',
} as const

export const FILES = {
  'datasheets/ex-100.pdf': 'datasheet',
  'reports/fi.pdf': 'report bytes',
} as const

export function plan(records: readonly unknown[], relays: readonly string[] = [PRIMARY]) {
  return { planVersion: 1, relays, records }
}
