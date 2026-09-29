# scrutiny-fabric-tools

Tools for the [SCRUTINY Fabric protocol](https://github.com/crocs-muni/scrutiny-fabric): a reference TypeScript implementation, plus examples that port public security datasets to fabric events.

The workspace has one package. `@scrutiny-fabric/core` parses, validates, queries, builds and admits SCRUTINY events. It has no I/O and does no cryptography. You give it an event, it gives you a verdict, a filter or a store view. Relay transport, signing and hashing stay with you.

```sh
pnpm install
pnpm verify        # lint, typecheck, build, tests, size, audit - the full CI gate locally
```

Requires Node 22 or later.

## Packages

| Package | What it does |
|---|---|
| [`@scrutiny-fabric/core`](./packages/core) | Reference implementation of the protocol (spec v0.8.1) |

## Quality

CI runs the full gate on every push: lint, typecheck, build, tests, publint and are-the-types-wrong on the packed tarball, a 20 kB size budget, and an npm audit. The workflows themselves are scanned by zizmor. The rules registry is generated from the spec's Appendix F and checked against its source in CI, so a rule id that does not exist is a compile error; `docs/COVERAGE.md` maps each module to the rules it owns.

The three hardest modules (`patch.ts`, `admit.ts`, `resolve.ts`) are mutation-tested with StrykerJS (`pnpm test:mutate`), ratcheted at 99.3 to 100 percent. A surviving mutant must be killed by a stronger test or justified with an inline evidence comment.

## Layout

- `packages/core/` — the library
- `examples/` — dataset ports (JCAlgTest results, sec-certs), a bulk publish script, signer helpers
- `docs/` — architecture decision record, module coverage
- `tools/` — spec-to-code generators (rules registry, ownership table)
- `investigations/` — measurement and parity reports that decisions cite

## Status

Development release. The core API can change while the spec moves. Known gaps are tracked as issues: quadratic bulk ingest (#34), README/API docs (#69–72), producer-side imeta builder (#81).

Releases: https://github.com/crocs-muni/scrutiny-fabric-tools/releases

MIT.
