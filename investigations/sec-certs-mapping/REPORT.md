# Investigation 2 — sec-certs → SCRUTINY mapping — REPORT

**Date:** 2026-05-22
**Data:** `data/main-dataset.json` (200 MB, 6 737 `CCCertificate` records,
sec-certs v0.3.2), `data/maintenance_updates.json` (17 MB, 862
`CCMaintenanceUpdate` records).
**Spec reference:** `../../../scrutiny-fabric/docs/protocol-spec.md` §3–§4.6,
§7, §9.

## Verdict

**FITS WITH ONE CAVEAT.** The four SCRUTINY event types (Product,
Metadata, Binding, Patch) encode the entire CC data model cleanly,
including maintenance updates, cross-references between certs, protection
profiles, PDFs, and status transitions. The mapping is mechanical for
every dense field. **The one caveat:** §9 (canonical indexer registry)
needs `cc-cert-id` as a registered indexer kind alongside CPE / CVE /
PURL / FIPS validation number — sec-certs already uses scheme-issued cert
IDs (`604-LSS`, `BSI-DSZ-CC-…`) as the de-facto primary key, and the
discovery layer can't surface CC certs without it. Captured in "Spec gaps
surfaced" below.

## Dataset shape

| Field bucket | Count | Density |
|---|---|---|
| Certs (active / archived) | 1 835 / 4 902 | 100% |
| Schemes | 19 country codes | 100% |
| Categories | 15 CC categories | 100% |
| Report PDFs | 6 643 / 6 737 | 98.6% |
| Security Target PDFs | 6 500 / 6 737 | 96.5% |
| Cert PDFs | 3 259 / 6 737 | 48.4% |
| SHA-256 hashes on PDFs | 6 643 / 6 737 | 98.6% |
| Maintenance updates | 862 (across 687 parents) | 91% of parents have 1 update; max 4 |
| Maintenance update → parent linkage | 687 / 687 | **100% — no orphans** |
| Total PDF payload | ~11 GB | report ≈ 3.5 GB, ST ≈ 7.6 GB |

Every top-level field on `CCCertificate` is 100% dense (no sparse
fields), so the mapping table below has no "optional / sometimes
absent" rows. `state.cert.download_ok` and `state.st.download_ok` are
the only sub-fields with meaningful sparsity.

## Field-by-field mapping (`CCCertificate`)

For each field: **target SCRUTINY surface**, **how**, and **rationale**.

