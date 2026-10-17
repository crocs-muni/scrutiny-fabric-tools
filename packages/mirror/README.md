# @scrutiny-fabric/mirror

The mirror package is the v0 importer for mirroring public security datasets into SCRUTINY-Fabric events.
Canonical design contract: `scrutiny-fabric/docs/mirroring/design.md` (+ `ground-truth/*`).
All decisions below are FROZEN for v0. Follow `types.ts`. Do not relitigate.

## Pipeline (3 stages)

```
loaders  →  source records (per-corpus, in-memory)
     ↓ transform+sign (emit/)
stage 1: signed events → artifacts/<corpus>.ndjson  (+ manifest.json)
     ↓ gate/  (self-consume + batch verify)
stage 2: gate report → artifacts/<corpus>.gate.json   (fail-closed)
     ↓ publish/ (WS + NIP-42 auth, paced)
stage 3: artifacts/<corpus>.publish-log.json  (+ ledger sqlite rows)
```

Chain integrity: `build:seccerts --relay URL` refuses while any ledger chain
point (live root tip/origin, live relation event) has no `publish_log` row for
that relay — building would overwrite the pending batch's artifacts and emit
patches against parents the relay never saw. Publish first, or re-run with
`--force-reset` to mark the dangling ids operator-abandoned. Every build also
writes a retention copy `artifacts/seccerts-<snapshot>-<producedAt>.ndjson`
alongside the `seccerts.ndjson` "latest" file publish reads.

## Frozen decisions (grilling session 2026-10-04)

- One publisher key (`npub1…`). Key loading: `NSEC` env / `NSEC_FILE` (hex or nsec) /
  `NSEC_AGE_FILE` + passphrase (never committed).
- Canonical tags only from leg 1 (`t scrutiny-fabric|scrutiny-v0.8.1|<type>` + corpus facet).
- Content: headline + plain-text bullets. Every machine fact ALSO spelled in prose (§4.1 rule 2a).
  Binding content carries `Refs: root <hex> link <hex>`.
  Record card = ONE single-line JSON block labeled `Record card (JSON):`.
  No placeholder URLs. Historical dates in content (never backdate).
- imeta: upstream file URLs only (pilot): CSVs from raw.githubusercontent.com mirrored repo,
  PDFs/sec-certs pages. `m`, `x` (sha256 of bytes we fetched/computed locally, same bytes), `size`.
- No generated images in pilot. No NIP-05. Kind-0 by hand.
- Card identity: one Product per (jcard cNNN, else name+ATR) identity. `jcard` absent when no
  c-number in frozen table. `jcver`/`jcver-lte` ONLY with exact declared version (no inference).
- Leaderboard: derived per `ground-truth/metric-canonicalization*` key `sign_ecdsa_p256_sha1_ms`.
  DATAFIXED `avg op` (already baseline-subtracted). Members ≤62 + `alg:ecdsa` + `jcver-lte:3.0.5`.
- Cross-links: all HIGH-confidence pairs from `ground-truth/crosslink-matrix.json` (62).
  Binding content = method + evidence strings. Bindings to cert Metadata of the 4 demo certs
  are emitted as real events (advisory spine incl. CVE-2017-15361 advisory + demo certs' TOE/cert
  events). All other cross-link bindings are emitted and stay PENDING (BD-6) until the CC leg.
- Ledger is part of v0 (bun:sqlite). Syncer = same code re-run. Weekly sec-certs, on-commit jcalgtest.
- Publish: WS + NIP-42 (relay requires auth, npub allowed). Pace 500 ms after stage 3 starts.
  Per-event NIP-20 result into ledger `publish_log`. Retry with backoff on rate-limits.
- kind-5 is never honored on OUR relay (deployment contract). Supersession marked in CONTENT.
- Demo set: c071 JCOP4 J3R180 (CARDIS pair), c008 Feitian-FTJCOS, c026 G+D SmartCafe 7,
  c046 Infineon SLE78. Full cross-link chain + ROCA advisory bridge per
  `ground-truth/roca-demo-shortlist.md`.

## Package features (unit boundaries)

- `loaders/`: parse sources into `SourceRecord` streams (v0: jcalgtest only).
- `emit/`: records → signed events (content templates + imeta + signing).
- `ledger/`: bun:sqlite, schema in `ledger/schema.ts`.
- `publish/`: relay probe + WS publish loop (NIP-42).
- `gate/`: batch verification + self-consume extraction.
- `cli.ts`: `build:jcalgtest`, `gate`, `probe`, `publish`.

Runtime: Bun >= 1.2 (`bun:sqlite`). Library deps: nostr-tools. Age decryption via `rage` CLI or env nsec for pilot.
Ground-truth inputs (present on the build machine): `docs/mirroring/ground-truth/*.json` (read at build time from the sibling repo path given by `--ground-truth <dir>`). jcalgtest_results clone at `--repo <dir>` (default `C:/tmp/jcres`).

## Legs

- **leg 1 (2026-10-05): JCAlgTest. DONE, live: 774 events on the pilot relay.**
- **leg 2 (2026-10-11): sec-certs (CC/EUCC/PP/FIPS + maintenance + FULL-CVE advisories +
  cross-links). BUILT + GATED + PUBLISHED-STAGED. 207,701 events, gate 0 errors / 0 lost facts,
  rerun-zero verified. Plan of record: `scrutiny-fabric/docs/mirroring/update-semantics.md`.
  Report: `scrutiny-fabric/docs/mirroring/leg-2-seccerts-report.md`. New units:
  `loaders/seccerts-*.ts` (+ `ppAliases`, `seccerts-crosslinks`), `emit/seccerts/*`
  (plan/roots/relations/engine/patch), `ledger/seccertsLedger.ts` (roots+relations tables),
  `cli.ts build:seccerts`. Cross-links: decision 2026-10-11, 62 live pairs (11 seeded from
  leg 1 + 51 newly emitted. c086 deferred, no leg-1 card Product).**
