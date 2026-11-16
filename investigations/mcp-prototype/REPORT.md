# Prototype MCP server — test-suite audit

Audit of `C:/Users/alsorehi/wt/mcp-stack/packages/mcp` (`test/`, `scripts/e2e.mjs`) to decide which
tests carry into the from-scratch rewrite (plan flow `draft_plan` → elicitation approval →
`publish_plan`; NIP-46 dropped; OS keyring kept; `structuredContent` + `outputSchema`; one refusal
record `{field, problem, fix}`).

Paths below are relative to `packages/mcp/`. Read-only audit: nothing in that repo was changed.

**Date:** 2026-11-16. **Prototype:** draft PRs #116–#121 (branches `stack/108-1-scaffold` …
`stack/108-6-keyring`). **Consumer:** [`docs/specs/mcp-publishing.md`](../../docs/specs/mcp-publishing.md) §12.

> **Resolved after this audit was written** (see [ADR-0003](../../docs/adr/0003-mcp-plan-based-publishing.md)):
> A1 — the dev-key seam is **dropped**; tests inject a signer through the port, so the seven
> "ADAPT (conditional)" rows become rewrites against an injected `TestSigner`, and only the
> hex/nsec/ncryptsec *parsing* cases survive (they now cover `import`). A2 — v1 plans carry
> `profile`, `product`, `metadata` and derived bindings only; **patch and retract rows are deferred**,
> not ported.

## Verdicts and tags

| Verdict | Meaning |
|---|---|
| KEEP | Port as an acceptance test; behaviour and assertions transfer. |
| ADAPT | Behaviour survives; the interface changes (how is stated). |
| DROP-ARCH | Tests removed architecture: per-event tool surface, NIP-46/NIP-44, the NIP-46 raw transport. |
| DROP-QUALITY | Not worth porting because of the tagged quality problem. |

Tags: TAUTOLOGICAL, REDUNDANT, VANITY, BRITTLE. A tag on a KEEP/ADAPT row is a defect to fix while
porting. A tag on a DROP-QUALITY row is the reason for the drop.

**Assumptions**

- **A1.** The brief keeps only the OS keyring signer. `NSEC`/`NSEC_FILE`/`NSEC_AGE_FILE` are neither NIP-46 nor
  the keyring. They are marked ADAPT (conditional): port them only if the rewrite keeps a dev-key test
  seam. The hex/nsec1 parsing still matters, because keyring material goes through the same
  `classifyLocalKey` function (`src/config.ts:237`). This needs a decision.
- **A2.** Plan records cover the old tools: profile, product, metadata, binding, patch, retract. `verify_event` and
  `status` stay as read-only tools.
- **A3.** Every refusal `field` becomes a path qualified by the plan record (for example
  `records[<ref>].indexers`) instead of a tool-argument name. This applies to every preflight row
  marked KEEP and is not repeated per row.

## Summary counts

| Source | Tests | KEEP | ADAPT | DROP-ARCH | DROP-QUALITY |
|---|---:|---:|---:|---:|---:|
| `test/compose/content.test.ts` | 12 | 10 | 2 | 0 | 0 |
| `test/compose/guide.test.ts` | 4 | 1 | 2 | 0 | 1 |
| `test/preflight/checkTable.test.ts` | 13 | 11 | 0 | 0 | 2 |
| `test/config.test.ts` | 14 | 5 | 7 | 2 | 0 |
| `test/identity.test.ts` | 9 | 5 | 2 | 2 | 0 |
| `test/sign.test.ts` | 15 | 13 | 0 | 0 | 2 |
| `test/nip44.test.ts` | 11 | 0 | 0 | 11 | 0 |
| `test/nip46.test.ts` | 24 | 0 | 2 | 22 | 0 |
| `test/schemas.test.ts` (3 blocks run ×8 tools) | 11 | 0 | 9 | 2 | 0 |
| `test/server.test.ts` | 9 | 1 | 5 | 0 | 3 |
| `test/relay/authedSocket.test.ts` (1 `it.each` ×4) | 23 | 19 | 0 | 1 | 3 |
| `test/relay/client.test.ts` | 12 | 12 | 0 | 0 | 0 |
| `test/relay/rawTransport.test.ts` | 4 | 0 | 0 | 4 | 0 |
| `test/tools/handlers.test.ts` | 19 | 0 | 17 | 1 | 1 |
| **vitest subtotal** | **180** | **77** | **46** | **45** | **12** |
| `scripts/e2e.mjs` (10 loop steps, 8 gate cases, 1 mode) | 19 | 2 | 12 | 1 | 4 |
| **Total** | **199** | **79** | **58** | **46** | **16** |

| Tag | Primary (DROP-QUALITY) | Secondary (on KEEP/ADAPT) | Total |
|---|---:|---:|---:|
| REDUNDANT | 10 | 1 | 11 |
| VANITY | 4 | 1 | 5 |
| TAUTOLOGICAL | 2 | 3 (partial) | 5 |
| BRITTLE | 0 | 20 | 20 |

### Most important findings

1. **The real-relay e2e harness cannot pass as written.** It goes stale in three places:
   - Step 1 requires `/signer: (dev-key|nip46)/` (`scripts/e2e.mjs:394`), but `status` now prints
     `signer: local env key — …` (`src/identity.ts:449`, which `test/server.test.ts:125` pins). The local run fails at its first step.
   - Remote mode requires `SCRUTINY_SIGNER_URI` (`scripts/e2e.mjs:723`), but config reads only `SCRUTINY_SIGNER`
     (`src/config.ts:84`).
   - A missing Go toolchain prints `SKIPPED` and exits 0 (`scripts/e2e.mjs:731-735`), so CI cannot see the breakage.

   The e2e file was last changed in `e3a8639`. The signer refactors `a6e7fe2` and `873d389` came after it.
