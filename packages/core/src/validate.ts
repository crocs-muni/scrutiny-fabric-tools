/**
 * Per-event Validity checking (§6.0's V layer).
 *
 * Pure: one event in, a verdict plus issues out. Nothing here reads trust state, and nothing here
 * applies a patch — trust is a presentation-time concern (TR-7) and application is the A layer.
 */

import { type Issue, hasError, issue } from './errors.js'
import {
  EVENT_TYPE_TAGS,
  FABRIC_TAG,
  INDEXER_PREFIX_PATTERN,
  type NostrEvent,
  type ScrutinyEventType,
  VERSION_TAG_PATTERN,
  compareVersionTags,
  derivedIndexerKinds,
  eTagsWithMarker,
  indexerKinds,
  isScrutinyEvent,
  scrutinyEventType,
  tTags,
  tagValues,
  versionTags,
} from './events.js'
import type { RuleId } from './rules.js'
import { VERSION_TAG } from './version.js'

/** Recommended maximum `i` and `k` tag count (PR-2, PR-3, MD-2, MD-3, IX-2). */
const MAX_INDEXER_TAGS = 64

/** The event-type `t` tags, as a set, for the TAG-3 count. */
const TYPE_TAG_SET: ReadonlySet<string> = new Set(Object.values(EVENT_TYPE_TAGS))

export interface ValidateOptions {
  /**
   * Look up an event from the observed set.
   *
   * Required to decide BD-3/BD-4 endpoint typing and PT-7 overlay lineage, both of which are
   * V rules that nonetheless depend on *other* events. Without it, an event whose verdict turns on
   * a reference is reported as `pending` rather than guessed at — which is the confluent answer
   * (UR-1): the same event set must yield the same state whatever the arrival order.
   */
  readonly lookupEvent?: (id: string) => NostrEvent | undefined
}

/**
 * The outcome of validating one event.
 *
 * `not-scrutiny` is distinct from `invalid` on purpose. §3 puts events without the fabric tag
 * outside this specification entirely — they are ordinary Nostr events, not malformed SCRUTINY
 * ones, and reporting them as invalid would misattribute a scope boundary as a defect.
 */
export type Validity =
  | { readonly status: 'not-scrutiny' }
  | {
      readonly status: 'valid'
      readonly type: ScrutinyEventType
      readonly issues: readonly Issue[]
    }
  | { readonly status: 'invalid'; readonly issues: readonly Issue[] }
  | {
      readonly status: 'pending'
      readonly type: ScrutinyEventType
      /** Event ids whose arrival would resolve the verdict. */
      readonly awaiting: readonly string[]
      readonly issues: readonly Issue[]
    }

/**
 * Validate one event against the Validity layer.
 *
 * A `valid` verdict may still carry issues: D-layer findings such as PR-2's 64-tag advice are
 * warnings, because TR-1 forbids rejecting a V-valid event over a D rule.
 */
export function validateEvent(event: NostrEvent, options: ValidateOptions = {}): Validity {
  if (!isScrutinyEvent(event)) return { status: 'not-scrutiny' }

  const issues: Issue[] = []
  checkTags(event, issues)

  const type = scrutinyEventType(event)
  if (type === undefined) {
    return { status: 'invalid', issues }
  }

  const awaiting: string[] = []
  switch (type) {
    case 'product':
    case 'metadata':
      checkRootEvent(event, type, issues)
      break
    case 'binding':
      checkBinding(event, issues, awaiting, options)
      break
    case 'patch':
      checkPatch(event, issues, awaiting, options)
      break
  }

  if (hasError(issues)) {
    return { status: 'invalid', issues }
  }
  if (awaiting.length > 0) {
    return { status: 'pending', type, awaiting, issues }
  }
  return { status: 'valid', type, issues }
}

// ---------------------------------------------------------------------------
// §3 — tags and versioning
// ---------------------------------------------------------------------------

