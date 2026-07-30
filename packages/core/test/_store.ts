/**
 * Shared helpers for the `store` suites.
 *
 * Reuses `_resolve.ts`'s deterministic `idOf`/`root`/`diffPatch`/`foreignPatch`/`deletion` builders
 * rather than `_fixtures.ts`'s counter-based ones, so a shrunk property-test counterexample replays
 * to the same ids and can be pinned as a regression case verbatim — same rationale `_resolve.ts`
 * itself states.
 */

import type { NostrEvent } from '../src/events.js'
import { PK_FOREIGN, PK_ROOT, baseTags } from './_fixtures.js'
import { idOf } from './_resolve.js'

/** The skeleton shared by `metadataAt`/`bindingAt` — `_resolve.ts`'s own `event()` isn't exported. */
function baseEvent(label: string, tags: string[][], content: string): NostrEvent {
  return {
    id: idOf(label),
    pubkey: PK_ROOT,
    created_at: 1_714_000_000,
    kind: 1,
    content,
    tags,
    sig: '0'.repeat(128),
  }
}

/** A Metadata event with a deterministic id — `_resolve.ts` only builds Product roots. */
export function metadataAt(label: string, content: string): NostrEvent {
  return baseEvent(label, baseTags('metadata'), content)
}

/** A Binding with deterministic, labelled ids — `_fixtures.ts`'s `binding()` uses a shared counter. */
export function bindingAt(label: string, rootId: string, linkId: string): NostrEvent {
  return baseEvent(
    label,
    [
      ...baseTags('binding'),
      ['e', rootId, '', 'root', PK_ROOT],
      ['e', linkId, '', 'link', PK_FOREIGN],
    ],
    'An edge.',
  )
}

/**
 * A `verify` predicate over the one signal these fixtures control: `sig`. `'valid'` passes,
 * anything else (a forged submission's `'forged'`, or any other placeholder) fails — modelling
 * SIG-1's actual contract (recompute-and-compare) without needing real cryptography in a test.
 */
export const verifyBySig = (event: NostrEvent): boolean => event.sig === 'valid'

/** A genuine copy of `base`, accepted by {@link verifyBySig}. */
export function genuine(base: NostrEvent): NostrEvent {
  return { ...base, sig: 'valid' }
}

/** A forged submission claiming the same id as `base`, rejected by {@link verifyBySig}. */
export function forged(base: NostrEvent, content = 'FORGED'): NostrEvent {
  return { ...base, sig: 'forged', content }
}
