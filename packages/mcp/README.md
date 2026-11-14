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

`SCRUTINY_SIGNER_URI` is the pilot path: the key stays in the NIP-46 bunker (`nak bunker`, knox). `NSEC`/`NSEC_FILE` is dev-grade only, never a shipped mode.

Signer port (A2, D13): `loadSigner(config, transport?)` resolves one of the two backends and
returns `{ mode, publicKey, sign(template) }`. The NIP-46 branch needs an injected relay
transport (`src/identity/transport.ts`); A4 supplies the WebSocket and hands the signer to the
publishing tools. Both branches reject a `created_at` outside the relay's gate (2 h past,
15 min future) before signing, naming the measured offset.

The eight #108 tools are wired in `src/tools/handlers/`: the server composes content (`src/compose/`, rule 8 + rule 2a restatement), runs the preflight table (`src/preflight/checkTable.ts`) before any signature, publishes over the A3 relay client, and fetches every event back for an inline verification. The long-form publisher guide (#109) is served as the `scrutiny://publisher-guide` resource from `docs/publisher-guide.md`.
