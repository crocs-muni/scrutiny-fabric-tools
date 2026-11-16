/**
 * The approval summary (spec §7.1), rendered by the server from the template graph, never from
 * agent text, and the chat-fallback approval code (§7).
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { TemplateGraph } from '../plan/draft.js'

const MAX_PRODUCTS = 5

/**
 * Six characters derived from the plan hash. It proves only that the agent called publish_plan
 * twice for the same plan (§7): the Level 1 chat fallback, stated openly in the spec.
 */
export function approvalCode(planHash: string): string {
  return bytesToHex(sha256(utf8ToBytes(`scrutiny-approval:${planHash}`)))
    .slice(0, 6)
    .toUpperCase()
}

function typeOf(event: TemplateGraph['events'][number]): string {
  return event.ref.slice(0, event.ref.indexOf(':'))
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function renderSummary(opts: {
  readonly graph: TemplateGraph
  readonly npub: string
  readonly planHash: string
  readonly planPath: string
  /** Events already acked in earlier calls (§7.3); 0 for a fresh run. */
  readonly published: number
}): string {
  const { graph } = opts
  const count = (type: string) => graph.events.filter((e) => typeOf(e) === type).length
  const total = graph.events.length
  const uploads = graph.blobs.filter((b) => b.via === 'upload')
  const urls = graph.blobs.length - uploads.length
  const megabytes = (uploads.reduce((sum, b) => sum + b.size, 0) / 1e6).toFixed(1)

  const products = graph.events.filter((e) => typeOf(e) === 'product')
  const productLines = products.slice(0, MAX_PRODUCTS).map((e) => {
    const headline = e.content.split('\n')[0] ?? ''
    const indexers = e.tags.filter((t) => t[0] === 'i').map((t) => t[1])
    return `  - ${headline}   [${indexers.join(', ')}]`
  })
  if (products.length > MAX_PRODUCTS)
    productLines.push(`  … and ${products.length - MAX_PRODUCTS} more`)

  return [
    `Publish to SCRUTINY Fabric as ${opts.npub}`,
    `Relays: ${graph.relays.map((r, i) => `${r} (${i === 0 ? 'primary' : 'mirror'})`).join(', ')}`,
    `Events: ${plural(count('profile'), 'profile', 'profiles')} · ${plural(count('product'), 'product', 'products')} · ${count('metadata')} metadata · ${plural(count('binding'), 'binding', 'bindings')} = ${total}`,
    `Files:  ${plural(uploads.length, 'upload', 'uploads')} (${megabytes} MB) · ${plural(urls, 'verified URL', 'verified URLs')}`,
    'Products:',
    ...productLines,
    ...(opts.published > 0
      ? [`${opts.published} of ${total} already published; ${total - opts.published} remaining.`]
      : []),
    'These are permanent and public. Indexers and files cannot be changed later.',
    `Full plan: ${opts.planPath}`,
    `Plan hash: ${opts.planHash}`,
  ].join('\n')
}