| sec-certs field | SCRUTINY surface | Encoding | Notes |
|---|---|---|---|
| `dgst` | implicit | not stored; the Nostr event id replaces it | `dgst` is sec-certs' own 16-hex digest. Discard on import; recreate by hash of the canonical Product content if a stable handle is needed offline. |
| `name` | **Product content** | line 1 of `content` | E.g. `Rathon-SSO v4.0`. |
| `manufacturer` | **Product content** | structured line in `content` | E.g. `Manufacturer: RathonTech`. Not a separate event — vendor identity is the *publisher pubkey* in the canonical case; for sec-certs imports we don't have the vendor's pubkey, so it stays as prose. |
| `manufacturer_web` | **Product content** | structured line in `content` | URL; no separate event. |
| `scheme` | **Product `i` tag** | `["i", "cc-scheme:KR"]` + `["k", "cc-scheme"]` | 19 distinct values; bounded vocabulary. Discoverable. |
| `category` | **Product content** | structured line; not an `i` tag | 15 values is small but the categories are a free-form CC taxonomy and don't have a registered indexer namespace. Prose suffices. |
| `status` | **Product content + Patch chain** | "Status: active" on root; status changes are Patches on the canonical chain | Two values (active/archived). Status flips fire a Patch updating the `Status:` line. See worked example §B. |
| `cert_link` / `report_link` / `st_link` | **Product `imeta`** | one `imeta` tag per PDF, carrying the URL | See "PDFs" below. |
| `not_valid_before` / `not_valid_after` | **Product content** | structured lines | Date range. Could also be `i` tags with a `cc-valid` kind, but no discovery use case justifies the indexer surface. |
| `security_level` (Set) | **Product content** | structured list | E.g. `[]` (empty in many recent KR certs) or `["EAL4+", "AVA_VAN.5"]`. |
| `protection_profile_links` (Set of URLs) | **Binding(s)** | one `scrutiny-binding` per PP, linking the Product's PP-conformance Metadata to a PP Product | The PP is itself a Product (see PP section). The Binding's `link` endpoint is a Metadata event saying "this cert claims conformance to this PP"; the `root` endpoint is the PP Product. |
| `maintenance_updates` (Set of inline records) | **Metadata + Binding per update** | each update becomes a separate Metadata event (carrying the maintenance report) + a Binding linking it to the parent Product | See "Maintenance updates" section. |
| `state.{report,st,cert}.pdf_hash` | **`imeta` `x` field** | SHA-256 hash | Spec §4.6 requires `x` for content integrity. 98.6% present; the 1.4% missing are PDFs whose `download_ok==false`. Skip the imeta for those (the URL is still in `content` as fallback). |
| `state.{report,st,cert}.{download_ok,convert_ok,extract_ok}` | dropped | — | These are sec-certs ingestion artifacts. Not part of the protocol-level representation. |
| `state.{...}.txt_hash` | dropped | — | Hash of the OCR'd text; sec-certs internal. |
| `pdf_data.{report,st,cert}_metadata` (Adobe PDF metadata) | dropped or **Metadata event** | optional secondary Metadata event with `k:pdf-metadata` | This is recoverable from the PDF itself. Surface only if a consumer wants metadata search without downloading 11 GB of PDFs. Default: drop. |
| `pdf_data.{report,st,cert}_frontpage` (extracted text) | dropped | — | OCR / first-page extraction is a derivation, recomputable from the PDF. |
| `pdf_data.{report,st,cert}_keywords` | dropped | — | sec-certs-internal keyword extraction. |
| `pdf_data.{report,st,cert}_filename` | **`imeta` `url`** | filename portion of the URL | Already implied by the URL; no separate tag. |
| `heuristics.cert_id` | **Product `i` tag** | `["i", "cc-cert-id:604-LSS"]` + `["k", "cc-cert-id"]` | **Primary discovery key.** See "Spec gap" — `cc-cert-id` isn't in §9's registered list yet. |
| `heuristics.eal` | **Product `i` tag** | `["i", "cc-eal:EAL1"]` + `["k", "cc-eal"]` | 8 bounded values (EAL1–EAL7, plus augmentations). Discoverable. |
| `heuristics.extracted_versions` (Set) | **Product content** | structured list | Version strings extracted from the ST. |
| `heuristics.cpe_matches` (nullable) | **Product `i` tags** | one `i` tag per CPE, with `k:cpe` | When non-null, this is the CPE binding sec-certs has computed. The `verified_cpe_matches` field overrides when present. |
| `heuristics.verified_cpe_matches` (nullable) | **Product `i` tags** | as above, takes precedence | sec-certs' higher-confidence CPE binding. |
| `heuristics.related_cves` (nullable) | **Metadata + Binding(s)** | each CVE is a separate `scrutiny-metadata` event with `i:cve:CVE-…`, bound to the Product via `scrutiny-binding` | Mirrors the worked example in spec §4.3. |
| `heuristics.direct_transitive_cves` / `indirect_transitive_cves` | **Metadata + Binding(s)** | same shape; the binding's `content` distinguishes direct vs indirect | E.g. "Indirect transitive CVE via dependency on Infineon TPM chip". |
| `heuristics.extracted_sars` (Set of SAR objects) | **Metadata event** | one Metadata event listing all SARs in `content` (JSON or prose) + `i` tags per SAR family/level | E.g. `["i", "cc-sar:ADV_FSP.1"]`. Bounded vocabulary (~40 families × 5 levels). |
| `heuristics.scheme_data` | **Metadata event** | one `scrutiny-metadata` event with the scheme registry's view, bound to the Product | Captures the certifying body's own record (which may diverge from what sec-certs scraped). |
| `heuristics.protection_profiles` (Set of PP dgsts) | **Binding(s)** | see `protection_profile_links` row above | Two views of the same data; sec-certs has both the URL list and the resolved PP digests. |
| `heuristics.{prev,next}_certificates` (nullable) | **Patch chain** | next-cert relationship becomes a Patch on the predecessor's chain, OR a Binding if pubkeys differ | This is the **revision chain across cert IDs** — different from `maintenance_updates`. A "next certificate" is a *recertification*, a new cert entirely; the relationship is metadata, not content evolution. Lean toward Binding. |
| `heuristics.{st,report,annotated}_references` | **Binding(s)** | one Binding per outgoing reference, anchored at the citing Product, linked to the cited Product | Cross-cert references inside CC reports — exactly the binding use case. |
| `heuristics.cert_lab` (nullable) | **Product content** | structured line when present | Sparse; sec-certs has lab info for some certs only. |

