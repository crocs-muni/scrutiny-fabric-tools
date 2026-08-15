/**
 * Unsigned event templates — {kind, created_at, tags, content}. No `id`, no `pubkey`, no `sig` (D13):
 * those three are the injected signer's job.
 *
 * E4 (variable-length fences) and P1/P3/P4 (producer obligations unfalsifiable on receipt) are this
 * module's sole enforcement point. See `docs/QUERY-BUILD.md` §2 for the full design, including the
 * P2 double-listing note (§2.2) and why P4 is the one rule here with a real emission (§2.4).
 */

import { type Issue, issue } from './errors.js'
import { EVENT_TYPE_TAGS, FABRIC_TAG, SCRUTINY_KIND, parseIndexer } from './events.js'
import type { IndexedEventType, ScrutinyEventType, UnsignedEvent } from './events.js'
import { type Hunk, diffHunks, lineCount, occurrences, spliceAt, toLines } from './patch-matcher.js'
import { type ApplyOptions, applyPatchContent, makePatch } from './patch.js'
import { VERSION_TAG } from './version.js'

/** The result of every builder in this module. `issues` is always present (see the module doc). */
export interface BuildResult {
  readonly template: UnsignedEvent
  readonly issues: readonly Issue[]
}

const NO_ISSUES: readonly Issue[] = Object.freeze([])

// ---------------------------------------------------------------------------
// §5.4 producer bounds (RL-1) and §4.5's indexer ceiling (IX-2)
// ---------------------------------------------------------------------------

/**
 * §5.4's recommended bounds, as far as a producer holding one template can see them.
 *
 * The plan listed RL-1 and IX-2 among the rules "not owned by any module, by design (producer
 * guidance)". The Phase 8 audit found that wrong for the three bounds below: every input they
 * constrain is already in this module's hands when it assembles a template, so they are checkable
 * here the same way P4 is — build the artifact, then measure it. What is genuinely not checkable
 * here is §5.4's fourth bound, patches per canonical chain (≤ 1000): `build` sees one event, never
 * a chain. That half stays with the consumer-side ceilings (RL-2/RL-3) in `patch`/`resolve`.
 *
 * All emitted as `warning`. RL-1 and IX-2 are D-layer, and TR-1 forbids a D-layer rule rejecting a
 * V-valid event — the template is always returned, exactly as with P4.
 */
const MAX_EVENT_BYTES = 65536
const MAX_TAG_VALUE_BYTES = 1024
const MAX_HUNKS_PER_PAYLOAD = 64
/** IX-2, and its per-event-type siblings PR-2/MD-2. */
const MAX_INDEXER_TAGS = 64

/**
 * Bytes the signer adds once it fills in `id`, `pubkey` and `sig` — three fixed-width hex fields
 * plus their JSON keys, separators and quotes. Constant, so the size a relay will weigh can be
 * bounded from an unsigned template without this module ever seeing a key (D12/D13).
 */
const SIGNED_ENVELOPE_BYTES = 285

/** UTF-8 byte length. Relay limits are byte limits; `String.length` counts UTF-16 units. */
function utf8Bytes(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

/** RL-1's two whole-template bounds: per-tag-value length, and total signed event size. */
function boundsIssues(template: UnsignedEvent): Issue[] {
  const issues: Issue[] = []

  for (const tag of template.tags) {
    for (const value of tag) {
      const bytes = utf8Bytes(value)
      if (bytes > MAX_TAG_VALUE_BYTES) {
        issues.push(
          issue(
            'RL-1',
            'warning',
            `tag value of ${bytes} bytes exceeds §5.4's recommended maximum of ${MAX_TAG_VALUE_BYTES} (strfry maxTagValSize); deployed relays reject the event outright`,
          ),
        )
      }
    }
  }

  const size = utf8Bytes(JSON.stringify(template)) + SIGNED_ENVELOPE_BYTES
  if (size > MAX_EVENT_BYTES) {
    issues.push(
      issue(
        'RL-1',
        'warning',
        `signed event of about ${size} bytes exceeds §5.4's recommended maximum of ${MAX_EVENT_BYTES} (strfry maxEventSize); move bulk payload to an imeta attachment (§4.6)`,
      ),
    )
  }

  return issues
}

/** Assemble a result, attaching RL-1's bounds findings to whatever the builder already found. */
function result(template: UnsignedEvent, own: readonly Issue[] = NO_ISSUES): BuildResult {
  const issues = [...own, ...boundsIssues(template)]
  return { template, issues: issues.length === 0 ? NO_ISSUES : issues }
}

function baseTags(type: ScrutinyEventType): string[][] {
  return [
    ['t', FABRIC_TAG],
    ['t', VERSION_TAG],
    ['t', EVENT_TYPE_TAGS[type]],
  ]
}

// ---------------------------------------------------------------------------
// Product / Metadata
// ---------------------------------------------------------------------------

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
  type: IndexedEventType,
  content: string,
  createdAt: number,
  indexers: readonly string[],
): BuildResult {
  const template: UnsignedEvent = {
    kind: SCRUTINY_KIND,
    created_at: createdAt,
    tags: [...baseTags(type), ...indexerTags(indexers)],
    content,
  }

  // IX-2, producer side. `validate.ts` already enforces the same ceiling on receipt, but cites the
  // per-event-type siblings PR-2/MD-2 there — IX-2 states it for events generally, and this is the
  // only place a producer can be told before publishing. See docs/QUERY-BUILD.md §2.2 for why one
  // obligation carrying several rule IDs is normal here rather than a conflict.
  const own =
    indexers.length > MAX_INDEXER_TAGS
      ? [
          issue(
            'IX-2',
            'warning',
            `${indexers.length} i tags exceeds the recommended maximum of ${MAX_INDEXER_TAGS}; surface only the indexers this event is *about* (IX-4) rather than every indexer its payload mentions`,
          ),
        ]
      : NO_ISSUES

  return result(template, own)
}

