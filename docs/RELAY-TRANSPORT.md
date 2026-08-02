# `RelayTransport` — the relay I/O port (D16's fourth interface)

Mini-spec for decision 4 of `PLAN-2026-08-01-rewrite-mandate.md` (§4, "RelayTransport interface").
Not a phase with owned rule IDs — this is an I/O port, the same category as `EventStorage`, not a
V/A/D-rule-bearing module. Written to be foldable into `IMPLEMENTATION-PLAN.md` alongside `STORE.md`
and the rest.

Governing text: NIP-01 (`REQ`/`EVENT`/`EOSE`/`CLOSE`, the `OK` message), NIP-45 (`COUNT`, optional by
its own text). Decisions: D16 (four branded interfaces, `Symbol.for()`, only `RelayTransport` and
`ScrutinySigner` still undeclared), D6 (no published relay adapters — copy-paste
`examples/adapters/` only; naming rule `@scrutiny-fabric/relay-<library>` if ever published), D19
(verification status and `source` travel with ingest — the fact that drives §1.1 below), D18
(`verify` required, no default — the same "fail closed, no silent gap" posture this spec's §1.2
answer follows). Sequenced after item 1 (`EventFilter` reshape): `request()`/`count()`'s filter
parameter is the flat NIP-01 shape that reshape produces, so building the Phase 7 adapters against
this interface waits on it even though this interface's own text does not depend on it
(mandate §4, "Sequencing"). Blocks Phase 7 today: `AUDIT-2026-07-31.md` §6.4 and §7 — `interfaces.ts`
declares only `TrustProvider` and `EventStorage`; the transport interface has, until now, lived
solely in the plan's D16 table, and "adapters" cannot be built against an undefined interface.

---

## 0. Scope and shape

`RelayTransport` answers one question: **given a `Store` and zero or more relay URLs, how does a
consumer get events onto and off of the wire, without `core` ever depending on a specific relay
library?** It is the fourth and last of D16's four branded interfaces (`TrustProvider` — `admit`'s
port, done; `EventStorage` — `store`'s port, done; `ScrutinySigner` belongs to whichever of
`query`/`build` needs it first, out of scope here). Unlike those two, `core` ships **no
implementation of this interface at all, ever** — D6 is explicit that publishing one *is* forcing a
relay library on every consumer, so the only artifacts that exist are `examples/adapters/*`,
CI-tested but not published, one per ecosystem library.

The shape mandate item 4 fixes is unchanged from the original design pass:

```ts
request(
  relays: readonly string[],
  filters: readonly EventFilter[],
  onEvent: (event: NostrEvent) => void,
  onEose?: (relay: string) => void,
): () => void

publish(
  event: NostrEvent,
  relays: readonly string[],
): Promise<ReadonlyMap<string, { readonly ok: boolean; readonly reason?: string }>>

count?(
  relays: readonly string[],
  filters: readonly EventFilter[],
): Promise<ReadonlyMap<string, number | undefined>>
```

Callback plus an explicit unsubscribe closure, not an `EventEmitter` and not a push-to-pull bridge
(async iterator) — this matches what nostr-tools' `SimplePool.subscribeMany`, NDK's `subscribe`,
applesauce's relay layer, and nostrify's `NRelay1` all expose internally, so an adapter is a thin
pass-through, never new plumbing. `count()` is optional, not required-and-throwing, because NIP-45
is itself optional relay-side. `publish()` returns a per-relay outcome map mirroring NIP-01's `OK`
message, never a collapsed boolean — a design already settled by the mandate and not reopened here.
What the mandate left open is three questions about exactly what travels through this shape; §1
resolves each, and §2 gives the interface text those resolutions produce.

---

## 1. The three open questions

### 1.1 Does `onEvent` need a relay-of-origin parameter?

**Resolved: yes.** `onEvent` becomes `(event: NostrEvent, relay: string) => void`.

**Design correction, found while writing this section.** The mandate's sketch omits this parameter;
resolving the question honestly requires changing the sketch, not just documenting a choice within
it. The real use case is not hypothetical: `store.ts` already has a field waiting for exactly this
data and nothing upstream of it can ever supply a value.

