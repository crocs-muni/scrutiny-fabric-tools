# Adding and removing pilot publishers

Run this on the relay VM to add or remove a publisher's write access. The pilot
runs on **2026-11-24**; rehearse the whole procedure on **2026-11-23** and fill in
the TODO timings below.

## Why this is a restart, not a reload

The allowlist is read once at process start. `config.FromEnv`
(`internal/config/config.go:162`) parses `SCRUTINY_ALLOWED_PUBKEYS` into a slice,
and `gate.NewAuthGate` (`internal/gate/gate.go:70`) copies it into a fixed map.
Nothing re-reads the environment afterwards, and the relay deliberately does not
serve NIP-86 (`internal/relay/relay.go:104`). Every allowlist change is therefore:
edit `compose.yaml`, `docker compose up -d`. Do not expect a running relay to pick
up an edit on its own.

Reads are never gated — only writes. Adding or removing a key changes nothing for
readers.

## Before you start

You need, on the VM:

1. Shell access as a user in the `docker` group, from the `relay/deploy/`
   directory of a checkout of `scrutiny-fabric-tools`.
2. The operator secret key, available to `nak` or to an MCP client, for the test
   publish in step 5. Its pubkey is already in `SCRUTINY_ALLOWED_PUBKEYS`.
3. Each publisher's public key, either as 64-character hex or as `npub1...`.
   Both forms are accepted verbatim — `parsePubkey`
   (`internal/config/config.go:366`) decodes `npub1...` through NIP-19 and
   otherwise calls `nostr.PubKeyFromHex`. **You do not need to convert
   `npub1...` to hex yourself.**

What the parser tolerates, per `parsePubkeyList` (`config.go:345`):

| Input | Result |
| --- | --- |
| Leading/trailing whitespace around an entry | Trimmed, accepted |
| Empty entries (`a,,b` or a trailing comma) | Skipped silently |
| The same key twice (hex and its `npub1...`) | Collapsed to one entry |
| A malformed key | **The relay refuses to start.** The whole list is rejected, not just the bad entry |
| An empty list | The relay refuses to start: `SCRUTINY_ALLOWED_PUBKEYS must list at least one publisher pubkey (64 hex chars or npub1...)` |

A malformed-key startup failure looks like:

```
SCRUTINY_ALLOWED_PUBKEYS: entry 3 ("npub1..."): invalid npub: ...
```

The old container stays removed until you fix the list, so a typo costs you
downtime. Read the value back before restarting (step 3).

## Procedure

Allow about ten minutes including verification. The interruption itself is
seconds; measure it during rehearsal.

### 1. Save the current compose file

This is your rollback artifact. Do not skip it.

```sh
cd relay/deploy
cp compose.yaml compose.yaml.$(date +%F-%H%M).bak
ls -1t compose.yaml.*.bak | head -3
```

Keep at least the previous file until the pilot ends.

### 2. Collect and check the publisher keys

1. Ask each publisher for their **public** key. Never accept a private key
   (`nsec1...`). The relay cannot store one safely and must not be given one.
2. Confirm each key is 64 hex characters, or starts with `npub` and decodes:

   ```sh
   nak decode npub1...     # prints the hex pubkey
   ```

3. Record which hex pubkey belongs to which publisher in the pilot notes. You
   will want this mapping when a publisher calls at 08:30.
4. Locally test-parse the exact list you intend to deploy, so a typo fails here
   and not on the VM:

   ```sh
   cd relay
   SCRUTINY_SERVICE_URL=ws://localhost:3334 \
   SCRUTINY_ALLOWED_PUBKEYS="<paste the exact final list>" \
   go run ./cmd/relay
   ```

   Stop it with Ctrl-C once it logs `listening`. A configuration error would
   instead abort startup immediately with the message above.

### 3. Edit `SCRUTINY_ALLOWED_PUBKEYS`

1. Open `compose.yaml`.
2. Find the line under `services.relay.environment`:

   ```yaml
   SCRUTINY_ALLOWED_PUBKEYS: "<FILL-ME>"
   ```

3. **Append**, do not replace: keep every existing key and add the new ones after
   a comma. Removing the operator's own key locks you out of step 5.
