# Module-ownership table — which rules each module owns

Rule IDs are from Appendix F. These assignments drive the generated coverage report (D34).

<!-- ownership:table:start -->

| Module | Owns | Notes |
|---|---|---|
| `validate` | TAG-1…TAG-5, VER-1…VER-4, SIG-1, PR-1…PR-5, MD-1…MD-5, BD-1…BD-5/BD-7/BD-10/BD-12, PT-1…PT-4/PT-7/PT-10/PT-11, IM-5, E1…E3/E5/E6, C1…C4/C7, P2, TR-1, IR-1…IR-4 | Pure, one event in, `Issue[]` out. Endpoint typing (BD-3/4/5) and PT-7 lineage need the observed set → returns *pending*, resolved by `store` per §7.6. **C7 added** — it was dropped in transcription from §6.0's V manifest, which cites it explicitly. **P1 removed** — unsatisfiable at validation time; see F1 |
| `admit` | TR-2…TR-7, OV-7, DEL-4/DEL-5 | Refcounted reason sets. `direct-trust` = Set bit; `binding` = counter guarded by `liveBindings` (D23) |
| `build` | IX-2, E4, P1…P4, RL-1 | Emits `{kind, created_at, tags, content}` — **no `id`, `pubkey`, `sig`** (D13). Sole enforcement point for P1 and E4, both unfalsifiable on receipt. **RL-1 and IX-2 added by Phase 8**: three of §5.4's four bounds (tag value ≤1024 B, signed event ≤64 KB, hunks ≤64) and IX-2's 64-`i`-tag ceiling are computable from the template this module assembles; the fourth (patches per chain) stays with RL-2/RL-3 on the consumer side |
| `patch` | PB-1/PB-2, E7, N1…N3, C5/C6/C8, T1…T3, H1, RL-3/RL-4 | **T1/T2/T3 is hand-written and non-injectable** (D30). No stock applier does the exactly-once check. C8 (new in spec v0.6.1) was already satisfied — jsdiff already splits a multi-header payload into per-file hunks and this module already sequences them all under T3 (F5). Phase 18 moved the matching primitives into internal `patch-matcher.ts`; the gate stays here |
| `query` | BD-8, DQ-1…DQ-4 | Returns plain NIP-01 filter objects; no transport dependency. **Never puts a version tag into a relay filter** — the dead engine did, silently violating VER-4 |
| `resolve` | BD-9, PT-5/PT-6/PT-8/PT-9, IX-3, H1/H2, CHN-1…CHN-3, RL-3/RL-5, RC-1…RC-5, SF-1…SF-7, OV-2…OV-4/OV-6/OV-8/OV-9, UR-4, DEL-1…DEL-3/DEL-6/DEL-7 | **Reads no trust state** (D25). `ChainState.forked` has **no `tipId`** — makes SF-4 unrepresentable. RC-5, SF-7, OV-9, RL-5 are new in spec v0.6.1; SF-7 and OV-9/RL-5 codify design calls this module already made (F10/F11). RC-5 exposed a real bug — see fix/spec-v061-drift |
| `store` | SIG-1, BD-6/BD-7, RL-2/RL-3, RC-3/RC-4, UR-1…UR-3, DEL-8/DEL-9 | Reducer + `StorageAdapter` port, **not a class** (D15). Three epochs (D24). SIG-1's halves: recompute in `id.ts` via injected hash (no crypto in core, per R11's `JSON.stringify` serialization), enforcement in this module |

Not owned by any module, by design: **13 rules, now enumerated with written reasons in
`packages/core/test/_unowned.ts` and machine-checked** — OTS-1, CA-1, BD-11, IX-1/IX-4, IM-1…IM-4, OV-1/OV-5, DEL-10/DEL-11. The previous form of this
sentence was wrong twice: it listed IX-2 and RL-1, both of which turned out implementable (see
`build` above), and it omitted seven rules entirely.

BD-7 (shared: validate, store), H1 (shared: patch, resolve), P2 (shared: validate, build), RC-3 (shared: resolve, store), RC-4 (shared: resolve, store), RL-3 (shared: patch, resolve, store), SIG-1 (shared: validate, store) are claimed by more than one table — several obligations span layers legitimately (see the closure gate's note on uniqueness).

<!-- ownership:table:end -->

> ⚠️ **The marked block above is GENERATED, by `node tools/gen-ownership.mjs` (`pnpm ownership:gen`),
> from `rules.json` + the coverage tables + `_unowned.ts`; CI runs `pnpm ownership:check`.** Do not
> edit the Owns column by hand — edit the coverage table the rule lives in and regenerate. The
> Notes column is hand-kept prose carried forward per module name. The hand-maintained era was
> found wrong three times, which is why this marks the table as documentation with a generator
> behind it, not a specification. The six per-module `OWNED` arrays in the gate files still
> transcribe their own module's row — a smaller, deliberately redundant intent check;
> `rule-closure.test.ts` closes the whole registry over the tables directly.