2. **The e2e "future-clock" gate tests a test seam, not a fast clock.** It skews only the stamp clock
   (`scripts/e2e.mjs:633`), while the signer re-reads the real clock (`src/identity/sign.ts:303`). On a
   machine whose clock really is fast, both clocks move together, so neither the preflight nor the signer fires.
   For the same reason, preflight gate 4 can never fire in production: `ctx.stamp()` and `checkTable` share
   `ctx.now()` (`src/tools/handlers/context.ts:88-93`, `src/tools/handlers/publish.ts:53`).
3. **Timing-flaky test.** `test/sign.test.ts:74-83` computes `now`, then the signer re-reads
   `Date.now()`. If the second ticks over in between, the future case lands exactly on the 900 s bound and does not throw.
4. **Partial tautology in the signing test.** `test/sign.test.ts:60` checks the id with the same `computeEventId` the signer
   uses (`src/identity/sign.ts:306`). No fixed NIP-01 id vector (known event → known id) anchors the serialization.
5. **Misnamed test.** `test/relay/authedSocket.test.ts:376` is titled "…with a retryable error" but asserts
   `retryable === false` (`:388`).
6. **Dead code with tests.** `src/relay/rawTransport.ts` is imported nowhere in `src/`. Only its 4 tests use it.

### Tests worth praising (port these first)

- **Byte-exact goldens.**
  - Composition: `test/compose/content.test.ts:20`, `:51`, `:140`.
  - Wire event: `test/tools/handlers.test.ts:172` — content and tag literals are independent of the code, so the id check is strong.
  - Executable documentation: `test/compose/guide.test.ts:50`, `:56`.
- **Official NIP-44 vectors** (`test/nip44.test.ts`). The suite is well built but is dropped with NIP-46.
- **Real relay binary.** `scripts/e2e.mjs` builds `relay/`, publishes, and reads back:
  - stored bytes equal the guide (`:482-488`);
  - verbatim relay verdicts (`:565`, `:695`);
  - `/metrics` counters prove the verdict came from the relay (`:572-582`).
- **Fixed key vectors.** `01…01` → `1b84…` (`test/sign.test.ts:48`) and nsec1 → `7e7e…` (`test/identity.test.ts:32`).
- **Safety tests.** Wrong key under a keyring identity is refused (`test/identity.test.ts:60`). Key material is never echoed
  (`test/config.test.ts:135`, `test/identity.test.ts:69`).
- **Hostile-relay tests.**
  - Spurious OK frames ignored (`test/relay/authedSocket.test.ts:256`).
  - Foreign event on an ids-REQ ignored (`:290`).
  - Relay-tampered content detected (`test/tools/handlers.test.ts:471`).
  - Single-field tamper matrix (`test/sign.test.ts:94`).
- **Boundary pairs.** Tag budget 60/61 (`test/preflight/checkTable.test.ts:65`, `:73`). Inclusive freshness bounds
  (`test/sign.test.ts:118`).
- **"Nothing was signed" checks.** `signerCalls` stays empty and no socket opens (`test/tools/handlers.test.ts:238-239`, `:385`).

## Per-file tables

### `test/compose/content.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| renders headline, bullets, Links block and the record card last, LF only | KEEP | — | Byte-exact rule 8 golden (`:20-41`). |
| omits optional blocks instead of leaving empty ones | KEEP | — | Edge cases (empty bullets, empty card) a refactor could break (`:43-47`). |
| folds CRLF to LF, strips C0 controls to spaces and normalizes typographic quotes | KEEP | — | Byte-exact emit-boundary normalization; guards the Go-relay hashing hazard (`:51-68`). |
| keeps a headline newline as a second headline line | KEEP | — | Pins the mirror two-line headline (`:70-76`). |
| oneLine joins continuation lines and trims trailing whitespace | ADAPT | — | Tests an exported helper directly (`:78-80`). Assert through a composed bullet instead, so the helper can stay private. Partly overlaps `:55`. |
| appends Facts and Identifiers bullets for missing card scalars and indexer spellings | KEEP | — | Core rule 2a restate behaviour (`:84-100`). In the plan flow the preview must also show `appended`. |
| does not restate facts the prose already carries | KEEP | — | Casefold and separator-insensitive negative case (`:102-112`). |
| ignores scalars shorter than 4 characters and the documented exemptions | KEEP | — | Covers short, long-hex, `@N` type and `jcver-lte` (`:114-129`). The `«` exemption (`src/compose/content.ts:123`) is untested. |
| the post-append guard throws a CompositionError when a fact cannot be restated | ADAPT | BRITTLE | Matches `/server bug/` prose (`:135`). Map to the refusal record. It also calls `assertNoLostFacts` directly, never proving `composeIndexed` runs it (`src/compose/event.ts:133`). |
| ends with the mandatory Refs line after the label and bullets | KEEP | — | Byte-exact rule 8d (`:140-148`). |
| renders a label-only binding without an empty bullet block | KEEP | — | Edge case (`:150-156`). |
| renders one NIP-92 tag per row in the guide field order | KEEP | — | Exact tag order (`:160-181`). `alt` normalization through `oneLine` (`src/compose/event.ts:163`) is untested. |

