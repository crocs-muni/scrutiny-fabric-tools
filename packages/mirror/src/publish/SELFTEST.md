# publish/ + probe/ self-test (acceptance evidence)

Run:

```
cd packages/mirror
bun src/publish/selftest.ts        # all three parts, exits non-zero on first failed assertion
```

The script is fully local: it starts an in-code mock relay (`Bun.serve` websocket) and a dead-port
probe. No event was published to any real relay. `wss://nos.lol` was contacted read-only (REQ /
NIP-11 fetch only) for the probe-shape example below.

## What is asserted

| Area | Assertions (all executed, all passing) |
|---|---|
| ledger (part 1) | 6 rows upserted → still 6 after re-upsert of 1 row with changed columns (PK `corpus,source_id`); `readAll()` returns records=6 / publish_log=2 / relays=1; persisted across close+reopen; `wasPublished` true for ok row, false for rejected row and for a different relay; last-write-wins on `(event_id, relay)` |
| publish (part 2, run 1) | NIP-42 late challenge: first EVENT → `auth-required` → AUTH handshake → automatic resend; 6 events → accepted=5/rejected=1/skipped=0; rate-limited event retried exactly once after backoff; pacing gaps ≥ pace−30 ms; per-event NIP-20 msg captured into `publish_log` (duplicate/invalid text); non-retryable `invalid:` not retried; ledger marks only ok rows as published |
| publish (part 2, run 2) | resume-skip: skipped=5 (exactly the previously-acked ids), only the previously rejected event re-touched the relay (2 network messages: auth dance + rejection) |
| publish (part 2, run 3) | `limit=1`, `skipPublished=false`: one event published |
| probe (part 3) | mock relay: 5 filters sent, `facet-t` returns 1 mock event, search rejected with `unrecognised filter item: search`; AUTH handshake accepted when key given (kind:22242 with matching `relay`/`challenge` tags validated server-side), no-key run receives the challenge but sends nothing; dead port → `unreachable`, zero probes; **mock recorded 0 EVENT messages from probe runs** (probe never publishes) |

## Captured output (2026-10-04, Bun 1.4.0)

```
== part 1: ledger sqlite round-trip ==
  file: artifacts/selftest/mirror-selftest.sqlite
  write: 6 rows upserted, then 1 re-upserted (2 modified columns)
  read:  records=6 publishLog=2 relays=1
  reopen: records=6 publishLog=2 relays=1
  PASS

== part 2: publishBatch vs in-code mock relay ==
  mock relay: ws://127.0.0.1:49770 (NIP-42 late challenge, NIP-20: rate-limit/invalid/duplicate)
  run1: total=6 accepted=5 rejected=1 skipped=0 networkEvents=8
  run1 gaps between network events (ms): 3, 124, 152, 125, 124, 126, 123
  backoff gap for rate-limit retry: 152 (base 150)
  pacing gaps (min): 123 (pace 120)
  NIP-20 captured: e6 msg='duplicate: already have this event', e5 msg='invalid: bad signature'
  run2 (resume): total=6 accepted=0 rejected=1 skipped=5 networkEvents=2
  run3 (limit=1, skipPublished=false): total=1 accepted=1
  PASS

== part 3: relayProbe (read-only) ==
  probe(mock, key): reachable; nip11 absent; filters accepted 4/5; search rejected (unrecognised filter item: search); auth ok
  probe(mock, key): [["facet-t",true,1],["i-exact",true,0],["k-facet",true,0],["kind5-e",true,0],["search",false,0]]
  probe(mock, no key): reachable; nip11 absent; filters accepted 4/5; search rejected (unrecognised filter item: search); auth challenge seen (no key given)
  probe(dead port): unreachable: websocket error connecting to ws://127.0.0.1:1
  PASS

selftest: ALL PASS
```

Numbers of record: 6 record rows written (12 would have been written without the PK), 3
publish_log writes (2 distinct rows), 1 relay capability row, 6 publish_log rows after the batch
run. Mock relay network messages run1: 8 (6 events + 1 auth-required retry + 1 rate-limit retry).

### Mock relay semantics (in-code, `selftest.ts`)

- `challengeOnConnect=false` for the batch test: the relay demands AUTH only on the first
  unauthenticated EVENT (`["AUTH", "mock-challenge-late"]` + `OK false "auth-required: …"`), which
  exercises `authedSocket`'s post-rejection retry path deterministically. `challengeOnConnect=true`
  for the probe test exercises the challenge-on-open path.
- Server validates the AUTH event (kind 22242, `relay` = connected URL, `challenge` = issued value)
  before acking. A bad AUTH is answered `OK false "invalid: bad AUTH event"`.
- One event id is answered `OK false "rate-limited: too much for this connection"` on first hit and
  `OK true ""` afterwards (backoff + retry). Another is answered
  `OK false "invalid: bad signature"` permanently. The rest `OK true "duplicate: already have this
  event"` (NIP-20 msg capture).

## Probe JSON shape examples

### Unreachable relay (probe vs nothing): `artifacts/probe-2026-10-04T23-38-52-901Z.json`

