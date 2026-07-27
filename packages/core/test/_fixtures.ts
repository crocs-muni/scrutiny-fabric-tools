import type { Issue } from '../src/errors.js'
import type { NostrEvent } from '../src/events.js'
import { type ValidateOptions, validateEvent } from '../src/validate.js'
import { VERSION_TAG } from '../src/version.js'

export const PK_ROOT = 'a'.repeat(64)
export const PK_FOREIGN = 'b'.repeat(64)
export const PK_OTHER = 'c'.repeat(64)

let counter = 0
/** A distinct 64-hex id per call, so fixtures never collide by accident. */
export function nextId(): string {
  counter += 1
  return counter.toString(16).padStart(64, '0')
}

export function ev(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: nextId(),
    pubkey: PK_ROOT,
    created_at: 1714000000,
    kind: 1,
    tags: [],
    content: '',
    sig: '0'.repeat(128),
    ...overrides,
  }
}

/** Base `t` tags for a well-formed SCRUTINY event of a given type. */
export function baseTags(type: string): string[][] {
  return [
    ['t', 'scrutiny-fabric'],
    ['t', VERSION_TAG],
    ['t', `scrutiny-${type}`],
  ]
}

export function product(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return ev({
    content: 'A product.',
    tags: baseTags('product'),
    ...overrides,
  })
}

export function metadata(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return ev({
    content: 'Some metadata.',
    tags: baseTags('metadata'),
    ...overrides,
  })
}

export function binding(rootId: string, linkId: string, extra: string[][] = []): NostrEvent {
  return ev({
    content: 'An edge.',
    tags: [
      ...baseTags('binding'),
      ['e', rootId, '', 'root', PK_ROOT],
      ['e', linkId, '', 'link', PK_FOREIGN],
      ...extra,
    ],
  })
}

export function patch(
  rootId: string,
  replyId: string,
  content: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return ev({
    content,
    tags: [
      ...baseTags('patch'),
      ['e', rootId, '', 'root', PK_ROOT],
      ['e', replyId, '', 'reply', PK_ROOT],
    ],
    ...overrides,
  })
}

/** A minimal spec-conformant patch payload. Note it has zero context lines — see F1. */
export const MINIMAL_PAYLOAD = [
  '--- a/content',
  '+++ b/content',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n')

/** Wrap a payload in a backtick-fenced `diff` block. */
export function fenced(payload: string, info = 'diff', fence = '```'): string {
  return `${fence}${info}\n${payload}\n${fence}`
}

/** Build a lookup over a fixed set of events. */
export function lookup(...events: NostrEvent[]): ValidateOptions {
  const byId = new Map(events.map((e) => [e.id, e]))
  return { lookupEvent: (id) => byId.get(id) }
}

/** Every issue produced for an event, regardless of verdict. */
export function issuesOf(event: NostrEvent, options: ValidateOptions = {}): Issue[] {
  const result = validateEvent(event, options)
  return result.status === 'not-scrutiny' ? [] : [...result.issues]
}

/** The rule codes produced for an event. */
export function codesOf(event: NostrEvent, options: ValidateOptions = {}): string[] {
  return issuesOf(event, options).map((i) => i.code)
}