### `test/compose/guide.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| composes the documented content byte-for-byte, with no restatement bullets | ADAPT | — | Strong executable documentation (`:50-54`). The marker text names a `publish_product` call (`:30`); rewrite the guide example as a plan record. |
| derives the documented tag block byte-for-byte | ADAPT | — | Same (`:56-61`). Build the tags through the plan composer, not `buildProduct` plus `imetaTags`. |
| lists exactly the preflight KNOWN_INDEXER_PREFIXES | KEEP | — | Keeps the doc table and the allowlist from drifting apart (`:77-79`). |
| documents the warning-not-refusal posture for unknown prefixes | DROP-QUALITY | VANITY | A regex on markdown prose `warning\*\*, never a refusal` (`:82`). Catches no code bug; the behaviour is tested at `test/preflight/checkTable.test.ts:122`. |

### `test/preflight/checkTable.test.ts`

The refusal shape is already `{field, problem, fix}`, so these tests port almost unchanged (see A3).

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| accepts a builder-composed event | KEEP | — | Negative control for every gate (`:22-24`). |
| refuses an event missing its version tag and says it is a server bug | KEEP | — | Structured `field` assert (`:37`). The `fix` substring `'server bug'` is mild prose coupling. |
| refuses a kind 5 deletion without exactly one e tag | KEEP | — | (`:42-47`). |
| refuses past the relay ceiling … names the indexers to drop | KEEP | BRITTLE | Real logic: excess and the last-N indexers to drop (`:51-63`). Counts are asserted inside prose (`'i 64 + k 1 + e 0 + t 3 + imeta 0'`, `'drop 4 indexers'`). Make the counts and the drop list structured fields. |
| warns between the mirror budget and the relay ceiling, without blocking | KEEP | BRITTLE | Boundary 61 (`:65-71`). Asserts substrings of free-text warnings. |
| stays silent at or below the mirror budget | KEEP | — | Boundary 60; pairs with the previous row (`:73-76`). |
| refuses an event whose signed size passes 64 KiB and points at imeta | KEEP | BRITTLE | Asserts `'285 bytes'` and `` '`imeta` attachment' `` prose (`:84-86`). 70 000 is far from the bound; no exact-65536 boundary test. |
| refuses a tag value over 1024 bytes and names the field | KEEP | — | Structured field (`:89-95`). Multi-byte UTF-8 counting is untested. |
| refuses a created_at three hours in the past with the measured offset | DROP-QUALITY | REDUNDANT | The guard is the same function as `test/sign.test.ts:139`. In production gate 4 cannot fire (stamp and check share `ctx.now()`), and in the plan flow a draft has no `created_at` (`:99-105`). |
| refuses a created_at far in the future | DROP-QUALITY | REDUNDANT | Same; covered by `test/sign.test.ts:127` (`:107-110`). |
| recognizes every documented prefix | KEEP | — | Checks the allowlist against core's `INDEXER_PREFIX_PATTERN`. It would catch an entry like `fips-t` that the pattern rejects (`:114-120`). |
| warns on an unknown but well-formed prefix and still allows the publish | KEEP | BRITTLE | Asserts the issue number `'#48'` in prose (`:127`). Rule IDs are fine; an issue number is not. |
| warns on a malformed prefix and on a value without one | KEEP | BRITTLE | Depends on warning order `[0]`/`[1]` (`:134-135`). |

### `test/config.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| defaults to the public relay and no signer | KEEP | — | (`:30-36`). |
| reads the key from the injected OS store under the identity the URI names | KEEP | — | Keyring onboarding contract: `calls` proves service and account parsing; account = pubkey (`:38-57`). The `material === HEX_KEY` assert is only a mock passthrough. |
| prefers the named identity over NSEC and reports a missing entry without echoing it | ADAPT | BRITTLE | Five behaviours in one test, all regexes on messages (`:66-77`). The null-entry case matches only `/SCRUTINY_SIGNER/`, which every error on that path contains. Split it, and assert refusal-record fields. |
| treats a store read failure as an outage, not a silent miss | ADAPT | — | Weak (`:84`): `/OS secret store/` also matches the *missing-entry* message (`src/config.ts:234`). It would still pass if the outage were turned into a miss. Assert a distinct problem kind. |
| does not touch the store when a signer daemon is configured | DROP-ARCH | — | `bunker://` (`:87-95`). |
| normalises the relay URL to an endpoint without a trailing slash | KEEP | — | Needed for the byte-exact NIP-42 `relay` tag (`:97-101`). |
| rejects a non-WebSocket relay URL | KEEP | BRITTLE | Full-message regex (`:105-107`); assert `field` instead. |
| accepts a NIP-46 bunker URI as the signer plan | DROP-ARCH | — | (`:110-113`). |
| rejects a signer scheme it cannot honour | ADAPT | — | Becomes: `bunker://` and `nostrconnect://` are both refused with "NIP-46 not supported" (`:115-119`). |
| accepts hex and nsec1 dev keys, normalising hex case | ADAPT | — | A1: re-target at keyring material forms (`:121-133`). |
| rejects junk key material without echoing it | KEEP | — | Secret non-echo with a structured `variable` assert (`:135-147`). Re-target at keyring material. |
| reads NSEC_FILE and reports its source | ADAPT | — | A1, conditional (`:149-156`). |
| rejects an empty NSEC_FILE | ADAPT | BRITTLE | A1, conditional; regex prose (`:160`). |
| rejects NSEC_AGE_FILE instead of silently ignoring it | ADAPT | — | A1, conditional (`:163-167`). |