function checkTags(event: NostrEvent, issues: Issue[]): void {
  const ts = tTags(event)

  const fabricCount = ts.filter((t) => t === FABRIC_TAG).length
  if (fabricCount !== 1) {
    issues.push(
      issue('TAG-1', 'error', `expected exactly one "${FABRIC_TAG}" t tag, found ${fabricCount}`),
    )
  }

  const versions = versionTags(event)
  if (versions.length !== 1) {
    issues.push(
      issue(
        'TAG-2',
        'error',
        `expected exactly one version t tag matching ${VERSION_TAG_PATTERN.source}, found ${versions.length}`,
      ),
    )
  }

  const typeTags = ts.filter((t) => TYPE_TAG_SET.has(t))
  if (typeTags.length !== 1) {
    issues.push(
      issue(
        'TAG-3',
        'error',
        `expected exactly one event-type t tag, found ${typeTags.length}${
          typeTags.length > 0 ? ` (${typeTags.join(', ')})` : ''
        }`,
      ),
    )
  }

  // The underscored form is how the previous implementation died: it emitted `scrutiny_v032`, which
  // no version-tag check recognises, and nothing in its CI ever complained.
  const underscored = ts.filter((t) => t.startsWith('scrutiny_'))
  if (underscored.length > 0) {
    issues.push(
      issue(
        'TAG-4',
        'warning',
        `tag names are kebab-case; underscored variants are not recognised: ${underscored.join(', ')}`,
      ),
    )
  }

  // VER-3: a higher-version event whose event type this implementation does not recognise must not
  // be rendered as one of the four types. VER-2 still allows storing it opaquely, and VER-4 forbids
  // rejecting a higher-version event *solely* for its version — which is why this fires only in
  // combination with an actual Validity failure.
  const single = versions.length === 1 ? versions[0] : undefined
  if (
    single !== undefined &&
    typeTags.length === 0 &&
    compareVersionTags(single, VERSION_TAG) > 0
  ) {
    issues.push(
      issue(
        'VER-3',
        'error',
        `event declares ${single}, newer than this implementation's ${VERSION_TAG}, and carries no recognised event-type tag; it must not be rendered as a Product, Metadata, Binding, or Patch`,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// §4.1 / §4.2 — Product and Metadata
// ---------------------------------------------------------------------------

/**
 * §4.1 and §4.2 are the same four checks under different rule ids.
 *
 * A table rather than four parallel ternaries, so the Product and Metadata rule sets stay visibly
 * aligned and a fifth paired rule is a row instead of a fifth conditional.
 */
const ROOT_RULES = {
  product: { content: 'PR-1', i: 'PR-2', k: 'PR-3', set: 'PR-4' },
  metadata: { content: 'MD-1', i: 'MD-2', k: 'MD-3', set: 'MD-4' },
} as const satisfies Record<'product' | 'metadata', Record<string, RuleId>>

function checkRootEvent(event: NostrEvent, type: 'product' | 'metadata', issues: Issue[]): void {
  const rules = ROOT_RULES[type]

  if (typeof event.content !== 'string') {
    issues.push(issue(rules.content, 'error', 'content field is required'))
  }

  checkIndexers(event, issues)

  for (const name of ['i', 'k'] as const) {
    const count = tagValues(event, name).length
    if (count > MAX_INDEXER_TAGS) {
      issues.push(
        issue(
          rules[name],
          'warning',
          `${count} ${name} tags exceeds the recommended maximum of ${MAX_INDEXER_TAGS}`,
        ),
      )
    }
  }

  // A missing k entry costs discoverability through the #k relay filter, never validity — the kind
  // is derivable from the i prefix. Re-tagged V -> D in v0.6.0 for exactly this reason.
  const declared = indexerKinds(event)
  const missing = [...derivedIndexerKinds(event)].filter((p) => !declared.has(p))
  if (missing.length > 0) {
    issues.push(
      issue(
        rules.set,
        'warning',
        `no k tag for indexer prefix(es) ${missing.join(', ')}; the event stays valid but is less discoverable via #k`,
      ),
    )
  }
}

/** IR-1: every `i` tag value must parse and carry a lowercase-ASCII prefix. */
function checkIndexers(event: NostrEvent, issues: Issue[]): void {
  for (const raw of tagValues(event, 'i')) {
    const colon = raw.indexOf(':')
    if (colon <= 0) {
      issues.push(issue('IR-1', 'error', `i tag "${raw}" has no "<prefix>:<value>" form`))
      continue
    }
    const prefix = raw.slice(0, colon)
    if (!INDEXER_PREFIX_PATTERN.test(prefix)) {
      issues.push(
        issue(
          'IR-1',
          'error',
          `i tag prefix "${prefix}" is not lowercase ASCII matching ${INDEXER_PREFIX_PATTERN.source}`,
        ),
      )
    }
  }
}

// ---------------------------------------------------------------------------
// §4.3 — Binding
// ---------------------------------------------------------------------------

function checkBinding(
  event: NostrEvent,
  issues: Issue[],
  awaiting: string[],
  options: ValidateOptions,
): void {
  const roots = eTagsWithMarker(event, 'root')
  const links = eTagsWithMarker(event, 'link')

  if (roots.length === 0) issues.push(issue('BD-1', 'error', 'missing an e tag with marker "root"'))
  if (links.length === 0) issues.push(issue('BD-2', 'error', 'missing an e tag with marker "link"'))
  if (roots.length > 1 || links.length > 1) {
    issues.push(
      issue(
        'BD-10',
        'error',
        `a Binding must not carry more than one e root or e link (found ${roots.length} root, ${links.length} link)`,
      ),
    )
  }
  if (roots.length !== 1 || links.length !== 1) return

  const root = roots[0]
  const link = links[0]
  if (root === undefined || link === undefined) return

  const endpoints = [
    { ref: root, role: 'root', required: 'product', rule: 'BD-3' },
    { ref: link, role: 'link', required: 'metadata', rule: 'BD-4' },
  ] as const

  for (const { ref, role, required, rule } of endpoints) {
    const observed = options.lookupEvent?.(ref.id)
    if (observed === undefined) {
      // BD-6: pending, not invalid. Neither admitted nor rejected until the endpoint arrives.
      awaiting.push(ref.id)
      continue
    }

    const observedType = scrutinyEventType(observed)
    if (observedType !== required) {
      issues.push(
        issue(
          rule,
          'error',
          `e ${role} endpoint ${ref.id} is ${observedType ?? 'not a SCRUTINY event'}, but must be a scrutiny-${required}`,
        ),
      )
      issues.push(issue('BD-5', 'error', 'Binding endpoints violate the typing rule; not admitted'))
      // The typing of an observed endpoint cannot change on further observation, so this rejection
      // is safe to cache permanently (UR-3). Contrast a Patch's authorship class, which can.
      issues.push(issue('BD-7', 'warning', 'this rejection is permanent and may be cached'))
    }

    // BD-12: advisory only. Reported so an audit view can surface it, never rejecting.
    if (ref.authorHint !== undefined && ref.authorHint !== observed.pubkey) {
      issues.push(
        issue(
          'BD-12',
          'warning',
          `e ${role} author hint ${ref.authorHint} does not match the endpoint's pubkey ${observed.pubkey}; the hint is advisory and does not invalidate the Binding`,
        ),
      )
    }
  }

  if (awaiting.length > 0) {
    issues.push(
      issue(
        'BD-6',
        'warning',
        `endpoint(s) not yet observed: ${awaiting.join(', ')}; the Binding is held pending and is not rendered`,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// §4.4 — Patch
// ---------------------------------------------------------------------------

function checkPatch(
  event: NostrEvent,
  issues: Issue[],
  awaiting: string[],
  options: ValidateOptions,
): void {
  const roots = eTagsWithMarker(event, 'root')
  const replies = eTagsWithMarker(event, 'reply')

  if (roots.length !== 1) {
    issues.push(
      issue(
        'PT-1',
        'error',
        `expected exactly one e tag with marker "root", found ${roots.length}`,
      ),
    )
  }
  if (replies.length !== 1) {
    issues.push(
      issue(
        'PT-2',
        'error',
        `expected exactly one e tag with marker "reply", found ${replies.length}`,
      ),
    )
  }

  checkPatchPayload(event, issues)

  const root = roots[0]
  const reply = replies[0]
  if (roots.length !== 1 || replies.length !== 1 || root === undefined || reply === undefined)
    return

  const rootEvent = options.lookupEvent?.(root.id)
  if (rootEvent === undefined) {
    // UR-2: without the root's pubkey the patch cannot be classified as root-author or foreign at
    // all, so it is retained and re-evaluated on the root's arrival. UR-3 forbids caching this.
    awaiting.push(root.id)
    return
  }

  // PT-7 constrains foreign patches only; a root-author patch's lineage is PT-6, an A rule that
  // resolve.ts applies when building the canonical chain.
  if (event.pubkey === rootEvent.pubkey) return
  if (reply.id === root.id) return

  const target = options.lookupEvent?.(reply.id)
  if (target === undefined) {
    awaiting.push(reply.id)
    return
  }

  const targetIsRootAuthorPatch =
    scrutinyEventType(target) === 'patch' && target.pubkey === rootEvent.pubkey
  if (!targetIsRootAuthorPatch) {
    issues.push(
      issue(
        'PT-7',
        'error',
        `foreign patch replies to ${reply.id}, which is neither the root nor a root-author patch; overlay-to-overlay reply is invalid`,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// §5.2 — patch payload envelope and grammar
// ---------------------------------------------------------------------------

/** A fenced code block located in an event's `content`. */
interface FencedBlock {
  readonly fenceChar: '`' | '~'
  readonly info: string
  /** Payload bytes: the lines strictly between the fences, each terminated by LF (E5). */
  readonly payload: string
  /** False when the block runs to the end of `content` with no closing fence (E3). */
  readonly closed: boolean
}

/** Whether a block's info string marks it as a patch payload (E2). */
function isPayloadInfo(info: string): boolean {
  const first = info.trim().split(/\s+/)[0]?.toLowerCase()
  return first === 'diff' || first === 'patch'
}

/** E2 + E1: only a *backtick*-fenced diff block carries a payload. A tilde-fenced one is ignored. */
function isPayloadBlock(block: FencedBlock): boolean {
  return block.fenceChar === '`' && isPayloadInfo(block.info)
}

/**
 * Locate CommonMark §4.5 fenced code blocks in `content`.
 *
 * Both backtick and tilde fences are collected so E1 can report a tilde-fenced diff block as
 * ignored rather than silently dropping it.
 */
export function findFencedBlocks(content: string): FencedBlock[] {
  const lines = content.split('\n')
  const blocks: FencedBlock[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open === null) continue

    const fence = open[1]
    const info = open[2]
    if (fence === undefined || info === undefined) continue
    // CommonMark: a backtick fence's info string may not contain a backtick.
    if (fence.startsWith('`') && info.includes('`')) continue

    const fenceChar = fence[0] === '`' ? '`' : '~'
    const closer = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}\\s*$`)

    const body: string[] = []
    let closed = false
    let j = i + 1
    for (; j < lines.length; j++) {
      const candidate = lines[j]
      if (candidate === undefined) continue
      if (closer.test(candidate)) {
        closed = true
        break
      }
      body.push(candidate)
    }

    blocks.push({
      fenceChar,
      info,
      payload: body.length > 0 ? `${body.join('\n')}\n` : '',
      closed,
    })
    i = j
  }

  return blocks
}

/**
 * The patch payload for an event, or `undefined` if it has none (a no-op patch, E7).
 *
 * The first backtick-fenced block whose info string matches E2 wins; later matching blocks are
 * prose (E6, PT-4). This defends against a renderer-quoted example being picked up as the payload.
 */
export function findPatchPayload(content: string): string | undefined {
  return findFencedBlocks(content).find(isPayloadBlock)?.payload
}

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded by a high one.
 *
 * Equivalent to `!String.prototype.isWellFormed()`, written out because that builtin needs the
 * ES2024 lib and the package targets ES2022.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const FORBIDDEN_PREAMBLE = [
  /^index [0-9a-f]{4,}\.\.[0-9a-f]{4,}/,
  /^(old|new) mode /,
  /^(new|deleted) file mode /,
  /^similarity index /,
  /^(rename|copy) (from|to) /,
]

function checkPatchPayload(event: NostrEvent, issues: Issue[]): void {
  const blocks = findFencedBlocks(event.content)

  const tildeDiff = blocks.filter((b) => b.fenceChar === '~' && isPayloadInfo(b.info))
  if (tildeDiff.length > 0) {
    issues.push(
      issue(
        'E1',
        'warning',
        'a tilde-fenced diff block is present; only backtick fences carry a SCRUTINY patch payload, so it is ignored',
      ),
    )
  }

  const payloadBlocks = blocks.filter(isPayloadBlock)
  if (payloadBlocks.length === 0) return // E7: a no-op patch. Valid.

  if (payloadBlocks.length > 1) {
    issues.push(
      issue(
        'PT-3',
        'warning',
        `a Patch carries zero or one fenced diff block, found ${payloadBlocks.length}`,
      ),
    )
    issues.push(
      issue('E6', 'warning', 'only the first fenced diff block is the payload; the rest are prose'),
    )
  }

  const block = payloadBlocks[0]
  if (block === undefined) return

  if (!block.closed) {
    issues.push(
      issue(
        'E3',
        'warning',
        'the patch payload block has no closing fence and runs to end of content',
      ),
    )
  }

  checkPayloadGrammar(block.payload, issues)
}

/**
 * Check a payload against §5.2's consumer grammar.
 *
 * Two deliberate departures, both recorded in `docs/SPEC-FEEDBACK-v0.6.0.md`:
 *
 * - The grammar's `*VCHAR` is ABNF `%x21-7E`, which excludes the space and every non-ASCII byte —
 *   so read literally it rejects any line containing a space, the spec's own em-dash example, and
 *   the `patch -u` timestamps C2 mandates tolerating. Line bodies are treated here as any sequence
 *   of characters other than LF (F3).
 * - Unrecognised lines are tolerated rather than rejected. §5.2 defines the grammar as what a
 *   consumer MUST *accept*, which is a floor, not a ceiling; only constructs a rule explicitly
 *   forbids are rejected. P1 is not evaluated at all (F1).
 */
function checkPayloadGrammar(payload: string, issues: Issue[]): void {
  if (payload === '') return

  const lines = payload.split('\n')
  if (lines.at(-1) === '') lines.pop()

  // P3, UTF-8 clause. A lone surrogate survives JSON.parse but has no valid UTF-8 encoding, so it
  // cannot be serialised for an id recompute or transmitted verbatim. This is the only reachable
  // UTF-8 violation, since content arrives already decoded (R11).
  if (LONE_SURROGATE.test(payload)) {
    issues.push(
      issue('P3', 'error', 'patch payload contains an unpaired surrogate and is not valid UTF-8'),
    )
  }

  // P3, LF clause. PB-1 forbids normalising line endings, so a CRLF payload is reported and passed
  // through untouched rather than repaired. If the endings genuinely mismatch the target content,
  // T1 catches it at apply time, where the evidence to judge it actually exists.
  if (lines.some((l) => l.endsWith('\r'))) {
    issues.push(
      issue(
        'P3',
        'warning',
        'patch payload uses CRLF line endings; LF is required inside the payload and the bytes are not normalised',
      ),
    )
  }

  const headerAt = lines.findIndex((l) => l.startsWith('--- '))
  if (headerAt === -1) {
    issues.push(issue('C1', 'error', 'patch payload has no "--- a/content" header line'))
    return
  }

  // P2 applies only to the preamble. Inside a hunk every line carries a ' ', '+', '-' or '\'
  // prefix, so content that happens to begin with "index " cannot be mistaken for git metadata.
  for (const line of lines.slice(0, headerAt)) {
    if (FORBIDDEN_PREAMBLE.some((re) => re.test(line))) {
      issues.push(
        issue(
          'P2',
          'error',
          `patch payload carries forbidden git metadata: "${line}". Strip index, mode, similarity and rename lines post-hoc — note that --no-index does not remove them`,
        ),
      )
    }
  }

  checkHeaderPath(lines[headerAt], '--- ', 'a/content', issues)
  checkHeaderPath(lines[headerAt + 1], '+++ ', 'b/content', issues)
}

/**
 * C1: the header path token must be exactly `a/content` or `b/content`.
 *
 * C2 requires trailing data (timestamps, whitespace) to be tolerated, so only the first
 * whitespace-delimited token after the marker is compared.
 */
function checkHeaderPath(
  line: string | undefined,
  marker: '--- ' | '+++ ',
  expected: 'a/content' | 'b/content',
  issues: Issue[],
): void {
  if (line === undefined || !line.startsWith(marker)) {
    issues.push(issue('C1', 'error', `patch payload has no "${marker}${expected}" header line`))
    return
  }
  const token = line
    .slice(marker.length)
    .trimStart()
    .split(/[\s\t]/)[0]
  if (token !== expected) {
    issues.push(
      issue(
        'C1',
        'error',
        `header path token must be exactly "${expected}", found "${token ?? ''}"`,
      ),
    )
  }
}
