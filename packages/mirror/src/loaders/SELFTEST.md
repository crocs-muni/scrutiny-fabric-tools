# loaders/ SELFTEST — jcalgtest + groundTruth

Actual numbers from a real run of `loadJcalgtest` (this unit's loader) against the frozen
local snapshots on 2026-10-04/05 (workstation clock UTC 2026-10-04):

- repo: `C:/tmp/jcres` — clone of `crocs-muni/jcalgtest_results`, HEAD `1437997364b11deeab8c9a1ad8831fbcb3052d50` (2026-09-29)
- ground truth: `$HOME/scrutiny-fabric/docs/mirroring/ground-truth` (snapshot 2026-10-04)
- 275 CSVs under `javacard/Profiles/**`, 81.5 MB; load ≈ 1.7–1.9 s

Reproduce (Bun ≥ 1.2):

```bash
bun -e "const m = await import('./src/index.ts');
const b = m.loadJcalgtest({ repoDir: 'C:/tmp/jcres',
  groundTruthDir: '$HOME/scrutiny-fabric/docs/mirroring/ground-truth' });
console.log(b.runs.length, b.cards.length, b.crosslinks.length, b.leaderboard.top.length,
  JSON.stringify(b.snapshot))"
```

## Headline counts

| Quantity | Actual | Expected / census | Note |
|---|---|---|---|
| `runs.length` | **275** | 275 (timeline `counts.csv_files`) | exact match |
| ALGSUPPORT / DATAFIXED / DATADEPEND / AIDSUPPORT | **158 / 46 / 31 / 40** | same | kind = directory |
| runs with `run.date` | **223** (undated **52**) | 223 / 52 | `Execution date/time` well-formed only |
| runs with `epochMs` | **76** | — | 13-digit `_<epoch>_` filename token |
| runs with `contributedBy` | **160** | — | filename `(provided_by_X)` first, header line second |
| runs with declared `jcver` | **107** | 107 (67.7 %) | and identical distribution |
| cards (`cards.length`) | **184** | “~206” (timeline name+ATR groups) | see “Card count” below |
| cards with `jcard` | **116** | 117 table rows | c086 is a duplicate row of c056 (see below) |
| cards unmatched (`jcard: null`) | **68** | — | incl. all perf-only/unlisted cards |
| cards with `jcver` set | **105** | “≈107 runs' worth” | 107 declaring runs; two cards declare in 2 runs each |
| cards with `cplc` / `vendorRaw` | **113 / 86** | — | `vendorRaw` only via fab mapping 4790/4090 |
| `crosslinks.length` | **62** | 62 | rank-1 HIGH candidate per card profile |
| `leaderboard.top.length` | **10** | ≤ 62 | cohort = declared `jcver` ≤ 3.0.5 |
| `leaderboard.excluded` | **28 + 8** | — | 28 unsupported, 8 version-undeclared (runs) |

`snapshot` = `{ corpus: 'jcalgtest', snapshot: '2026-10-04', tool: 'jcalgtest_results@1437997',
counts: { cards: 184, runs: 275, crossings: 62 },
datasetSha256: 'dbe9aee8110ccd3f21e712778938f01f50e4a2893239f940886bdca0b37bdae1',
source: 'https://github.com/crocs-muni/jcalgtest_results' }`.

`datasetSha256` formula: **sha256 over the concatenation of each file's lowercase sha256 hex
digest, files sorted ascending by repo-relative path, no separators** (`sha256(sorted(perFileSha).join(''))`).
Deterministic across runs (verified: identical on two loads in one process and across processes).

## Run parsing checks

Declared-version distribution (107 runs): `3.0.4×33, 2.2.2×25, 2.2.1×15, 3.0.5×13, 3.0.1×11,
2.1.2×8, 3.0.2×1, 2.2.0×1` — identical to design §10.4.

### ATR provenance (filename first, header second)

| Source | Runs |
|---|---|
| filename token (`__3b_fa_18_…`, `3B D5 18 …`, `3BFC18…`, `…90_003f_6d…`) | **269** |
| header `Card ATR;` / `ATR;` fallback | **0** (with the final case-insensitive extractor) |
| **no usable ATR** (`atr: null`) | **6** |

The 6 ATR-less runs are exactly the masked-placeholder files `[undisclosed1..4]` and
`[undisclosed7..8]` (`3b xx xx …`, header equally masked). Their cards are matched by name
(`[undisclosed1]`…), keeping `atr: null`.

Filename/header disagreements (3 in the corpus) all resolve in the filename's favour and the
header is ignored for them: `NXP_JCOP_CJ3A081_JC222` (filename ATR = the frozen c084 row;
header is the generic JCOP v2.4.1 ATR), `Sysmocom_sysmoISIM-SJA2` (header copy-pasted from the
c105 run), `Unknown_3b_68…` (header repeats the ATR twice; the doubled value is also halved
defensively when it is the only source).

## Card count — 184, and why it differs from the ground-truth numbers

Ground truth groups runs by `(Card name, Card ATR)`: timeline = **206** groups;
crosslink-matrix = 146 profiles (115 mapped, 31 unmapped); jcard-table = 117 rows.
This loader's rule (mirror README/`types.ts`) is **one identity per `jcard` c-number,
else per `(name, ATR)`**:

- matching legs over the 275 runs: **path 117** (the frozen table's own reconciled file
  claims), **ATR 68**, **name 10**, **unmatched 80**;
- 195 matched runs collapse into **116** card identities (jcard merging: relabels such as
  c040's two sample ATRs, c046's two ATRs, A22CR c017/c018 → one c-number each);
- the 80 unmatched runs form **68** `(name, ATR)` identities (perf-only cards, jCardSim
  variants, `S01C`, `NXP J2E081`/`J2A080` perf samples, masked `[undisclosed*]`, …);
- 116 + 68 = **184**.
- For reference, our own tokenized `(name, ATR)` pair count over the 275 runs is **205** vs the
  timeline's 206 — the one-pair difference is name normalization on the masked
  `[undisclosedN]` rows (timeline keeps `[Undisclosed 5]` spellings distinct).
- 116 of the 117 table rows are represented; **c086 is absent** because it is a duplicate row
  of c056 (identical name `NXP JCOP J2A080 80K ICFabDate 2011 070`, identical ATR, both claiming
  the same two run files — one of the table's `files_claimed_by_multiple_rows: 2`). Duplicate
  rows that share a name resolve deterministically to the **lowest c-number** (`c056`).
  Consequence: the one cross-link whose `cardJcard` is `c086` (`NXP J2A080 80K`) has no
  corresponding card identity in this bundle (flagged for emit as a pending/attach mismatch).

## Leaderboard — actual `sign_ecdsa_p256_sha1_ms`, cohort `jcver-lte:3.0.5`

Computed per card as the **min** over its DATAFIXED runs of the registry key
`sign_ecdsa_p256_sha1_ms` (`avg op` of `KeyPair_ALG_EC_FP KeyBuilder_LENGTH_EC_FP_256
Signature_ALG_ECDSA_SHA Signature_sign()`); cohort = card-level declared `jcver` ≤ `(3,0,5)`
(tuple), ranked ascending, top ≤ 62.

```
[1,"c044","Infineon SECORA ID X",23.58]
[2,"c043","Infineon SECORA ID S (SCP02 with RSA2k JC305 GP230 NOT FOR SALE - PROTOTYPE ONLY)",32.15]
[3,"c075","NXP JCOP4 P71D321",33.06]
[4,"c048","Infineon SPA1-1 ThothTrust Edition",39.19]
[5,"c025","G+D SmartCafe 7.0 215K USB Token S",52.34]
[6,"c045","Infineon SECORA ID X Batch 16072021 SALES",58.84]
[7,"c082","NXP JCOP CJ2A081 JC222 ICFabDate 2012 240",76.71]
[8,"c003","Athena IDProtect ICFabDate 2015",119.67]
[9,"c056","NXP JCOP J2A080 80K ICFabDate 2011 070",141.79]
[10,"c040","Infineon CJTOP 80K INF SLJ 52GLA080AL M8.4 ICFabDate 2012 001",145.88]
```

`excluded = [{reason: 'ecdsa unsupported (NO_SUCH_ALGORITHM)', count: 28},
{reason: 'version undeclared', count: 8}]` — counted **per DATAFIXED run**: 18 runs measure the
metric (46 DATAFIXED files total; the other 28 have the block as a single error token), and 8 of
the measured runs belong to cards with no exact declared version.

**Acceptance note (deviation, with evidence).** The expected top row was “Feitian H19CR →
ms ≈12.65”. 12.65 is indeed the fastest measured value in the whole corpus — it matches
`metric-canonicalization.json` → `registry.canonical_keys.sign_ecdsa_p256_sha1_ms.source.value_range_ms_per_op_across_corpus.DATAFIXED.min = 12.65` (18 measured entries). But
`Feitian_H19CR_Edition_20230713` declares **no** `JavaCard support version` (only
`JCSystem.getVersion()[Major.Minor];3.0;` in both of its runs; `crosslink-matrix.json` lists
`jc_versions: []` for it), so under the frozen cohort rule it is **excluded** —
it is one of the 8 `version undeclared` runs, at 12.65 ms, and the actual cohort `top[0]` is
`[1,"c044","Infineon SECORA ID X",23.58]`. The undeclared-value set, for the record:
H19CR 12.65; NXP JCOP4 J3R180 SECID P71 31.96; NXP JCOP3 J3H145g P60 56.29; NXP J3H145 RSA4096
enabled SCP03 58.69; NXP CJ2A081 77.48; NXP 2.4.1 R3 78.14; NXP J3A081 JCOP v2.4.1 78.80;
NXP J2E081 88.23. No measured run has a declared version > 3.0.5.

## Cross-links

`crosslinks.length = 62` — the **rank-1 HIGH-confidence candidate of each card profile** in
`ground-truth/crosslink-matrix.json` (candidate arrays are in rank order). The file contains
**1,037** high-confidence candidates across the same 62 profiles; they are dominated by
per-card families (`c071` alone has 25 high candidates), so “all HIGH pairs” would be 1,037
bindings — the mirror contract's “(62)” is read as one high-confidence pair per card.
Each `CrosslinkRecord.evidence` carries the method line, matched tokens and up to 8 verbatim
evidence strings (`field: "cert value" [card token]`, CPLC-semantic rows with their `via` chain).

Two caveats:

- **c008 (`Feitian-FTJCOS`)** — one of the four demo cards — has **no HIGH candidate**
  (its best, SERTIT-091, is `medium`; see `roca-demo-shortlist.md` §“ROCFeitian-FTJCOS”). Under
  the high-only rule it gets no cross-link; if the demo spine needs c008↔SERTIT-091 it must be
  added deliberately by emit (the other three demo cards all have rank-1 high candidates:
  c071→`f29f88756682e034`, c026→`d8473663e3e82527`, c046→`109970ff1b92aad4`).
- 1 of the 62 records references `jcard:c086`, which has no card identity in this bundle (see
  card-count note above).

## Spot checks against the design's filled examples

- `c071` run `NXP_JCOP4_J3R180_P71_ALGSUPPORT__…` — `selected` = `{ecdsa_sha256_sign_s: 0.066,
  ecdsa_sha_sign_s: 0.056, rsa2048_crt_keygen_s: 6.915, ecfp256_keygen_s: 0.212,
  sha256_digest_s: 0.042, sha1_digest_s: 0.042, prng_generate_s: 0.028}` — exactly the
  §4.3.6 values; families `3des, aes, ecdh, ecdsa, rsa, sha-2`; counts 223/153/70;
  contributor `PetrS`; highlight = the §4.3.6 AES-192/256 keybuilder-vs-cipher quirk.
  (The design text's “222 rows / 69 not supported” for this run differs by one row from the
  clone's 223/70; our rule counts every `yes|no|error` body row and the two header-region rows
  — `High-power mode supported …; no`, `JCSystem.isObjectDeletionSupported; yes` — are never
  counted, so 223/70 is the clone-faithful count.)
- `c046` (`Infineon SLE78 Universal JCard`) — same seven keys (e.g. `sha256_digest_s: 0.144`),
  families identical to c071.
- `NXP_JCOP_J3R200_EMV_noECC` DATAFIXED (`run.epochMs 1751988592612`, date `2025-07-08`) —
  `sign_ecdsa_p256_sha1_ms: null`, families `3des, aes, sha-2`, highlight
  “ECDSA unsupported in this run (all EC signature blocks returned NO_SUCH_ALGORITHM)” —
  matches §4.3.7's exclusion claim.
- `NXP_J2E081` DATADEPEND — `sign_ecdsa_p256_sha1_ms: 88.44`, 15 covered lengths
  `[16,32,48,56,64,80,96,112,124,128,160,192,248,256,512]`.

## Assumptions about malformed / legacy files

1. **Two ALGSUPPORT dialects.** Semicolon rows (`NAME;yes;0.055000`) and the 2025 comma dialect
   (`NAME,yes,,,0.042,48,32,0`); a line is a row when its second `;`- or `,`-separated field is
   `yes|no|error`. The comma dialect has empty `time_elapsed` fields at indices 2–3, so the
   printed time is read from index 4 when index 2 is empty.
2. **Comma decimals** (`ALG_EC_SVDP_DH…;yes;0,105000`) parse as `0.105`; only values matching
   `^-?\d+([.,]\d+)?$` are accepted, everything else leaves the time empty.
3. **Legacy 1.0/1.1 files**: card name may be the bare first line; `Card ATR:` uses a colon;
   section headers may carry a `;supported` suffix and regex-escaped dots
   (`javacard\.security\.KeyAgreement`); rows frequently have no time (→ no `selected` value);
   `Tested and provided by` may be absent.
4. **Header keys** are matched with any of `;`, `:`, `,`, `=` as separator (AIDSUPPORT writes
   `ICFabricator; 4090` and `ICFabricator=4090`); values are trimmed and lose trailing `;`/`,`.
5. **ALGSUPPORT body** starts at the first line beginning with `javacard.`/`javacardx.` (section
   header). Header-region rows (`High-power mode supported…; no`,
   `JCSystem.isObjectDeletionSupported; yes`, `Extended APDU;no`) are never counted; the `\,`
   escapes in section names are unescaped for matching, the `selected` table matches on the
   clearest form (`javacard.security.KeyPair ALG_RSA_CRT on-card generation`).
6. **ALGSUPPORT counts**: `measuredCount` = every answer row in the body (yes+no+error),
   `supportedCount` = yes, `unsupportedCount` = no; error rows are reported in `highlights`
   (`N rows returned error tokens`). 39 runs (all ALGSUPPORT) legitimately have empty
   `highlights` (no error rows, no quirk, no version mismatch) — highlights are exception
   reports, not required content.
7. **Perf blocks**: a block runs from `method name:;` to the next `method name:`; recognized
   field lines are `measurement config`, `baseline …`, `operation raw …`, `operation stats …`,
   `operation info`; a bare token right after the name/config is the error body
   (`NO_SUCH_ALGORITHM`, `CANT_BE_MEASURED`, `ILLEGAL_VALUE`, `UNKONWN_ERROR-…`, `SW_ALG_OPS_NOT_SUPPORTED`, …).
   Stray `jnasmartcardio`/`javax.smartcardio` exception lines terminate a block (they are not
   a body); a block counts as measured iff it has `avg op`. `avg op` is taken **verbatim**
   (the client already subtracts the baseline — data trap `baseline-already-subtracted`).
8. **`selected` (DATAFIXED/DATADEPEND)** comes from `metric-canonicalization.json`'s 20-key
   registry: names are normalized by collapsing `[_\s]+` and stripping the old
   `;<data-length>;` suffix, so client 1.6.0 vs ≥1.7.4 separator drift matches. A key whose
   block is absent is omitted; a block present but errored yields `null`
   (e.g. `ecdsa_sign_ms: null`). The ALGSUPPORT `selected` keys
   (`ecdsa_sha256_sign_s`, `ecdsa_sha_sign_s`, `rsa2048_crt_keygen_s`, `ecfp256_keygen_s`,
   `sha256_digest_s`, `sha1_digest_s`, `prng_generate_s`) are this loader's table following
   design §4.3.6 — they are not in any ground-truth registry — and are emitted only for
   `yes` rows carrying a numeric time.
9. **DATADEPEND values** are per data length; the registry keys are defined on 256-byte input,
   so the 256-byte block is preferred (else the first measured length). `lengths[]` = distinct
   `operation info` data lengths, ascending (the corpus really contains 48/56/124/248 too).
10. **`jcver`** only from an exact `JavaCard support version;` value matching `\d+(\.\d+)+`
   (trailing `;` tolerated). Card-level: the newest *declaring* run wins (runs sorted by
   `date`, undated last); ties at the same newest date with divergent values → `null`.
   105 cards carry a version from 107 declaring runs.
11. **`contributedBy`**: filename `(provided_by_X)`/`(provided by X)`/`(provide_by_X)` wins;
    the `Tested and provided by` value is used otherwise unless it is the corpus template
    (`insert your name please.`).
12. **`date`**: only `YYYY/MM/DD[ HH:MM:SS]` is accepted (junk like `2014` yields `null`),
    normalized to ISO; 223/275 dated matches the timeline census.
13. **Placeholder/duplicate ATRs**: masked (`xx`) values never become `atr`; all-zero ATRs are
    kept as hex (c115/c116 share `3b0000…`) but the name/`i` stay honest — identity for those
    runs resolves through the table's reconciled path, so `[undisclosed5]`/`[undisclosed6]`
    land on their own rows.
14. **Card matching order**: frozen-table file claim (path) → ATR + name compatibility
    (exact / contiguous-sublist / token-subset) → unique name match (no ATR evidence) →
    unmatched. A collided ATR with an incompatible name never merges two products (the 4-byte
    `3b119580` shared by `Feitian_H19CR` and `NXP SECID P60` is the live example).
    Duplicate rows for the same card resolve to the lowest c-number.

## Cross-unit smoke (not this unit's tests)

`loadJcalgtest` → `emitSourceBundle` (test key) → `writeArtifacts` → `gateBatch` ran green on
2026-10-04/05: **774 events** (`products 191, metadata 284, bindings 299`), **gate ok,
0 errors, 0 lostFacts**. All 275 runs land as run Metadata + card↔run Bindings; the only
remaining warnings are the **53** “cross-link pending (certificate record not mirrored in
leg 1)” notes, which are by design (README: only the 4 demo certs are mirrored in leg 1).

## Observation: local clone bytes vs today's `master` (imeta integrity)

`upstreamUrl` uses the `master` ref (as in the design examples), while `sha256`/`sizeBytes`
are of the **local clone bytes** — the design's own “same bytes” imeta rule. One spot check on
2026-10-05 shows upstream churn: the c071 run file is **10 746 B / sha256 c7e717c3…** at clone
HEAD `1437997` (2026-09-29) but **10 450 B / sha256 a335e371…** on `master` (the exact bytes the
design's `examples/artifacts/jcalgtest-results-snapshot.json` descriptor recorded). The loader
mirrors the clone it is pointed at (`--repo`); the ledger's per-path blob diff (§6.1) is what
detects the upstream change on the next import. If byte-verifiable imeta is wanted without a
ledger, pin `upstreamUrl` to the `.git` revision instead of `master` (one-line change here).
