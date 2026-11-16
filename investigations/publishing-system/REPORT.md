# Publishing SCRUTINY Fabric events: system design and interface decision

**Date:** 2026-11-10
**Branch:** `research-fabric-event-publishing`
**Scope:** How an external vendor (pilot: Tropic Square) should publish security-relevant data as SCRUTINY Fabric events so it renders well in SCRUTINY Lens; whether the interface should be an MCP server, a web app, a CLI + playbook, or a hybrid.

No code was changed. Findings are from the protocol spec, the local `packages/core` / `packages/mirror` / `relay` sources, the Lens source at `C:/tmp/scrutiny-lens`, Tropic Square's public repository, and the web sources listed in §12.

---

## TL;DR

1. **Do not build "just an MCP" as the whole system — but do use the MCP's own description surface as the playbook.** Build one deterministic publisher engine, expose it through a **CLI first** (portable across Claude Code, Codex, OpenCode, and CI), and treat the MCP server as an **optional adapter** for harnesses that support it. The MCP `instructions` field + tool descriptions + a linked `AGENTS.md`/`llms.txt` can replace a separate skill; the same document is the CLI/startup-prompt playbook. Add a thin review console only if a non-technical approver or multi-tenant self-service requires it.
2. **An agent is the right *authoring* surface**, because security data is document-heavy and semi-structured. Give it a CLI + playbook (portable) or an MCP adapter (where supported); it is not the right *publishing* surface: signing, idempotency, retries, audit, and key custody belong in the engine/CLI.
3. **The central artifact is a publication plan**, not an event. Agents and humans edit a declarative, diffable plan; the engine validates it against the protocol + Lens contract, signs once, publishes idempotently, and records per-relay acks.
4. **For the two-week pilot: CLI + playbook first, MCP if the harness supports it, no app, no staging relay.** Demo path: agent reads local/public files → asks the interpretation questions → proposes plan → engine validates/previews → human confirms → publish to the pilot relay during a controlled open/allowlisted window → Lens shows the graph. Testers generate real keys; the CLI logs pubkeys and event IDs in a session manifest for post-test cleanup. Production path: plan in Git → PR review → CI signs/publishes.
5. **The biggest protocol/Lens gaps to fix or work around:** metadata subtype is a Lens-only top-level tag (`m|meta|metaType`) with a certification-centric vocabulary (`report|target|maintenance|sbom|advisory`), Lens's graph fallback reads legacy top-level tags instead of `i`, and the icon map lacks `advisory|report|sbom|specification|test`. The publisher should emit a small "Lens compatibility" tag set for the pilot; Lens/spec should be fixed long-term.

---

## 1. The job to be done

A vendor publishing "all security-relevant data" is not uploading files. It is building a graph that answers:

- *What product is this about?* — one Product per thing a user would search for.
- *What is the claim?* — one Metadata per specification, test result, evaluation report, advisory, SBOM, or release.
- *Why are they connected?* — one Binding per product↔metadata relation.
- *What changed?* — patches for evolving prose; new roots for new artifacts or identifiers; kind-5 retractions for statements the author no longer stands by.
- *Can a consumer verify it?* — signature, event id, artifact hash, publisher identity, chain state.

That yields eight jobs the system must do:

| # | Job | Hard part |
|---|---|---|
| 1 | Acquire source data (PDFs, JSON, APIs) | Document-heavy corpora are unstructured; every vendor differs |
| 2 | Model it (product identity, metadata type, edges) | The same document can be modeled several ways; identity choices are hard to reverse |
| 3 | Validate (protocol + rendering + relay limits) | Fail-closed before signing; errors must be machine-readable |
| 4 | Preview (what Lens will show) | Must be truthful, not a mockup |
| 5 | Sign (company identity, key custody) | The key must never enter the agent context; no revocation path on Nostr |
| 6 | Publish (idempotent, paced, multi-relay) | Partial batches, rate limits, relay freshness windows, duplicate events |
| 7 | Verify (fetch back, resolve, render) | A green publish is not a correct graph |
| 8 | Maintain (patches, retractions, new versions) | Roots' `i`/`imeta` are immutable; corrections require patch or re-root + retract |

The system is a **publishing pipeline with a human judgment step**, not a form and not a chat.

---

## 2. Protocol constraints that shape the system

Source: `C:/Users/alsorehi/scrutiny-fabric/docs/protocol-spec.md` (v0.8.1). Selected rules that matter to a publisher:

| Constraint | Consequence |
|---|---|
| Four event types, all kind 1, distinguished by `t` tags (TAG-1..3) | Every root needs exactly one `scrutiny-fabric`, one version, one type tag. A typo makes the event invisible to SCRUTINY consumers. |
| Product/Metadata roots carry `i`/`k` indexers (IX-1..4) | `i` is the discovery surface. `k` is derivable and should be emitted. Root `i`/`k` are immutable after publication; changing them requires a new root. |
| `i`/`k` are capped at 64 each (IX-2/3) and the relay counts **all single-letter tags** (`i`, `k`, `e`, `t`) against a 64-tag ceiling | A 64-indexer event plus `k` tags plus `t` tags is rejected. The mirror caps total single-letter tags at 60 (`packages/mirror/src/emit/seccerts/roots.ts:84-119`). |
| Binding is an immutable directed edge, exactly one `e root` (Product) + one `e link` (Metadata) (BD-1..10) | Corrections are delete + republish. Bindings cannot be patched. M:N = multiple Binding events. |
| Patch is a NIP-10 reply with one `e root` + one `e reply`, carrying a unified diff over the target's `content` (PT-1..11) | Patches only change prose. New artifact or new indexer = new root. A patch's context must occur exactly once (T1) or the chain HALTs. |
| Root-author patches must reply to the root or another root-author patch; foreign patches are overlays (PT-6/7) | The vendor must publish from one key/serialized pipeline, or risk a root self-fork (two patches replying to the same parent; §7.2). |
| `created_at` is publish time, not the fact's date (CA-1) | Historical dates go in `content`. The pilot relay rejects events older than **2 hours** (`relay/internal/config/config.go:49-52`) and more than 15 minutes in the future (`relay/internal/relay/relay.go:43`). Sign at publish time; do not build a batch and publish it days later. |
| NIP-92 `imeta` attachments (`url`, `m`, `x`, `size`) | Artifact hash is the only defense against substitution. Attach the actual PDF/SBOM; do not rely on the event signature to attest bytes. |
| NIP-09 kind 5 deletion = retraction; same pubkey only (DEL-1..11) | Retraction is a statement, not erasure. The pilot relay stores kind-5 but never acts on it (`relay/internal/gate/gate.go:138-140`); Lens applies the deletion client-side. |
| Writes require NIP-42 auth from an allowlisted pubkey; the authenticated key must equal the event author (`relay/internal/gate/gate.go:60-99`) | Onboarding is operator work: add the vendor's npub to `SCRUTINY_ALLOWED_PUBKEYS`. There is no self-service, and no delegation. |
| Relay limits: content ≤ 256 KiB, WS frame ≤ 512,000 B, indexable tags ≤ 64, query limit 500 | Large SBOMs must go to `imeta` (or Blossom), not inline. The mirror uses a 55 KiB content soft cap and a 60-total-single-letter-tag budget to stay under relay walls (`packages/mirror/src/emit/seccerts/roots.ts:100-119`); use the same headroom. |
| Kind 0 is accepted and replaceable | A vendor profile (name, picture) is publishable; Lens uses it for the publisher chip. |

**The immutability rule is the system's central UX constraint.** A vendor will want to "fix" a published event. The protocol says: patch the prose, or publish a new root and retract the old one. The publisher must make this obvious *before* signing, and must implement re-root + retract as a first-class workflow.