### `test/identity.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| reports no signer when nothing is configured | ADAPT | BRITTLE | Becomes a `status` `structuredContent` field. Regex on `detail` prose (`:18`). |
| derives the x-only pubkey from a hex dev key | ADAPT | BRITTLE, REDUNDANT | `toStrictEqual` on a full English sentence with a typographic apostrophe (`:26-28`). Pubkey derivation is already covered by `test/sign.test.ts:48`. |
| derives the pubkey from an nsec1 dev key | KEEP | — | Fixed bech32 → pubkey vector (`:32-34`); re-target at keyring nsec1 material. |
| prefers the bunker and never echoes its secret param | DROP-ARCH | — | NIP-46. `expect(signerUri).toContain(secret)` (`:43`) asserts the test's own fixture. |
| rejects a dev key that is a valid hex64 but not a scalar | KEEP | — | The `00…00` scalar through the config → status path (`:46-50`). |
| resolves the keystore key whose pubkey matches the identity in the URI | KEEP | — | Keyring happy path (`:52-58`). Only the hex-account form is tested; the npub form (`src/identity.ts:364-376`) is untested. |
| refuses a keystore key that derives to a different identity | KEEP | BRITTLE | The most important safety test (`:60-67`). The regex `/holds a key for/` should become refusal-record fields. |
| never echoes key material when the bech32 checksum fails | KEEP | — | Regression test for a real leak (`:69-83`). |
| pilot mode ignores dev material entirely | DROP-ARCH | — | Bunker precedence (`:85-94`). The keyring equivalent is in config `:59`. |

### `test/sign.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| derives the BIP-340 x-only pubkey | KEEP | — | Fixed vector (`:48-50`). |
| rejects a scalar that is not a valid secret key | KEEP | — | (`:52-54`). |
| rejects the wrong secret-key length | DROP-QUALITY | VANITY | No config path can reach it: the regexes pin 64 hex / 58-char bech32 (`src/config.ts:74-76`), and noble rejects 31 bytes anyway. It asserts only a message (`:56-58`). |
| fills id/pubkey/sig and the id recomputes from the signed event | KEEP | TAUTOLOGICAL (partial) | The id check reuses `computeEventId`, which the signer itself calls (`src/identity/sign.ts:306`), so a shared serialization bug passes. Add a fixed NIP-01 id vector (`:66-67`). |
| refuses to sign a template outside the relay freshness window | KEEP | BRITTLE | Timing flake: `now` is read at `:76` and the signer re-reads it (`src/identity/sign.ts:303`). If the second ticks over, offset = 900 and nothing throws. Inject `now`. |
| accepts the untouched event | DROP-QUALITY | REDUNDANT | `verifySignedEvent(event) === true` is already asserted at `:71` (`:90-92`). |
| rejects every single-field tamper | KEEP | — | Seven-field tamper matrix; the basis of fetch-back verification (`:94-107`). |
| rejects non-event values without throwing | KEEP | — | Handles hostile relay frames (`:109-114`). |
| accepts both inclusive bounds | KEEP | — | Boundary test (`:118-125`). |
| names the measured future offset | KEEP | — | Structured `offsetSeconds` (`:133`). The `'maxFutureAge'` prose assert is minor. |
| names the measured past offset | KEEP | — | Same (`:145`). |
| rejects non-integer timestamps | KEEP | — | (`:151-154`). |
| uses now when there is no previous event | KEEP | — | JIT stamping in the plan flow still needs `nextCreatedAt` (`:158-160`). |
| advances monotonically within the same second | KEEP | — | Parent and child signed in the same second (`:162-165`). |
| fails before a batch crosses the future limit | KEEP | — | Long-plan drift guard (`:167-169`). |

### `test/nip44.test.ts`: all DROP-ARCH

NIP-44 is imported only by `src/identity/nip46.ts:26`. All 11 tests run the official NIP-44 v2 vector
file byte-exactly, in both directions. It is good test engineering, but nothing in the new architecture needs it.

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| matches every valid (sec1, pub2) pair | DROP-ARCH | — | NIP-44 (`:92`). |
| derives the same conversation key from either side of a pair | DROP-ARCH | — | (`:99`). |
| throws for every invalid pair | DROP-ARCH | — | (`:112`). |
| splits the 76-byte HKDF output exactly | DROP-ARCH | — | (`:123`). |
| matches every recorded input/output pair (calc_padded_len) | DROP-ARCH | — | (`:135`). |
| produces the recorded payload and decrypts back to the plaintext | DROP-ARCH | — | (`:143`). |
| hashes both sides of the 65,535-byte boundary messages | DROP-ARCH | — | (`:156`). |
| rejects unpaddable plaintext lengths | DROP-ARCH | — | (`:171`). |
| rejects every invalid payload | DROP-ARCH | — | (`:181`). |
| rejects a MAC computed without the nonce as AAD | DROP-ARCH | — | (`:190`). |
| enforces the 1 MiB decrypt cap at the boundary | DROP-ARCH | — | (`:205`). |

