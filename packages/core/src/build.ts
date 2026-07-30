/**
 * Unsigned event templates — {kind, created_at, tags, content}. No `id`, no `pubkey`, no `sig` (D13):
 * those three are the injected signer's job.
 *
 * E4 (variable-length fences) and P1/P3/P4 (producer obligations unfalsifiable on receipt) are this
 * module's sole enforcement point. See `docs/QUERY-BUILD.md` §2 for the full design, including the
 * P2 double-listing note (§2.2) and why P4 is the one rule here with a real emission (§2.4).
 */

import { type Issue, issue } from './errors.js'
import { EVENT_TYPE_TAGS, FABRIC_TAG, parseIndexer } from './events.js'
import type { UnsignedEvent } from './events.js'
import { applyPatchContent, makePatch } from './patch.js'
import { VERSION_TAG } from './version.js'

/** Every SCRUTINY event uses this Nostr kind (§3). */
const SCRUTINY_KIND = 1

/** The result of every builder in this module. `issues` is always present (see the module doc). */
export interface BuildResult {
  readonly template: UnsignedEvent
  readonly issues: readonly Issue[]
}

const NO_ISSUES: readonly Issue[] = Object.freeze([])

function baseTags(type: 'product' | 'metadata' | 'binding' | 'patch'): string[][] {
  return [
    ['t', FABRIC_TAG],
    ['t', VERSION_TAG],
    ['t', EVENT_TYPE_TAGS[type]],
  ]
}

// ---------------------------------------------------------------------------
// Product / Metadata
// ---------------------------------------------------------------------------

export interface BuildIndexedOptions {
  /** Raw `i`-tag values, e.g. `"cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*"`. */
  readonly indexers?: readonly string[]
}

/** `k` tags derived from `indexers`' distinct prefixes (PR-4/MD-4) — never hand-supplied separately. */
function indexerTags(indexers: readonly string[]): string[][] {
  const iTags = indexers.map((raw) => ['i', raw])
  const prefixes = new Set<string>()
  for (const raw of indexers) {
    const parsed = parseIndexer(raw)
    if (parsed !== undefined) prefixes.add(parsed.prefix)
  }
  return [...iTags, ...[...prefixes].map((p) => ['k', p])]
}

function buildIndexedEvent(
  type: 'product' | 'metadata',
  content: string,
  createdAt: number,
  options: BuildIndexedOptions,
): BuildResult {
  return {
    template: {
      kind: SCRUTINY_KIND,
      created_at: createdAt,
      tags: [...baseTags(type), ...indexerTags(options.indexers ?? [])],
      content,
    },
    issues: NO_ISSUES,
  }
}

export function buildProduct(
  content: string,
  createdAt: number,
  options: BuildIndexedOptions = {},
): BuildResult {
  return buildIndexedEvent('product', content, createdAt, options)
}

export function buildMetadata(
  content: string,
  createdAt: number,
  options: BuildIndexedOptions = {},
): BuildResult {
  return buildIndexedEvent('metadata', content, createdAt, options)
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/** The `e`-tag shape §4.3's worked examples use: `["e", id, relay, marker, author_pk]`. */
export interface EndpointRef {
  readonly id: string
  /** BD-8: advisory relay hint. Omitted ⇒ `""` ("no hint"). */
  readonly relay?: string
  /** NIP-10 author hint (BD-12), advisory. Omitted ⇒ `""`. */
  readonly authorPubkey?: string
}

function endpointTag(marker: 'root' | 'link' | 'reply', ref: EndpointRef): string[] {
  return ['e', ref.id, ref.relay ?? '', marker, ref.authorPubkey ?? '']
}

export function buildBinding(
  root: EndpointRef,
  link: EndpointRef,
  content: string,
  createdAt: number,
): BuildResult {
  return {
    template: {
      kind: SCRUTINY_KIND,
      created_at: createdAt,
      tags: [...baseTags('binding'), endpointTag('root', root), endpointTag('link', link)],
      content,
    },
    issues: NO_ISSUES,
  }
}

// ---------------------------------------------------------------------------
// Patch — E4, P1, P3, P4
// ---------------------------------------------------------------------------

/**
 * Longest run of consecutive backticks anywhere in `payload` (E4). Scanned globally rather than
 * line-anchored — see `docs/QUERY-BUILD.md` §2.3 for why the wider scan is the correct conservative
 * choice rather than a re-derivation of CommonMark's closing-fence grammar.
 */
function longestBacktickRun(payload: string): number {
  let max = 0
  for (const run of payload.match(/`+/g) ?? []) max = Math.max(max, run.length)
  return max
}

/** E4 — `max(3, N + 1)`, where `N` is {@link longestBacktickRun}. */
export function fenceLength(payload: string): number {
  return Math.max(3, longestBacktickRun(payload) + 1)
}

/**
 * Wrap a unified-diff payload in a CommonMark fenced code block, choosing a fence long enough that
 * no embedded backtick run can close it early (E4). `payload` is assumed LF-terminated, which every
 * `makePatch` output is (verified against `diff@9.0.0` — including the zero-hunk no-op case).
 */
export function fencePatchPayload(payload: string, info = 'diff'): string {
  const fence = '`'.repeat(fenceLength(payload))
  return `${fence}${info}\n${payload}${fence}\n`
}

export interface BuildPatchOptions {
  /**
   * Context lines for `makePatch` (P1). Default 3 is P1's own enforcement point — leave it alone
   * except to exercise the zero-context shape in a test, exactly as `patch.ts`'s own `context`
   * parameter exists for.
   */
  readonly context?: number
}

/**
 * Build a Patch template carrying the unified diff from `before` to `after`.
 *
 * P4 (self-verification): after assembling `template.content`, this re-applies it via the same
 * fence-lookup-then-apply path a real consumer uses (`applyPatchContent`) and compares the result
 * against `after`. This is not always true — `before` content with repeated lines can make a hunk's
 * context genuinely ambiguous (T1), which `patch-property.test.ts`'s own gate already accepts as a
 * normal outcome — so a disagreement is reported as a `P4` warning rather than silently discarded;
 * the template is still returned, since P4 is a SHOULD and TR-1 forbids treating an A-layer rule as a
 * rejection.
 */
export function buildPatch(
  root: EndpointRef,
  reply: EndpointRef,
  before: string,
  after: string,
  createdAt: number,
  options: BuildPatchOptions = {},
): BuildResult {
  const payload = makePatch(before, after, options.context ?? 3)
  const content = fencePatchPayload(payload)
  const template: UnsignedEvent = {
    kind: SCRUTINY_KIND,
    created_at: createdAt,
    tags: [...baseTags('patch'), endpointTag('root', root), endpointTag('reply', reply)],
    content,
  }

  const check = applyPatchContent(before, content)
  const reproduced =
    check.status === 'applied' || check.status === 'noop' ? check.content : undefined
  if (reproduced === after) return { template, issues: NO_ISSUES }

  return {
    template,
    issues: [
      issue(
        'P4',
        'warning',
        `self-verification failed before publishing: applying the built patch against the given "before" content produced ${check.status === 'applied' || check.status === 'noop' ? 'different content' : `a ${check.status}`} rather than the given "after" content`,
      ),
    ],
  }
}