```ts
// packages/core/src/store.ts:451-457
export interface IngestMeta {
  /**
   * Part of D19's mandated call shape (`store.add(events, {source, verified})`) — not yet read by
   * `add()` itself. Reserved for a future consumer (e.g. per-relay provenance/audit logging); the
   * field exists now so that shape doesn't become a breaking addition later.
   */
  readonly source?: string
  ...
}
```

D19 mandates `source` travel with a whole *batch* passed to one `store.add()` call. `request()`
accepts `relays: readonly string[]` — plural, by design, for one logical subscription — so a
consumer wiring an arbitrary multi-relay pool into `store.add()` receives one interleaved stream of
events from every relay in the pool through a single `onEvent` callback. If that callback carries no
relay identity, there is no batch boundary a caller can draw that corresponds to "the events this
one relay just sent" — `source` (D19) becomes permanently unpopulatable for exactly the multi-relay
case `request()` exists to serve, and the field `store.ts` already reserved for it is dead on
arrival for any transport built from this interface.

This is not R9 reopened. R9 rejected **building a relay-provenance feature** — indexing which
`(filter, relay)` pairs completed, and drawing censorship inferences from absence, because absence
has too many innocent explanations to support a claim. That is a decision about what `core` computes
and asserts. Whether the low-level callback signature *carries the data point at all* is a different
question, and R9 itself already answered it in passing: "`source` still rides along in ingest
metadata for free; no indexes, no comparison logic, no claims." `onEvent`'s second parameter is that
same free ride, one level closer to where the data actually originates — the transport adapter is
the only place that ever knows which relay delivered a given wire message; if it discards that fact
before the callback fires, no downstream consumer can reconstruct it. Declining to plumb it through
is not neutrality, it is a permanent loss of a data point R9 explicitly said should be kept.

**Rejected: a separate `onEventFrom` callback per relay, or a `Map<relay, onEvent>` parameter.**
Either avoids touching the sketch's arity but forces the adapter to fan out one callback registration
per relay internally regardless — exactly the same work `request()` already has to do to attribute
events (see §3) — while making the common single-callback case (the overwhelming majority of real
call sites, which do not care which relay an event came from and simply want the union) pay a
`Map`-construction tax for no benefit. A second positional argument costs single-relay callers
nothing: `(event) => {...}` remains valid JS regardless of how many parameters the type declares,
same as any callback with an unused trailing parameter.

### 1.2 What happens when a relay silently times out on `publish()`?