### `test/nip46.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| parseBunkerUri: parses the pubkey, every relay, and the optional secret | DROP-ARCH | — | (`:78`). |
| parseBunkerUri: treats an empty secret as absent | DROP-ARCH | — | (`:90`). |
| parseBunkerUri: percent-decodes the secret exactly once and keeps + literal | DROP-ARCH | — | (`:96`). |
| parseBunkerUri: rejects malformed percent-encoding instead of echoing the query | DROP-ARCH | — | (`:104`). |
| parseBunkerUri: rejects a URI without a relay | DROP-ARCH | — | (`:110`). |
| parseBunkerUri: rejects a non-ws relay | DROP-ARCH | — | (`:114`). |
| parseBunkerUri: rejects an npub host and a nostrconnect URI | DROP-ARCH | — | (`:120`). |
| handshake: authorizes with the URI secret, learns the user key, and sends metadata | DROP-ARCH | — | (`:131`). |
| handshake: rejects a bunker pubkey that is hex but not on the curve | DROP-ARCH | — | (`:149`). |
| handshake: rejects a mismatched secret with the bunker error, not a timeout | DROP-ARCH | — | (`:158`). |
| handshake: surfaces an auth challenge instead of a timeout for an unapproved secret | DROP-ARCH | — | (`:168`). |
| handshake: rejects the auth challenge with the URL to open | DROP-ARCH | — | (`:179`). |
| handshake: times out when the bunker never answers sign_event | DROP-ARCH | — | (`:190`). |
| handshake: never adopts a plaintext get_public_key answer | DROP-ARCH | — | (`:199`). |
| sign_event: returns the event signed by the user key, matching the template | DROP-ARCH | — | (`:210`). |
| sign_event: rejects an event re-signed with altered content | DROP-ARCH | — | (`:228`). |
| sign_event: rejects an event whose id no longer matches its content | DROP-ARCH | — | (`:240`). |
| sign_event: rejects a response authored by anyone but the configured bunker | DROP-ARCH | — | (`:249`). |
| sign_event: rejects an event signed by a different user key | DROP-ARCH | — | (`:259`). |
| sign_event: refuses a stale template before spending a bunker round-trip | DROP-ARCH | — | (`:268`). The "refuse before the signer" idea lives on in the handlers tests. |
| loadSigner: signs with a dev key and reports its pubkey | ADAPT | — | Not NIP-46. Move it to the identity tests as the keyring `loadSigner` happy path that also signs (`:282-291`). |
| loadSigner: resolves the bunker branch over the injected transport | DROP-ARCH | — | (`:293`). |
| loadSigner: explains that a bunker needs a transport | DROP-ARCH | — | (`:304`). |
| loadSigner: refuses to load with no signer configured | ADAPT | — | Becomes the refusal record from `publish_plan` (`:311-313`). |

### `test/schemas.test.ts`

The per-tool schemas are gone. The *properties* survive and must be asserted on the `draft_plan`
input, every record variant inside it, and the `publish_plan` input.

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| registers exactly the eight #108 tools | DROP-ARCH | — | Per-event tool list (`:47-58`). |
| has a baseline payload for every registered tool | DROP-ARCH | — | Checks the test fixture against the tool list (`:60-62`). |
| <tool> schema: accepts its baseline payload (×8) | ADAPT | — | One minimal valid record per record type inside `draft_plan` (`:67-71`). |
| <tool> schema: rejects a free-form content argument (×8) | ADAPT | — | Key acceptance criterion: no `content` at plan level or record level (`:73-80`). |
| <tool> schema: rejects nsec, hex64 and generic secret arguments (×8) | ADAPT | — | Key acceptance criterion: apply to `draft_plan`, each record, and `publish_plan` (`:82-93`). |
| rejects an empty indexer value and an empty list | ADAPT | — | Product/metadata record schema (`:98-102`). |
| rejects more than IX-2's 64 indexers | ADAPT | — | Record schema (`:104-109`). |
| rejects an imeta alt over Lens's 60-char limit | ADAPT | — | Record schema; good positive/negative pair (`:111-130`). |
| rejects a content key nested inside an imeta row | ADAPT | — | Nested strictness (`:132-149`). |
| accepts every documented meta_subtype and rejects an invented one | ADAPT | — | Metadata record (`:151-163`). |
| rejects ids that are not canonical hex64 | ADAPT | — | References become `local ref | hex64`; keep rejecting malformed hex and uppercase (`:167-183`). |

### `test/server.test.ts`

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| advertises the eight #108 tools with strict object schemas | ADAPT | VANITY (partial) | Keep `additionalProperties:false`, annotations, and add `outputSchema` presence. Drop `description.length > 40` (`:96`), which says nothing about quality. |
| delivers the playbook instructions to the host | DROP-QUALITY | VANITY | Compares `getInstructions()` with the constant `INSTRUCTIONS` from the same module (`:106`). An empty string passes. |
| reports the relay and an unconfigured signer | ADAPT | BRITTLE | Assert `structuredContent` fields, not `text.toContain('signer: none — set …')` (`:115-118`). |
| reports the derived pubkey for a dev key without leaking the key | ADAPT | — | Keyring config; keep the non-leak assert (`:121-127`). |
| lists and serves the publisher guide byte-identically | KEEP | — | sha256 of the served bytes against the file catches re-encoding (`:134-149`). |
| refuses to publish when no signer is configured | ADAPT | — | `publish_plan` refusal record (`:153-158`). Decide whether `draft_plan` works without a signer; it should, since preview needs no key. |
| rejects a free-form content argument on the wire | ADAPT | — | The one test that proves the SDK enforces the schema on the wire (`:160-167`). Keep one per new tool. |
| rejects an nsec argument on the wire | DROP-QUALITY | REDUNDANT | The wire path is proven by the previous row; the per-key rejection is covered by the schemas tests (`:169-178`). |
| rejects a malformed event id before any handler runs | DROP-QUALITY | REDUNDANT | Covered by the schemas test (`:167`). It also asserts zod message prose (`:186`). |

### `test/relay/authedSocket.test.ts`