### PDFs → `imeta` (concrete shape)

For each of the three PDFs whose `download_ok==true` and whose
`pdf_hash` is non-null:

```
["imeta",
 "url <link>",
 "m application/pdf",
 "x <pdf_hash>",
 "size <pdf_file_size_bytes>",
 "alt <kind>: <filename>"]
```

Where `<kind>` is one of `report`, `st`, `cert`. The `alt` field uses
SCRUTINY's extended `imeta` semantics (§4.6) — it's the only place a
consumer can distinguish "which PDF is which" without reading the PDF
itself. The PDFs themselves are 11 GB total across the dataset; they
SHOULD live on a Blossom server (or any signature-authenticated content
host), not be inlined.

When `download_ok==false`, drop the `imeta` and keep the URL as prose in
`content` (so the cert isn't completely opaque, but no integrity
guarantee is implied).

## Maintenance updates — decision: **Metadata + Binding** (not Patch)

The investigation considered three options:

| Option | Shape per update | Pros | Cons |
|---|---|---|---|
| A | 1 Metadata + 1 Binding | matches sec-certs' own structural choice (separate record); update has its own PDFs which patches can't carry (immutable `imeta`); preserves vendor identity vs CB identity distinction | parent's `content` doesn't reflect the new build/version when viewed standalone |
| B | 1 Patch on parent's chain | appears inline in parent's timeline; CC concept "maintenance update" semantically = "this product changed" | patch can't carry the new maintenance-report PDF (imeta is per-event, not chain-aggregated); a maintenance update is usually issued by the **CB**, not the **product vendor** — so as a Patch it would be a "different pubkey" patch → §4.4 classifies it as a *dispute / annotation*, not the canonical chain, which is wrong |
| C | hybrid (Patch + separate Metadata + Binding) | both views available | 3 events per update × 862 updates = 2 586 event overhead; only buys what A already gives |

**Decision: A (Metadata + Binding).** Rationale:

- The CB (or sec-certs as a third-party indexer) is the typical publisher
  of maintenance updates, not the product vendor. §4.4's authorship rule
  ("same pubkey as the root event's author: canonical chain") would force
  CB-published patches into the *dispute* bucket, which contradicts what
  a maintenance update actually is.
- Each update has its own report PDF + ST PDF that the patch event cannot
  carry (the spec is explicit: `i` tags and `imeta` are immutable after
  root publication; patches only modify `content`).
- Option B is preserved for the **vendor self-attesting** edge case — if
  the original vendor publishes a maintenance update on their own
  product, it's a Patch on their canonical chain (and they would also
  republish an `imeta`-bearing new Metadata if they wanted to attach the
  new PDFs).

