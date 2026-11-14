# Publisher guide: SCRUTINY Fabric events through the MCP server

This guide is the MCP resource `scrutiny://publisher-guide`. It teaches you to map vendor data — a datasheet, a CSV, a JSON export — onto the tool inputs of `@scrutiny-fabric/mcp`.

You supply structured fields. The server composes the event content, derives the tags, validates against the relay's gates, signs through a NIP-46 bunker and publishes. You never write event text and never hold the key.

Target protocol: `protocol-spec.md` v0.8.1. Where this guide and the spec disagree, the spec wins.

## 1. What you publish

A publication is a graph, not an upload. Four event types are kind 1 — Product, Metadata, Binding and Patch; a retraction is kind 5, and a profile (kind 0) names you as the publisher.

- **Product** — the thing a reader searches for.
- **Metadata** — one claim about it: a specification, test result, evaluation report, advisory, SBOM or maintenance record.
- **Binding** — the edge that makes a Metadata record reachable from a Product.
- **Patch** — a prose correction to an existing record.
- **Retraction** — a kind 5 statement that you no longer stand by an event; the bytes stay published.

Two rules organise the whole graph:

1. **One Product per searchable thing.** Start with the family name. Add a part-number Product only when that part carries its own documents.
2. **Every Metadata record is bound to at least one Product.** Lens result cards are product cards, so a Metadata record with no product root never appears in the results rail (`src/lib/pipeline/cards.ts:112-116`, report §3.2).

A shared record bound to two Products becomes a bridge node in the Lens graph. That is intended, not noise (report §4.2).

## 2. The tools

Call a tool with the fields in the table. The server composes the content and refuses a payload that would fail a relay gate, naming the field and the fix — so a refusal is a message to act on, not a bug to work around.

| Tool | Call it when | Required fields |
| --- | --- | --- |
| `set_profile` | First, once per publisher key: kind 0 profile that feeds the Lens publisher chip | `name` |
| `publish_product` | A new searchable thing appears | `headline`, `indexers` |
| `publish_metadata` | A specification, test, report, advisory, SBOM or maintenance record appears | `headline`, `indexers`, `meta_subtype` |
| `publish_binding` | A record must become reachable from a product | `root_ref`, `link_ref`, `label` |
| `publish_patch` | Prose in an existing record is wrong or out of date | `target_id`, plus `before`+`after` or `diff` |
| `retract` | You withdraw an event you authored | `target_id`, `reason` |
| `verify_event` | After every publish, to fetch the stored event back | `event_id` |
| `status` | First call of a session | none |

Optional fields shared by `publish_product` and `publish_metadata`: `bullets`, `links`, `card`, `imeta`. `publish_binding` also takes `bullets`. `set_profile` also takes `display_name`, `about`, `picture_url`.

Reference shapes:

- `indexers` is an array of raw `i` strings — `"cve:CVE-2017-15361"`, not `{"prefix":…,"value":…}` (`src/tools/schemas.ts:31-39`).
- `links` is an array of objects: `url` (absolute http(s)) and optional `label` (`schemas.ts:41-48`).
- `imeta` is an array of objects: `url`, `m`, `x`, `size`, `alt` (`schemas.ts:55-72`).
- `root_ref` and `link_ref` are `{ "id": "<64-hex event id>", "relay": "<url>", "author": "<64-hex pubkey>" }`, with `relay` and `author` optional advisory hints (BD-8; `schemas.ts:135-148`).
- `card` is a flat object of string, number or boolean values (`schemas.ts:74-79`).

**You never write event content.** No schema has a `content` field, and every input object is `.strict()`, so an unknown key is rejected rather than silently dropped (`schemas.ts`). The server composes content from your fields and derives the tags: exactly one `t=scrutiny-fabric`, one version tag, one type tag (TAG-1, TAG-2, TAG-3; `packages/mirror/src/emit/content.ts:51-70`), plus one `k` tag per distinct `i` prefix (PR-4, MD-4; `content.ts:83-108`).