All tests use the in-memory fake relay, which never verifies signatures (`test/relay/fakeRelay.ts:7-8`).

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| answers the eager OnConnect challenge with the socket URL by default | KEEP | TAUTOLOGICAL (partial) | `relay`/`challenge` tag asserts are real. `sig` matching hex128 (`:92`) only asserts the fake signer's `'bb'.repeat(64)` (`test/relay/fakeRelay.ts:25`). |
| retries once when the relay rejects the write auth-required and challenges afresh | KEEP | — | Exact protocol frame order EVENT, AUTH, EVENT with the same id (`:109-114`). |
| names both URLs when the relay rejects the tag, and does not retry a verdict | KEEP | BRITTLE | Behaviour matters (proxy/tunnel dial). Asserts three message substrings (`:128-130`). The positive `authRelayUrl` path is never tested. |
| re-signs a reused challenge after a rejection and publishes | KEEP | — | Signing per attempt; distinct AUTH ids (`:164`). |
| refuses an AUTH event the signer returned malformed | DROP-ARCH | — | Guards *remote* signer output (`:167-192`). An in-process noble signer cannot return a short id. |
| names a missing challenge when the relay gates writes without challenging | KEEP | BRITTLE | Prose substrings (`:202-203`). |
| passes a rejection message through verbatim | KEEP | — | Verbatim passthrough is the behaviour (`:209-219`). |
| keeps %j readable for the model (it.each ×4) | DROP-QUALITY | REDUNDANT | Same code path as the previous row with other strings: the fake returns X and the test asserts X (`:221-232`). |
| fails with the event id and the last NOTICE when no OK arrives | KEEP | — | `retryable: false` means an event that may have landed is not blindly re-sent (`:234-246`). |
| rejects a malformed event before it reaches the wire | KEEP | — | Cheap boundary guard; the no-EVENT-frame assert is structural (`:248-254`). |
| ignores OK frames carrying a foreign or truncated event id | KEEP | — | Critical for the plan flow: a forged ack must not release a child for signing (`:256-270`). |
| reads a stored event back over REQ ids and closes the subscription | KEEP | BRITTLE | Pins the private subscription id `'mcp-read-1'` (`:279-282`). Assert "one REQ, one matching CLOSE". |
| returns null when the relay EOSEs without the event | KEEP | — | (`:285-288`). |
| ignores a foreign event on an ids-REQ and waits for EOSE | KEEP | — | Fetch-back must not accept the wrong record (`:290-295`). |
| times out rather than accept a foreign event, and closes the subscription | KEEP | — | (`:297-304`). |
| surfaces a CLOSED with no message as "closed by relay" | DROP-QUALITY | VANITY | Asserts a placeholder default string (`:306-311`). The verbatim CLOSED row (`:353`) covers the path. |
| reads a stored event while the handshake is still pending | KEEP | — | Reads are never gated, so a parent fetch-back is not blocked by AUTH (`:313-336`). |
| throws on timeout rather than pretending the event is absent | KEEP | BRITTLE | The timeout vs absent distinction is vital. Asserts the prose `'no EOSE for REQ {"ids":["ee0000'` and the sub id (`:345`, `:350`). |
| surfaces a CLOSED answer verbatim | KEEP | — | (`:353-358`). |
| rejects an id that is not NIP-01-shaped | DROP-QUALITY | REDUNDANT | Agent-supplied ids are rejected by the schema (`test/schemas.test.ts:167`); internal ids are always computed (`:360-363`). |
| reports a failed connect as a retryable RelayError | KEEP | — | (`:367-374`). |
| fails an in-flight write with a retryable error when the socket closes | KEEP | BRITTLE | The title says retryable but the test asserts `false` (`:376` vs `:388`); exact message equality (`:387`). Fix the name. |
| fails pending work retryably when the facade resets the socket | KEEP | TAUTOLOGICAL (partial) | The `retryable: true` assert is real. The message assert just echoes the string the test passed to `reset()` (`:399`, `:404`). |

### `test/relay/client.test.ts`: all KEEP

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| dials lazily and reuses the socket across operations | KEEP | — | (`:45-56`). |
| shares one dial between concurrent operations | KEEP | — | (`:58-68`). |
| does not report connected while the socket is still connecting | KEEP | — | `status` honesty (`:70-84`). |
| retries a peer operation when a concurrent failure resets the socket | KEEP | — | (`:86-98`). `>= 2` sockets is loose. |
| serves fetchById through the same socket | KEEP | — | (`:100-107`). |
| dials a fresh socket after the relay dropped the live one | KEEP | — | (`:109-117`). |
| reconnects once when the connection dies before the ack | KEEP | — | Does not assert that the resent EVENT has the **same id** (`:129` checks only the count). In the plan flow a re-signed or re-stamped retry would fork the record. Add the id check. |
| never reconnects for a relay verdict | KEEP | — | (`:132-141`). |
| gives up after the reconnect budget and reports the last failure | KEEP | — | (`:143-152`). |
| retries a failed dial within the same budget | KEEP | — | (`:154-159`). |
| reconnectAttempts: 0 means exactly one socket and a rethrown failure | KEEP | — | Budget lower bound (`:161-169`). |
| is permanent: the socket is closed and later operations refuse | KEEP | — | (`:173-186`). |

### `test/relay/rawTransport.test.ts`: all DROP-ARCH

`rawTransport` was the NIP-46 signer channel and is imported nowhere in `src/`; `index.ts` uses
`identity/wsTransport.ts`.

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| queues frames until the socket opens, then flushes them in order | DROP-ARCH | — | (`:20`). |
| fans inbound frames out to every handler and stops after unsubscribe | DROP-ARCH | — | (`:34`). |
| refuses to send after close and closes the socket | DROP-ARCH | — | (`:59`). |
| drops the queue when the relay closes before it opens, and reports it | DROP-ARCH | — | (`:72`). |

