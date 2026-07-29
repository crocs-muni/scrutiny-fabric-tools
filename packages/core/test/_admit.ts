/**
 * Scenario builders and a fake `TrustProvider` for the `admit` suites.
 *
 * Ids are derived from a label rather than `_fixtures.ts`'s global counter, so a shrunk
 * counterexample replays to the same ids and can be pinned as a regression case verbatim — same
 * discipline as `test/_resolve.ts`.
 */

import type { NostrEvent } from '../src/events.js'
import { type TrustProvider, trustSymbol } from '../src/interfaces.js'
import { PK_FOREIGN, PK_OTHER, PK_ROOT, baseTags } from './_fixtures.js'

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

export function product(label: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return event({ id: idOf(label), content: 'A product.', tags: baseTags('product'), ...overrides })
}

export function metadata(label: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return event({
    id: idOf(label),
    content: 'Some metadata.',
    tags: baseTags('metadata'),
    ...overrides,
  })
}

/** A Binding, authored by `PK_OTHER` by default — a third party distinct from root and foreign. */
export function bindingEvent(
  label: string,
  rootId: string,
  linkId: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return event({
    id: idOf(label),
    pubkey: PK_OTHER,
    content: 'An edge.',
    tags: [...baseTags('binding'), ['e', rootId, '', 'root'], ['e', linkId, '', 'link']],
    ...overrides,
  })
}

/** A root-author patch replying into `rootId`'s chain. */
export function rootPatch(
  label: string,
  rootId: string,
  replyId: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return event({
    id: idOf(label),
    pubkey: PK_ROOT,
    content: 'A patch.',
    tags: [
      ...baseTags('patch'),
      ['e', rootId, '', 'root', PK_ROOT],
      ['e', replyId, '', 'reply', PK_ROOT],
    ],
    ...overrides,
  })
}

/** A foreign overlay patch — same shape as {@link rootPatch}, authored by `PK_FOREIGN`. */
export function foreignPatch(
  label: string,
  rootId: string,
  replyId: string,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return rootPatch(label, rootId, replyId, { pubkey: PK_FOREIGN, ...overrides })
}

/** A NIP-09 kind 5 deletion. `pubkey` must match every honoured target's for DEL-1 (§8). */
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

/** A `TrustProvider` over a fixed, mutable-free set — `deltaSince` is unused by Phase 4. */
export function fakeTrust(trusted: readonly string[]): TrustProvider {
  const set = new Set(trusted)
  return {
    [trustSymbol]: true,
    isTrusted: (pk) => set.has(pk),
    version: 0,
    deltaSince: () => null,
  }
}
