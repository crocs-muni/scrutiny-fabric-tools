# Demo corpus for the 2026-11-24 company testing

A 28-event corpus for the fictional smartcard vendor **Acme Secure**, built for the #192 pilot
session: two companies publish their own data against `wss://relay.scrutiny.cloud` and browse
Lens unguided. The corpus exists so a presenter can open Lens on a relay that already looks
like a vendor's public graph — product cards, bound records, an advisory with an edit history
and a retracted record — and so an analyst can ask questions whose answers are in the events.

The shapes mirror the pilot corpus in the publishing-system report (§4.4): one vendor profile,
one family Product, two part-number Products, six test/evaluation records with PDF artifacts,
one advisory, two specifications, twelve Bindings, one patch and one clearly labelled test
record with its retraction. Every name, part number, laboratory and artifact is fabricated, and
every URL is under `.example`, so nothing resolves.

## The corpus at a glance

| Role | Count | What it is | Tool |
| --- | --- | --- | --- |
| profile | 1 | kind-0 publisher profile; the Lens publisher chip | `set_profile` |
| product | 3 | family `AS-SE1`, recommended part `AS-SE1-C2P-T301`, discontinued board `AS-SE1-B2S-T005` | `publish_product` |
| metadata:test | 6 | PUF, ISAP, AES-GCM, TRNG, decapsulation and fault-injection evaluations, each with its PDF | `publish_metadata` |
| metadata:advisory | 1 | laser fault-injection advisory `ODR_AS-SE1_SA_2026030100`, with its PDF | `publish_metadata` |
| metadata:specification | 2 | SE-1 security architecture note, T301 datasheet | `publish_metadata` |
| metadata:test-record | 1 | `TEST-ACME-DEMO-0001`, labelled as a demo record, retracted in the same run | `publish_metadata` |
| binding | 12 | every record reachable from a product; three records are bridges to two products | `publish_binding` |
| patch | 1 | the advisory's affected-version sentence updated to name the fixed release | `publish_patch` |
| retraction | 1 | kind-5 over the demo test record, with a reader's reason | `retract` |

26 kind-1 events, one kind-0, one kind-5. The patch is what makes Lens show `edited ×1` on the
advisory; the retraction is what makes one node render retracted without retracting a record
that claims to be real.

## How it is built

`corpus.mjs` is the corpus as data: one step per tool call, with symbolic references
(`root: 'family'`, `target: 'advisory'`) that `publish.mjs` resolves to event ids. No event text
is written by hand — the same MCP handlers a host calls compose the content, derive the tags,
preflight the event and sign it, so this corpus exercises the shipped publisher surface instead
of a parallel one. The patch baseline is read back from the relay, never reconstructed, because
`publish_patch` refuses a `before` that is not the content the target resolves to.

## Publish locally

The default mode builds `relay/cmd/relay` with Go, starts it on a free loopback port with a
throwaway data directory and an allowlist holding only this run's pubkey, publishes the corpus,
and removes the relay and its data afterwards. Requires Go and Node 23.6 or newer (the repo's
`packages/mcp/scripts/e2e.mjs` has the same floor; on Node 22.x add `--experimental-strip-types`).

```bash
# compose and preflight into an in-memory relay, print every event, send nothing
node examples/demo-corpus/publish.mjs --dry-run

# boot a local relay and publish all 28 events, verifying each one on the way
node examples/demo-corpus/publish.mjs

# same, against a relay you already run
node examples/demo-corpus/publish.mjs --relay ws://127.0.0.1:3334

# write the signed set for later inspection or a byte-level diff of the ids
node examples/demo-corpus/publish.mjs --out events.ndjson
```

Point Lens at `ws://127.0.0.1:3334` (or the port the run prints) and open any product card.
`queries.md` lists six questions that work against this corpus and what each must show.

### Determinism

`--now <iso|epoch>` fixes the `created_at` base; the server stamps `now, now+1, …` in publish
order. Event ids hash the signed fields, so the same `--now` and the same arguments produce the
same 28 ids. A second run against a relay that already holds them adds nothing: the relay keeps
its first copy of a known id and the CLI reports `already stored` per event, after proving each
one with `verify_event`. Signatures are *not* stable across runs — the dev signer draws a random
BIP-340 auxiliary nonce — so the event bytes differ in `sig` while ids, content and tags match,
and `--out` from a re-run writes the relay's first copies.