### `test/tools/handlers.test.ts`

Each ADAPT here becomes `draft_plan` (with one or more records) → approve → `publish_plan`. The
`PublishReport` JSON-in-text becomes a per-record `structuredContent` result.

| Test | Verdict | Tag | Reason |
|---|---|---|---|
| sends the byte-exact event the builders and composer specify | ADAPT | — | Best test in the suite (`:172-224`). Content and tag literals are independent of the code, so the id equality is strong. Port it as a one-record plan. |
| refuses an oversized payload before the signer is touched and before any dial | ADAPT | — | Becomes a `draft_plan` refusal record. The `signerCalls` and `sockets` empty asserts (`:238-239`) must stay. The `'publish_product refused — nothing was signed.'` prose goes. |
| reports accepted-but-unverified honestly and says to call verify_event again | ADAPT | — | Per-record status. In the plan flow, an unverified parent must also stop its children (untested; see gaps) (`:242-249`). |
| surfaces preflight warnings on a successful publish | ADAPT | — | Warnings move to the draft preview (`:251-261`). |
| emits the Lens compatibility tag last and the metadata type tag | ADAPT | — | Metadata record (`:265-275`). |
| publishes the NIP-01 profile JSON with no tags | ADAPT | — | Profile record; exact JSON, `picture_url` → `picture` (`:279-299`). |
| emits BD-8 marked e tags and the rule-8d Refs line | ADAPT | — | Binding record. In the plan flow `root_ref`/`link_ref` are local refs resolved after the parent ack, so this is the key acceptance test (`:303-326`). |
| resolves the root chain and emits one e root + one e reply | ADAPT | — | Patch record (`:353-373`). |
| refuses a stale before baseline without spending a signature | ADAPT | — | Refusal record; `signerCalls` empty (`:375-387`). |
| accepts a unified diff only when it applies to the resolved tip | ADAPT | — | Byte-exact fenced content (`:389-405`). |
| refuses a diff that does not apply to the resolved tip | ADAPT | — | (`:407-423`). |
| refuses a target the relay does not have | ADAPT | — | Weak: asserts only the substring `'target_id:'` (`:432`). |
| publishes kind 5 with one e tag and the reason as content | ADAPT | — | Retract record (`:438-450`). |
| returns the stored event with id and signature checks | ADAPT | — | `verify_event` → `structuredContent`. Real signatures (`:454-469`). |
| reports a relay-served event whose id no longer matches its content | ADAPT | — | Relay-tamper detection (`:471-487`). |
| reports a missing event without an error | ADAPT | — | (`:489-494`). |
| reports connection state without dialing, then reflects the open socket | ADAPT | — | `status` `structuredContent` (`:498-506`). |
| signs the composed event with the bunker user key and publishes it | DROP-ARCH | — | NIP-46 (`:510-544`). |
| buildProduct emits the tag order the golden wire test asserts | DROP-QUALITY | REDUNDANT | Tests core's builder (core has its own tests). The golden test at `:172` and `test/compose/guide.test.ts:56` already fail on a tag-order change (`:550-561`). |

### `scripts/e2e.mjs`: real relay binary

Steps 1–10 run in order inside `runLoop`. Any failure aborts the run (`requireThat`). Gate cases
print PASS/FAIL. Port this as the plan-flow acceptance suite against the real relay: one plan of
profile → product → metadata → binding(product, metadata) → patch → retract.

| Step / case | Verdict | Tag | Reason |
|---|---|---|---|
| 1. status | ADAPT | BRITTLE | **Currently fails.** `/signer: (dev-key|nip46)/` (`:394`) no longer matches `signer: local env key — …` (`src/identity.ts:449`). Assert `structuredContent.signer.mode`. |
| 2. set_profile accepted + verified | ADAPT | — | Profile record against the real relay (kind 0 acceptance, relay `2184194`) (`:400-410`). |
| 3. publish_product (guide §8 inputs) | ADAPT | — | Plan record (`:413-416`). |
| 4. publish_metadata | ADAPT | — | Plan record (`:419-433`). |
| 5. publish_binding (real ids) | ADAPT | — | Becomes local refs inside the same plan. This is the core JIT-ordering acceptance case (`:436-446`). |
| 6. publish_patch (before = guide §8 block) | ADAPT | — | Plan record that targets a local ref (`:450-465`). |
| 7. verify_event(product): content and tags equal the guide | ADAPT | — | Real-relay round trip compared byte-for-byte with the documentation (`:468-489`). |
| 8. retract | ADAPT | — | Plan record (`:493-499`). |
| 9. verify_event(retraction) | ADAPT | — | (`:502-512`). |
| 10. verify_event(retracted) still fetchable (DEL-11) | KEEP | — | A relay-contract check the demo depends on (`:515-522`). |
| a. not-an-allowed-publisher | ADAPT | — | Verbatim relay message (`:565`). In the plan flow, the first rejected record must leave every child unsigned. |
| a/reached-relay (metrics) | KEEP | — | `/metrics` deltas prove the verdict came from the relay, not the client (`:572-582`). |
| b. oversized-payload-refused | DROP-QUALITY | REDUNDANT | The refusal never reaches a relay. Covered by `test/tools/handlers.test.ts:226` and `test/preflight/checkTable.test.ts:80`. The anchored full-prose regex (`:532`) is BRITTLE too. |
| b/no-event-frame (metrics) | DROP-QUALITY | REDUNDANT | Weaker than `test/tools/handlers.test.ts:239` (no socket at all) (`:611-619`). |
| c. future-clock-refused | DROP-QUALITY | TAUTOLOGICAL | Skews only the stamp seam (`:633`) while the signer reads the real clock (`src/identity/sign.ts:303`). It passes because of that seam; a genuinely fast machine moves both clocks and is never caught. |
| c/no-event-frame (metrics) | DROP-QUALITY | TAUTOLOGICAL | Same setup (`:651-657`). |
| d. author-mismatch | ADAPT | — | Drives `RelayClient` directly; the server cannot produce this case (`:671-697`). Move it to the relay's own tests or a relay-client contract test. |
| d/reached-relay (metrics) | ADAPT | — | Same relocation (`:698-708`). |
| remote rehearsal mode (`SCRUTINY_SIGNER_URI` bunker) | DROP-ARCH | — | NIP-46. Also stale: it checks `SCRUTINY_SIGNER_URI` (`:723`), but config reads `SCRUTINY_SIGNER` (`src/config.ts:84`). Cases b and c send the public `01…01` key against the remote relay (`:595`, `:632`), contradicting the message at `:726`. |

