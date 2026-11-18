# @crocs-muni/scrutiny-fabric-mcp

An MCP server that turns a publisher's local security files (datasheets, test reports, advisories)
into [SCRUTINY Fabric](https://github.com/crocs-muni/scrutiny-fabric) events and publishes them to
Nostr relays after the user approves the exact plan. The agent drafts a plan; the server composes,
checks, signs and publishes it. Design: [docs/specs/mcp-publishing.md](../../docs/specs/mcp-publishing.md).

Requires Node.js 22 or later. The signing key lives in the OS keystore (macOS Keychain, Windows
Credential Manager, Linux Secret Service); it is never in a file, an environment variable or the
host's configuration.

## 1. Create your key (once per laptop)

```bash
npx @crocs-muni/scrutiny-fabric-mcp@0.2.0 keygen
```

`keygen` stores the key in the OS keystore and prints two things:

- your **npub**: send it to the relay operator, who adds it to the relay's publisher allowlist;
- an **ncryptsec** backup (the key encrypted with a password you choose): store it, with the
  password, somewhere safe.

In a terminal it asks for the backup password twice, with no echo. With no terminal it reads
**exactly one** line from stdin instead, so a script or an agent can create the key and keep the
password it generated:

```bash
printf '%s\n' "$BACKUP_PASSWORD" | npx @crocs-muni/scrutiny-fabric-mcp@0.2.0 keygen
```

Either way the password is never an argument (shell history) and the key itself is never printed.

`import` loads an existing key instead (it prompts for it; never pass a key as an argument), and
`whoami` prints the npub in use.

## 2. Warm the npx cache (once)

The first `npx` run downloads the package and the native keyring binary, which can take longer
than a host's default server-start timeout. Run the server once in a terminal, wait until it is
silent (it is waiting for a host on stdin), then press Ctrl+C:

```bash
npx -y @crocs-muni/scrutiny-fabric-mcp@0.2.0
```

## 3. Add the server to your host

Every snippet pins the **exact** version, so a later (possibly tampered) release is never picked
up silently. When you upgrade, change the version on purpose.

Each snippet also raises the host's timeouts where it has them: 120 s for server start (a cold
`npx` start), and 120 s for a tool call (`publish_plan` returns within about 25 s and resumes on
the next call, so this is margin).

On Windows, plain `npx` works in every host below that documents Windows. If a host reports that
it cannot find `npx` (`ENOENT`), use `"command": "cmd"` with `"args": ["/c", "npx", "-y",
"@crocs-muni/scrutiny-fabric-mcp@0.2.0"]` instead.

### Claude Code

```bash
claude mcp add --scope user scrutiny-fabric -- npx -y @crocs-muni/scrutiny-fabric-mcp@0.2.0
```

or, shared with a project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "scrutiny-fabric": {
      "command": "npx",
      "args": ["-y", "@crocs-muni/scrutiny-fabric-mcp@0.2.0"],
      "timeout": 120000
    }
  }
}
```

Server start: the `MCP_TIMEOUT` environment variable, in ms (default 30000). Start Claude Code with
`MCP_TIMEOUT=120000 claude` (PowerShell: `$env:MCP_TIMEOUT=120000; claude`), or warm the cache
first (step 2).

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "scrutiny-fabric": {
      "command": "npx",
      "args": ["-y", "@crocs-muni/scrutiny-fabric-mcp@0.2.0"]
    }
  }
}
```

Quit and restart Claude Desktop afterwards. It has no documented timeout setting, so warm the cache
first (step 2). The server's log is `mcp-server-scrutiny-fabric.log` in Claude's `logs` folder.

### Codex (CLI, ChatGPT desktop app, IDE extension)

All three read `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows):

```toml
[mcp_servers.scrutiny-fabric]
command = "npx"
args = ["-y", "@crocs-muni/scrutiny-fabric-mcp@0.2.0"]
startup_timeout_sec = 120   # default 10: too short for a cold npx start
tool_timeout_sec = 120      # default 60
```

`codex mcp add scrutiny-fabric -- npx -y @crocs-muni/scrutiny-fabric-mcp@0.2.0` adds the first
three lines; add the timeouts by hand. The approval dialog needs `approval_policy` to let MCP
elicitations through: `"never"` declines them, and so does a granular policy without
`mcp_elicitations = true`.

### opencode

In `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "scrutiny-fabric": {
        "type": "local",
        "command": ["npx", "-y", "@crocs-muni/scrutiny-fabric-mcp@0.2.0"],
        "timeout": { "startup": 120000, "execution": 120000 }
      }
    }
  }
}
```

Older opencode versions (config format V1) take the server directly under `mcp`, with
`"enabled": true` and a single `"timeout": 120000`.

### omp (oh-my-pi)

In `~/.omp/agent/mcp.json` (user) or `.omp/mcp.json` (project); omp also reads a project's
`.mcp.json`:

```json
{
  "mcpServers": {
    "scrutiny-fabric": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@crocs-muni/scrutiny-fabric-mcp@0.2.0"],
      "timeout": 120000
    }
  }
}
```

omp uses one timer, default 30 s, for both server start and each tool call (`OMP_MCP_TIMEOUT_MS`
overrides it for all servers), so set `timeout`.

### VS Code (GitHub Copilot) and Cursor

Both take the same `mcpServers` shape, in `~/.copilot/mcp-config.json` (VS Code) or
`~/.cursor/mcp.json` / `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "scrutiny-fabric": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@crocs-muni/scrutiny-fabric-mcp@0.2.0"]
    }
  }
}
```

Neither documents a timeout setting; warm the cache first (step 2).

## 4. Check it

Ask the agent to call the `status` tool. `signer.state` must be `ready` and `signer.npub` must be
the npub you sent the relay operator. Otherwise `signer.fix` says what to do.

## How publishing works

1. Point the agent at a folder with your files and ask it to publish them. It reads the
   `scrutiny://publisher-guide` resource, drafts a plan, and calls `draft_plan`.
2. `draft_plan` checks the plan and returns a preview plus **open questions**; the agent asks you
   the ones it cannot settle and drafts again until the plan is ready.
3. `publish_plan` asks for your approval of that exact plan (its hash):
   - in hosts with MCP form dialogs (elicitation), as an approve/decline dialog;
   - otherwise in the chat: the agent shows you a summary and a six-character code, and you reply
     with the code to approve. This also happens when a host announces dialogs but cancels the
     dialog or never shows it (reported for Claude Desktop chat and Cowork). Declining the dialog
     stops there, with no code offered.
4. The server signs and publishes in a fixed order, reads each event back from the relay, and
   records progress in `.scrutiny/` inside your folder, so an interrupted run resumes without
   duplicates. `verify` re-checks published events at any time.

Published events are immutable; corrections are new events. The preview says which fields can
never change.

## Development

```bash
pnpm -C packages/mcp test     # unit and integration tests
pnpm -r build && pnpm -C packages/mcp run e2e   # real relay (needs Go) and the built bin over stdio
```

The e2e builds `relay/cmd/relay`, starts it on a loopback port and publishes through it. Without Go
it fails; it never skips.