/** `indexers` are raw `i`-tag values, e.g. `"cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*"`. */
export function buildProduct(
  content: string,
  createdAt: number,
  indexers: readonly string[] = [],
): BuildResult {
  return buildIndexedEvent('product', content, createdAt, indexers)
}

/** `indexers` are raw `i`-tag values, e.g. `"cve:CVE-2017-15361"`. */
export function buildMetadata(
  content: string,
  createdAt: number,
  indexers: readonly string[] = [],
): BuildResult {
  return buildIndexedEvent('metadata', content, createdAt, indexers)
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
  return result({
    kind: SCRUTINY_KIND,
    created_at: createdAt,
    tags: [...baseTags('binding'), endpointTag('root', root), endpointTag('link', link)],
    content,
  })
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

/**
 * §5.4's recommended bound on the widening search's own total work, identical unit and default to
 * `patch.ts`'s `ApplyOptions.maxWork`: a pair whose widening cannot finish inside the budget a
 * consumer's default would allow is one whose eventual application would strain that consumer
 * anyway (CONTEXT-WIDENING.md §3) — so the producer degrades to the same P4 warning the consumer's
 * own gate would have produced.
 */
const DEFAULT_MAX_WIDEN_WORK = 16 * 1024 * 1024

/** The widening search's outcome: the context that won (or the last one tried), and its hunks. */
export interface WidenResult {
  readonly context: number
  readonly hunks: readonly Hunk[]
  readonly exhausted: boolean
}

/**
 * Widen linearly — step EXACTLY 1, never a stride or binary search (CONTEXT-WIDENING.md §2.1) —
 * from `startContext` up to full-file context, stopping at the first context where every hunk's
 * T1 pattern is unique. Each hunk is checked against the content produced by every prior hunk in
 * the same trial payload via `spliceAt`, exactly mirroring T3's sequencing in `applyPatchPayload`
 * (§2.2: an independent per-hunk check against the static pre-patch lines can report `unique`
 * where the real consumer-side scan would still find ambiguity). Work is charged per F12's
 * per-element floor (`len(line) + 1` per pattern line times the *running* line count), so a
 * blank-line-dominated pattern still costs the scan it causes (§3).
 *
 * Termination is arithmetic: `context` increases by one per iteration, clamped to `fullContext`,
 * and §2.3 proves a pattern spanning the whole file is unique by a length argument alone — so
 * `exhausted: true` is reachable only through a `ceilingWork` cut-off (or kept as the honest
 * fullContext guard the spec's own comment requires). A `spliceAt` failure mid-trial (an
 * EOF-marker branch, C5-shaped) is not an ambiguity widening is guaranteed to fix: the trial
 * treats it as unresolved and keeps widening — the final verdict remains the P4 self-check's,
 * which is exactly the §4 composition.
 */
export function widenContext(
  before: string,
  after: string,
  startContext: number,
  ceilingWork: number,
): WidenResult {
  const beforeLines = toLines(before)
  const afterLines = toLines(after)
  const fullContext = Math.max(lineCount(beforeLines), lineCount(afterLines))
  let work = 0

  for (let context = startContext; ; context++) {
    const capped = Math.min(context, fullContext)
    const hunks = diffHunks(before, after, capped)

    let lines = beforeLines
    let ambiguous = false
    for (const hunk of hunks) {
      if (hunk.oldPat.length === 0) continue // T2's carve-out — no pattern to disambiguate

      const cost = lines.length * hunk.oldPat.reduce((sum, line) => sum + line.length + 1, 0)
      work += cost
      if (work > ceilingWork) return { context: capped, hunks, exhausted: true }

      const found = occurrences(lines, hunk.oldPat)
      if (found.count !== 1) {
        ambiguous = true
        break // atomic, same as T3 — a later hunk in this trial is never scanned past the first miss
      }
      const spliced = spliceAt(lines, hunk, found.first)
      if (!spliced.ok) {
        ambiguous = true
        break
      }
      lines = spliced.lines
    }

    if (!ambiguous) return { context: capped, hunks, exhausted: false }
    if (capped === fullContext) return { context: capped, hunks, exhausted: true } // see §2.3
  }
}

/**
 * `buildPatch`'s parameters as ONE named-fields object (mandate §10 / `AUDIT-2026-07-31.md` §10
 * item 3): `root`/`reply` and `before`/`after` are same-typed positional pairs, and swapping
 * `before`/`after` used to produce a plausible *inverse* patch that still passed the P4
 * self-check — against the wrong baseline. With named fields the swap is a compile error, not a
 * runtime surprise.
 */
export interface BuildPatchOptions {
  readonly root: EndpointRef
  readonly reply: EndpointRef
  readonly before: string
  readonly after: string
  readonly createdAt: number
  /**
   * P1's floor and the widening search's *starting* context (CONTEXT-WIDENING.md §2 — the floor
   * is the fast path, widening elects to do better than the floor when the floor itself would
   * make the patch ambiguous on its own admitted input). Defaults to 3. Leave it alone except to
   * exercise the zero-context shape in a test, exactly as `patch.ts`'s own `context` exists for.
   */
  readonly context?: number
  /**
   * The widening search's work ceiling (CONTEXT-WIDENING.md §3, Phase 18's option folded into
   * this object). Defaults to `DEFAULT_MAX_WIDEN_WORK`.
   */
  readonly maxWidenWork?: number
  /**
   * Ceilings for the P4 self-check (the audit's second half: a 70-hunk patch's self-check used
   * to hit RL-2's default and be misreported as a producer-correctness failure, with no
   * parameter to fix it). Defaults to `applyPatchContent`'s usual ones.
   */
  readonly apply?: ApplyOptions
}

/**
 * Build a Patch template carrying the unified diff from `before` to `after`.
 *
 * Resolves the context via the widening loop first (CONTEXT-WIDENING.md §2), then calls
 * `makePatch` exactly once at the resolved context. P4 (self-verification) is unchanged in
 * shape: after assembling `template.content`, this re-applies it via the same
 * fence-lookup-then-apply path a real consumer uses (`applyPatchContent`, now with the caller's
 * `apply` ceilings if given) and compares the result against `after`. Exhausted widening needs
 * no branch of its own — a payload that still has an ambiguous hunk fails this check and
 * surfaces through the existing P4 warning, verbatim (§4). P4 remains a SHOULD: the template is
 * always returned, since TR-1 forbids treating an A-layer rule as a rejection.
 */
export function buildPatch(options: BuildPatchOptions): BuildResult {
  const { context: resolvedContext } = widenContext(
    options.before,
    options.after,
    options.context ?? 3,
    options.maxWidenWork ?? DEFAULT_MAX_WIDEN_WORK,
  )
  const payload = makePatch(options.before, options.after, resolvedContext)
  const content = fencePatchPayload(payload)
  const template: UnsignedEvent = {
    kind: SCRUTINY_KIND,
    created_at: options.createdAt,
    tags: [
      ...baseTags('patch'),
      endpointTag('root', options.root),
      endpointTag('reply', options.reply),
    ],
    content,
  }

  const own: Issue[] = []

  // RL-1's third producer-visible bound: hunks per payload (§5.4, basis "T1 cost"). Counted from
  // the payload this call just produced, so it reflects what will actually be published.
  const hunks = (payload.match(/^@@ /gm) ?? []).length
  if (hunks > MAX_HUNKS_PER_PAYLOAD) {
    own.push(
      issue(
        'RL-1',
        'warning',
        `patch carries ${hunks} hunks, exceeding §5.4's recommended maximum of ${MAX_HUNKS_PER_PAYLOAD}; a consumer enforcing that ceiling (RL-2) aborts application and reports the chain as aborted rather than resolved (RL-5)`,
      ),
    )
  }

  const check = applyPatchContent(options.before, content, options.apply)
  const settled = check.status === 'applied' || check.status === 'noop'
  if (!settled || check.content !== options.after) {
    own.push(
      issue(
        'P4',
        'warning',
        `self-verification failed before publishing: applying the built patch against the given "before" content produced ${settled ? 'different content' : `a ${check.status}`} rather than the given "after" content`,
      ),
    )
  }

  return result(template, own)
}
