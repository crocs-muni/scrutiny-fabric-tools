# @scrutiny-fabric/mcp

Publish-first MCP server: the agent supplies structured fields, the server composes the event, signs through a signer port (D13) and publishes. No tool accepts event text or key material (#108).

Stdio, host-agnostic — Claude, Codex, OpenCode, any MCP host.

```json
{ "mcpServers": { "scrutiny-fabric": {
  "command": "node",
  "args": ["--experimental-strip-types", "<repo>/packages/mcp/src/index.ts"],
  "env": { "SCRUTINY_RELAY_URL": "wss://relay.scrutiny.cloud",
           "SCRUTINY_SIGNER_URI": "bunker://<signer-pubkey>?relay=wss://relay.scrutiny.cloud" }
} } }
```

`SCRUTINY_SIGNER_URI` is the signer-daemon path: the key stays in a NIP-46 bunker (`nak bunker`, knox, Amber) and this process only ever asks for signatures. Note: the NIP-46 client here has **not** been validated against a live bunker, and the bunker channel needs a coordination relay the fabric relay cannot be (it accepts kinds 0/1/5 only). `SCRUTINY_KEYRING` is the pilot default; `NSEC`/`NSEC_FILE` is test-grade only.

Signer port (A2, D13): `loadSigner(config, transport?)` resolves one of the two backends and
returns `{ mode, publicKey, sign(template) }`. The NIP-46 branch needs an injected relay
transport (`src/identity/transport.ts`); A4 supplies the WebSocket and hands the signer to the
publishing tools. Both branches reject a `created_at` outside the relay's gate (2 h past,
15 min future) before signing, naming the measured offset.

The eight #108 tools are wired in `src/tools/handlers/`: the server composes content (`src/compose/`, rule 8 + rule 2a restatement), runs the preflight table (`src/preflight/checkTable.ts`) before any signature, publishes over the A3 relay client, and fetches every event back for an inline verification. The long-form publisher guide (#109) is served as the `scrutiny://publisher-guide` resource from `docs/publisher-guide.md`.

## End-to-end harness (`e2e`)

`pnpm --filter @scrutiny-fabric/mcp e2e` proves the whole loop against a real relay, not a fake one:
it builds `relay/cmd/relay` from this checkout, starts it on a free loopback port with a throwaway
data directory and an allowlist of fixture keys, then drives `buildServer` in-process over the
SDK's in-memory transport (dev-key signer) through `status` → `set_profile` → `publish_product`
(the publisher guide §8 inputs) → `publish_metadata` → `publish_binding` → `publish_patch` →
`verify_event` → `retract`. The `verify_event` step re-reads the stored Product and byte-compares
its content and tag block with the guide's documented blocks; the retraction must leave the
retracted event fetchable (DEL-11). It prints a `step | id | accepted | verified` table and exits
non-zero on the first mismatch. The relay process and the temp directory are removed in `finally`.

Requirements: Node ≥ 22 (the script imports the `.ts` sources with Node's type stripping — core is
resolved from source, so no `pnpm build` is needed) and a Go toolchain. Without `go` on `PATH` the
script prints `SKIPPED: go not found` and exits 0, so a CI job that has no Go stays green.

Four gate cases run after the loop; each prints `PASS`/`FAIL` and never aborts the others:

| Case | What is asserted |
| --- | --- |
| not allowlisted | a throwaway dev key authenticates but the relay answers `blocked: not an allowed publisher`, and nothing is stored |
| oversized payload | a >64 KiB headline is refused before signing, naming `content` and RL-1, and the relay's write counters do not move (no EVENT frame left the process) |
| future clock | a +20 min clock is refused before any signature, naming the measured offset and the relay's 15 min `maxFutureAge` |
| author mismatch | an event signed by key A, published on a connection authenticated as key B, is answered `blocked: event author must be the authenticated pubkey` |

The write-counter checks read the relay's `/metrics`, which is loopback-only; the harness skips
those sub-checks (with a `SKIP` line) when it targets a remote relay.

### Dress rehearsal against production (2026-11-23)

Set both variables; when `SCRUTINY_RELAY_URL` is present the harness builds nothing and targets
that relay:

```sh
SCRUTINY_RELAY_URL=wss://relay.scrutiny.cloud \
SCRUTINY_SIGNER_URI='bunker://<signer-pubkey>?relay=wss://relay.scrutiny.cloud' \
pnpm --filter @scrutiny-fabric/mcp e2e
```

`SCRUTINY_SIGNER_URI` is required in this mode — the harness refuses to run a dev key against a
remote relay, because the key would have to be on that relay's allowlist. Every write goes through
the bunker, so expect one approval prompt per event (six writes: profile, product, metadata,
binding, patch and the retraction).

What "pass" means: every publish returned `accepted: true, verified: true`; the stored Product's
bytes equal the guide's §8 composed block and tag block; the retraction was stored and the
retracted Product stayed fetchable; and each gate case printed `PASS` with the documented wording.
The `author-mismatch` case is skipped remotely — it needs two allowlisted keys, which only a relay
you control offers.

When it fails, the line names the step and what was observed. `status` first: `signer: none` or a
relay URL mismatch means configuration, not code. A publish with `accepted: false` carries the
relay's message verbatim — `blocked: not an allowed publisher` means the bunker's user pubkey is
not in `SCRUTINY_ALLOWED_PUBKEYS`; `created_at is … ahead of this machine's clock` means this
machine's clock, not the server. A refuse-before-signing line names the schema field and the fix,
and nothing was signed, so the fix costs no approval. `accepted: true, verified: false` means the
write is unproven, not failed: run `verify_event` with the returned id before republishing.