```json
{
  "relay": "wss://relay.example.com",
  "probed_at": "2026-10-04T23:38:52.900Z",
  "nip11_doc_present": false,
  "supported_nips": null,
  "nip11_name": null,
  "connected": false,
  "per_probe": [],
  "auth": {
    "attempted": false,
    "challenge_received": false,
    "ok": null,
    "msg": "connect failed: connect timeout after 8000ms"
  },
  "verdict": "unreachable: connect timeout after 8000ms"
}
```

### Live relay, read-only: `wss://nos.lol`, without key (`artifacts/probe-2026-10-04T23-38-53-624Z.json`)

```json
{
  "relay": "wss://nos.lol",
  "probed_at": "2026-10-04T23:38:53.623Z",
  "nip11_doc_present": true,
  "supported_nips": [1, 2, 4, 9, 11, 28, 40, 45, 70],
  "nip11_name": "nos.lol",
  "connected": true,
  "per_probe": [
    { "name": "facet-t", "filter": { "kinds": [1], "#t": ["jcalgtest"], "limit": 3 }, "accepted": true, "events_returned": 0, "notice": null, "ms": 78 },
    { "name": "i-exact", "filter": { "kinds": [1], "#i": ["i-nonexistent-x1"] }, "accepted": true, "events_returned": 0, "notice": null, "ms": 33 },
    { "name": "k-facet", "filter": { "kinds": [1], "#k": ["vendor"] }, "accepted": true, "events_returned": 0, "notice": null, "ms": 40 },
    { "name": "kind5-e", "filter": { "kinds": [5], "#e": ["0000000000000000000000000000000000000000000000000000000000000000"] }, "accepted": true, "events_returned": 1, "notice": null, "ms": 36 },
    { "name": "search", "filter": { "kinds": [1], "search": "__scrutiny_probe_unlikely__" }, "accepted": false, "events_returned": 0, "notice": "ERROR: bad req: unrecognised filter item: search", "ms": 37 }
  ],
  "auth": { "attempted": false, "challenge_received": false, "ok": null, "msg": null },
  "verdict": "reachable; nip11 present (NIPs 1,2,4,9,11,28,40,45,70); filters accepted 4/5; search rejected (ERROR: bad req: unrecognised filter item: search); auth not attempted"
}
```

(Only `notice` text differs between relays. `per_probe[].ms` varies run to run. The
`kind5-e` = 1 result on nos.lol is some unrelated public kind-5 event whose `e` tag is all zeros.
Recorded verbatim, not interpreted.)

Re-run with an ephemeral key (`bun src/cli.ts probe --relay wss://nos.lol --key <hex>`):
`verdict: …; auth not requested`. nos.lol advertises no NIP-42 and sends no challenge, so nothing
was sent. The on-connect challenge path is proven against the mock relay above.

## CLI smokes

```
$ bun src/cli.ts probe --relay wss://relay.example.com        # unreachable (off-network)
probe: unreachable: connect timeout after 8000ms
  report: artifacts\probe-2026-10-04T23-38-52-901Z.json       # exit 1

$ bun src/cli.ts probe --relay wss://nos.lol                  # read-only, no key
probe: reachable; nip11 present (NIPs 1,2,4,9,11,28,40,45,70); …; auth not attempted   # exit 0

$ bun src/cli.ts gate --in artifacts/selftest/cli-smoke.ndjson
gate: FAIL — events=1 errors=3 lostFacts=0                     # kind-1 smoke event, fail-closed # exit 1
  report: …\artifacts\selftest\cli-smoke.gate.json

$ bun src/cli.ts publish --relay ws://127.0.0.1:1 --in artifacts/selftest/cli-smoke.ndjson --limit 1 --pace 1 --ledger artifacts/selftest/cli-smoke.sqlite --nsec <hex>
publish: total=1 accepted=0 skipped=0 rejected=1 → artifacts\selftest\cli-smoke.publish-log.json   # exit 1
  rejected 24c0f6a8a06d…: connect failed: websocket error connecting to ws://127.0.0.1:1
```

The publish smoke shows the stage-3 artifact shape:
`{"relay":"ws://127.0.0.1:1","total":1,"accepted":0,"rejected":1,"skipped":0,"results":[{"id":"24c0…","ok":false,"msg":"connect failed: …","skipped":false,"attempts":1,"ms":12}],"producedAt":"…"}`.

`build:jcalgtest` orchestrates `loaders/jcalgtest` → `emit` → `writeArtifacts`. The loaders/emit
units were still landing when this file was written. Both error paths were exercised:

```
$ bun src/cli.ts build:jcalgtest
error: key: set NSEC / NSEC_FILE, or pass --nsec <ENV_VAR|hex|nsec1…>            # exit 1

$ bun src/cli.ts build:jcalgtest --nsec <hex>
error: cannot load loaders/jcalgtest (./loaders/jcalgtest.js): Cannot find module … — is the unit built yet?   # exit 1
```

Re-run without `--nsec` once `loaders/` + `emit/` land (and with `--ground-truth` pointing at the
sibling docs repo until the ground-truth inputs are mirrored here).