---

## 3. The Lens rendering contract

Lens is a static SvelteKit app with no server and no login; it reads relays, verifies events, and resolves chains. It does **not** publish (`docs/spec.md` §10, "Won't: publishing events"). The publisher must therefore target Lens's actual rendering logic, not an imagined API.

### 3.1 What each surface reads

| Surface | Deterministic input | AI-dependent input | Source |
|---|---|---|---|
| Result card | one card per **root Product**; title = first `i` tag for products, first content line for metadata; identifiers = deduped `i` tags; snippet = first 200 chars; counts = bound metadata / files / updates | title/snippet may be rewritten by the card agent, zod-gated | `src/lib/pipeline/cards.ts:84-145` |
| Graph node | kind; icon from `i` prefix (`cve`, `cert`, `st`, `cc-pp`) or kind default; title from top-level `ccid > cve > cpe > d > name`, else `identifier`, else first word; publisher; time; `edited ×N`; chain word | title/description/typeToken and metadata label may be AI-filled | `src/lib/graph/icons.ts:42-88`, `src/lib/ai/projector.ts:43-90`, `src/lib/graph/subject-graph.ts:273-286` |
| DetailDrawer | Summary/Content/History/Files; history rows `root`, `applied`, `halted here`, `shared parent`, `fork branch`, `pending`, `overlay`, `retracted`; content banners for `halted/forked/stopped at limit/absent` | summary text | `src/lib/dossier.ts:163-293`, `DetailDrawer.svelte:177-196` |
| Files | `imeta` only; `alt` ≤ 60 chars; `m` drives icon; `x`/`size` shown; subject-own rows first; binding-derived rows use the binding **content** as the verb (clipped 28) | record title may be AI-filled | `src/lib/artifacts.ts:33-170`, `src/lib/dossier.ts:296-364` |
| Publisher chip | kind-0 `name` → `display_name`; `picture`; otherwise identicon + npub | none | `src/lib/net/profiles.ts:167-180`, `PublisherChip.svelte` |
| Facets | every `i` prefix becomes a facet group; values counted; OR within, AND across | none | `src/lib/pipeline/cards.ts:157-201` |
| Chat | answers cite admitted events; citation quotes must match content verbatim | yes, but citations are verified | `docs/spec.md` §2 |

### 3.2 The publisher checklist

**Emit for protocol correctness:**

- Exactly one `["t","scrutiny-fabric"]`, one `["t","scrutiny-v0.8.1"]`, one type tag.
- `["i","<prefix>:<value>"]` for top-level indexers the record is *about*; `["k","<prefix>"]` once per distinct prefix.
- `content` with a headline first, then plain-text bullets; no tables, no fenced blocks on roots.
- Binding: `["e", productId, relayHint, "root", productPubkey]`, `["e", metadataId, relayHint, "link", metadataPubkey]`; content is a short human label (it becomes the Files verb chip).
- Patch: `e root` + `e reply` + fenced `diff` block; compute the diff against the **resolved tip**, not the root.
- Kind 5: `["e", targetId]`, same author, human reason in `content`.
- `imeta`: `url` (http(s)), `m`, `x` (64-hex SHA-256), `size`, `alt` (≤ 60 chars).
- `created_at` = now (within the relay window). Historical facts go in prose.
- One Product per searchable thing; every Metadata bound to at least one Product.

**Emit for Lens today (de-facto conventions, not protocol):**

- `["meta","<subtype>"]` on Metadata. Lens reads top-level `m`, `meta`, or `metaType` (`src/lib/ai/agents/nodes.ts:213-219`); this is the only way to get a deterministic metadata subtype. Lens's current vocabulary is `report|target|maintenance|sbom|advisory` — certification-centric. For a generic corpus, use `report` for specifications and test reports today, or extend Lens with `specification`, `test`, `datasheet`, `evaluation`. Do not invent a subtype Lens does not read: unknown values fall back to `unknown`. Prefer `meta` over `m` to avoid colliding with NIP-94's MIME `m`.
- `["identifier","<vendor code>"]` on Metadata for the AI-down graph title (`src/lib/ai/projector.ts:76-90`).
- `["name","<product name>"]` or `["ccid"|"cve"|"cpe","<id>"]` on Products if you want a clean graph title when AI is down. Result cards already use `i`.
- `["scheme","<scheme>"]` and `["eal","EAL6+"]` only when true; they compose the graph meta line (`src/lib/ai/projector.ts:57-70`).
- `["status","active"]` only; any other value is treated as `unknown` and dropped. **Never use `status` for "deprecated" or "archived"** — those are not protocol statuses (`docs/spec.md` §2 rule 2; `src/lib/ai/agents/nodes.ts:251-259`).
- Short binding content (≤ 28 chars is what the Files chip shows; longer is clipped).
- `i vendor:<slug>` on Products and Metadata for the vendor facet. `vendor`, `scheme`, `cc-cert-id`, `cc-scheme`, `pp` are Lens-guided prefixes (`src/lib/ai/agents/query.ts:26-41`) even though only some are in the spec registry.
- Preview against the pilot relay only during a controlled open/allowlisted window; log pubkeys and event IDs so the operator can filter/wipe them afterward. `-test` tags are not a substitute: Lens only admits them when `PUBLIC_INCLUDE_TEST_TAGS` is on.

**Do not emit / do not rely on:**

- `t` facets for filtering — Lens facets come from `i` prefixes, not `t` (`src/lib/pipeline/cards.ts:162-201`). `t` tags only classify event type.
- URLs in `content` as files — Lens Files are `imeta` only (`src/lib/artifacts.ts:1-17`).
- Long `alt` labels — > 60 chars are dropped, not truncated (`src/lib/artifacts.ts:159-165`).
- Backdated `created_at` — relay rejection is silent.
- Metadata without a Product root — Lens result cards are product cards; metadata-only events do not appear in the results rail (`src/lib/pipeline/cards.ts:112-115`).

### 3.3 The gaps worth fixing in Lens/spec

These are not publisher problems; they are cross-repo design gaps surfaced by this research:

1. **Metadata subtype is a Lens-only tag with a certification-centric vocabulary.** The protocol has no canonical metadata type. Lens's enum is `report|target|maintenance|sbom|advisory`, which does not cover product specifications or test results. Fix: add a canonical, generic `meta` tag to the spec and extend Lens with `specification`, `test`, `datasheet`, `evaluation` (or document a mapping). Until then, the publisher emits `["meta","report"]` for specs/tests as a documented compatibility profile.
2. **Graph fallback reads legacy top-level tags, not `i`.** `projectSkeleton` uses `ccid|cve|cpe|d|name` (`src/lib/ai/projector.ts:43-53`), so a protocol-correct event with `i cve:` gets a poor AI-down title. Fix: derive identifiers from `i` first, legacy tags second.
3. **Icon map lacks `advisory`, `report`, `sbom`, `specification`, `test`, `doc`, `part`.** A vendor advisory without a CVE falls back to a generic file icon (`src/lib/graph/icons.ts:42-47`). Fix: extend `BY_I_PREFIX` and/or map `meta` subtype to icons deterministically.
4. **No deterministic metadata-only card.** Only root Products become cards. If a vendor publishes a metadata record with no product root, it is invisible in results. This is a product decision, but document it.
5. **`status` misuse.** Vendors will want "deprecated", "superseded", "archived". Lens only knows `active`/`retracted`. The publisher must translate: a deprecation is a Metadata record or a patch, not a status.

---

## 4. Tropic Square: what the corpus actually is