**Concrete encoding** (one Metadata event + one Binding event per update):

```jsonc
// The Metadata event (carries the maintenance report PDFs)
{
  "kind": 1, "pubkey": "<importer-or-cb-pk>",
  "content": "Maintenance update: Oracle Identity Governance 12c, Build 12.2.1.4, with patch 38477295 (January 2026)\nmaintenance_date: 2026-01-15",
  "tags": [
    ["t","scrutiny-fabric"], ["t","scrutiny-metadata"], ["t","scrutiny-v053"],
    ["i","cc-cert-id:604-LSS"], ["k","cc-cert-id"],
    ["imeta","url <maintenance-report.pdf>","m application/pdf",
             "x <pdf_hash>","alt report: 604-LSS MR v1.0.pdf"],
    ["imeta","url <new-st.pdf>","m application/pdf",
             "x <pdf_hash>","alt st: 604-LSS ST v1.6.pdf"]
  ]
}

// The Binding event (links the update Metadata back to the parent cert Product)
{
  "kind": 1, "pubkey": "<importer-or-cb-pk>",
  "content": "Maintenance update for parent CC certificate.",
  "tags": [
    ["t","scrutiny-fabric"], ["t","scrutiny-binding"], ["t","scrutiny-v053"],
    ["e","<parent-product-id>","","root","<parent-vendor-pk>"],
    ["e","<update-metadata-id>","","link","<importer-or-cb-pk>"]
  ]
}
```

## CC ↔ FIPS cross-references

Not present in `main-dataset.json` directly (FIPS lives in a separate
dataset which the user did not drop). sec-certs' API exposes it via
`heuristics.st_references` / `heuristics.report_references` when the CC
report cites a FIPS-validated module. Encode each such reference as a
**Binding** with `link = CC Product`, `root = FIPS Product` (or
vice-versa depending on direction; the spec's marker semantics are
endpoint-symmetric for non-chain edges). Defer the detailed FIPS-side
mapping until the FIPS dataset is available.

## Protection profiles (`ProtectionProfile`)

Per the sec-certs docs (the user-dropped Sphinx stubs):
`sec_certs.sample.ProtectionProfile` has the same general shape as
`CCCertificate` — name, scheme, document attachments, conformance
relations. **Map identically to a Product event.** The PP-conformance
relationship is then a single Binding per cert × PP pair, as above.

## Vendor identity

sec-certs has no Nostr pubkey for vendors — they're just strings. For
imports:

- **Default:** the importer (e.g. a SCRUTINY indexer running over the
  sec-certs dataset) publishes everything from a single import pubkey.
  All events are non-canonical-chain by §4.4's rule (vendor isn't the
  publisher).
- **Future:** if a vendor publishes their own pubkey via NIP-05 or a
  registry, an importer MAY re-anchor the Product event under that
  pubkey, making subsequent vendor-published patches canonical-chain.
  This is a v0.6+ concern; outside this investigation's scope.

The implication for v0.5.x: **CC imports produce non-canonical-chain
data only**. That's fine — the discovery layer still works (Bindings are
the primary affordance for CC, not patches).

## Worked example — Rathon-SSO v4.0 → SCRUTINY events

Source: cert `dgst=67a1fd7853faf864`, the first entry in
`main-dataset.json` (see `sample-cert.json`). This cert has no
maintenance updates, no CPE matches yet, and one protection-profile
link, so the example fits in 4 events.

### E1: Product event (root)

