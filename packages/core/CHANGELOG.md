# @scrutiny-fabric/core

## 0.1.0

### Minor Changes

- 6c5fa4d: Campaign wrap-up: spec v0.8.0 conformance (UR-4 hold-pending, F13/F14 version-tag retirement), Step-3 verified fixes (S3-11…S3-28), Step-5 mutation hardening, Step-6 measurement harness, tooling (zizmor/size-limit/Knip/publint/API Extractor), and governance/docs doctrine.
- 74a7b48: Add `eventsById(ids)`, the §8.2 traversal leg for fetching events a previous leg discovered (binding endpoints, a patch's root; spec-feedback F21, crocs-muni/scrutiny-fabric#42): `{ids:[...]}`. Kind-agnostic with no `#t` — DQ-1's kind-5 carve-out proves the lookup space isn't kind-1-only, and the id already pins everything (SIG-1), so every extra filter key is a footgun. Pass-through: no dedup, no validation; the relay-side mirror of `EventStorage.get`. Unblocks scrutiny-lens's second hop (#78).
- 6a6dabb: Add `imetaArtifacts(event)`, the §3.1/§4.6 NIP-92 imeta read tier (#79): one `ArtifactRef` per
  `imeta` tag carrying the declared `url` (first valid http(s) entry, verbatim), `mime`, `sha256`
  (lowercased 64-hex `x`), `size` (decimal text, never `Number`ed), and `alt` (verbatim, no length
  guard). Tolerant like the rest of `events.ts` — a tag with no usable `url` contributes nothing,
  unknown NIP-94 keys are ignored, and dedupe/normalization stays the consumer's job (BD-11). Fetch,
  verification, and display are out of scope: IM-1..IM-4 remain the consumer/artifacts-package
  obligation (`IMETA_TAG` is the single named source for the tag itself). Absorbs the parser
  scrutiny-lens kept app-side (#77/#78); the producer side is tracked as #81.
- b7c56b1: Add `patchesReferencing(eventId)`, the §8.2 traversal leg the spec implies but never writes out (#75; spec-feedback F19, crocs-muni/scrutiny-fabric#39): `{kinds:[1], '#t':['scrutiny-patch'], '#e':[eventId]}`. Anchored at a chain root, one query returns the whole patch chain (every patch carries `e` with marker `root`, PT-1); chain order is rebuilt client-side from `e reply` parentage (PT-2, §5.3), and role classification is `classifyByRole`'s existing job (S3-13). `#t` carries the event-type tag alone — NIP-01 ORs values within a filter key, so adding `scrutiny-fabric` would void DQ-4's type MUST.

### Patch Changes

- a3dcabb: CI hygiene: new verify-examples job (examples were never installed or tested), job timeouts, changeset gate base-ref fix, and root config trimming (changeset .gitignore footgun, duplicate workspaces field, duplicate attw dep, redundant biome ignore, grouped monthly Dependabot).
- b402612: Clean up three low-severity nits: vector files now tagged `scrutiny-v0.8.0` (was v0.7.0), storage-indexes test fixtures updated from retired `scrutiny-v061` to `scrutiny-v0.8.0`, and unreachable `noUncheckedIndexedAccess` guard in `parseVersionTag` documented with a Stryker-disable comment.
