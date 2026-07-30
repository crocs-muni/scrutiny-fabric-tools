# @scrutiny-fabric/core

Reference implementation of the [SCRUTINY Fabric protocol](https://github.com/crocs-muni/scrutiny-fabric), spec v0.6.1.

Sans-IO, crypto-free, ESM-only. The package parses and validates SCRUTINY events and applies patch
payloads; it does not talk to relays, hash anything, or hold keys.

```bash
npm install @scrutiny-fabric/core
```

## What it does

```ts
import { validateEvent } from '@scrutiny-fabric/core'

const verdict = validateEvent(event)
// → { status: 'valid' | 'invalid' | 'pending' | 'not-scrutiny', issues: Issue[], ... }
```

Every `Issue` cites the Appendix F rule it comes from, with the rule's layer and spec section
attached automatically — so a finding can be printed, linked to the spec, or asserted on in a
conformance suite without a second lookup.

`status` distinguishes four outcomes that are genuinely different. `not-scrutiny` means the event
has no fabric tag and is outside the specification entirely, which is not the same as being an
invalid SCRUTINY event. `pending` means the verdict depends on an event that has not arrived yet;
the `awaiting` list names the ids that would settle it.

## Design constraints

- **No crypto.** Signature verification and id recomputation take an injected hash function (D12).
  The package runs unchanged in a browser with no polyfill.
- **No I/O.** One event in, a verdict out. Relay transport, storage, and caching are the caller's.
- **No byte normalisation.** PB-1 and PB-2 make patch payload bytes normative, so CRLF endings,
  BOMs and missing trailing newlines are passed through exactly as received rather than repaired.
- **Rules are generated from the spec.** `src/rules.ts` is derived from Appendix F and checked in
  CI against its source, so a rule id that does not exist is a compile error.

The patch applier is deliberately **not** exported (D32). No stock tool enforces the protocol's
determinism requirement — both `git apply` and `jsdiff.applyPatch` silently relocate a hunk by
context match — so exposing an applier would invite callers to bypass the gate that makes patch
application deterministic.

## Requirements

Node 22 or later. ESM only; there is no CommonJS build.

## License

MIT. See [LICENSE](./LICENSE).