Preflight runs before signing. It checks the `t` vocabulary, the clock window, the content and event size bounds (RL-1), the single-letter tag budget, the `i` prefixes and the `imeta` shape (#108, "Composition is deterministic"). The relay can still refuse the event for reasons only it knows — the allowlist and its own clock window — and those refusals are in §7.

## 3. Field rules

| Field | Do | Source |
| --- | --- | --- |
| `headline` | Put the identifying fact in the first line. Clients truncate; a second line is allowed when the server joins it into the same headline | rule 8a; `packages/mirror/src/emit/seccerts/roots.ts:669-676` |
| `bullets` | One fact per line. The server renders each as `- <text>`; no tables and no fenced blocks in root content | rule 8b; `content.ts:147-150` |
| `links` | Absolute http(s) URLs only, with an optional `label`. Lens Files come from `imeta`, not from prose links | `schemas.ts:41-48`; report §3.2 |
| `card` | Flat JSON. The server renders it as the last line, `Record card (JSON): <compact JSON>`, and nothing after it | rule 8c; `content.ts:163-165` |
| `card.type` | Always set `"type": "<vendor>-<kind>@1"`, for example `"acme-datasheet@1"` | rule 8c convention (mirror: `jcalgtest-card@1`) |
| `meta_subtype` | One of `specification`, `test`, `report`, `advisory`, `sbom`, `maintenance`; it becomes the Lens compatibility tag `["meta","<subtype>"]` | `schemas.ts:90-104` |
| `indexers` | See §4 | IX-1..IX-4 |
| `imeta` | See §5 | NIP-92; IM-1..IM-4 |

`meta_subtype` compatibility: Lens reads `report`, `target`, `maintenance`, `sbom` and `advisory` today. The schema also accepts `specification` and `test`, but Lens maps an unknown subtype to `unknown` (`src/lib/ai/agents/nodes.ts:213-224`, report §3.2). Until Lens extends the vocabulary, use `report` for a specification or test record that must render with a subtype now (report §3.3, gap 1).

### Rule 2a: every machine fact also appears in prose

Rule 2a requires every card scalar and every `i` value to appear in the prose as well. The server enforces it by construction and refuses a payload that would lose a fact (`content.ts:222-262`, `assertRule2a`).

Why the rule exists: the record card is one machine-readable line at the end of the content, and many clients — including Lens's AI summariser — read prose only. A fact that lives only in the card is invisible to them, and a fact in neither the card nor the prose is invisible everywhere.

Keep facts machine-shaped and let the server restate them. Three consequences for how you write:

- You do not need to match case or punctuation. Matching is casefold and separator-insensitive: `EAL6+` in the card is satisfied by `eal6` in prose (`content.ts:241-250`).
- Card strings shorter than 4 characters are not checked (`content.ts:229`).
- Four exemptions are automatic: a value containing `«`, a hex run of 60 or more characters (event ids, artifact hashes), a string ending in `@<digits>`, and the `jcver-lte` cohort buckets (`content.ts:24-27`, `content.ts:185-190`). The `@1` in `card.type` is the third of these — that is why the type string carries a version suffix.

If a fact is missing, the server appends a restatement bullet rather than dropping the fact or publishing an event that fails the mirror gate. Write the bullets yourself anyway: your sentence is better than the server's.

## 4. Indexers

`i` tags are the discovery surface: they are what a `#i` filter matches. Choose them before you publish, because they cannot change afterwards (IX-3).

| Prefix | Use for | Example | Source |
| --- | --- | --- | --- |
| `cve` | CVE id | `cve:CVE-2017-15361` | spec §9 |
| `cwe` | Weakness class | `cwe:CWE-310` | spec §9 |
| `cpe` | CPE 2.3 name | `cpe:2.3:h:infineon:m7794a12:-:*:*:*:*:*:*:*` | spec §9 |
| `purl` | Package URL, top-level components only | `purl:pkg:maven/org.apache/log4j-core@2.14.1` | spec §9; IX-4 |
| `cc` | Common Criteria certificate id | `cc:BSI-DSZ-CC-0814-2012` | spec §9 |
| `fips` | FIPS 140 validation number | `fips:140-3-4321` | spec §9 |
| `fcc-id`, `swid`, `gtin` | FCC id, SWID tag, GS1 GTIN | `gtin:00012345678905` | spec §9 |
| `vendor` | Vendor slug — the vendor facet | `vendor:acme-secure` | report §3.2; `cardProduct.ts:76` |
| `part` | Part or ordering number | `part:AS-SE1-C2P-T301` | report §4.2 |
| `doc` | Document key (datasheet, app note, errata) | `doc:ODD_TR01_datasheet_vA_11` | report §4.2 |
| `report` | Evaluation report key | `report:ODR_TR01_PSR_001` | report §4.2 |
| `test` | Test or test-run key | `test:ODR_TR01_PSR_006` | report §4.2 |
| `advisory` | Advisory key | `advisory:ODR_TR01_SA_2026012900` | report §4.2 |
| `firmware` | Firmware version | `firmware:2.1.0` | report §4.2 |
| `atr` | Answered-to-reset bytes, continuous lowercase hex | `atr:3bfa1800ff10004a546178436f72655631` | `cardProduct.ts:74` |
| `cplc` | CPLC chip-line key | `cplc:4790-d321` | `cardProduct.ts:75` |
| `jcard` | Card profile key | `jcard:c071` | `cardProduct.ts:4` |
| `scheme`, `eal` | Scheme code, assurance level | `scheme:nl`, `eal:EAL6+` | report §3.2 |

The nine prefixes up to `gtin` are the spec's baseline registry. Everything below them is a convention in use, not a spec entry — the registry is open (IR-4). Never invent a prefix for a new kind of fact if one above already covers it, and never invent an identifier: no CVE, no certificate id, no part number that the source does not state (report §4.1).

Rules that decide the spelling:

- Prefix is lowercase ASCII matching `[a-z0-9-]+` (IR-1).
- Value is the authority's canonical form, verbatim — case, punctuation and separators as issued (IR-2).
- Parsers split on the first `:` only, so `cpe:2.3:…` works (IR-3).
- An `i` value is a spelling: a `#i` filter matches exactly that spelling, and an unknown prefix is a valid opaque indexer (IR-4, IR-5).
- Index top-level identifiers only. Do not turn every SBOM component into an `i` tag (IX-4).

**Identifier budget.** The schema accepts up to 64 `indexers` (`schemas.ts:31-39`; IX-2). The relay counts every single-letter tag — `i`, `k`, `e`, `t`, `imeta` — against one ceiling of 64 (`relay/internal/relay/relay.go:44`), so a 64-indexer event with its `k` and `t` tags is already over. Keep the total at 60 or below, as the mirror does (`packages/mirror/src/emit/seccerts/roots.ts:110-119`), and stop indexing when the record stops being *about* that fact.

**Identifiers are forever.** `i` and `k` tags on a root are immutable (IX-3); patches change `content` only. If you guess an identifier wrong, or a source value changes, the fix is a new root plus a kind 5 retraction of the old one — not an edit. Decide the identifier set before the first publish, and publish every artifact version you have at that moment (report §4.3).

## 5. Artifacts

An artifact is attached as one `imeta` row per file. The server renders each row as one NIP-92 tag:

```
["imeta","url https://…/AS-SE1-datasheet-v1.2.pdf","m application/pdf","x 9f2c…","size 412033","alt SE-1 datasheet v1.2"]
```

Emit pattern: `packages/mirror/src/emit/runMetadata.ts:187`, `roots.ts:621-628`.

| `imeta` field | Meaning | Constraint |
| --- | --- | --- |
| `url` | Where the bytes live | Absolute http(s); the server does not host files (#81, no Blossom) |
| `m` | Media type, NIP-92 `m` | `type/subtype`; Lens picks the file icon from it |
| `x` | SHA-256 of the bytes | 64 lowercase hex |
| `size` | Byte length | Non-negative integer |
| `alt` | Field label Lens renders verbatim | 60 characters or fewer |

Source: `schemas.ts:50-72`. Lens drops an `alt` longer than 60 characters rather than truncating it (`src/lib/artifacts.ts:159-165`), so a long label removes the label entirely.

**Hash or it didn't happen.** The artifact hash is the only defense against substitution: the event signature attests the event, not the bytes at that URL. Consumers re-fetch and stream-compare `x` (IM-1) and treat a `size` mismatch as a verification failure of the same severity (IM-2). Compute both from the file you actually upload, after any compression or re-rendering.

**Big files are attachments, never inline.** The relay rejects content over 256 KiB (`relay/internal/relay/relay.go:42`) and the signed event should stay under 64 KiB; prefer `imeta` above roughly 30 KiB (spec §5.4, RL-1; `packages/core/src/build.ts:43-44`). A 2 MB SBOM belongs at a URL with its hash in `imeta`, not in `bullets`.

**Artifacts are immutable on a root too** (IX-3, MD-5). If a report exists in v1.0 and v1.1, attach both PDFs at first publication if the record is "the evaluation report". If v1.1 is a separate record, publish it as its own Metadata event and bind both — never add the newer file to the older event (report §4.3).

## 6. Lifecycle

| What changed | What to publish |
| --- | --- |
| Wording or a fact inside the prose is wrong | `publish_patch` on `target_id` = the current tip |
| A new version of an attached document | New Metadata root with the new `imeta`, new Binding, `retract` the old root |
| A new identifier (a CVE assigned, a certificate issued) | New root with the new `indexers`, `retract` the old root |
| A Binding is wrong | `retract` the Binding, publish a replacement (BD-9) |
| You no longer stand by the record | `retract` with a human reason |

Patches change prose only. A patch is one `e root` plus one `e reply` (PT-1, PT-2), carries exactly one fenced diff (PT-3, E4), must apply with unambiguous context (T1), and is append-only (PT-9). Because a patch cannot touch tags, indexers and artifacts stay fixed (IX-3). Send either `before`+`after` and let the server diff against the resolved tip, or a unified `diff`; the server fences it with a fence longer than any backtick run in the payload (E4) and refuses a patch that would not apply cleanly (P4). Target the **resolved tip**, never the root.

A retraction is a statement, not an erasure. `retract` publishes a kind 5 event that only counts from the same author (DEL-1). The pilot relay stores it and never acts on it (DEL-11; `relay/internal/gate/gate.go:138-140`), so the retracted event stays fetchable and Lens marks it retracted client-side (report §2). Requirement from the schema: a `reason` string (`schemas.ts:182-189`). Write what changed and why, in the reader's language — "withdrawn: superseded by the 2026-11 datasheet" is a reason; "retracted" is not.

Planning the corpus changes the numbers: a full Tropic Square-shaped set — one profile, three Products, nine Metadata records, ten to twelve Bindings, one patch, one retraction — is about 28 events, which is what a demo can publish inside the relay's freshness window (report §4.4).

## 7. Your key

The key never enters the agent's context. Signing goes through a NIP-46 bunker: the MCP server is a NIP-46 client, the bunker holds the key, and `sign_event` is a request over kind 24133 (NIP-46).

1. **Create the identity.** On the publishing laptop, run `nak key generate` if you have no key yet, then `nak key encrypt` to store it as a NIP-49 `ncryptsec1…` string instead of plaintext. The plaintext key exists only inside these two commands.
2. **Start the bunker.** `nak bunker --prompt-sec wss://<relay-host>`. It prompts `type your secret key as ncryptsec, nsec or hex:` and reads the key from the terminal, not from a file or an argument (`nak/bunker.go`).
3. **Take the connection string.** `nak bunker` prints `bunker://<signer-pubkey>?relay=…&secret=…` (`nak/bunker.go:348-352`). That string is a capability: anyone who has it can ask for signatures.
4. **Put it in the host config, not in the prompt.** Set `SCRUTINY_SIGNER_URI` to that string in the MCP server entry of your host's config (`packages/mcp/README.md`). When it is present, the bunker is authoritative and the dev key is ignored (`src/config.ts:54,161-168`). Never paste the string into a chat message, an issue or a commit.
5. **Give the operator your public key.** The *user* key — `nak key public <your-key>` prints it. The operator adds it to `SCRUTINY_ALLOWED_PUBKEYS`, which accepts either 64-character hex or `npub1…` verbatim (`relay/internal/config/config.go:345,366`; `relay/deploy/PILOT-PUBLISHERS.md`). Reads are never gated; only writes are.
6. **Check the clock.** The relay rejects `created_at` older than 2 hours (`config.go:49-52`) or more than 15 minutes in the future (`relay.go:43`, a compile-time constant). Run `date -u` on the publishing machine and compare it with the operator's, then enable NTP (`sudo timedatectl set-ntp true`; `timedatectl status` must say `System clock synchronized: yes`). `created_at` is not a tool field — the server stamps it at publish time — and it is part of the signed event id, so a clock fix means a fresh publish, not an edit. Never backdate `created_at` to the date the record describes — that date belongs in prose (CA-1).
7. **Call `status` first.** It reports the relay URL, the signer backend and the pubkey in use. `signer: none` means the host config is wrong; publishing tools will refuse.

Expected refusals and their fixes:

| The relay answers | Cause | Fix |
| --- | --- | --- |
| `auth-required: writes require authentication` | No successful NIP-42 AUTH yet | The client must answer the AUTH challenge |
| `blocked: not an allowed publisher` | Authenticated, key not on the allowlist | Send the operator your pubkey; they restart the relay |
| `blocked: event author must be the authenticated pubkey` | Bunker key differs from the key the connection authenticated | Use one key for both |
| `blocked: kind 1 event carries no accepted scrutiny t tag` | Only possible for hand-built events; the server sets the tags | Do not hand-build events |
| `blocked: kind <n> is not accepted by this relay` | This relay takes kinds 0, 1 and 5 | Use the tools, which emit only those |
| `event too old` / `event too much in the future` | Clock skew | Sync the clock, then publish again |

Sources: `relay/internal/gate/gate.go:47-58` and `:78-98`; `relay/internal/relay/relay.go:273-275`; message strings and the operational procedure in `relay/deploy/PILOT-PUBLISHERS.md`.

You have no revocation path: a Nostr key has no revoke, and a published root cannot be withdrawn from relays (report §6.3). Treat the bunker host as the security boundary.

## 8. Worked example

Fake vendor: Acme Secure, product SE-1. Raw datasheet excerpt, three lines, as a vendor hands it over:

```
Part number: AS-SE1-C2P-T301
Security: CC certified by BSI, certificate BSI-DSZ-CC-1234-2026, EAL6+ AVA_VAN.5
Firmware: 2.1.0 (shipped default)
```

Map the facts to a Product and one `publish_product` call:

```json
{
  "headline": "Acme Secure SE-1 — secure element, CC certified at EAL6+ (firmware 2.1.0)",
  "bullets": [
    "Part number AS-SE1-C2P-T301; the package is a 4 mm × 4 mm QFN32.",
    "Certified by BSI under BSI-DSZ-CC-1234-2026 at EAL6+ AVA_VAN.5.",
    "Ships with firmware 2.1.0; the vendor facet is vendor:acme-secure."
  ],
  "links": [
    { "url": "https://www.acme-secure.example/datasheets/AS-SE1-datasheet-v1.2.pdf" }
  ],
  "indexers": [
    "vendor:acme-secure",
    "part:AS-SE1-C2P-T301",
    "cc:BSI-DSZ-CC-1234-2026"
  ],
  "card": {
    "type": "acme-datasheet@1",
    "part": "AS-SE1-C2P-T301",
    "certificate": "BSI-DSZ-CC-1234-2026",
    "eal": "EAL6+",
    "firmware": "2.1.0"
  },
  "imeta": [
    {
      "url": "https://www.acme-secure.example/datasheets/AS-SE1-datasheet-v1.2.pdf",
      "m": "application/pdf",
      "x": "9f2c1d7a4b6e8f0a1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f0a2b4c6d8e0f1a3b",
      "size": 412033,
      "alt": "SE-1 datasheet v1.2"
    }
  ]
}
```

Composed output (illustrative until #108 A4 lands). The order and the blank lines are fixed by `composeContent`: headline, blank line, bullets, blank line, `Links:`, its items, blank line, and the record card as the last single line, LF only, no fences (`packages/mirror/src/emit/content.ts:139-165`).

```
Acme Secure SE-1 — secure element, CC certified at EAL6+ (firmware 2.1.0)

- Part number AS-SE1-C2P-T301; the package is a 4 mm × 4 mm QFN32.
- Certified by BSI under BSI-DSZ-CC-1234-2026 at EAL6+ AVA_VAN.5.
- Ships with firmware 2.1.0; the vendor facet is vendor:acme-secure.

Links:
- https://www.acme-secure.example/datasheets/AS-SE1-datasheet-v1.2.pdf

Record card (JSON): {"type":"acme-datasheet@1","part":"AS-SE1-C2P-T301","certificate":"BSI-DSZ-CC-1234-2026","eal":"EAL6+","firmware":"2.1.0"}
```

Why this passes rule 2a without a server restatement bullet — walk the two fact sets:

- Card scalars: `acme-datasheet@1` is exempt (the `@1` suffix); `AS-SE1-C2P-T301`, `BSI-DSZ-CC-1234-2026`, `EAL6+` and `2.1.0` all appear in the headline or the bullets.
- `i` values: `acme-secure` appears as `vendor:acme-secure`; `AS-SE1-C2P-T301` and `BSI-DSZ-CC-1234-2026` appear in the bullets.

The artifact hash is exempt as a 64-character hex run, so the `x` value never needs to be in prose (`content.ts:24-27`). The tags the server emits around this content:

```
["t","scrutiny-fabric"] ["t","scrutiny-product"] ["t","scrutiny-v0.8.1"]
["i","vendor:acme-secure"] ["i","part:AS-SE1-C2P-T301"] ["i","cc:BSI-DSZ-CC-1234-2026"]
["k","vendor"] ["k","part"] ["k","cc"]
["imeta","url https://…/AS-SE1-datasheet-v1.2.pdf","m application/pdf","x 9f2c…","size 412033","alt SE-1 datasheet v1.2"]
```

Ten single-letter tags (`t` 3, `i` 3, `k` 3, `imeta` 1) against the 60-tag budget of §4. One `k` per distinct prefix, in first-seen order (`content.ts:83-108`).

To attach the datasheet as its own citable record instead, publish a Metadata child: `publish_metadata` with `indexers: ["part:AS-SE1-C2P-T301","doc:ODD_AS-SE1_datasheet_vA_12"]` and `meta_subtype: "report"`, then `publish_binding` with `root_ref` = the Product id, `link_ref` = the Metadata id and `label: "documents"`.

## 9. Verification loop

A publish is not done until the relay hands the event back. Run these four steps for every event you publish.

1. **Publish.** The tool returns the relay's NIP-20 acknowledgement: `OK true <event-id>`. An `OK false` carries the rejection string from §7; fix the cause and publish again.
2. **Read the id.** Record it with the tool's name and your own source reference. This is the handle everyone downstream will use.
3. **`verify_event` with that `event_id`.** The server fetches the event back with `REQ {"ids":[…]}` (`schemas.ts:192-196`) and returns what the relay stored. Compare it with what you published: same content bytes, same tags, same signature. A local success message is not proof; the stored event is.
4. **Open it in Lens.** Point Lens at the relay and search one of your `i` values. Check three things: the record renders, its card and prose agree, and its artifacts show the `alt` labels you sent. A record that publishes but does not render usually has no product root, no accepted `t` tag, or an identifier Lens does not index.

Then check the graph, not just the event: every Metadata record has a Binding, and every Binding's `root_ref` is a Product you actually published. Bindings are the edges Lens draws; a correct event with no edge is an orphan.

## Sources

- `protocol-spec.md` v0.8.1 (`C:/Users/alsorehi/scrutiny-fabric/docs/protocol-spec.md`): TAG-1..3, PR-*, MD-*, BD-1..12, PT-1..11, P4, E4, T1, IX-1..4, IM-1..4, CA-1, DEL-1/DEL-11, IR-1..5, RL-1, §5.4, §9.
- `packages/mcp/src/tools/schemas.ts`, `packages/mcp/src/tools/register.ts`, `packages/mcp/src/config.ts`, `packages/mcp/README.md`.
- `packages/mirror/src/emit/content.ts` (rule 8 composition, rule 2a checker, `k` derivation), `emit/seccerts/roots.ts` (tag budget, two-line headline), `emit/cardProduct.ts` (`atr`, `cplc`, `jcver`), `emit/runMetadata.ts` (`imeta` shape).
- `relay/internal/gate/gate.go`, `relay/internal/relay/relay.go`, `relay/internal/config/config.go`, `relay/deploy/PILOT-PUBLISHERS.md`.
- Publishing system report, `investigations/publishing-system/REPORT.md` (§1 job model, §2 protocol constraints, §3.2 Lens checklist, §4.2 corpus model, §4.3 immutability, §4.4 demo subset, §6.3 key custody).
- Lens (`scrutiny-lens`): `src/lib/pipeline/cards.ts:112-116` (product-only result cards), `src/lib/artifacts.ts:159-165` (`alt` limit), `src/lib/ai/agents/nodes.ts:213-224` (metadata subtype).
- NIP-01, NIP-09, NIP-42, NIP-46, NIP-92; `nak` `bunker.go`; issue #108 for the tool surface and preflight gates.
