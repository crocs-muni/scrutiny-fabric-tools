# gate/SELFTEST.md — importer v0 gate vs the 18 frozen example events

Frozen inputs: `$HOME/scrutiny-fabric/docs/mirroring/examples/*.json`
(18 signed events; contract: `design.md` §4.1 rules 2a/8, `packages/mirror/README.md`,
`src/types.ts`). Run date: 2026-10-05.

## How to reproduce

```bash
cd packages/mirror
bun run src/gate/selftest.ts                 # human report over the default example dir
bun run src/gate/selftest.ts <examplesDir>   # explicit example directory
# stage-2 batch form (writes artifacts/<corpus>.gate.json):
bun -e "const {gateBatch}=await import('./src/gate/index.js'); console.log(await gateBatch('artifacts/jcalgtest.ndjson'))"
```

`selftest.ts` exits `0` iff all 18 events pass shape/id/signature; the remaining
findings below are the known legacy deviations and do not change that exit code.

## Exact counts (18 events)

| Check | Result |
|---|---|
| shape + NIP-01 id + BIP-340 sig | **18/18 PASS** |
| gate errors | **12** — `REFS-LINE` 7, `PLACEHOLDER-URL` 4, `TAG-3` 1 |
| rule-2a lost facts | **7** |
| events with zero error codes | 6 (`01`, `02`, `06`, `08`, `11a`, `13`) |
| events with zero findings (errors + lost facts) | 4 (`01`, `06`, `08`, `13`) |

Per event (`selftest.ts` output):

```
01-toe-product.json                    sig/id OK  clean
02-cc-cert-metadata.json               sig/id OK  clean        (7 rule-2a lost facts)
03-roca-advisory-metadata.json         sig/id OK  PLACEHOLDER-URL
04-binding-toe-cert.json               sig/id OK  REFS-LINE
05-binding-toe-advisory.json           sig/id OK  REFS-LINE
06-pp-product.json                     sig/id OK  clean
07-binding-cert-pp.json                sig/id OK  REFS-LINE
08-jcard-product.json                  sig/id OK  clean
09-jcard-algsupport-metadata.json      sig/id OK  PLACEHOLDER-URL
10-binding-card-algsupport.json        sig/id OK  REFS-LINE
11-crosslink-binding.json              sig/id OK  REFS-LINE
11a-jcop4-cert-metadata.json           sig/id OK  clean        (4 rule-2a lost facts)
12-leaderboard-metadata.json           sig/id OK  PLACEHOLDER-URL
12a-dataset-snapshot-metadata.json     sig/id OK  PLACEHOLDER-URL
12b-binding-leaderboard-corpus.json    sig/id OK  REFS-LINE
12c-binding-snapshot-corpus.json       sig/id OK  REFS-LINE
13-corpus-product.json                 sig/id OK  clean
14-patch-example.json                  sig/id OK  TAG-3
sig/id pass = 18/18
```

## Known failures — reproduce, do NOT weaken the gate

1. **`REFS-LINE` × 7** — `04`, `05`, `07`, `10`, `11`, `12b`, `12c`.
   Rule 8(d) (`Refs: root <hex> link <hex>`) postdates this example set: the design
   document states the rule was *measured against these very 18 examples*. The
   bindings must be regenerated with the Refs line; until then the gate MUST keep
   failing them (fail-closed).
2. **`TAG-3` × 1** — `14-patch-example.json`.
   The v0 gate contract admits exactly three event types
   (`scrutiny-product|scrutiny-metadata|scrutiny-binding`); `scrutiny-patch` is outside
   v0 gate scope (no patch rules were specified for this gate). Expected until patch
   gating is specified; the message names the patch case explicitly.
3. **`PLACEHOLDER-URL` × 4** — `03`, `09`, `12`, `12a`.
   `03`/`12`/`12a` contain the literal note “placeholder URL — mirror-hosted asset”,
   and `09`/`12a` carry the hypothetical host `blossom.sec-certs-mirror.example` in
   `imeta`/links. The contract forbids placeholder **and** example hosts in gate
   output; a real import cites `raw.githubusercontent.com` / `sec-certs.org`. The
   scan therefore reports them. Not weakened.
4. **rule-2a lost facts × 7** — `02` (`rsa`, `ecdsa`, `ecdh`) and `11a`
   (`ecdsa`, `ecdh`, `aes`, `sha-2`).
   These are `alg:<family>` `i` tags on sec-certs certificate-record Metadata whose
   prose does not enumerate the families. `design.md` §4.3.2’s own Cert-Metadata
   template spells “algorithm families evidenced: RSA, ECDSA, ECDH”, so this is a
   **genuine content gap in the legacy examples, not an exemption**: rule 2a requires
   the family names in prose. The gate reports them; do not add prose-blind
   exemptions to make the set green.