4. Keep the whole value on one YAML line, double-quoted:

   ```yaml
   SCRUTINY_ALLOWED_PUBKEYS: "npub1operator...,npub1publisherA...,3bf2c...publisherBhex"
   ```

5. Re-read the line and count the entries against the list in step 2.

Do not touch `SCRUTINY_SERVICE_URL` or the Caddyfile. Those three hostnames must
stay byte-identical (`deploy/README.md` §2); changing them breaks every
authenticated publish while reads keep working, which is a quiet failure.

### 4. Restart the relay

```sh
cd relay/deploy
docker compose up -d
```

Do **not** pass `--build`: only the environment changed, the image is unchanged.

What this does and does not disturb:

- Compose recreates the `relay` container because its environment changed.
- The named volume `scrutiny-relay-data` is reattached, so `base.bolt` and the
  `search/` index survive. **No events are lost and no reindex is needed.**
- Caddy is not recreated and keeps serving. While the relay is down, Caddy
  answers clients with `502`.
- Connected clients are dropped. `http.Server.Shutdown` does not wait for
  websockets — khatru hijacks those connections, so the graceful 10-second drain
  (`cmd/relay/main.go:119-127`) does not cover them. They close when the process
  exits.

Tell the publishers in advance: **expect your connection to drop and reconnect;
a publish that fails during the restart must be retried.** Most Nostr clients
reconnect on their own; confirm rather than assume.

> TODO(rehearsal, 2026-11-23): measure the wall-clock time from `docker compose
> up -d` returning to `/healthz` answering 200 again: ____ seconds.
> TODO(rehearsal): measure how long a connected client takes to reconnect:
> ____ seconds.

### 5. Verify

Run every check. Do not declare the change done on restart alone.

| Check | Command | Expected |
| --- | --- | --- |
| Containers up | `docker compose ps` | `relay` and `caddy` both running; `caddy` never restarted |
| Health | `docker compose exec caddy wget -qO- http://relay:3334/healthz` | `200`, body `ok` |
| No config error | `docker compose logs --since=5m relay` | `relay 0.1.0-pilot listening on 0.0.0.0:3334`; no `configuration:` error |
| NIP-11 | `curl -s -H 'Accept: application/nostr+json' https://<HOSTNAME>.fi.muni.cz/` | JSON with `"restricted_writes":true`; `supported_nips` contains `50` and **not** `86` |
| Ops endpoints still private | `curl -i https://<HOSTNAME>.fi.muni.cz/healthz` | `404` (the real `/healthz` is internal only) |

The health check goes through the Caddy container because the relay image is
distroless: no shell, no `curl`, so `docker compose exec relay ...` cannot work.

Then publish a test event. First with the operator key:

```sh
nak event --sec <operator-nsec-or-key-source> \
  -k 1 -c "pilot allowlist check $(date -Is)" \
  --tag t=scrutiny-fabric-pilot \
  wss://<HOSTNAME>.fi.muni.cz
```

| Expect | Where |
| --- | --- |
| `OK true` with the new event id | `nak` output |
| The event is retrievable by id | `nak req -i <id> wss://<HOSTNAME>.fi.muni.cz`, or `verify_event` via MCP |

Then repeat with **one key per publisher**, using their own client and their own
key. Each publisher should confirm `OK true` themselves — a successful operator
publish says nothing about the publisher's key being on the list.

Note that `t=scrutiny-fabric-pilot` matters: a kind 1 event without an accepted
`t` tag is refused for a different reason (see troubleshooting).

### 6. Tell the publishers

1. Send each publisher the relay URL `wss://<HOSTNAME>.fi.muni.cz`.
2. Remind them their client must answer NIP-42 AUTH. Unauthenticated writes get
   `auth-required: writes require authentication`, which makes khatru send an
   AUTH challenge; a client that ignores it cannot publish.
3. Remind them `created_at` must be current — see clock skew below.
4. Ask each publisher to publish one real event now, while you are both watching.

## Troubleshooting at 08:30 on the day

Two expected calls. Both are configuration or clock problems, not bugs.

### "My publish is rejected" — the key is not on the list

The client receives:

```
OK false ... blocked: not an allowed publisher
```

That string is `MsgNotAllowed` (`internal/gate/gate.go:53`), returned when a
NIP-42-authenticated pubkey is absent from the allowlist
(`gate.go:87-90`). The publisher **authenticated successfully**; the relay simply
does not know their key.

