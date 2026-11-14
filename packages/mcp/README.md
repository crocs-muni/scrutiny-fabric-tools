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

Scaffold of the eight #108 tools (`src/tools/`); publisher guide: #109.
