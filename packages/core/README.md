# @scrutiny-fabric/core

Reference implementation of the [SCRUTINY Fabric protocol](https://github.com/crocs-muni/scrutiny-fabric), spec v0.8.1.

The package parses and validates SCRUTINY events, applies patch payloads, builds new events, and answers graph queries. It has no I/O and does no cryptography. You give it an event, it gives you a verdict, a filter or a store view. Relay transport, signing and hashing stay with you.

## Install

```bash
npm install @scrutiny-fabric/core
```

Node 22 or later. ESM only; there is no CommonJS build. `diff` is the only runtime dependency.

## What it does

```ts
import { validateEvent } from '@scrutiny-fabric/core'

const verdict = validateEvent(event)
// → { status: 'valid' | 'invalid' | 'pending' | 'not-scrutiny', issues: Issue[], ... }
```

Each `Issue` cites the Appendix F rule it comes from, with the rule's layer and spec section attached. You can print a finding, link it to the spec, or assert on it in a conformance suite without a second lookup.

The four statuses say different things. `not-scrutiny` means the event has no fabric tag, so the specification does not apply to it. `pending` means the verdict depends on an event that has not arrived yet; the `awaiting` list names the ids that would settle it.

```ts
import { imetaArtifacts, eventsById, patchesReferencing } from '@scrutiny-fabric/core'

imetaArtifacts(event)           // NIP-92 imeta tags → artifact refs (url, sha256, size, …)
eventsById(['<id>', '<id>'])    // relay filter for the §8.2 by-id hop
patchesReferencing('<root-id>') // relay filter for a patch chain
```

For each traversal leg in spec §8.2 there is a filter builder: bindings, patch chains, deletions, by-id lookup. One query returns a whole chain; chain order is rebuilt client-side from reply parentage.

## Design constraints

- No crypto. Signature checks and id recomputation take an injected hash function (D12). The package runs unchanged in a browser with no polyfill.
- No I/O. One event in, a verdict out. Relay transport, storage and caching are the caller's.
- No byte normalization. PB-1 and PB-2 make patch payload bytes normative, so CRLF endings, BOMs and missing trailing newlines pass through exactly as received.
- Rules are generated from the spec. `src/rules.ts` is derived from Appendix F and checked in CI against its source. A rule id that does not exist is a compile error.
- The patch applier is not exported (D32). No stock tool applies patches deterministically; both `git apply` and `jsdiff.applyPatch` silently relocate a hunk by context match. Keep the gate that makes application deterministic.

Status: development release (v0.1.0). Known gaps: quadratic bulk `admit()` at corpus scale, docs for some API surface. The rules registry carries a V-layer entry for every Appendix F rule; the three hardest modules are mutation-tested (StrykerJS, ratcheted above 99 percent).

## License

MIT. See [LICENSE](./LICENSE).