1. Have them print their own pubkey: `nak key public <their-key>`.
2. Compare it with the running allowlist — not your notes:

   ```sh
   docker compose exec caddy wget -qO- http://relay:3334/healthz   # relay alive
   grep SCRUTINY_ALLOWED_PUBKEYS relay/deploy/compose.yaml
   ```

3. The decoded hex must match. `nak decode npub1...` to normalize both sides.
4. If it is missing, run the procedure above for that one key. If you edited
   `compose.yaml` after the last restart, the running relay is still using the
   old list: `docker compose up -d` again.

Nearby messages worth distinguishing, all from `gate.go`:

| Client sees | Cause | Fix |
| --- | --- | --- |
| `auth-required: writes require authentication` | No successful NIP-42 AUTH yet | Client must respond to the AUTH challenge; check the client supports NIP-42 |
| `blocked: not an allowed publisher` | Authenticated, but the key is not allowlisted | Add the key (this procedure) |
| `blocked: event author must be the authenticated pubkey` | Authenticated as one key, event signed by another (`gate.go:96`) | Sign with the same key the client authenticated with |
| `blocked: kind 1 event carries no accepted scrutiny t tag` | Kind 1 note with no accepted `t` tag | Add an accepted tag, e.g. `scrutiny-fabric` or `scrutiny-fabric-pilot` |
| `blocked: kind <n> is not accepted by this relay` | Only kinds 0, 1 and 5 are accepted | Use an accepted kind |

### "My publish is rejected as too old / from the future" — clock skew

The client receives one of:

```
event too old
event too much in the future
```

These come from khatru's `PreventTimestampsInThePast` /
`PreventTimestampsInTheFuture`, wired in `internal/relay/relay.go:274-275`. The
windows are:

| Direction | Limit | Set by |
| --- | --- | --- |
| Event older than now | 2 hours | `DefaultMaxEventPastAge`, `internal/config/config.go:52`; overridable via `SCRUTINY_MAX_EVENT_PAST_AGE` |
| Event later than now | 15 minutes | `maxFutureAge`, `internal/relay/relay.go:43`; **compile-time constant, no env override** |

The fix is on the publisher's machine:

1. Check their clock against a reference: `date -u` on both sides.
2. Enable NTP. `sudo timedatectl set-ntp true`, then `timedatectl status` and
   look for `System clock synchronized: yes`.
3. Re-sign and resend. `created_at` is part of the signed event id, so editing
   the timestamp means re-signing; do not reuse the old event.
4. Do **not** widen `SCRUTINY_MAX_EVENT_PAST_AGE` to accommodate a broken clock.
   It exists for backfills, and the 15-minute future window cannot be widened
   without a rebuild. Fix the clock instead.

If an event looks fresh but is still refused as too old, check the relay host's
own clock the same way before escalating.

## Rollback

1. Restore the previous compose file:

   ```sh
   cd relay/deploy
   cp compose.yaml.<timestamp>.bak compose.yaml
   ```

2. Recreate the relay:

   ```sh
   docker compose up -d
   ```

3. Re-run the verification table in step 5, including the operator test publish.

Rollback takes exactly as long as the original restart. The data volume was never
touched, so no restore of events is involved.

## After the pilot: removing publishers

Same procedure, inverse edit.

1. Save the current compose file (step 1).
2. In `SCRUTINY_ALLOWED_PUBKEYS`, delete the publishers' entries. Keep at least
   one key — with the variable empty or all-empty the relay will not start
   (`config.go:197-199`). Normally keep the operator key.
3. `docker compose up -d`.
4. Verify `/healthz` is 200 and publish a test event with the operator key.
5. Confirm a removed key can no longer write: a publish from it now returns
   `blocked: not an allowed publisher`. Confirm it can still **read** — reads are
   not gated, so a removed publisher retaining read access is correct behaviour,
   not a leak.
6. Delete the stale `.bak` files you no longer need once the final list is
   verified; keep the last known-good one.

> TODO(rehearsal): record the time needed for the full removal pass, including
> the rejected-write confirmation: ____ minutes.

## Out of scope

No hot reload and no NIP-86 management API. Both would mean new relay code, and
two restarts on the pilot day do not justify it. If the publisher count grows,
revisit then.
