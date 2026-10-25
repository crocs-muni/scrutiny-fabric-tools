# scrutiny-fabric-tools/relay

A single-binary [khatru](https://pkg.go.dev/fiatjaf.com/nostr/khatru) relay for the
scrutiny-fabric pilot. Reads are open: all NIP-01 filters, plus NIP-50 search over a
bleve index. Writes must be NIP-42 authenticated by a pubkey on the pilot allowlist
and must pass a vocabulary gate. A kind 1 note needs at least one accepted scrutiny
`t` tag. A kind 5 deletion request passes on its own. Deletion requests follow spec
rule **DEL-11** ("store, never act"). The relay accepts a kind 5 event, stores it and
serves it like any other event. It never deletes its targets. NIP-11 does not
advertise NIP-9. The framework `DeleteEvent` hook is deliberately left unwired, so
nothing in the relay can ever delete an event. Events live in a pure-Go boltdb base
store. The bleve search index holds only kind-1 content, and it hydrates its hits
from the base store.

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `SCRUTINY_LISTEN_ADDR` | no | `:3334` | host:port the HTTP server binds to |
| `SCRUTINY_SERVICE_URL` | **yes** | — | public relay URL used as the NIP-42 challenge `relay` tag, e.g. `wss://relay.example.com` (must survive the reverse proxy) |
| `SCRUTINY_DATA_DIR` | no | `data` | directory holding `base.bolt` and `search/` |
| `SCRUTINY_ALLOWED_PUBKEYS` | **yes** | — | comma-separated publisher allowlist, 64-char hex or `npub1...` |
| `SCRUTINY_ACCEPTED_TAGS` | no | canonical vocabulary + twins | comma-separated `t` tag values accepted on kind 1 events |
| `SCRUTINY_RELAY_NAME` | no | `scrutiny-fabric relay` | NIP-11 name |
| `SCRUTINY_RELAY_DESCRIPTION` | no | pilot description | NIP-11 description |
| `SCRUTINY_RELAY_CONTACT` | no | `<operator-email>` | NIP-11 contact |
| `SCRUTINY_MAX_QUERY_LIMIT` | no | `500` | max events one filter may return |
| `SCRUTINY_MAX_EVENT_PAST_AGE` | no | `2h` | Go duration. How old an event's `created_at` may be before the relay rejects it as too old. Widen it only temporarily for backfills (writes stay allowlist-gated regardless) |
| `SCRUTINY_TRUSTED_PROXY_CIDRS` | no | loopback only | Comma-separated CIDRs (or bare IPs) whose transport peer may set `X-Forwarded-For`. Set it to the reverse proxy's network (`172.16.0.0/12` for the compose docker network); a direct client outside the list gets its XFF deleted, so the per-IP limiters key on its real address. Loopback is always trusted. |

The default `SCRUTINY_ACCEPTED_TAGS` set is the canonical vocabulary
(`scrutiny-fabric`, `scrutiny-v0.8.1`, `scrutiny-product`, `scrutiny-metadata`,
`scrutiny-binding`, `scrutiny-patch`). It adds one `-test`/`-pilot`/`-demo` twin per
canonical value (for example `scrutiny-fabric-test`, `scrutiny-product-pilot`).
Setting the variable replaces the whole set.

## Quickstart (locally)

```sh
export SCRUTINY_SERVICE_URL=ws://localhost:3334
export SCRUTINY_ALLOWED_PUBKEYS=npub1...   # or the 64-char hex pubkey
go run ./cmd/relay
```

or build the binary and run it:

```sh
go build -o relay ./cmd/relay
./relay
```

Endpoints:

* `ws://localhost:3334`: the relay itself (NIP-11 via
  `Accept: application/nostr+json`)
* `GET /healthz`: `200 ok` when the base store answers, else `503`
* `GET /metrics`: JSON counters: `events_stored`, `events_rejected`,
  `queries_with_search`, `store_drift`, `uptime_s`. `store_drift` counts
  search-index writes that failed after the base store accepted the event;
  nonzero means NIP-50 results are incomplete until a `relay reindex`.

To rebuild the search index from the base store, stop the relay first. boltdb holds
an exclusive lock:

```sh
./relay reindex
```

## Deployment

The directory holds a Docker image and a compose stack (the relay behind a Caddy TLS
sidecar) for the FI MUNI Stratus VM. See [deploy/README.md](deploy/README.md).
`SCRUTINY_SERVICE_URL` must byte-match the Caddyfile vhost and the CVT DNS record. It
is the NIP-42 challenge anchor.

## Maintenance subcommands

These run against the data directory and need only `SCRUTINY_DATA_DIR`; the service
URL and the publisher allowlist play no part in them. Stop the relay first — boltdb
takes an exclusive lock on its file, so a running instance makes the open fail.

| Command | What it does |
| --- | --- |
| `relay reindex` | wipes the bleve search index and replays the base store into it |
| `relay import -in FILE.ndjson [-verify=false]` | stores a corpus of signed events into the base store and the search index (kinds the search backend doesn't index land in the base store only) |
| `relay count` | prints how many events the base store holds, per kind |
| `relay diff -other BASE.bolt [-out FILE.ndjson]` | writes the events this store has and another lacks, as NDJSON feedable straight back into `import` |

`relay count` is the read-side counterpart, used to verify a store after an import or a
volume restore (`/metrics` cannot: `events_stored` counts accepts since process start).
A missing `base.bolt` is an error, never `events: 0` — an empty result means a wrong
path or the wrong volume, so treat `0` as a mount mistake until proven otherwise.

`relay import` is the offline disaster-recovery path. It bypasses **every** write
policy — NIP-42, the allowlist, the vocabulary gate and the freshness window —
because a restore must rebuild a store from an archive whose events are far older
than any allowed past age and without a publisher secret. Keep it off the network; it
is an operator command only. It writes the base store with fsync disabled and one
flush at the end, so a crash can lose the tail — the command is idempotent for the
base store (duplicates are counted, not errors), so the remedy is to run it again.
The search index has no separate convergence guarantee: if its duplicate-heal write
keeps failing, the import still counts the event as a duplicate, and only
`relay reindex` reconciles the index afterwards. The search
backend still commits one document per event, so expect roughly 20 ms per event
(a 200k-event corpus is about an hour). `-verify=false` skips the id re-hash and the
BIP-340 check; leave it on for archives that may have been edited after export —
note it cannot rescue a truncated file, whose last line fails JSON parsing either way.

```
docker run --rm -v scrutiny-relay-data:/data \
  -e SCRUTINY_DATA_DIR=/data --entrypoint /relay \
  <image> import -in /data/corpus.ndjson
```

## Behavior notes

* **Authentication**: every write needs NIP-42. The relay rejects an
  unauthenticated write with `auth-required: writes require authentication` and a
  fresh challenge. It rejects an authenticated pubkey outside the allowlist with
  `blocked: not an allowed publisher`. Reads are never gated, so
  `Limitation.auth_required` stays false in NIP-11.
* **Deletion**: kind 5 is stored and queryable (`{"kinds":[5],"#e":[...]}`). The
  referenced event keeps being served. NIP-11 lists NIP-1, 11, 42, 50, 70. It
  lists no NIP-9 and no NIP-86: the management API is never served (see below).
* **Search**: NIP-50 over kind 1 content. A search string shorter than 2
  characters (after trimming) returns no events.
* **Counting**: NIP-45 is not supported. It is not advertised in NIP-11, and
  `COUNT` requests get a CLOSED message.
* **Store failures**: if the search index write fails after the base store has
  accepted an event, the write fails and the relay logs the drift. Run
  `relay reindex` to rebuild the index.
* **Management API (NIP-86)**: the endpoint is never served. A request with
  `Content-Type: application/nostr+json+rpc` gets `404` and a one-line comment
  from the HTTP hardening in front of khatru. khatru's management handler reads
  and hashes the entire request body before it checks its `Authorization` header
  (`nip86.go:71` vs `79`), so an unauthenticated caller could force an unbounded
  read. This relay wires no management methods anyway. NIP-11 consequently does
  not advertise NIP-86. As belt-and-braces, every non-websocket request body is
  capped at 64 KiB. Websocket traffic is bounded by the 512000-byte frame cap
  instead.
* **Client identity / `X-Forwarded-For`**: khatru's per-IP limiters prefer the
  first global-unicast `X-Forwarded-For` entry over the socket peer. The relay
  therefore keeps that header only when the connecting peer is loopback or in
  one of the `SCRUTINY_TRUSTED_PROXY_CIDRS` ranges (default: none, so loopback
  only). Caddy (the compose sidecar) reaches the relay from the docker network
  and replaces XFF with the real peer address, so production sets the variable
  to that network. Any other peer (a client that reached the relay directly,
  including one inside the same private LAN) has the header dropped and is
  identified by its socket address, so it cannot forge its per-IP identity.
* **Filter complexity**: the relay refuses a single filter that asks for more
  than 400 `authors`, 500 `ids`, or 500 total `#x` tag values. It answers
  `CLOSED rejected: filter too complex`. The check runs before the rate limiters,
  so it consumes no token. The caps sit above the fabric pipelines (id batches of
  300-400) and lens (narrow tag filters) usage.
* **Rate limits**: three per-IP token buckets, all **DDoS ceilings, not user
  throttles**. A NAT'd lab of lens clients plus our own tunnel walks must never
  hit them:
  - *connections*: 600 up-front, then 30 per 10s. A new connection over budget
    gets `429`.
  - *filters*: 2000 up-front, then 600/min on stored-event queries.
  - *search* (NIP-50 `search` filters only): 120 up-front, then 30/min. Over
    budget the relay answers `CLOSED rate-limited: search budget exhausted,
    retry in a minute`. The per-IP search buckets are themselves capped at
    16384 entries. When that ceiling is reached and a sweep of refilled buckets
    cannot free space, searches from **new** IPs fail closed (same `CLOSED`
    message) until draining buckets refill and get swept. Existing IPs keep
    their budget.

  The first two are khatru policies and exempt loopback. The search limiter does
  **not** exempt loopback, so the relay's own tunnel walks are bounded too. No
  per-IP limit is applied to writes: that path is allowlist-gated by NIP-42
  already.

  Multi-filter REQ caveat (pre-existing khatru behavior, F2): the filters of one
  REQ are processed one by one. A rejection anywhere (complexity cap or rate
  limit) closes the whole subscription, but listeners khatru already registered
  for the earlier filters keep delivering events. Prefer single-filter REQs.
  Re-sending the same subscription id or sending `CLOSE` removes the stale
  listeners.
