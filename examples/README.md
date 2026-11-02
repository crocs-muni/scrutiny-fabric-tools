# Examples

This directory contains reference implementations that demonstrate how to use the SCRUTINY Fabric protocol with your own infrastructure.

**Examples are not packages.** They live outside the `packages/` workspace, are never published, and are deliberately self-contained so you can copy them out and adapt them to your needs.

## Why examples, not packages?

- **Crypto lives here, never in core.** The D12 invariant forbids cryptography in `packages/*/src`. Signers, relay adapters, and other crypto-dependent code belong in `examples/`.
- **No forced dependencies.** Consumers should not be required to depend on a specific crypto library (D6). Copy what you need, adapt it, or replace it entirely.

Use examples as templates. Do not add them as dependencies.

## Dataset ports

Two one-shot bootstrap scripts port public datasets into signed SCRUTINY Fabric events. They are self-contained Node scripts, each with its own `package.json` and `pnpm-lock.yaml` (install with `pnpm install` inside the directory). The scripts, the JCAlgTest manifests and the lockfiles are tracked; the generated `events.ndjson` files are not (`.gitignore`). Both read the signing secret at run time from `--key-file` (a line `Secret key (hex): <64 hex>`) or the `SCRUTINY_NSEC_HEX` environment variable; no key is stored in the repository.

### `jcalgtest-port/`

Maps the [jcalgtest_results](https://github.com/crocs-muni/jcalgtest_results) corpus (plus the JCAlgTest site PNGs) to events: one Product per card model, one run-report Metadata per artifact CSV (and the CPLC text for three bank cards), a Binding from every run to its model, and one aggregate "JCAlgTest corpus" report carrying the five site PNGs. Details are in the header of `port.mjs`.

```bash
cd examples/jcalgtest-port
pnpm install
# 1. first run writes manifest/manifest.draft.json and stops for review
node --experimental-strip-types port.mjs <jcalgtest_results clone> <commit>
# 2. build with the reviewed manifest (the curated one is manifest/manifest.curated.json)
node --experimental-strip-types port.mjs <jcalgtest_results clone> <commit> \
  --manifest manifest/manifest.curated.json --key-file <keyfile> --out events.ndjson
```

Add `--unsigned` for a dry run without a key, `--test` to suffix every SCRUTINY `t` tag with `-test`, and `--relays wss://a,wss://b` to also broadcast. The build is deterministic for a pinned manifest, so a re-run yields the same event ids.

### `sec-certs-port/`

Maps a [sec-certs.org](https://sec-certs.org) Common Criteria `dataset.json` to events: a Product per certificate, Metadata per artifact (certificate, security target, certification report, maintenance reports), protection-profile hub events, in-subset reference edges, and a PQC-analysis Metadata for certificates that match the PQC vocabulary. The subset is chosen by the rules in the header of `port.mjs`. `port.mjs` does no relay I/O.

```bash
cd examples/sec-certs-port
pnpm install
node --experimental-strip-types port.mjs --dataset <dataset.json> --key-file <keyfile> --out events.ndjson
# publish, then check what the relay stored
node publish-bulk.mjs events.ndjson wss://<relay> [--pace 250] [--auth-sec <hex> | --auth-key-file <path>]
node verify-live.mjs wss://<relay> [--expect N]
```

`--dry-run` emits unsigned templates and `--limit N` truncates the subset. `publish-bulk.mjs` is a crash-safe, rate-limit-aware NDJSON publisher with a per-relay cursor; `verify-live.mjs` runs a NIP-45 `COUNT` plus a few recipe probes against the relay (its `--expect` default is 10790). `examples/publish-bulk.mjs` is a copy of the same publisher without the NIP-42 AUTH reply and the `ws` dependency.

### Relationship to `packages/mirror`

`packages/mirror` is the v0 importer for mirroring public security datasets into SCRUTINY Fabric events. Its README documents the current legs: JCAlgTest (774 events live on the pilot relay) and sec-certs (207,701 events built and gated). Those figures are the mirror README's, not these scripts'. The mirror emits canonical tags only, whereas these ports are the earlier one-shot bootstraps and carry the `--test` quarantine option. Use `packages/mirror` for new imports; the ports remain as reference implementations of the original mappings.