Also: when `go` is missing the harness prints `SKIPPED` and returns exit 0 (`:731-735`), so CI
reports green with no relay coverage. In the rewrite, a missing toolchain must fail CI, or CI must
be able to see the skip.

## Gaps: behaviours with no test, given the new architecture

### Plan graph (`draft_plan`)

1. A dangling local ref, a duplicate ref name, a self-reference, and a cycle each produce a refusal
   record whose `field` points at the offending record.
2. Ref type checks: a binding `root`/`link`, a patch `target` and a retract `target` must point at a
   record kind that is valid for them (or at an existing hex id). Mixing local refs and hex ids is allowed.
3. Topological order is deterministic for a given plan (a stable tie-break), so the preview order equals the publish order.
4. Rule 2a and rule 8d run on content **after** local-ref substitution: the binding `Refs:` line
   and the patch target id are only known after the parent is acked. The preview must show placeholders
   and the published content must equal the preview with ids substituted (golden test).
5. Preflight runs on every record at draft time, and the tag budget includes `e` tags and `imeta` rows.
   Today only `i`/`k`/`t` combinations are exercised (`test/preflight/checkTable.test.ts:51-76`).

### Approval (elicitation)

6. Approval is bound to the exact composed bytes. `publish_plan` must refuse when the plan or its
   composed content changed after approval (a plan hash or version).
7. Elicitation decline or cancel → nothing signed and no socket dialed (`signerCalls` empty, `sockets` empty).
8. A client without the elicitation capability → refusal record, with no fallback that signs without approval.
9. `publish_plan` called twice for the same approved plan does not double-publish (idempotency or replay refusal).

### Publish (`publish_plan`)

10. A child is signed only after its parent's OK **and** fetch-back verification. For each failure, assert that children are never signed:
    - the parent is rejected;
    - the parent ack times out (unknown outcome);
    - the parent is accepted but not verified.
11. Partial-publish result: a per-record status (published+verified / rejected / unknown /
    not-attempted) in `structuredContent`, with ids for what landed.
12. `created_at` is stamped at sign time, not at draft time. Stamps are monotonic across the plan, even
    when approval took longer than the relay's 2 h past window.
13. A lost-ack reconnect resends the **same signed bytes** (same id), never a re-stamped or re-signed
    event (`test/relay/client.test.ts:121` checks only counts).
14. The "sent but no verdict" branch (`src/tools/handlers/publish.ts:73-87`) has no handler-level test today.
15. A relay rejection at handler level (`accepted: false` plus the note) is covered only by e2e (`scripts/e2e.mjs:563`).
16. `verifyStored` mismatch and read-back-failure branches (`src/tools/handlers/verify.ts:57-69`) are untested.

### Result shape

17. Every tool's `structuredContent` validates against its advertised `outputSchema` (SDK-side validation is enabled).
18. One refusal record `{field, problem, fix}` for **every** failure class:
    - schema violation;
    - preflight finding;
    - no signer;
    - keyring outage vs missing entry vs wrong identity;
    - relay rejection;
    - timeout with unknown outcome;
    - composition bug.

    Today these are free text (`src/tools/handlers/context.ts:116-145`).

### Signer and keyring

19. The npub-form keyring account (`keyring://scrutiny-fabric/npub1…`, `src/identity.ts:364-376`) is
    untested; only the hex account is covered.
20. Secret non-echo in MCP results: a keyring read error or a malformed stored key must not leak into
    `status` or refusal text over the wire (tested only at function level).
21. `scripts/store-key.mjs` and `scripts/status.mjs` (keyring onboarding) have no tests.
22. A fixed NIP-01 event-id vector (independent of `computeEventId`) to anchor serialization.

### Relay and preflight details

23. NIP-42 success path with `authRelayUrl` set (proxy/tunnel dial with the public URL in the tag).
    Only the failure path is tested (`test/relay/authedSocket.test.ts:118`).
24. RL-1 boundary: exactly 65 536 bytes passes, 65 537 refuses. The `SIGNED_ENVELOPE_BYTES = 285`
    constant (`src/preflight/checkTable.ts:190`) is never checked against a real signed event's size.
25. Multi-byte UTF-8 byte counting in `utf8Bytes` (`src/preflight/checkTable.ts:252`) for content and tag values.
26. The rule 2a `«` exemption (`src/compose/content.ts:123`), labelled links (`src/compose/event.ts:70`)
    and `imeta` `alt` normalization (`src/compose/event.ts:163`).

### Process entry

27. stdio startup: a `ConfigError` gives exit code 2 with a message that does not echo secrets (`src/index.ts`).