`--now` must sit inside the signer's window (at most 15 minutes ahead of the publishing machine,
at most 2 hours behind the relay's clock). It is for reproducing a run, not for backdating: the
date a record describes belongs in the prose.

### Compatibility profile

Three decisions keep the corpus rendering in Lens today, and each is one edit away from the
strict form:

- **Metadata subtype.** Lens knows `report`, `target`, `maintenance`, `sbom` and `advisory`
  (`src/lib/ai/agents/nodes.ts`); `specification` and `test` would render as `unknown`. The
  corpus declares the role in `corpus.mjs` and publishes the documented compatibility value
  (`report`) through `LENS_SUBTYPE`.
- **Binding hints.** Each Binding carries the publisher pubkey in the NIP-10 author-hint slot
  and no relay hint: the author is stable across a local run and production, while a relay hint
  would be an ephemeral loopback URL in a local run.
- **Artifacts are placeholders.** `imeta` URLs do not resolve and `size`/`x` are not real file
  measurements: `x` is the SHA-256 of a fixed label. Replace both with values computed from the
  file you actually upload before using this corpus for anything but a demo (guide §5).

Known gap: the advisory has no `["identifier", …]` tag. Lens uses that tag as a graph-title
hint (`src/lib/ai/projector.ts`), and no MCP tool can emit it — `publish_metadata` composes
`t`, `i`, `k`, `imeta` and `meta` only. Until the tool surface grows an extra-tag input (or
Lens derives titles from `i`), the advisory's title falls back to its content head.

## Publish to production before the 24th

The pilot relay is `wss://relay.scrutiny.cloud`. It gates writes on an allowlist, so the key you
publish with must be in `SCRUTINY_ALLOWED_PUBKEYS` (`relay/deploy/README.md` §3). Publish with
the operator's bunker key, not the demo key, when the corpus should look like the operator's
publication; publish with the demo key when it should look like a vendor's.

```bash
# on the publishing laptop: the key stays in this process, never in a flag or a file
nak bunker --prompt-sec wss://relay.scrutiny.cloud     # prints bunker://<signer>?relay=…&secret=…

node examples/demo-corpus/publish.mjs \
  --relay wss://relay.scrutiny.cloud \
  --bunker 'bunker://…' \
  --out examples/demo-corpus/events.ndjson
```

The run prints `PASS` only after every event's read-back matched its signature and id, then
point Lens at `wss://relay.scrutiny.cloud`. Every id it printed is fetchable with
`REQ {"ids":[…]}`; the NDJSON is the same byte set, minus its signatures' auxiliary nonces.

This is a permanent public write: the relay stores the events and has no delete path for a
publisher, so a mistyped corpus stays visible until the operator wipes it. Rehearse with
`--dry-run`, then publish once. Run it before the session, not during: the relay refuses an
event older than 2 hours, and the demo needs the events present when Lens is opened.

## The throwaway key

The default dev key is published in `publish.mjs` on purpose: a corpus that needs a secret
cannot be committed, reviewed or replayed. Its identity is

```
npub1npxmrhuxfec9kxyxawms9lyluxswl62gjzntzh650avpgxkrltcqsv0uym
hex 984db1df864e705b1886ebb702fc9fe1a0efe94890a6b15f547f58141ac3faf0
```

Treat it as disposable. Anyone can sign as this key, so:

- use it for demo and test data only, never for a record a reader should trust;
- add it to a relay's allowlist only for a session you are willing to see it in;
- rotate it by editing `DEMO_DEV_KEY` and re-running — the ids change, so the corpus is a new
  publication, not an update;
- keep the production publish on the operator's bunker key, where the secret never enters the
  repository, a flag or an NDJSON file.

## Files

| File | Role |
| --- | --- |
| `corpus.mjs` | the 28 steps as data, plus the Lens compatibility map |
| `publish.mjs` | the CLI: local relay, remote relay, dry run, NDJSON out, fixed clock |
| `queries.md` | six presenter/analyst questions and the result each must show |
| `.gitignore` | keeps generated `*.ndjson` out of the commit |