## Legitimate exemptions (facts the gate intentionally does not report as lost)

`selfConsume.ts` exempts machine-only strings that carry no human-searchable fact:

| Exemption | Reason |
|---|---|
| values containing `«` (design’s `«…»` convention) | unresolved template value; the URL scan reports it as an error instead |
| ≥ 60-char lowercase hex | event ids / sha256 digests; published as `Refs`/`e`/`imeta x` hex, not as prose |
| record-card `type` values ending `@<n>` (e.g. `sec-certs-cc-toe@1`) | schema discriminator, not a record fact |
| `jcver-lte` `i` values (e.g. `3.0.5`) | cohort *bucket* vocabulary; the version itself is carried by `jcver:` |
| booleans / null / non-strings | not facts |

Matching itself is: **casefold substring**, then a **separator-insensitive substring**
(both sides stripped of non-alphanumerics). The fallback is what lets rule-2a accept
the *spelled-out* forms the rule asks for — e.g. an ATR written `3b fa 18 00 …`
satisfies `atr:3bfa1800…`, and `Infineon Technologies AG` satisfies
`vendor:infineon-technologies-ag`. Nothing else is relaxed.

## Legacy format deviation (documented, not silently accepted)

The 18 examples carry their record cards as fenced ` ```json ` blocks, not the
rule-8(c) single-line `Record card (JSON): {…}` form. `selfConsume` consumes the
rule-8(c) form only (that is the emitter contract going forward), so for these events
the record-card-scalar axis is N/A and rule-2a is exercised on the `i`-tag axis. If
those fenced cards *were* parsed, roughly two dozen further rule-2a gaps would appear
(e.g. `cplc "4790-d321"`, `vendor "NXP Semiconductors"`, `not_supported_highlights`
in `09`, `status` in `01`). Regenerating the examples with the labeled card is a
prerequisite for that axis to be meaningful; the gate does not silently treat the
legacy fenced form as compliant.

## Example reports

**(1) batch report for `01`, `02`, `04`** (verbatim `gateBatch` output):

```json
{
  "ok": false,
  "eventCount": 3,
  "errors": [
    {
      "event": "5ad9fdc9c9c203717ca5c5cf95066c9b67ac6f7e20fd339211e48778e642b0bf",
      "code": "REFS-LINE",
      "detail": "binding content lacks a 'Refs: root <64hex> link <64hex>' line (design §4.1 rule 8d)"
    }
  ],
  "lostFacts": [
    { "event": "de62b57c4cf1db11c930216db1bffbaf3be7af4a7ccbd0303a96d32914aab26c", "fact": "rsa" },
    { "event": "de62b57c4cf1db11c930216db1bffbaf3be7af4a7ccbd0303a96d32914aab26c", "fact": "ecdsa" },
    { "event": "de62b57c4cf1db11c930216db1bffbaf3be7af4a7ccbd0303a96d32914aab26c", "fact": "ecdh" }
  ]
}
```

**(2) a clean event** — `01-toe-product.json` yields no entries (its `i` values
`cc:BSI-DSZ-CC-0814-2012`, `vendor:infineon-technologies-ag`, `alg:rsa` and its
`Refs`-free Product content all pass).

**(3) batch summary over all 18** (verbatim `selftest.ts` aggregate):

```
eventCount=18 errors=12 lostFacts=7
error codes: {"PLACEHOLDER-URL":4,"REFS-LINE":7,"TAG-3":1}
sig/id pass = 18/18
```

## Scoped proof of this unit

- `bun run src/gate/selftest.ts` → `sig/id pass = 18/18`, exit 0 (above).
- Synthetic positive/negative paths exercised during development: a binding with a
  correct `Refs:` line raises no `REFS-LINE`; a mismatched line raises `REFS-TARGET`;
  a labeled record card with a present scalar yields 0 lost facts and an absent scalar
  1 lost fact; malformed card JSON yields `SELFCONSUME-CARD`; a malformed NDJSON line
  yields `NDJSON-PARSE`; a probe with `verdict: "no-auth"` / `supported_nips: [1]`
  yields `PROBE-VERDICT` + `PROBE-NIPS` and `ok:false`.
- Typecheck of `src/gate/**` under the repo’s strict flags (strict,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`): clean. (The package’s own `tsconfig.json` currently fails
  tsc on unrelated infra: `moduleResolution: bundler` with inherited
  `module: node16`, and missing `@types/bun` — outside this unit.)
- `biome check packages/mirror/src/gate` (repo biome 1.9.4): clean — no lint or
  formatting findings.