```json
{
  "kind": 1, "pubkey": "<importer-pk>", "created_at": 1764745200,
  "content": "Rathon-SSO v4.0\nManufacturer: RathonTech\nManufacturer-web: https://rathontech.com/\nCategory: Access Control Devices and Systems\nScheme: KR\nValidity: 2026-04-03 → 2031-04-02\nSecurity level: (unspecified)\nStatus: active",
  "tags": [
    ["t","scrutiny-fabric"], ["t","scrutiny-product"], ["t","scrutiny-v053"],
    ["i","cc-cert-id:<scheme-issued-id>"], ["k","cc-cert-id"],
    ["i","cc-scheme:KR"], ["k","cc-scheme"],
    ["imeta",
     "url https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Certification%20Report(Rathon-SSO%20v4.0).pdf",
     "m application/pdf",
     "x d54bbde34984620cf5c42ff42f1da196c683d4053b4082429ad84bd5da2fe415",
     "size 614821",
     "alt report: Certification Report (Rathon-SSO v4.0).pdf"],
    ["imeta",
     "url https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/Rathon-SSO%20v4.0%20ST_EN_v1.1.pdf",
     "m application/pdf",
     "x eb8a47aba86cfbc78e8ddee0d8e0b36c850f4e012ecbc609d1ad4ef46252cb58",
     "alt st: Rathon-SSO v4.0 ST_EN_v1.1.pdf"]
  ]
}
```

### E2: PP Metadata + E3: Binding to the PP Product

```json
{
  "kind": 1, "pubkey": "<importer-pk>", "created_at": 1764745201,
  "content": "Claims conformance to protection profile: KECS-PP-1348-2025.",
  "tags": [
    ["t","scrutiny-fabric"], ["t","scrutiny-metadata"], ["t","scrutiny-v053"]
  ]
}
```

```json
{
  "kind": 1, "pubkey": "<importer-pk>", "created_at": 1764745202,
  "content": "PP conformance edge.",
  "tags": [
    ["t","scrutiny-fabric"], ["t","scrutiny-binding"], ["t","scrutiny-v053"],
    ["e","<PP-product-event-id>","","root","<importer-pk>"],
    ["e","<E2-metadata-event-id>","","link","<importer-pk>"]
  ]
}
```

(The PP itself — KECS-PP-1348-2025 — is a separate `scrutiny-product`
event, imported from `protection_profiles` dataset. Not shown here.)

### E4: Status-change Patch (when cert flips to `archived` in 2031)

```json
{
  "kind": 1, "pubkey": "<importer-pk>", "created_at": 1925030400,
  "content": "Cert expired; status archived.\n\n```diff\ndiff --git a/content b/content\n--- a/content\n+++ b/content\n@@ -7 +7 @@\n-Status: active\n+Status: archived\n```",
  "tags": [
    ["t","scrutiny-fabric"], ["t","scrutiny-patch"], ["t","scrutiny-v053"],
    ["e","<E1-product-event-id>","","root","<importer-pk>"],
    ["e","<E1-product-event-id>","","reply","<importer-pk>"]
  ]
}
```

The patch is on the **importer's own canonical chain** (same pubkey as
root). When the cert expires, the importer flips the status. This is the
clean shape for any "small mutable field on a Product."

### Per-cert event budget

| Cert flavour | Event count |
|---|---|
| Minimal cert (1 PP, no CVEs, no updates) | 1 Product + 1 PP-claim Metadata + 1 PP Binding = **3 events** |
| Active cert with 3 CVEs | 3 + (3 × (Metadata + Binding)) = **9 events** |
| Cert with 1 maintenance update | + 1 Metadata + 1 Binding = **+2 events** |
| Cert lifecycle (status change once) | + 1 Patch = **+1 event** |

Across the full dataset (6 737 certs, 862 maintenance updates, average
~1 PP each, CVE counts unknown until cross-reference): rough order of
magnitude **30 k–60 k events** for the import, dominated by the Binding
count. Well within relay capacity.

## Spec gaps surfaced

### G1 — `cc-cert-id` MUST be a registered indexer kind in §9

