/**
 * Scenario builders for the `resolve` suites.
 *
 * Event ids are derived from the scenario's own structure rather than from `_fixtures.ts`'s global
 * counter, so a shrunk counterexample replays to the same ids and can be pinned as a regression
 * case verbatim.
 */

import type { NostrEvent } from '../src/events.js'
import { makePatch } from '../src/patch.js'
import { PK_FOREIGN, PK_ROOT, baseTags, fenced } from './_fixtures.js'

/** A 64-hex id derived from a label, so scenarios are reproducible across runs. */
export function idOf(label: string): string {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `${hash.toString(16).padStart(8, '0')}${label.replace(/[^a-f0-9]/gi, '')}`
    .padEnd(64, '0')
    .slice(0, 64)
}

function event(overrides: Partial<NostrEvent> & { id: string }): NostrEvent {
  return {
    pubkey: PK_ROOT,
    created_at: 1_714_000_000,
    kind: 1,
    tags: [],
    content: '',
    sig: '0'.repeat(128),
    ...overrides,
  }
}

export function root(content: string, label = 'root'): NostrEvent {
  return event({ id: idOf(label), content, tags: baseTags('product') })
}

/** A patch carrying a real diff from `before` to `after`. */
export function diffPatch(
  label: string,
  rootId: string,
  replyId: string,
  before: string,
  after: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return event({
    id: idOf(label),
    content: fenced(makePatch(before, after)),
    tags: [
      ...baseTags('patch'),
      ['e', rootId, '', 'root', PK_ROOT],
      ['e', replyId, '', 'reply', PK_ROOT],
    ],
    ...overrides,
  })
}

/** A prose-only patch: a valid chain link that changes nothing (PT-8). */
export function noopPatch(
  label: string,
  rootId: string,
  replyId: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return event({
    id: idOf(label),
    content: 'An administrative note, no diff.',
    tags: [
      ...baseTags('patch'),
      ['e', rootId, '', 'root', PK_ROOT],
      ['e', replyId, '', 'reply', PK_ROOT],
    ],
    ...overrides,
  })
}

/** A patch whose payload cannot apply to anything: the HALT lever. */
export function badPatch(
  label: string,
  rootId: string,
  replyId: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return diffPatch(label, rootId, replyId, 'NOT-PRESENT-IN-ANY-CONTENT\n', 'REPLACED\n', overrides)
}

export function foreignPatch(
  label: string,
  rootId: string,
  replyId: string,
  before: string,
  after: string,
  pubkey = PK_FOREIGN,
): NostrEvent {
  return diffPatch(label, rootId, replyId, before, after, { pubkey })
}

/** A NIP-09 kind 5 deletion. `pubkey` must match the target's for DEL-1 to honour it. */
export function deletion(
  label: string,
  targetIds: readonly string[],
  pubkey = PK_ROOT,
): NostrEvent {
  return event({
    id: idOf(label),
    kind: 5,
    pubkey,
    content: 'Retracting.',
    tags: targetIds.map((id) => ['e', id]),
  })
}

/** Deterministic reverse of an event array — the cheapest confluence probe for a unit test. */
export const reversed = (events: readonly NostrEvent[]): NostrEvent[] => [...events].reverse()
