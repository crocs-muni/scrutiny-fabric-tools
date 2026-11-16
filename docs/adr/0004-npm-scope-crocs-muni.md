# ADR-0004: npm scope `@crocs-muni`, flagship `@crocs-muni/scrutiny-fabric`

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Supersedes** | ADR-0001 **D3** ("`@scrutiny-fabric` scope, flagship pattern") |

## Context

D3 (2026-07-27) chose the `@scrutiny-fabric` scope on the atproto model: the protocol, not the
publisher, names the scope, so third-party implementations read as siblings of the reference one.
D3 also verified that neither the scope nor the flat name `scrutiny-fabric` was taken on npm.

By November 2026 the protocol had a publisher. On the public registry an organization publishes
only under a scope equal to its own name, so the org name decides the scope, not the other way
around. The lab's org was created as `crocs-muni`: the lab is the durable home of record (no
foundation or governance transfer is expected), and a lab-held account is what makes the npm
identity something the lab can maintain as a process — two owners, shared recovery — rather than
a personal account that leaves when its holder does.

## Decision

- **npm org:** `crocs-muni`, free "Unlimited public packages" plan, owned by the lab.
- **Flagship package:** `@crocs-muni/scrutiny-fabric`. The full protocol name moves to the package
  part; `@crocs-muni/core` reads as nothing, and `@crocs-muni/fabric` is unsearchable and collides
  with Microsoft Fabric in every npm result.
- **Future packages** follow the same shape: `@crocs-muni/scrutiny-fabric-cli`,
  `@crocs-muni/scrutiny-fabric-mcp`.
- **Unchanged:** `packages/mirror` keeps `@scrutiny-fabric/mirror` (private, never published), and
  the `Symbol.for('@scrutiny-fabric/trust|storage|transport')` brands keep the protocol name —
  they identify a protocol interface across realms, not an npm package.
- **Publishing** is OIDC-only after the first release (`.github/workflows/release.yml`,
  tag-triggered, npm trusted publishing, no `NPM_TOKEN`). The first version is published manually
  by an org member with 2FA, because trusted publishing cannot create a package's first version.

## Consequences

- Renaming at 0.1.0 costs nothing: nothing had been published, so no downstream consumer exists.
  After the first publish the name is effectively frozen.
- Third-party implementations no longer sit beside the reference one inside one npm scope; they
  depend on `@crocs-muni/scrutiny-fabric` and publish under their own scopes — the nostr pattern
  (`@nostr-dev-kit/ndk`, `@rust-nostr/nostr-sdk` beside `nostr-tools`).
- The lab name appears in every install line and import path. Deliberate: it is the citation
  credit for a university protocol and the lab is the home of record.
- If the protocol ever moves to a foundation, the org can be transferred without renaming
  packages (a registry transfer, not a rename).
