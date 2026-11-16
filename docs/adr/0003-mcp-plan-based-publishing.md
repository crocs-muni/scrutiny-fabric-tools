# ADR-0003: MCP publishing is plan-based, approved once, signed just in time

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Spec** | [`docs/specs/mcp-publishing.md`](../specs/mcp-publishing.md) |
| **Supersedes** | The tool surface in #108 and prototype PRs #116–#121 |
| **Evidence** | [`investigations/publishing-system/REPORT.md`](../../investigations/publishing-system/REPORT.md), [`investigations/mcp-prototype/REPORT.md`](../../investigations/mcp-prototype/REPORT.md) |

## Context

The prototype MCP server (#116–#121) exposed one tool per event type, and each call signed and
published immediately. The target workflow is different. A publisher points an agent at a local
folder; the agent proposes a set of events; the user approves; then everything is published. Events
are permanent and public, relays enforce `created_at` windows and rate limits, and the pilot is a
single day with any MCP host.

## Decisions

1. **The unit is a plan.** It is a graph of records with local refs. Approval binds the canonical
   template graph (content, tags with ref placeholders, pubkey, relays, blob hashes). `created_at`
   and event ids are assigned at send time, so rate limits and slow approvals cannot invalidate an
   approved plan.
2. **Each event is signed just before it is sent**, in a fixed order (profile → products →
   metadata → bindings). A child is signed only after its parents are acked by the primary relay
   (invariant A). Retries resend identical bytes. On resume, an un-acked event is looked up on the
   relay: if it is stored it is marked acked; otherwise it is re-signed with a fresh `created_at`,
   which cannot fork anything because it has no signed children. A journal makes runs resumable,
   and an approval stays valid for 30 minutes so a resume after a host timeout does not ask again.
3. **Custody Level 1:** the threat is an honest agent that makes mistakes. The key lives in the OS
   keystore. The spec states that an injected agent with shell access can read it.
4. **Approval is rendered by the server** through elicitation (MCP 2025-11-25, SDK v1), with a chat
   fallback for hosts without elicitation. The fallback relies on the agent relaying the summary
   honestly, which is accepted at Level 1. MRTR (MCP 2026-07-28) is deferred until a pilot host needs it.
5. **The agent supplies meaning; the server derives everything mechanical** (hashes, tags,
   composition, ids). Records cite `sources`. `draft_plan` returns open questions, which drives an
   iterative interview.
6. **Artifacts:** Blossom on the primary relay (`relay.scrutiny.cloud`, allowlisted uploads, no
   deletes), plus publisher-hosted URLs verified by SHA-256 against the local file.
7. **Relays are a per-plan input.** The server asks when they are missing. The first relay is the
   primary and gates progress; the others are best-effort mirrors receiving identical bytes.
8. **No deduplication across runs in v1.** Read-before-write is specified but deferred.
9. **Rewrite from the spec.** The prototype is closed; its tests are carried over selectively
   according to the audit.
10. **No environment-variable or file key.** Tests inject a signer through the port.
11. **Four tools:** `status`, `draft_plan` (inline plan or a path to a plan file), `publish_plan`,
    `verify`. Each has an `outputSchema`, and every failure uses one refusal shape.
12. **Layered guidance**, with `draft_plan` results as the primary channel. Examples are
    vendor-neutral.
13. **Distribution:** npm, with the exact version pinned in host config and depending on the
    published core. A CLI in the same binary handles `keygen` (keystore plus `ncryptsec` backup),
    `import` and `whoami`. Keystore-less Linux (`unlock`) is deferred. Publishers' npubs are
    allowlisted before pilot day.
14. **v1 record types:** `profile`, `product`, `metadata`, and bindings derived from `bind_to`.
    Patches and retractions are deferred.

## Rejected

- **Per-event tools that sign immediately:** approval lives only in the chat, plans fail halfway,
  and the agent has to sequence ids.
- **Signing the whole plan at approval time:** caps plan size at the relay's clock window and
  breaks under rate limits.
- **A plaintext key in an environment variable or `mcp.json`:** prompt-injection exfiltration class;
  rejected in #108 and again here.
- **NIP-46 in v1:** about 700 lines in the prototype, never completed a live handshake, and not
  needed at Level 1.
- **Public Blossom servers:** no retention guarantee and third-party operators.
- **`npx nostr-tools generate-key`:** the package has no CLI binary; `nak key generate` prints the
  secret to stdout, where an agent running it would capture it.

## Consequences

- The relay gains a Blossom endpoint (separate PR, same VM and domain). `PUT /upload` is exempt from
  the relay's 64 KiB HTTP body cap and has its own 50 MB cap. The blob directory is the index; no
  kind-24242 records enter the event store.
- `draft_plan` cannot detect a key that is missing from the allowlist (NIP-42 auth succeeds for any
  key). The allowlist is handled during onboarding and reported at publish time.
- `@crocs-muni/scrutiny-fabric` must be on npm before the MCP package (publication planned; the registry returned 404 for `@crocs-muni/scrutiny-fabric` on 2026-11-16).
- The pilot hosts and their MCP versions must be confirmed at the start of the build. A host that
  speaks only 2026-07-28 brings MRTR into v1.