CC scheme-issued cert IDs (`604-LSS`, `BSI-DSZ-CC-0814-2012`,
`KECS-CISS-1234-2026`) are the **primary key** of the CC ecosystem — the
URL on the CC Portal is keyed by them, the maintenance update report
references them, and they're the value humans actually search for.
Without a registered `cc-cert-id` indexer kind, discovery of CC certs
falls back to content search, which collapses the protocol's value
proposition for this dataset.

**Recommended §9 entry:**

> `cc-cert-id` — Common Criteria scheme-issued certificate identifier.
> Value is the scheme-local ID as published on the Common Criteria
> Portal (e.g. `BSI-DSZ-CC-0814-2012`, `604-LSS`). Case-sensitive. The
> `cc-scheme` indexer SHOULD also be present on the same event to
> disambiguate cross-scheme ID collisions.

### G2 — `cc-scheme`, `cc-eal`, `cc-sar` indexer kinds

Subsidiary to G1. The full bounded vocabulary:

- `cc-scheme:<country>` — 19 values (FR, US, DE, JP, …).
- `cc-eal:<level>` — EAL1 through EAL7 + augmentations (`EAL4+`).
- `cc-sar:<family>.<level>` — ~40 families × 5 levels (e.g.
  `ADV_FSP.1`).

Recommend grouping these into a single registry entry in §9:

> `cc-scheme`, `cc-eal`, `cc-sar`, `cc-cert-id` — Common Criteria
> ecosystem indexers. See [link to a CC indexer spec] for the
> normative value vocabulary.

The actual value vocabulary doesn't need to be inlined into §9 — a
linked-out registry (in a sibling doc, or this investigation report
folded into the spec repo) is enough.

### G3 — No spec gap for maintenance updates

The investigation initially expected a gap here. There isn't one. The
Metadata + Binding pattern is exactly what §4 was designed for. The
authorship-classification rule in §4.4 (same pubkey = canonical chain,
different pubkey = dispute) is what forces the choice between Patch and
Metadata-binding for vendor vs CB publication, and it's a sensible
forcing function.

## Verification

The mapping was sanity-checked by:

1. Reading the full top-level field list of one representative cert
   (`sample-cert.json`, the cert at index 0) and confirming every field
   has a target surface above. **All 19 top-level fields mapped.**
2. Reading the full `heuristics` field list (18 sub-fields) and
   confirming each maps to Product `i` tags, Metadata events, Bindings,
   Patches, or "drop." **All 18 sub-fields mapped.**
3. Walking the parent-update linkage of one real pair
   (cert `b3bdda767050e981` "Oracle Identity Governance 12c" + update
   `cert_b3bdda767050e981_update_80ca0420fdb7c274`) and confirming the
   resulting event graph is a well-formed SCRUTINY topology.
4. Counting events for a worked example (Rathon-SSO v4.0) and verifying
   it composes from the spec's primitives without inventing new tag
   types or event shapes.

## Out of scope

- FIPS dataset — user did not drop FIPS data. The cross-reference mapping
  (CC ↔ FIPS) is sketched but not concretely walked.
- ProtectionProfile dataset — same as FIPS. The general shape is
  identical to CCCertificate per the docs, so the mapping carries over.
- Actual import implementation — that's a Phase E concern at the
  earliest. This investigation produces only the design contract.
- Performance / relay capacity sizing — the 30 k–60 k event estimate is
  an order-of-magnitude check, not a benchmark.

## Carry-forward

- Add §9 entries `cc-cert-id`, `cc-scheme`, `cc-eal`, `cc-sar` in a
  separate spec amendment (queue alongside the §5 amendments from
  Investigation 1's `SPEC-UPDATE-PROMPT.md`).
- When Phase E gets a `sec-certs-importer` package, this report is the
  contract.
- The Rathon-SSO v4.0 worked example is a Phase D test-vector
  candidate — full event JSON round-trip.

---

**Verdict (restated):** CC fits the SCRUTINY protocol cleanly. One §9
amendment (register `cc-cert-id` and friends) is required before Phase A
locks; everything else is implementation.