Tropic Square is a useful pilot because its public data is **product specifications, test/evaluation results, and an advisory** — the generic case SCRUTINY Fabric exists for, not a certificate showcase. (For the record: TROPIC01 is not CC/SESIP certified and certification is not planned; do not model fake certificates. The protocol is not certification-specific.)

### 4.1 Public corpus (verified 2026-11-10)

From `github.com/tropicsquare/tropic01`:

- **6 public test/evaluation reports** (`doc/pages/security-reports.md`):
  - PUF — Tropic Square — `ODR_TR01_PSR_001_PUF_TropicSquare` — v1.0 and v1.1 PDFs.
  - ISAP — Security Pattern — `ODR_TR01_PSR_002_ISAP_SecPat`.
  - AES-GCM — Security Pattern — `ODR_TR01_PSR_003_AESGCM_SecPat`.
  - TRNG — Tropic Square — `ODR_TR01_PSR_004_TRNG_TropicSquare`.
  - Decapsulation — FEE UWB Pilsen — `ODR_TR01_PSR_005_Decap_ZCU`.
  - Fault Injection — KU Leuven COSIC — `ODR_TR01_PSR_006_FI_KUL`.
- **1 security advisory**: `ODR_TR01_SA_2026012900`, "Potential Bypass of Firmware Verification by Laser Fault Injection", PDF v1.0 (`doc/pages/security-advisories.md`). The public blog gives affected version 1.0, CVSS 5.7, mitigations, and a late-2026 hardware/firmware fix timeline ([Tropic Square blog](https://www.tropicsquare.com/blogs/potential-bypass-of-firmware-verification-by-laser-fault-injection)).
- **5 part numbers** (`doc/pages/part-numbers.md`): `TR01-C2P-T301` (recommended), `TR01-C2P-T202`, `TR01-C2P-T103`, `TR01-C2P-T101`, `TR01-B2S-T005` (deprecated).
- **8 firmware versions** (0.2.0 → 2.1.0) with datasheet/API versions and change notes.
- **Security architecture app note**, datasheets, API docs, errata, catalog list, and open RTL/firmware repositories.
- A CVD program with `security.txt` and PGP ([CVD](https://www.tropicsquare.com/cvd)).

Notably, the advisory has **no CVE** in the public index. Do not invent one. If a CVE is assigned later, the `i` tags are immutable, so the advisory would need a new root and a retraction of the old one.

### 4.2 Event model

| Real-world thing | SCRUTINY construct | Suggested tags |
|---|---|---|
| TROPIC01 family | Product | `i vendor:tropic-square`, `i part:TROPIC01`; content: auditable RISC-V secure element, SPECT, open RTL/firmware |
| Part number (e.g. T301) | Product (only if it has distinct docs/lifecycle) | `i vendor:tropic-square`, `i part:TR01-C2P-T301`; content: package, default FW, status |
| Product specification (datasheet, architecture, API) | Metadata + Binding | `i part:…`, `i doc:ODD_TR01_datasheet_vA_11`, `["meta","specification"]` (Lens today: `report`), imeta PDF |
| Test run / result (PUF, ISAP, AES-GCM, TRNG, decapsulation, fault injection) | Metadata + Binding | `i part:…`, `i test:ODR_TR01_PSR_001`, `["meta","test"]` (Lens today: `report`), imeta PDF/JSON |
| Evaluation report | Metadata + Binding to product | `i vendor:…`, `i report:ODR_TR01_PSR_001…`, `["meta","report"]`, `["identifier","ODR_TR01_PSR_001"]`, imeta PDF(s) |
| Security advisory | Metadata + Binding | `i vendor:…`, `i advisory:ODR_TR01_SA_2026012900`, `["meta","advisory"]`, `["identifier",…]`, imeta PDF |
| Errata | Metadata + Binding to part | `i part:…`, `i doc:ODD_…`, `["meta","report"]`, imeta PDF |
| Firmware release | Metadata + Binding to part | `i firmware:2.1.0`, `i part:…`, `["meta","maintenance"]`, release notes/hash |
| Deprecation of a part | Metadata "deprecation notice" + Binding, **not** `status` | `["meta","advisory"]` or `report`; content says deprecated, date, replacement |
| Vendor profile | kind 0 | `name`, `display_name`, `about`, `picture`, `nip05` (optional), `website` |

**Product identity heuristic:** one Product per thing a user would search for. Start with the family (`TROPIC01`); add part-number Products only where they carry distinct security artifacts (datasheet, errata, firmware). Bind family-wide reports to the family; bind part-specific docs to the part. Shared records become Lens "bridge" nodes between products, which is a feature, not noise.

**Do not model:**
- a fake CC/SESIP certificate (they have none);
- a fake CVE (the advisory has none);
- `status: deprecated` (not a protocol status);
- every SBOM component as an `i` tag (IX-4; use `purl` for top-level components only);
- one event per PDF page or per firmware file (attach multiple `imeta` to one record, or one record per version).

### 4.3 The immutability trap

`i`/`k`/`imeta` on a root are immutable (`IX-3`, `MD-5`). For Tropic Square:

- The PUF report has v1.0 and v1.1. Attach **both PDFs at first publication** if the record is "the PUF evaluation report". If v1.1 supersedes v1.0 and you want separate records, publish two Metadata events and bind both; do not add v1.1 later to the v1.0 event.
- If a report gets a new version after publication, publish a new Metadata event (new root) and either keep the old as historical or retract it with a reason.
- If the advisory gets a CVE, its `i` set changes; that requires a new root + kind-5 on the old advisory. Plan for it.

This is why the publisher needs a **preview + "this cannot be changed later" warning** on `i`/`imeta`, and a first-class "re-root" workflow.

### 4.4 Demo subset

A usability-test/demo set that exercises the generic case and every Lens state:

- 1 vendor kind-0 profile.
- 1 family Product `TROPIC01`.
- 2 part-number Products: `TR01-C2P-T301` (recommended) and `TR01-C2P-T202` (deprecated).
- 6 test/evaluation Metadata (one per report; PUF carries both PDF versions).
- 1 advisory Metadata.
- 2 specification Metadata: security-architecture app note and T301 datasheet.
- 10–12 Bindings.
- 1 patch: advisory update ("affected versions 1.0; fix in late-2026 hardened release") → `edited ×1`.
- 1 retraction: a clearly labeled **test record** created for the session (e.g. `TEST-DRAFT-…`), retracted to show the state. The relay stores kind-5 but does not act on it; clean the record up through the session manifest afterward. Do not retract a real Tropic Square record just to show a red node.
- 1 question for Lens chat: "Which TROPIC01 tests cover fault injection?" → cites the KU Leuven report.

That is ~28 events: enough for a readable graph, small enough to publish live within the relay's 2-hour freshness window.

---

## 5. What already exists

`packages/mirror` is the v0 importer. Its pipeline is the right skeleton:

```
loaders/  →  emit/ (plan → transform → sign)  →  gate/ (self-consume + verify)  →  publish/ (NIP-42, paced, ledger)  →  ledger
```

From the source map:

**Reusable as-is (corpus-agnostic):**
- `emit/keys.ts` — `Signer` interface, key loading (`NSEC`, `NSEC_FILE`), `createClock`.
- `emit/content.ts` — tag grammar, `composeContent`, record-card line, rule-2a "every machine fact in prose", shape assertions.
- `emit/binding.ts` (`buildBinding`), `emit/deletion.ts`, `emit/ndjson.ts`.
- `emit/seccerts/patch.ts` — a pure LCS unified-diff engine (misnamed, but general).
- `emit/seccerts/engine.ts` — the **sync engine**: DesiredState ⇄ ledger, C1–C5 root classifications (new / unchanged / patch / re-root+retract / retire), R1–R5 binding classifications (new / unchanged / replace+retract / retract / re-point), fork guards, deletions last.
- `gate/*` — shape/signature/tag/rule-2a/placeholder verification.
- `publish/*` — NIP-42 socket, NIP-20 acks, resume-skip, backoff, watchdog, retry queue.
- `ledger/*` — publish log and sync-state schema (sqlite, Bun).

**Corpus-specific (stay in mirror):** all `loaders/`, the jcalgtest builders, the sec-certs projections, and the `build:*` CLI arms.

**Critical finding:** mirror does **not** use `packages/core`'s builders. It has a parallel builder stack with its own content conventions. `core` is the canonical producer API (`buildProduct`/`buildMetadata`/`buildBinding`/`buildPatch`), but it does not enforce rule-2a/record cards, and it has no `imeta` builder (issue #81). A third-party publisher copying either one gets a different convention. **Unifying these is a precondition for a publisher SDK.**

**Missing for external onboarding:**

| Gap | Why it matters |
|---|---|
| No publication-plan schema | Agents/humans need a diffable input contract; current loaders are hard-coded TS |
| No kind-0 builder | Lens publisher chip needs a profile; relay already accepts kind 0 |
| No `imeta` builder in core | Every publisher hand-assembles `["imeta", ...]`; easy to get `alt`/`x`/`size` wrong |
| No standalone `retract`/`patch` command | The engine has the logic, but it is coupled to the sec-certs ledger |
| No multi-relay publisher | `publishBatch` is single-relay; only `examples/publish-bulk.mjs` fans out |
| No preview | `--dry-run` emits unsigned templates; no Lens-shaped preview |
| No approval/review | The jcalgtest "draft manifest, stop for review" is the only precedent |
| No artifact hosting | `imeta` points at upstream URLs; no Blossom upload |
| No Node portability | `bun:sqlite` is the only Bun lock-in; the examples prove a Node/noble path |
| No staged onboarding | Relay allowlist is an env edit + redeploy; no self-service |
| No MCP | Planned v0.2 (ADR D4/D42), absent |

**Packaging implication:** extract a `@scrutiny-fabric/publish` engine (private first, publish later) with the sync engine, gate, publisher, ledger, signer, and a plan schema. `@scrutiny-fabric/cli` and `@scrutiny-fabric/mcp` become thin surfaces over it. `core` stays sans-IO; add the `imeta` builder there (issue #81) and keep crypto/relay in the publish package (D6/D12).

---

## 6. Architecture: one engine, three surfaces

```
Source data (PDFs, JSON, product DB, Git repo)
        │
        ▼
  Publication plan  ◄──── MCP (agent edits, validates, previews)
        │                 CLI (humans/CI edit, validate, preview)
        │                 App (optional review console)
        ▼
  Publisher engine
   1. resolve local keys → event refs (ledger + live relay)
   2. build unsigned templates (core builders + content profile)
   3. validate protocol + Lens + relay limits (fail-closed)
   4. preview (per-event table, diff, graph summary)
   5. sign once (created_at = now; plan handle binds exact bytes)
   6. publish (NIP-42, per-relay cursor, NIP-20 acks, backoff)
   7. verify (fetch back, recompute id, resolve chain)
        │
        ▼
  Relays  ──►  SCRUTINY Lens
```

### 6.1 The publication plan

The plan is the contract between authors and the engine. It is declarative, diffable, reviewable, and contains **no signatures** and **no `created_at`**.

```jsonc
{
  "planVersion": 1,
  "publisher": { "npub": "npub1…" },
  "products": [
    {
      "key": "tropic01",
      "content": "TROPIC01 — auditable RISC-V secure element …\n- …",
      "indexers": ["vendor:tropic-square", "part:TROPIC01"],
      "artifacts": []
    }
  ],
  "records": [
    {
      "key": "puf-report",
      "product": "tropic01",
      "kind": "report",
      "content": "TROPIC01 PUF — independent security and reliability evaluation …\n- …",
      "indexers": ["vendor:tropic-square", "report:ODR_TR01_PSR_001_PUF_TropicSquare"],
      "identifier": "ODR_TR01_PSR_001",
      "artifacts": [
        { "url": "https://…/…_1v0.pdf", "m": "application/pdf", "x": "…", "size": 123456,
          "alt": "PUF report v1.0 (PDF)" },
        { "url": "https://…/…_1v1.pdf", "m": "application/pdf", "x": "…", "size": 123789,
          "alt": "PUF report v1.1 (PDF)" }
      ],
      "binding": "Independent PUF evaluation report for TROPIC01"
    }
  ],
  "patches": [
    { "target": "lfi-advisory", "content": "…updated affected versions…" }
  ],
  "retractions": [
    { "target": "test-record", "reason": "Superseded by the published test record." }
  ]
}
```

Why a plan, not direct event construction:

- Agents are good at editing structured data and explaining diffs; they are bad at computing event ids, tags, and parents.
- The engine can validate the plan without side effects, and preview it without signing.
- The plan can live in Git and be reviewed with normal PR tooling.
- The plan hash is the idempotency key; the signed bytes are the replay unit.
- A plan can be regenerated from a source adapter and diffed against the previous plan (the mirror's sync engine already does this).

### 6.2 The engine's invariants

1. **No key in the plan.** The signer is injected (`Signer` interface); the plan never contains an nsec.
2. **Sign once, replay bytes.** `created_at` is stamped at materialization; the plan handle stores the signed bytes. A retry publishes identical bytes, so the relay dedupes by event id. Re-signing with a new timestamp is how you mint a new event and self-fork.
3. **Tip check before signing.** For a patch, resolve the target's canonical content and tip from the relay/ledger; compute the diff against the tip, not the root. Refuse if the tip changed between plan and publish.
4. **One root-author patch per tip per batch.** The mirror's fork guard (`engine.ts:25-28, 399-403`) is the model. Serialize plan→publish per (root, pubkey) with a lease if multiple operators exist.
5. **Deletions last.** Never retract a root before its replacement is published; the mirror orders kind-5 last (`engine.ts:30-33`).
6. **Fail closed.** A gate failure blocks the whole batch; no partial "best effort" publish.
7. **Relay window check.** If `now - created_at` approaches the relay's past-age limit, re-materialize the *unpublished* batch; if some events are already published, do not re-sign roots/bindings (their ids are referenced). For small vendor batches this is a non-issue; for large backfills, widen the relay window intentionally.

### 6.3 Key custody

| Option | Use for | Tradeoff |
|---|---|---|
| CI secret / OIDC workload identity | Production, recurring sync | Best audit story; key never on a laptop; needs CI |
| NIP-46 remote signer/bunker | Human-driven MCP/app; multi-device | Key stays in the signer; latency; batch signing may be slow |
| KMS/HSM-backed signer service | Enterprise production | Strongest custody; secp256k1 Schnorr support varies; custom service |
| Local nsec in env/file | Pilot/demo only | Simple; high leak risk; never in the agent context |

The relay allowlist is the outer bound: even a compromised publisher can only misuse the one allowlisted key. That is not a substitute for custody, but it bounds blast radius.

### 6.4 Governance

The strongest production pattern, and the one every comparable system uses, is **plan in Git → PR review → CI signs/publishes**:

- The author (human or agent) opens a PR with a plan file and artifacts.
- Reviewers see the plan diff, the validation report, and the preview link.
- CI runs `validate`, then `publish` on merge, using a CI-held key.
- The ledger and CI logs are the audit trail.
- Retractions are separate PRs with a reason.

This gives you agent-assisted authoring without letting the agent sign. It also works with GitHub/GitLab, which vendors already have. For a vendor without Git, the CLI's `--confirm` + a review console is the fallback.

---

## 7. Interface decision

### 7.1 Comparison

| Dimension | CLI/CI | Web app | MCP server | Playbook/prompt |
|---|---|---|---|---|
| Operator skill | Engineer/DevOps | Non-technical | Anyone with an agent client | Same as MCP |
| Determinism | High | High (if state machine behind UI) | Low end-to-end; tools deterministic, orchestration probabilistic | Lowest (instructions only) |
| Recurring sync | Native | Must build | Poor (stateless, no cron) | None |
| Governance/audit | High (branch protection, CI logs) | High (RBAC, approvals, SSO) | Emerging (host approval, scopes) | None |
| Key custody | Strong (CI secret/OIDC) | Strong (backend signer) | Weakest (long-lived env/PAT risk) | Same as MCP |
| Build cost | Low–medium | High | Medium | Very low |
| Demo value | Medium | High | High | Low |
| Best for | Repeatable, high-volume, production | Judgment calls by non-technical approvers | Interactive onboarding/mapping | Procedural consistency |

Sources: GitLab CI-only publishing and Sigstore keyless signing ([GitLab](https://docs.gitlab.com/development/npmjs/), [Sigstore CI](https://docs.sigstore.dev/quickstart/quickstart-ci/)); Stripe approvals/RBAC ([Stripe](https://docs.stripe.com/account/approvals)); MCP statelessness and client-dependent elicitation ([MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp)); Anthropic's API/CLI/MCP three-layer guidance ([Anthropic](https://claude.com/resources/articles/building-agents-that-reach-production-systems-with-mcp)); Sanity/Contentful/GitHub MCP guardrails ([Sanity](https://www.sanity.io/docs/ai/mcp-server), [Contentful](https://www.contentful.com/developers/docs/tools/mcp-server/), [GitHub](https://github.com/github/github-mcp-server)).

### 7.2 When each is right

- **CLI/CI** — the operator is an engineer; the output is public/immutable; cadence is recurring; audit/provenance is contractual; key custody must be workload identity. This is the default for all signing and publishing.
- **Web app** — a non-technical human must judge (approve extracted metadata, decide retractions, manage roles) and budget exists. Never the recurring-sync path.
- **MCP** — the vendor's primary interface is an agent client and the task is interactive/one-off: mapping documents, proposing a graph, explaining validation failures. Always read-only-first; write tools behind explicit approval; never the sole publishing path.
- **Playbook** — procedural knowledge that must be consistent across conversations: field mapping, event ordering, the Lens tag contract, the curation policy. Put the short version in the MCP `instructions` + tool descriptions, and the long version in `AGENTS.md`/`llms.txt`; a separate skill file is optional. It is a playbook, not an enforcement mechanism.
- **Prompt alone** — never enough. It cannot validate, sign, or guarantee idempotency.

### 7.3 Recommendation

**Build the engine + CLI first; add the MCP as a thin wrapper; ship one playbook (`AGENTS.md`/`llms.txt`); defer the app.**

Phasing:

1. **P0 — Publisher engine + CLI** (the foundation):
   - `plan` schema and parser; `validate` (protocol + Lens + relay); `preview`; `publish`; `retract`; `status`; `verify`.
   - Extract the mirror's sync engine, gate, publisher, ledger; unify content conventions; add `imeta` and kind-0 builders.
   - Node-first; Bun optional; key via env/CI/NIP-46.
2. **P1 — MCP server** (optional adapter for harnesses that support it):
   - Local stdio, one process per company, signer in server config, no key in tool args.
   - Tools: `plan`, `validate`, `preview`, `publish`, `retract`, `status`, `resolve`.
   - Resources: rules, plan preview, chain state, Lens checklist, examples.
   - Prompt: `/publish-security-data`.
3. **P2 — Playbook + Tropic Square adapter** (the pilot):
   - `AGENTS.md`/`llms.txt` playbook (event model, curation policy, Lens checklist, exact tool calls); the MCP `instructions` + tool descriptions carry the short version and link to it.
   - Adapter for Tropic Square's Markdown indexes + PDFs; generate a draft plan; hash artifacts.
   - Publish a curated demo subset to the pilot relay during the controlled window; verify in Lens.
4. **P3 — Review console** (only if needed):
   - Thin Svelte app over the same engine: plan diff, validation report, graph preview, approve/retract, audit.
   - NIP-46 signer or backend signer; RBAC if multi-user.
   - Not a CMS; no separate source of truth.
5. **P4 — Production sync**:
   - CI schedule, multi-relay, monitoring, key rotation, Blossom/artifact hosting.

**For Tropic Square, MCP-first is justified for authoring** because their corpus is document-heavy and their volume is low. But the publish step should still be the engine/CLI, ideally via Git PR + CI. The MCP is the "brain" that maps documents to a plan; the engine is the "hands" that sign and publish.

**Why CLI-first for portability:** the pilot must run in "any agent or harness." A CLI works wherever the agent can run shell commands; MCP is not universally supported and adds a server process. The MCP adapter is worth adding where supported, but the CLI + playbook/startup prompt is the portable contract. The MCP calls the same engine, never a second implementation.

### 7.4 What would change this recommendation

- If Tropic Square insists on non-technical self-service → build the review console earlier.
- If they want weekly automated sync from a product DB → CLI/CI is the primary surface; MCP is optional.
- If the ambition is a hosted multi-vendor product → the app/backend is the product; MCP is a client, and you need OAuth, per-tenant keys, RBAC, and audit from day one.
- If they cannot run local software → remote MCP/app with OAuth and a backend signer; do not put the key in the client.

### 7.5 Pilot decisions (2026-11-10)

The pilot answers change the build order, not the architecture:

| Decision | Answer | Consequence |
|---|---|---|
| Operator | The user opens an agent and points it at local files; CI is the later path | CLI + playbook first; MCP adapter only where the harness supports it |
| First milestone | One dataset in ~2 weeks, no sync yet | Build the smallest end-to-end path: local files → plan → validate → preview → publish → Lens |
| Future | CI sync is important | Design the plan/engine so CI reuses the exact same plan; add `--ci`/non-interactive mode now |
| Keys | Fresh demo key now; a company-owned key later | `keygen` + age-encrypted file/OS keychain for the demo; NIP-46/CI secret for production; no NIP-07 |
| Approval | Demo: interview + preview + confirm; future CI deterministic | The playbook/startup prompt conducts the interview; `publish` requires confirm; CI can pass `--yes` after validation |
| Relay / test session | Pilot relay with a time-boxed open window or live allowlisting; **no staging relay** | Add `--session-manifest` (pubkeys, event ids, relay); cleanup is operator-level; kind 5 is not a cleanup mechanism |
| Ambition | A reusable local-first toolkit for protocol users; no hosting; front end later | CLI is the portable contract; MCP is an adapter; app deferred |
| Harness | Any agent/harness (Claude Code, Codex, OpenCode, …) | CLI + startup prompt is the common denominator; MCP only where supported |

**Two-week demo build order:**

1. **Days 1–2:** CLI skeleton (`keygen`, `plan`, `validate`, `preview`, `publish`), plan schema, age-file signer, relay probe.
2. **Days 3–4:** Tropic Square adapter (Markdown tables + PDFs → plan), `imeta` hashing, Lens compatibility tags.
3. **Days 5–6:** pilot-relay publish inside the controlled window + verify + Lens checks; fix the preview.
4. **Days 7–8:** `AGENTS.md`/`llms.txt` playbook (also the MCP `instructions` + tool descriptions) with the interview questions; end-to-end rehearsal.
5. **Days 9–10:** MCP adapter only if the chosen harness supports it; otherwise polish the CLI demo.
6. **Buffer:** relay allowlist, key backup, fallback preview.

**Key custody recommendation.** For the demo, `scrutiny keygen` creates a fresh key, stores it in an age-encrypted file (or OS keychain), prints the npub, and the operator adds that npub to the relay allowlist. Do **not** use a browser extension: NIP-07 is a browser API, and the agent/CLI cannot use it. For production, the company generates its key on a trusted machine, backs it up (password manager + offline copy), and signs through a NIP-46 bunker or a CI secret; the CLI/MCP only sees the `Signer` interface. Losing the key loses the identity; there is no revocation. Rotating requires a relay allowlist update, and old events remain under the old key.

**No staging relay.** The pilot relay is the test surface. Either the operator adds each generated npub to `SCRUTINY_ALLOWED_PUBKEYS` as testers create keys, or the relay gets a time-boxed open-write mode (e.g. `SCRUTINY_OPEN_WRITE_UNTIL`) for the session. The publisher writes `test-session.json` with every pubkey, event id, timestamp, and relay; cleanup is operator-level (backup, filter by pubkey/event id, rebuild/move). Kind 5 is stored but not honored, so retraction is not a cleanup mechanism. Do not add a `--testing` tag/flag: the decision is real keys, real events, post-hoc cleanup.

**Interview flow for the demo.** Before building the plan, the agent should ask: (1) what are the distinct products/part numbers a user would search for; (2) which documents belong to the family vs a part; (3) what type each record is (`specification`, `test`, `report`, `maintenance`, `sbom`, `advisory`); (4) which records are drafts or superseded; (5) what short label should appear on each edge; (6) whether any record needs a retraction demo. The answers become plan fields, not free-form events.

---

## 8. MCP design (if built)

### 8.1 Primitives

- **Tools** for actions: `plan`, `validate`, `preview`, `publish`, `retract`, `status`, `resolve`.
- **Resources** for read-only context: `scrutiny://rules` (rules.json, the agent-facing artifact), `scrutiny://relay/info`, `scrutiny://chain/{rootId}`, `scrutiny://plan/{handle}/preview`, `scrutiny://docs/lens-checklist`.
- **Prompts** for the guided workflow: `/publish-security-data` — optional sugar; the `instructions` field and tool descriptions carry the contract (see §8.5).
- **No sampling** (deprecated and unnecessary); **roots optional** (pass paths as tool args; roots are deprecated in newer MCP revisions).
- **Tasks/progress** only for large batches; pilot volume does not need them.

### 8.2 Minimum safe tool surface

| Tool | Read-only | Destructive | Notes |
|---|---|---|---|
| `plan` | yes | no | Takes record selectors (paths/IDs), event type, optional target chain. Resolves live tip, builds templates, validates, **signs once**, returns `{planHandle, perEventSummary, diff, expectedTip}`. No key param. Single-use, TTL-bound handle. |
| `validate` | yes | no | Validate a draft plan/event; returns D40-shaped `{code, layer, section}` issues. |
| `preview` | yes | no | Per-event table + diff + graph summary; optionally a pilot-relay URL during the test window. |
| `publish` | no | no (additive) | Takes `planHandle` + `expectedTip`; re-checks tip; replays identical signed bytes; per-event NIP-20 results. **The confirmation boundary.** |
| `retract` | no | yes | Builds a kind-5 for an event the publisher authored. Highest friction: require the event id typed or `confirm: "RETRACT <id>"`; operator-only initially. |
| `status` / `resolve` | yes | no | Ledger state, per-relay acks, canonical content, chain state. |

### 8.3 Confirmation and safety

- **No nsec/secret in any tool argument.** The server loads it from env/age file or calls a NIP-46 bunker. Tool inputs pass through the model context; a secret there is a leak.
- **Plan handle as the backstop:** single-use, short TTL (e.g. 10 min), bound to the authenticated principal and the signed bytes' digest. Even a naive client cannot re-publish different bytes with the same handle.
- **Only `publish` and `retract` change external state.** Everything before the human says yes is read-only. Client tool-approval prompts are universal; elicitation is not, so do not depend on it.
- **Treat source documents as untrusted.** SBOMs/advisories/PDFs can contain prompt injection. The server should extract structured fields deterministically; the agent should not free-text signed content from untrusted text without human review.
- **Pin tool definitions and the server package** (rug-pull defense); scope the package name (`@scrutiny-fabric/mcp`).
- **Audit every tool call** with plan handle, event ids, per-relay acks, and who confirmed.

### 8.4 Deployment

- **Pilot: local stdio**, one process per company, key in server config. No OAuth; the relay allowlist is the bound. This is the simplest safe deployment and matches the existing mirror key-loading pattern.
- **Production: remote Streamable HTTP** only with OAuth 2.1, resource indicators, per-tenant keys in a backend signer, RBAC, and audit. A remote server that signs with one corporate key for many users is a confused-deputy magnet.
- **Client support:** Claude Code/Desktop, Codex, OpenCode, VS Code Copilot, Cursor; tool-approval UI is common, elicitation is not. Design for the lowest common denominator.

### 8.5 Instructions, tool descriptions, and the playbook

The server's `instructions` field (returned at initialize) is the right place for the short contract: what the server does, the plan→validate→preview→publish flow, the confirmation boundary, and the error shape. Each tool description states inputs, side effects, and annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). The long playbook — event model, curation policy, Lens checklist, examples, interview questions — is a resource/file (`AGENTS.md` or `llms.txt`) linked from the instructions and tool descriptions.

This replaces a separate "skill" for MCP-capable harnesses. Caveats:

- Clients differ in whether they surface `instructions`; the linked resource/file is the reliable path.
- Keep tool descriptions short and model-facing; do not paste the whole playbook into every description.
- For CLI-only harnesses, the same `AGENTS.md` is the startup prompt; `--help` prints the short version.
- Version the playbook with the MCP/CLI; a stale playbook is worse than none.

---

## 9. CLI + playbook design

### 9.1 CLI surface

```
scrutiny-publish init --vendor "Tropic Square"
scrutiny-publish keygen --out key.age
scrutiny-publish profile publish --name … --picture … [--nip05 …]
scrutiny-publish plan new
scrutiny-publish plan add product --key tropic01 --name TROPIC01 --indexer vendor:tropic-square
scrutiny-publish plan add record --key puf --product tropic01 --type test \
    --file report.pdf --indexer test:ODR_TR01_PSR_001 …
scrutiny-publish plan add record --key spec --product tropic01 --type specification \
    --file datasheet.pdf --indexer doc:ODD_TR01_datasheet_vA_11 …
scrutiny-publish plan add record --key advisory --product tropic01 --type advisory \
    --file advisory.pdf --indexer advisory:ODR_TR01_SA_2026012900 …
scrutiny-publish plan patch --target <event-id|key> --content-file new.md
scrutiny-publish plan retract --target <event-id|key> --reason "…"
scrutiny-publish validate plan.json
scrutiny-publish preview plan.json --out preview.html
scrutiny-publish publish plan.json --relay wss://… --confirm \
    --session-manifest test-session.json
scrutiny-publish status --relay wss://…
scrutiny-publish verify --relay wss://… --expect <n>
```

Design rules:

- `validate` and `preview` are always safe; `publish`/`retract` require `--confirm` and print a summary of what will be signed.
- `--json` output with D40-shaped errors for agents/CI.
- `--dry-run` emits the per-event table and gate report, never signatures.
- `--plan-handle`/`--resume` for crash-safe publish; the ledger is the source of truth.
- One command per step; composable in CI.

### 9.2 Playbook contents

One playbook shipped with the CLI/MCP — `AGENTS.md`/`llms.txt`, referenced from the MCP `instructions` and tool descriptions:

- The four event types and when to use each.
- The publication plan schema and local-key references.
- Product identity heuristics; metadata subtype mapping (`specification`, `test`, `report`, `advisory`, `sbom`, `maintenance`); indexer discipline.
- The Lens checklist (headline, `i` tags, `meta`, `imeta alt`, binding verb, status rules).
- Curation policy (one product per searchable thing; one record per claim; don't dump nested SBOM components; attach versions at first publish; patch prose, new root for new artifacts; retract with reason).
- The exact CLI/MCP calls for each workflow.
- The interview questions and the "never publish without a human confirm" rule; `publish` steps marked human-invoked.

The MCP should put the short contract (what the server does, the confirmation boundary, the error shape) in `instructions` and each tool description, and link to the full playbook as a resource/file. Do not stuff the whole playbook into every tool description; tool descriptions are model-facing and should stay short.

A playbook is **not** a substitute for the engine. It reduces agent drift; it cannot enforce validation, signing, or idempotency.

---

## 10. App design (if/when)

The app worth building is not a CMS. It is a **review console**:

- Import/upload documents; show extracted fields with confidence and source region.
- Show the plan diff, validation report, and a Lens-shaped graph preview.
- Approve/reject/retract; record who/when/why.
- Manage keys via NIP-46 or a backend signer; never raw nsec in the browser.
- RBAC/SSO/audit only if multi-user.

Build it when:

- a non-technical approver must judge records,
- the vendor will not use Git/CLI,
- or you are offering a hosted multi-vendor service.

Do not build it as the primary publishing path. It duplicates the engine's state and becomes a second source of truth. A thin Svelte app can reuse Lens components and the engine; a full dashboard is a $20–70K / 6–12 week product before RBAC/SSO/compliance (vendor estimates; treat as order-of-magnitude).

---

## 11. Risks, open questions, and spec feedback

### 11.1 Risks

| Risk | Mitigation |
|---|---|
| Agent hallucinates an identifier/tag | Agent edits a plan; engine validates; human confirms; no free-text signed bytes |
| Prompt injection in a source PDF/SBOM | Server extracts structured fields; untrusted text never becomes tool instructions; human review |
| nsec leak through tool args/logs | No key params; signer in server config/NIP-46; redact logs |
| Root self-fork from two publishers | One writer per chain; tip lease; fork guard; serialize plan→publish |
| Re-sign on retry mints a new event | Sign once; replay identical bytes; plan handle bound to the digest |
| Relay rejects a batch as too old | Sign at publish time; chunk large batches; coordinate a window widen for backfills |
| Immutable `i`/`imeta` published wrong | Preview + warning; re-root + retract workflow; validate identifiers before signing |
| Lens renders poorly because of missing conventions | Emit the Lens compatibility profile; fix Lens to read `i`/`meta`; test on the pilot relay inside the controlled window |
| Test events pollute the pilot relay | Time-boxed open window or live allowlisting; `--session-manifest` with pubkeys/event ids; operator cleanup by pubkey/id; kind 5 is not cleanup |

### 11.2 Decisions taken and remaining operational questions

Taken (2026-11-10):

- **Operator:** local agent over local files for the first dataset; CI is the later path.
- **Milestone:** one dataset in ~2 weeks; sync later.
- **Keys:** fresh demo key; a company-owned key later; no browser extension.
- **Approval:** interactive interview + preview + confirm for the demo; CI deterministic later.
- **Ambition:** reusable local-first toolkit; no hosting; front end later.
- **Harness:** any agent/harness; CLI is the portable contract.

Remaining (operational, not architectural):

1. Does the relay get a time-boxed open-write mode, or do we add each generated npub to the allowlist live during the session?
2. Which harness will the demo actually use (Claude Code / Codex / OpenCode / other), so we can decide whether the MCP adapter is worth building in the two-week window?
3. Who runs the post-test cleanup (backup, filter by pubkey/event id, rebuild/move), and when?
4. Who owns the production key/backup at Tropic Square, and do they want NIP-46 or a CI secret?

### 11.3 Spec/Lens feedback to file

- **Spec:** canonicalize metadata subtype (or explicitly bless a `meta` tag) with a generic vocabulary (`specification`, `test`, `report`, `advisory`, `sbom`, `maintenance`); document the Lens compatibility tags as non-normative render hints.
- **Lens:** derive graph identifiers from `i` before legacy top-level tags; extend `BY_I_PREFIX` with `advisory`, `report`, `sbom`, `specification`, `test`, `doc`, `part`; map `meta` subtype to icons deterministically; consider a metadata-only card or explicitly document the product-root requirement.
- **Relay:** document the 2-hour past-age window and the 60-single-letter-tag budget for external publishers; add a time-boxed open-write mode (or a documented live-allowlist procedure) for testing; no staging relay.
- **Core:** producer-side `imeta` builder (issue #81); a kind-0 profile builder (publish package); a `buildPatch`-based re-root helper.

---

## 12. Usability-test / demo script

**Setup:** pilot relay with a time-boxed open write window (or live allowlisting of generated npubs), Lens pointed at it, Tropic Square's public repo available locally, the CLI installed, and an agent with the playbook (MCP adapter optional). Testers generate keys on the spot; `--session-manifest test-session.json` is on.

1. **Show the source** — Tropic Square's `security-reports.md`, `security-advisories.md`, and part-number/datasheet pages.
2. **Ask the agent:** "Onboard Tropic Square's TROPIC01 product specifications, tests, and advisory into SCRUTINY Fabric. Use one product for the family and bind each record."
3. **Agent reads the repo, asks the interview questions, proposes a plan:** 1 product, 2 specs, 6 tests, 1 advisory, N bindings; shows a table and validation issues.
4. **Correct one thing:** "Attach both PUF v1.0 and v1.1 to the PUF test record; keep the label short."
5. **Validate + preview:** engine reports protocol/Lens warnings; preview shows the graph and card text.
6. **Confirm and publish:** engine signs and publishes; returns event ids and per-relay acks.
7. **Open Lens:** show the product node, spec/test nodes, advisory node, files, publisher chip, facets.
8. **Patch the advisory:** "Update affected versions and add the late-2026 fix timeline." Publish; Lens shows `edited ×1` and the History row.
9. **Retract the test record:** publish a clearly labeled session record, then retract it; Lens shows the red dashed node and the retraction row; toggle "show deleted."
10. **Ask Lens chat:** "Which TROPIC01 tests cover fault injection?" — citation to the KU Leuven report.
11. **Cleanup:** the operator uses `test-session.json` to filter the session's pubkeys/event ids, backs up the store, and removes/moves those events. Kind 5 is not a cleanup mechanism; it only shows the retracted state in Lens.

**Fallbacks:** if the relay is unavailable, show the preview HTML and the signed NDJSON; if the AI is down, Lens's rule-5 fallback still shows the `i` tags and first 200 chars; if the agent misbehaves, the engine's validation gate blocks the publish.

---

## Appendix A — Plan schema (minimal)

```jsonc
{
  "planVersion": 1,
  "publisher": { "npub": "npub1…" },
  "products": [{
    "key": "string",                 // local reference, unique
    "content": "string",             // headline + bullets
    "indexers": ["vendor:…", "part:…"],
    "artifacts": [{
      "url": "https://…", "m": "application/pdf",
      "x": "64-hex", "size": 123, "alt": "≤60 chars"
    }]
  }],
  "records": [{
    "key": "string",
    "product": "product-key",
    "kind": "specification|test|report|target|maintenance|sbom|advisory",
    "content": "string",
    "indexers": ["vendor:…", "cve:…", "report:…"],
    "identifier": "string",          // Lens fallback title
    "artifacts": [ … ],
    "binding": "short human label"
  }],
  "patches": [{ "target": "key|event-id", "content": "string" }],
  "retractions": [{ "target": "key|event-id", "reason": "string" }]
}
```

Engine rules: local keys resolve topologically (products → records → bindings → patches → retractions); `created_at` is assigned at materialization; signatures are never in the plan; the plan hash is the idempotency key.

## Appendix B — Lens publisher checklist (compact)

| Do | Why |
|---|---|
| One Product root per searchable thing | Result cards are product cards; metadata-only events are invisible |
| Bind every Metadata to a Product | A binding's counterparty must be admitted or the edge/Files row disappears |
| `i` tags for top-level indexers; `k` per prefix | Discovery is `#i`; facets are `i` prefixes |
| `["meta","<subtype>"]` (`specification`, `test`, `report`, `advisory`, `sbom`, `maintenance`) | Lens's only deterministic metadata subtype; today Lens reads `report|target|maintenance|sbom|advisory`, so use `report` for spec/test until extended |
| `["identifier","<code>"]` | AI-down graph title |
| `imeta` `alt` ≤ 60, `m`, `x`, `size` | Files rows; long labels are dropped |
| Short binding content | It becomes the Files verb chip (clipped at 28) |
| Headline first; bullets; no tables/fences | Cards/snippets truncate; AI titles from the first line |
| `created_at` = now | Relay rejects backdated events |
| `status: active` only | Other values are silently `unknown` |
| Kind-0 profile (name/display_name/picture) | Publisher chip; otherwise identicon + npub |
| Pilot relay inside a controlled window + `--session-manifest` | No staging relay; test events must be findable for post-test cleanup |

| Don't | Why |
|---|---|
| Use `status` for deprecated/archived | Not a protocol status; silently unknown |
| Put URLs in content as files | Lens Files are `imeta` only |
| Add `imeta`/`i` after publication | Roots immutable; requires re-root + retract |
| Publish a metadata record with no product | No result card |
| Backdate `created_at` | Silent relay rejection |
| Put an nsec in a tool arg | Prompt-injection/exfiltration risk |
| Rely on search to find patches/deletions | They carry no `i`/`t`; only traversal reaches them |

## Appendix C — Tropic Square event map

| Key | Type | `i` tags | `meta` | Artifacts | Binding to |
|---|---|---|---|---|---|
| `tropic01` | Product | `vendor:tropic-square`, `part:TROPIC01` | — | — | — |
| `tr01-c2p-t301` | Product | `vendor:…`, `part:TR01-C2P-T301` | — | — | — |
| `tr01-c2p-t202` | Product | `vendor:…`, `part:TR01-C2P-T202` | — | — | — |
| `puf` | Metadata | `vendor:…`, `test:ODR_TR01_PSR_001…` | `test` | PUF v1.0 + v1.1 PDFs | `tropic01` |
| `isap` | Metadata | `vendor:…`, `test:…002…` | `test` | PDF | `tropic01` |
| `aesgcm` | Metadata | `vendor:…`, `test:…003…` | `test` | PDF | `tropic01` |
| `trng` | Metadata | `vendor:…`, `test:…004…` | `test` | PDF | `tropic01` |
| `decap` | Metadata | `vendor:…`, `test:…005…` | `test` | PDF | `tropic01` |
| `fault-injection` | Metadata | `vendor:…`, `test:…006…` | `test` | PDF | `tropic01` |
| `lfi-advisory` | Metadata | `vendor:…`, `advisory:ODR_TR01_SA_2026012900` | `advisory` | PDF | `tropic01` |
| `sec-arch` | Metadata | `vendor:…`, `doc:ODN_TR01_app_008` | `specification` | PDF | `tropic01` |
| `t301-datasheet` | Metadata | `part:TR01-C2P-T301`, `doc:ODD_TR01_datasheet_vA_11` | `specification` | PDF | `tr01-c2p-t301` |
| `test-record` | Metadata (session only) | `vendor:…`, `test:TEST-…` | `test` | — | `tropic01` |
| `lfi-advisory` patch | Patch | — | — | — | target `lfi-advisory` |
| `test-record` retraction | kind 5 | — | — | — | target `test-record` |

## Appendix D — Sources

**Local (verified reads):**
- `C:/Users/alsorehi/scrutiny-fabric/docs/protocol-spec.md` — v0.8.1; §3–§10, Appendix A.
- `docs/DECISIONS-2026-07-27.md` — D3/D4/D5/D6/D12/D13/D40/D42; D4 says CLI and MCP in v0.2.
- `packages/core/src/build.ts`, `validate.ts`, `events.ts`, `index.ts` — producer API, validation, imeta parser.
- `packages/mirror/src/emit/seccerts/engine.ts`, `packages/mirror/src/publish/*`, `packages/mirror/src/gate/*`, `packages/mirror/src/ledger/*` — sync engine, publisher, gate, ledger.
- `relay/internal/config/config.go`, `relay/internal/relay/relay.go`, `relay/internal/gate/gate.go` — relay limits, NIP-42, kind 0/5.
- `C:/tmp/scrutiny-lens` — `docs/spec.md`, `src/lib/pipeline/cards.ts`, `src/lib/ai/projector.ts`, `src/lib/ai/agents/nodes.ts`, `src/lib/artifacts.ts`, `src/lib/dossier.ts`, `src/lib/graph/icons.ts`, `src/lib/net/profiles.ts`, `src/lib/query.ts`, `src/lib/components/shell/DetailDrawer.svelte`.

**Web (primary/selected):**
- MCP specification 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- SEP-2575 stateless MCP: https://modelcontextprotocol.io/seps/2575-stateless-mcp
- OWASP MCP Top 10: https://owasp.org/projects/mcp-top-10
- MCP security best practices: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- Sigstore CI: https://docs.sigstore.dev/quickstart/quickstart-ci/
- GitLab CI-only publishing: https://docs.gitlab.com/development/npmjs/
- CSAF: https://www.csaf.io/tools/ ; https://docs.oasis-open.org/csaf/csaf/v2.1/csd01/csaf-v2.1-csd01.html
- OSV schema/withdrawn: https://github.com/ossf/osv-schema/blob/main/docs/schema.md ; https://google.github.io/osv.dev/faq/
- GitHub advisories: https://docs.github.com/en/rest/security-advisories/repository-advisories
- CVE Services: https://cveawg.mitre.org/api-docs/
- Stripe approvals: https://docs.stripe.com/account/approvals
- Anthropic three-layer guidance: https://claude.com/resources/articles/building-agents-that-reach-production-systems-with-mcp
- Claude Code skills: https://code.claude.com/docs/en/skills
- Sanity MCP: https://www.sanity.io/docs/ai/mcp-server
- Contentful MCP: https://www.contentful.com/developers/docs/tools/mcp-server/
- GitHub MCP: https://github.com/github/github-mcp-server
- Tropic Square FAQ: https://www.tropicsquare.com/faqs
- Tropic Square repository: https://github.com/tropicsquare/tropic01
- Tropic01 security reports: https://github.com/tropicsquare/tropic01/blob/main/doc/pages/security-reports.md
- Tropic01 security advisories: https://github.com/tropicsquare/tropic01/blob/main/doc/pages/security-advisories.md
- Tropic01 part numbers: https://github.com/tropicsquare/tropic01/blob/main/doc/pages/part-numbers.md
- Tropic Square advisory blog: https://www.tropicsquare.com/blogs/potential-bypass-of-firmware-verification-by-laser-fault-injection
- Tropic Square CVD: https://www.tropicsquare.com/cvd