**Resolved: it appears in the returned map, with `ok: false` and a `reason` string identifying the
timeout — never by omission.** Every relay named in the `relays` array passed to `publish()` MUST
have a corresponding key in the resolved map's entries. Adapters that impose their own deadline
(nostr-tools' `pool.publish` has none built in — see §3) attribute a relay that never sent an `OK`
before that deadline to `{ ok: false, reason: 'timeout' }` or an equivalently descriptive string;
`reason` stays a plain `string`, not a closed union, matching the field's existing shape in the
mandate's sketch — a Nostr relay's own rejection message (the fourth element of its `OK` frame) is
free text, so a timeout reason sits in the same open vocabulary rather than a separate enum.

**Why against NIP-01's `OK` semantics, not despite them.** NIP-01 defines the `OK` message as the
relay's acknowledgment of an `EVENT` it received, `["OK", <event_id>, <true|false>, <message>]`, and
is silent on a deadline — a relay that never replies is simply not conforming to the *SHOULD send
promptly* guidance, not violating a MUST. That silence is exactly why a real convention has to be
chosen rather than deferred: NIP-01 gives implementers nothing to fall back on for "this relay never
told me anything," and if `RelayTransport` also says nothing, every adapter invents its own answer
and every consumer of `publish()`'s result has to special-case "key absent" against three different
adapters' three different silent conventions. The mandate's own text for this method — "a per-relay
outcome map mirroring NIP-01's `OK` message exactly, never a collapsed boolean" — is the argument
against omission, not for it: a missing key *is* a collapsed boolean wearing a `Map`'s clothing,
because the caller still has to reduce "absent" to a single implicit meaning (usually "assume
failure," sometimes wrongly "assume it's still pending") before it can act, which is precisely the
information-loss the explicit map was introduced to prevent. Precedent inside this codebase: D43
made an illegal chain state structurally unrepresentable (`forked` carries no `tipId`) rather than
trust every caller to check a convention; the equivalent move here is making "no answer" a value the
type forces every caller to see, rather than a gap every caller has to remember to guard.

**Rejected: leaving a timed-out relay's key absent, "pending" by convention.** `publish()` returns a
`Promise`, which resolves exactly once — there is no second resolution to update an "absent" entry
into "actually failed" later, so "absent" would have to mean "permanently unknown," which is a worse
answer than an explicit, named timeout outcome for the exact same information.

### 1.3 Does `onEose` fire once per relay, or once overall?

**Resolved: once per relay**, matching the signature the mandate already sketched:
`onEose?: (relay: string) => void`. NIP-01 defines `EOSE` as a per-subscription signal a relay sends
when it has finished sending stored events matching that subscription's filters — it is emitted
independently by each relay a subscription is open on, at whatever time that relay individually
finishes replaying, which is exactly the granularity a `relay: string` parameter presupposes. A
"fires once overall" reading would require the adapter to hold state across every relay in `relays`
and synthesize a single combined event once all of them have reported — new bookkeeping the sketch's
signature was never going to need to express in the first place, since it already threads a
per-relay identity through. No design correction here: the mandate's own sketch had already made the
right choice: this section documents *why*, it does not change the shape.

**Rejected: a combined `onEose` firing once all relays have reported.** Loses the one piece of
information a consumer with a partial or slow relay set actually wants — *which* relay is still
catching up — and requires an adapter to buffer that state internally for no consumer-visible
benefit, since any caller that wants "all done" can trivially derive it by counting `relay` values
against its own `relays.length`.

---

## 2. The finished interface

Matches `interfaces.ts`'s existing doc-comment and brand-symbol style (`trustSymbol`/`storageSymbol`)
exactly.

```ts
/**
 * `Symbol.for` uses a global registry — see {@link trustSymbol}'s comment; same rationale (D16).
 */
export const transportSymbol = Symbol.for('@scrutiny-fabric/transport')

/**
 * The relay I/O port (D16) — the last of the four branded interfaces `core` declares, and the only
 * one with no implementation shipped anywhere, by design (D6): `core` never depends on a relay
 * library, so an adapter is always a copy-paste `examples/adapters/*` file, CI-tested but never
 * published. Callback plus an explicit unsubscribe closure, matching what nostr-tools, NDK,
 * applesauce, and nostrify all expose internally — a thin pass-through per adapter, never a
 * push-to-pull bridge.
 */
export interface RelayTransport {
  readonly [transportSymbol]: true

  /**
   * Subscribe across one or more relays under one logical subscription. `onEvent`'s second
   * parameter is the relay that delivered this particular copy of the event — present because
   * `store.ts`'s `IngestMeta.source` (D19) is reserved per ingest batch, and a multi-relay
   * `request()` is the only place that ever knows which relay a given event actually came from;
   * discarding that fact here makes `source` permanently unpopulatable for the multi-relay case.
   * This is not relay-provenance-for-censorship-detection (R9 rejected building that feature) — it
   * is not discarding a data point already free at the point it is produced.
   *
   * `onEose` fires once per relay, at whatever time that relay individually finishes replaying its
   * stored events for this subscription's filters — matching NIP-01's `EOSE` semantics, which are
   * per-relay per-subscription, never a combined signal. A caller that wants "every relay is now
   * live" derives it by counting distinct `relay` values against `relays.length`.
   *
   * Returns an explicit unsubscribe closure, `() => void`, rather than an object with a `.close()`
   * method or an `EventEmitter` — matches D16's callback-plus-unsubscribe precedent throughout.
   */
  request(
    relays: readonly string[],
    filters: readonly EventFilter[],
    onEvent: (event: NostrEvent, relay: string) => void,
    onEose?: (relay: string) => void,
  ): () => void

  /**
   * Mirrors NIP-01's `OK` message exactly, never a collapsed boolean. Every relay named in `relays`
   * MUST have a corresponding key in the resolved map — a relay that never sends `OK` before the
   * adapter's own deadline is reported as `{ ok: false, reason: 'timeout' }` (or an equivalently
   * descriptive string), never by omission. `reason` stays a plain, open `string` either way: a
   * relay's own rejection message (the fourth element of its `OK` frame) is free text, and a
   * timeout reason belongs in that same open vocabulary rather than a separate closed union.
   */
  publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly ok: boolean; readonly reason?: string }>>

  /**
   * NIP-45 `COUNT` is genuinely optional relay-side, so this stays an optional method, not
   * required-and-throwing. A relay present in `relays` but missing from the resolved map's keys, or
   * present with value `undefined`, means that relay did not answer `COUNT` — distinct from a real
   * count of `0`.
   */
  count?(
    relays: readonly string[],
    filters: readonly EventFilter[],
  ): Promise<ReadonlyMap<string, number | undefined>>
}
```

---

## 3. Worked example — a copy-paste nostr-tools adapter (D6)

Illustrative, per D6: not a published package, and not the actual `examples/adapters/nostr-tools`
file Phase 12 will CI-test against a pinned `nostr-tools` version — this is the shape that file
takes, adjusted for whichever `nostr-tools` minor is current at that time. Subscribing **per relay**
rather than through one combined `SimplePool.subscribeMany(relays, …)` call is deliberate: it is the
only way to attribute each event to the relay that actually sent it without depending on
`SimplePool`'s own internal `seenOn` bookkeeping, which records *every* relay that has ever sent a
given id, not which relay produced *this* callback invocation — the wrong granularity for §1.1's
resolution.

```ts
import { SimplePool } from 'nostr-tools/pool'
import type { RelayTransport, EventFilter } from '@scrutiny-fabric/core'
import { transportSymbol } from '@scrutiny-fabric/core'
import type { NostrEvent } from '@scrutiny-fabric/core'

export function createNostrToolsTransport(pool: SimplePool): RelayTransport {
  return {
    [transportSymbol]: true,

    request(relays, filters, onEvent, onEose) {
      // One subscription per relay, not `subscribeMany`, so every callback invocation carries an
      // unambiguous relay identity (§1.1) and every EOSE is already per-relay (§1.3) with no
      // bookkeeping needed to keep them apart.
      const closers = relays.map((relay) =>
        pool.subscribeMany([relay], [...filters], {
          onevent: (event: NostrEvent) => onEvent(event, relay),
          oneose: () => onEose?.(relay),
        }),
      )
      return () => closers.forEach((sub) => sub.close())
    },

    async publish(event, relays) {
      const TIMEOUT_MS = 5_000
      const results = await Promise.allSettled(
        pool.publish([...relays], event).map(
          (ack, i) =>
            new Promise<{ relay: string; ok: boolean; reason?: string }>((resolve) => {
              const timer = setTimeout(
                () => resolve({ relay: relays[i], ok: false, reason: 'timeout' }),
                TIMEOUT_MS,
              )
              ack
                .then((message) => {
                  clearTimeout(timer)
                  resolve({ relay: relays[i], ok: true, reason: message || undefined })
                })
                .catch((err) => {
                  clearTimeout(timer)
                  resolve({ relay: relays[i], ok: false, reason: String(err) })
                })
            }),
        ),
      )
      const outcomes = new Map<string, { ok: boolean; reason?: string }>()
      for (const r of results) {
        // Promise.allSettled + the inner Promise never rejecting means every entry is 'fulfilled';
        // the map is exhaustive over `relays` either way, satisfying §1.2's no-omission rule.
        if (r.status === 'fulfilled') outcomes.set(r.value.relay, { ok: r.value.ok, reason: r.value.reason })
      }
      return outcomes
    },

    // count() omitted: illustrative only — wire to whatever NIP-45 COUNT surface the installed
    // nostr-tools version exposes (relay-level `count()` on `AbstractRelay`, if present), or leave
    // `count` unimplemented entirely, since it is optional (§2).
  }
}
```

---

## 4. Where this lands

This document specifies the shape; it does not implement it. Once implemented, `RelayTransport` and
`transportSymbol` join `packages/core/src/interfaces.ts` directly — following the `TrustProvider`
(`admit`'s port) and `EventStorage` (`store`'s port) precedent already established there — never a
new subpath (D17: subpaths are named by caller intent and buy graph exclusion; a type with no runtime
module of its own qualifies for neither). This mini-spec stays its own file, the way `STORE.md` is
its own file despite `EventStorage` living in `interfaces.ts`, not `store.ts`.

Sequencing, restated from the mandate: land after item 1 (`EventFilter` reshape) so `request()` and
`count()` consume the real flat NIP-01 shape from the start — the interface text above already
assumes that shape and needs no further change once item 1 lands, but the Phase 7 adapters
(`AUDIT-2026-07-31.md` §6.4/§7) should not be built before it does.
