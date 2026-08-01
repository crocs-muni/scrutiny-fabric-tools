# Architecture decision record — 2026-07-27

Durable record of the recon and planning session that designed the TypeScript implementation of
SCRUTINY Fabric. **Append-only.** Supersedes `SESSION-SUMMARY-2026-05-21.md` in role; that file's
investigation conclusions still stand and are cited below.

Target spec version: **v0.6.0** (`scrutiny-v060`), amended from v0.5.9 — see
[`SPEC-AMENDMENT-BRIEF.md`](SPEC-AMENDMENT-BRIEF.md) in this directory.

---

## 0. Why this document exists

Two previous implementations died of protocol drift, not of bad code:

- `scrutiny-fabric/packages/scrutiny-fabric` — ~2000 LOC targeting **spec v0.3.2** while the spec
  reached v0.5.9. Its version constant was `scrutiny_v032`, the underscored form that v0.5.9's
  TAG-4 does not recognise. Nothing in CI ever complained.
- `scrutiny-fabric/apps/scrutiny-lens` — built against v0.5.2; audited 2026-05-16 as using event
  types and tag schemas removed in v0.5.3.

Both are now archived locally, not migrated. The countermeasure adopted here is **generated,
CI-enforced rule-ID coverage** (D34/D35), not discipline.

## 1. Starting state, verified

Facts established by direct inspection, not inference. These justify several decisions below.

| Finding | Evidence |
|---|---|
| Appendix F contains **123 rules**: V=47, A=50, D=25, 1 reserved | counted from the spec |
| The dead engine put the version tag **into the relay filter** — silently dropping every higher-version event, violating VER-4 invisibly | `packages/scrutiny-fabric/src/query/index.ts:39,41` |
| The dead engine implemented `maxTrustHops` N-hop trust, contradicting TR-3's non-transitivity; its own comments admit the confusion | `src/trust/index.ts:28,43,84` |
| The dead engine had **both** a top-level and a dynamic `node:crypto` import, re-exported from the package root — breaking any browser bundle | `src/verify/index.ts:1,73` |
| `docs/test-vectors.md` TV-1's input JSON is **syntactically invalid** (missing comma), and it describes patches diffing `a/i`/`b/i`, which v0.5.9 forbids (C1, IX-3) | `docs/test-vectors.md:40-41` |
| The current MVP (`scrutiny-session-explorer`) performs **zero** signature or event-id verification | grep of `src/lib` |
| The MVP has no protocol engine at all — its resolver comment says "until the full protocol engine is vendored" | `src/lib/session/resolver.ts` |
| §5.3 and §7 contain **no reference to trust or admission** — chain resolution is trust-independent | read |
| The v0.5.9 spec was **never committed** — HEAD held v0.3.2 (311 lines) while the worktree held v0.5.9 (1363 lines); `HEAD:docs/` contained only `protocol-spec.md` | `git show HEAD:docs/protocol-spec.md` |

That last row is why the cleanup was sequenced checkpoint-commit-first (D43).

---

## 2. Decisions

### Posture

**D1 — Reference implementation, not normative.** The specification plus its conformance vectors are
canonical; this is *an* implementation. Follows the Nostr/HTTP pattern. Carried forward from the
2026-05-21 plan ("Option α").

**D2 — Spec feedback is a tracked deliverable.** The spec is 0.x and implementation will surface
gaps. Every gap is recorded and batched into an amendment brief rather than worked around locally.

### Packaging

**D3 — `@scrutiny-fabric` scope, flagship pattern.** `@scrutiny-fabric/core`, `/cli`, `/mcp`.
*Rationale:* at least three published names are certain, and unscoped names (`scrutiny-fabric-cli`)
are typosquattable by anyone — unacceptable for a project whose subject is supply-chain security.
Only an npm scope guarantees provenance. Precedent: NDK kept `@nostr-dev-kit/ndk` as flagship rather
than renaming core to `ndk-core`. *Rejected:* flat `scrutiny-fabric` (squattable siblings);
all-peers scope à la `@welshman/*` (misrepresents a one-required-package layout); the stutter
`@scrutiny-fabric/scrutiny-fabric` (what the dead engine used). Verified 2026-07-27: neither the
scope nor the flat name is taken on npm.

**D4 — v0.1 publishes `core` only.** CLI and MCP in v0.2.

**D5 — One repo, several packages. Root barrel is the primary import; subpaths are an
optimisation.** *Rationale:* the compounding tax is repos, not packages — micromark's 22-package
workspace causes no pain; syntax-tree's 140 repos and unified's cross-org ESM migration (500+
packages, 7 orgs, purpose-built `npm-tools`) do. libp2p changed its entire interface surface in one
PR because it is one monorepo. On subpath-vs-root: libp2p shipped `@libp2p/interface/peer-id` etc.
and **abandoned it** for a flat root export, citing discoverability. Subpaths are retained only
where they buy *graph exclusion* (nostr-tools' 47 entries, noble v2), not organisation.

**D6 — No published relay adapters.** Core declares the transport interface; the repo ships
CI-tested copy-paste `examples/adapters/` for nostr-tools, NDK, applesauce, nostrify.
*Rationale:* publishing `@scrutiny-fabric/relay` with a hard `nostr-tools` dependency *is* forcing a
relay library, and serving four ecosystems means four packages plus a peer-dependency matrix.
`h11` published **zero** IO shells and still got `httpcore`, `urllib3` v2, `uvicorn` and `hypercorn`
written against it — the boundary being *real* mattered; the boundary being *published* did not.
*Naming rule if ever published:* name the library in the package name
(`@scrutiny-fabric/relay-nostr-tools`), never a generic `relay` — the rule that would have prevented
welshman's `relay` → `net` reversal.

**D7 — `artifacts` deferred; shape decided.** If built: separate package, Node-first,
`node:crypto` streaming by default with an injectable hasher. Not in v0.1; may never ship.
*Rationale:* the primitives are third-party (`@noble/hashes`, `fetch`, `blossom-client-sdk`) but the
*policy* is IM-1…IM-4, i.e. ours. In core it would poison the one-dependency property and break
browser bundles (exactly the dead engine's `verify/index.ts` failure). App-level makes IM-4
unenforceable. Deferring costs nothing.

**D8 — Internal package edges are `peerDependencies`, without exception. Versions use changesets
`linked`.** *Rationale:* NDK issue #312 — four cache packages declared core as a regular
`dependency`, producing two copies of core, structurally distinct types, and `as unknown as` casts
in user code. applesauce's `linked` config (majors/minors together, patches independent) is the only
scheme among the four Nostr libraries that has not caused a version incident; welshman's lockstep
and NDK's free drift (0.1.52 → 8.0.0 across an interoperating family) both have.

**D9 — ESM-only, `sideEffects: false`, extension-ful subpaths, no dynamic imports anywhere.**
*Rationale:* tree-shaking needs all three stacked. matrix-js-sdk issue #4154 — an empty project
calling only `createClient()` produced an **8.89 MB** bundle because a lazy `import()` of crypto was
flattened to a static require by a Babel `modules: 'commonjs'` setting. Lazy loading inside a
package is fragile; static subpaths are not.

**D10 — Node 22 floor.**

### Core architecture

**D11 — `core` is sans-IO. One runtime dependency (`diff`), behind an applier port. Zero
dependencies is the declared goal, not the current state.** *Rationale:* since the T1/T2/T3
determinism gate must be hand-written regardless (D30), jsdiff reduces to a hunk parser — ~250 LOC
we could own. Against: the 2026-05-21 investigation validated jsdiff across 20+ scenarios including
`\ No newline at end of file`, BOM, CRLF and mixed line endings; rewriting risks regressions exactly
where testing is hardest. Keep for v0.1 behind the port so removal is not a breaking change.

**D12 — `core` contains no cryptography and never handles a key.** Enforced structurally: there is
no code path that accepts one. Precedent: git holds your GPG key; libgit2 does not.

**D13 — `build` emits unsigned templates: `{kind, created_at, tags, content}`.** No `id`, no
`pubkey`, no `sig` — those are the injected signer's job, and NIP-07 computes them natively.
*Explicitly rejected:* the 2026-05-21 plan's `core/sign.ts` wrapping `finalizeEvent`, which would
have put key handling and a crypto dependency inside core.

**D14 — `core/id.js` provides `serializeForId(event)` and `eventIdMatches(event, sha256)` with the
hash function injected.** *Rationale — three independent reasons, none of them "JSON.stringify is
wrong" (see R11):*
1. Verifying the signature alone does not authenticate content. The signature is over the `id`,
   which is a hash; a relay can alter `content` while keeping `id` and `sig`, and a signature-only
   check passes. Only recomputing and comparing catches it. NIP-01 defines the computation and is
   silent on the obligation.
2. The bulk publisher needs ids **before** signing — Bindings reference endpoints by id and patch
   N+1's `e reply` references patch N's id. Without local id computation, 20k+ events must be
   serialised through the signer one at a time; tolerable for a CLI raw key, brutal over NIP-46.
3. The store must key on the recomputed id, or refuse events where recomputed ≠ declared.

**D15 — `store` is a subpath of `core`, shipped as a reducer plus a `StorageAdapter` port — never a
concrete class.** *Rationale:* the risk is substitutability, not bundling. The planned server-side
indexer will hold the observed set in Postgres, so it cannot use a `Map`-based store and would
reimplement BD-5/6/7, DEL-8, DEL-9 and RC-3 from scratch and untested. Shipping a class first makes
replacing it a breaking change to the most-used entry point. Pattern: `automerge-repo` ships
`StorageAdapterInterface` *and* `NetworkAdapterInterface` injected via config.

**D16 — Four interfaces, and only four: `RelayTransport`, `EventStorage`, `ScrutinySigner`, and
`TrustProvider` (defined in D21). All branded with `Symbol.for()`.** *Rationale:* `Symbol.for` uses a global registry, so two copies of
core in one dependency tree still interoperate — a structural fix for NDK #312. libp2p does exactly
this (`Symbol.for('@libp2p/transport')` plus an `isTransport()` guard). Type-only contracts do not
survive splitting: unified's declaration-merging contract breaks *silently* when two versions
coexist. Signer interface mirrors the NIP-07 shape so `window.nostr` satisfies it with zero adapter
code.

**D17 — Subpaths named by caller intent, never by the spec's V/A/D taxonomy.** See R1.
Names: `./events`, `./validate`, `./resolve`, `./admit`, `./query`, `./build`, `./store`, `./id`,
`./rules`. `./patch` stays internal (D32).

### Verification and trust

**D18 — `verify(event)` returns true only if the Schnorr signature is valid **and**
`event.id === sha256(serializeForId(event))`. Required constructor parameter, no default. Fail
closed.** *Rationale:* a forgotten default is how CVEs happen; a required parameter cannot be
forgotten. Documented limit: the guarantee holds only up to trusting a transport's assertion — a
lying adapter defeats it.

**D19 — Verification status travels with the event on ingest.**
`store.add(events, {source, verified})`. Avoids double work (~50–100 µs per verification; 6737
events ≈ 0.5 s, twice is pure waste) while keeping verification unskippable by default. The escape
hatch is named `trustUnverified` so misuse is visible in review.

Measured 2026-07-27, per library — **may it honestly assert `verified: true`?**

| Library | Recomputes id? | Verdict |
|---|---|---|
| nostr-tools | ✅ `JS.verifyEvent` in `pure.ts`; verifies sig against the *recomputed* hash | **Yes** — strongest; verification mandatory by construction |
| @nostrify/nostrify | ✅ `NRelay1.receive()` | Yes, if the pool factory didn't override it |
| welshman | ✅ via nostr-tools or nostr-wasm | Yes via `request`/`requestOne`; `netContext.isEventValid` is a mutable global |
| applesauce | Relay layer: **none**; `EventStore.add`: yes | **No** at the relay layer |
| **NDK 3.0.3** | ❌ | **No, under any configuration reachable from `new NDK()`** |

NDK's three defects are documented in `~/ndk/SCRUTINY-NDK-FINDINGS.md` (finding 3 reproduced at
runtime): the declared `id` is never authenticated; the verification memo is keyed on that id and
never compares the stored signature; and a `NaN` from an unbound `validationRatioFn` turns
verification off entirely per relay at the first 30-second tick after 10 validated events.
**The app currently uses NDK 3.0.3 with bare defaults and no verification of its own.**

**D20 — Dedup only after verification.** *Rationale:* nostr-tools' `_knownIds`/`seenOn`, welshman's
`tracker.track` and applesauce's `EventMemory` all insert the *declared* id into dedup state before
or without verification. A malicious relay in a pool can pre-register a genuine event's id and
thereby **suppress the authentic copy** arriving from an honest relay — a censorship primitive that
works even against sound verification.

**D21 — Trust is a synchronous predicate, never a set. No `trust` package.**
`TrustProvider {isTrusted(pk): boolean, version: number, deltaSince(v): {added, removed} | null}`.
*Rationale:* §6.1 puts the trust mechanism explicitly out of scope of the specification, so a
package in the *reference* implementation implementing an out-of-scope mechanism is definitionally
not part of it. Its dependency justification also dissolves: NIP-51 fetching is relay IO, and NIP-44
private entries must call `signer.nip44.decrypt`. And the dead engine's `maxTrustHops` shows what
happens when the guess gets a name. `deltaSince` returning `null` ("rebuild") must be legal — a
5.7 ms full rebuild at 100k events is acceptable; a subtly wrong delta is not. `isTrusted` **must**
be synchronous: an async predicate consulted mid-traversal gives torn reads.

**D22 — "Show everything" is a separate `AdmissionView` implementation, not a predicate or a
bypass flag.** Under trust-everything the admitted set *is* the set of all V-valid events, so the
computation degenerates to identity: the toggle is a pointer assignment, `trustEpoch` does not even
bump, and `OpenView ⊇ TrustedView` is structural rather than test-defended. A bypass flag invites
two classic bugs — forgetting it on one path, or implementing it as "add every observed pubkey to
the trusted set", which is O(E) *and* wrong for pubkeys whose events haven't arrived.

**D23 — Admission is a refcounted reason set.** Reasons: `direct-trust` | `binding(id)` |
`root-chain(rootId)`. An event stays admitted iff ≥1 reason survives.
*Why refcounting is sound here (and generally isn't):* BD-3/BD-4 make the graph bipartite
Product↔Metadata and TR-3 admits a Binding only by direct trust in its own author, so admission has
no transitive closure and no fixpoint — cyclic derivation is structurally impossible. Binding
deletion becomes "decrement two counters", O(1), no traversal.
**Implementation constraint:** `direct-trust` must be a `Set` bit (idempotent add/delete) and
binding support a counter *guarded by `liveBindings` membership*. Refcounting both produces **sticky
admission after revocation** — a redundant no-op delta pushes a count to 2, so a later un-trust
leaves it at 1.
**Also:** the credit map must hold entries for event ids never observed, or a trusted Binding
arriving before its endpoints never admits them when they arrive (BD-6).
⚠️ This rests on BD-3/BD-4 holding. §11 lists Metadata↔Metadata bindings as future work; if that
lands, stratification collapses. Isolate the reachability step to one ~10-line method with the
dependency commented.

### Resolution and caching

**D24 — Three independent invalidation epochs.**
1. `trustEpoch` — invalidates admission only.
2. `observedEpoch` — invalidates chains, overlays, and pending-reference state.
3. per-root chain epoch.
*Rationale:* measured, admission is ~1000× cheaper than chain resolution (full admission recompute
at 100k events ≈ 9 ms; a trust-list swap ≈ 0.4 ms; re-resolving 6700 roots × 10 patches ≈ 4.1 s).
Merging trust and observed epochs is *correct but catastrophic*: every "show everything" toggle
would trigger seconds of diff re-application. A third epoch is needed because the pending-binding
lifecycle is invalidated by **endpoint arrival**, which is neither a trust nor a chain change — and
BD-7's rejection cache is monotone, unlike the other two. **Regression test worth having from day
one:** any `trustEpoch` change performs zero `applyPatch` calls.

**D25 — Chain resolution never reads the trust set; trust is applied at projection.**
*Rationale:* verified against §5.3, §7.1, §7.2, §7.4 — none reference trust. And the highest-severity
bug in the design space: trust-filtering *before* chain construction silently masks self-forks and
HALT, because a root admitted only via a trusted Binding (TR-4) may have patches by an untrusted
pubkey — yielding a chain that renders linear and complete when it is neither. Also a §6.0
violation. This produced spec amendment S14/TR-7.

**D26 — The overlay classification cache key contains no trust component.** Key on
`(overlayId, hash(targetResolvedBytes))`. §7.4 step 5 trust-gates the *set iterated*; OV-4 makes each
*classification* pure.

**D27 — Resolution is configured by orthogonal booleans, not a four-level ladder.**
`resolve(root, events, {deletions, chain, overlays})`, and the result declares what it is.
*Rationale:* RC-2 separates canonical bytes from overlay enumeration, so those are orthogonal axes
and an ordered enum cannot express "chain without deletions" or "overlays without recomputing
canonical" — both of which were in the originally-requested set of cases. Deletion handling is the
cheap high-value rung: ignoring a deletion shows *retracted* content (a correctness failure);
ignoring a patch shows *outdated* content (a freshness failure); and honouring deletions costs one
batched `{kinds:[5], #e:[…]}` query versus a full chain walk.

**D28 — Intermediate chain states are computed lazily under a byte-bounded LRU.** Eagerly
materialising every per-position state (needed for OV-2 target snapshots) measured **216 MB** at
sec-certs scale versus ~25 MB lazy — a difference that matters far more in a browser tab than a CLI.

**D29 — The pure functions are retained as a conformance oracle.** Every incremental path must agree
with a from-scratch recompute over the vector corpus. This is the only real defence against the
refcount bugs in D23.

**D30 — The T1/T2/T3 determinism gate is ours, non-injectable, and sits above the applier.**
*Rationale:* the 2026-05-21 investigation proved both `git apply` and `jsdiff.applyPatch` silently
relocate hunks by context match, so **no existing tool can enforce T1's exactly-once uniqueness
check.** Consequence: `chain` has no dependency on `diff`; only `patch` does. Also normalise
jsdiff's two failure channels — it returns `false` on context mismatch and *throws* on truncated or
swapped hunks.

**D31 — jsdiff (`diff` v9) for v0.1, behind the applier port.** Producer is
`structuredPatch` + `formatPatch({isGit:true})` with names `a/content`/`b/content`, which emits
spec-canonical bytes natively (17/21 fixtures byte-identical to normalised git output; the other 4
differ only by `@@ -L +L @@` shorthand, which §5.2 accepts).

**D32 — `./patch` is internal, not a published subpath.** Exposing the applier invites callers to
bypass the gate §5.3 says implementations "MUST still enforce". Do not publish a footgun.

### Conformance and documentation

**D33 — Vectors live in the spec repo, on the NIP-44 model, vendored into this repo at a pinned
checksum.** Separate categorised JSON files with their SHA-256 pinned in spec prose — *not*
CommonMark-style prose-embedded examples. *Rationale:* we already tried CommonMark's model and it
failed — `docs/test-vectors.md` has invalid JSON in vector #1 and describes patches v0.5.9 forbids.
Markdown also cannot carry byte-exact vectors (no-trailing-newline, CRLF, BOM) when PB-1/PB-2 make
byte-exactness normative. And our vectors are heterogeneous — four runner shapes (V, A, D,
serialization) — where CommonMark's are uniform. Vendoring at a checksum gives the noble/scure
property: a released library version is testable offline forever against the exact vectors it
claimed. CI enforces both directions.

**D34 — Coverage is measured by observed rule-code emission, not by annotations.** Three honest
buckets: emitted during tests (machine-observed, unfakeable) · declared by a vector's `rule` field ·
not test-covered (listed with a reason). *Rationale:* annotations measure *citation*, not
correctness — `@rule BD-3` on the wrong function still reports "implemented", which is the classic
requirements-traceability failure. Not every rule is a line of code either: H1 (HALT) is emergent
from the apply loop. Annotations survive only as optional navigation and never feed coverage.
Expect roughly 60 static-vector / 25 harness / 15 not-testable of the 123.

**D35 — `rules.json` is generated from Appendix F in CI**, feeding three consumers: the conformance
runner, the coverage report, and AI agents. 123 hand-typed rules would drift. CI fails if code cites
a rule ID absent from the spec.

**D36 — Docs are generated, never hand-maintained matrices.** One extraction → `rules.json`
(machine) + `coverage.json` (machine) + `COVERAGE.md` (human). Derive, never duplicate. No TypeDoc
HTML.

### Storage

**D37 — Three tiers behind one `EventStorage` interface:** in-memory hot set → persistent
(IndexedDB in browser via `nostr-idb`; SQLite server-side) → relay. Hot set is small (one graph is
tens-to-hundreds of events); the archive is large but cold.
*Browser choice rationale:* Nostr filters are tag-shaped (`#t`, `#e`, `#i`), which maps natively onto
IndexedDB `multiEntry` indexes; SQLite would need a tags junction table. SQLite-WASM + OPFS is
genuinely faster at scale (multi-GB near-native vs IndexedDB being slow on large sets) but costs a
Worker, COOP/COEP headers and WASM→JS marshalling — a documented escape hatch, not a v0.1 choice.
Copy **welshman's repository shape** (`isDeleted()` as a predicate rather than a removal,
`query(filters, {includeDeleted})`, incremental `{added, removed}` notifications).
⚠️ **Do not use applesauce's `EventStore` defaults** — its kind-5 handling *removes the target event
from the database*, which destroys DEL-7 α-degradation, DEL-4 root-retraction audit, and DEL-10's
show-deleted toggle in one stroke.

**D38 — Cache raw events; never persist resolved content as truth.** Resolved content is derived and
RC-3 requires recomputation on observed-set change, so a persisted resolution can serve a
conformance failure from our own cache. Resolutions are an in-memory memo keyed
`(rootId, request, view)`, dropped on dirty. If ever persisted, they must carry their `setVersion`.

**D39 — Sessions store event *IDs*, not event copies.** Event ids are content hashes, so a single
content-addressed table gives free deduplication — which matters concretely: the sec-certs corpus
has ~217 Protection-Profile hub metadata events shared across ~4,984 bindings. Session-referenced
events need a `pinned` flag so eviction skips them.
*Accepted risk:* IndexedDB is best-effort and may be evicted under disk pressure.
`navigator.storage.persist()` was **considered and rejected** — the permission prompt reads as
hostile, and all web apps share this exposure.

### AI-agent consumption

**D40 — Every error and annotation carries `{code, layer, section}` from Appendix F.** One object
serves four consumers: the conformance suite asserts on `code`, the CLI prints it, the UI links it
to the spec, and an agent can cite the exact normative rule.

**D41 — `rules.json` is the agent-facing artifact.** An agent otherwise parses 1363 lines of
markdown to reason about the protocol; given `rules.json` it loads 123 structured rules, and because
`Issue.code` uses the same IDs it can dereference a runtime error immediately.

**D42 — Nothing agent-specific beyond the MCP server.** "Digestible by AI agents" is mostly the same
work as good API design: stable IDs, self-describing outputs, no ambiguous bare strings,
machine-readable errors.

**D43 — Self-describing resolution output.** `resolve()` returns
`{request, view, content, retracted, chain?, overlays?, issues}` — never a bare string — so no
consumer, human or model, can mistake a partial resolution for canonical bytes. `ChainState` has a
`forked` variant with **no `tipId` field**, making the SF-4 violation unrepresentable rather than
merely forbidden.

### Repo hygiene

**D44 — `scrutiny-fabric` is reduced to a public specification repo**: `.gitignore`, `LICENSE`,
`README.md`, `docs/protocol-spec.md`, `docs/threat-model.md`. Everything else archived to
`~/scrutiny-fabric-archive` (plain local directory, documented). All references to the external
security reviewer removed. Sequenced as checkpoint-commit-then-remove, because most of the material
had never been committed.

**D45 — Spec target is v0.6.0 (`scrutiny-v060`).** Not a free choice: `scrutiny-v059` is already
patch 9 and the tag regex is `^scrutiny-v\d{3}$` with digits encoding MAJOR/MINOR/PATCH, so there is
no `scrutiny-v0510`. Staying in 0.5.x would require changing the tag scheme itself — breaking
TAG-2, VER-1, and every published event.

---

## 3. Rejected approaches

**R1 — V/A/D as the module boundary.** The most attractive wrong idea in this session. Measured: 123
rules, and **12 of 16 rule-bearing sections mix layers** (§4.3 spans all three). Concretely, BD-5
("endpoints, *once observed*, …") is tagged V but needs the observed set, and BD-7's rejection cache
is tagged V but is a cache — so `validate` would have to import `store`, a genuine cycle. The
taxonomy is also one minor version old and already rewritten once (v0.5.8's L1/L2 → v0.5.9's V/A/D,
~30 rules retagged). Naming published subpaths after it repeats the `effective-view` mistake.
V/A/D survives as metadata only.

**R2 — Separate `store`, `relay`, `trust`, `svelte` packages.** Ten units → four. `svelte` in
particular: ~50 lines is a README snippet, the real consumer's session store is 347 lines with its
own injection seam and would bypass a generic wrapper, and Svelte 4→5 broke every store wrapper in
the ecosystem. Two of the four Nostr libraries surveyed have shipped boundary rollbacks (welshman
deleted `relay` and merged it into `net`, and deprecated `dvm`; applesauce dissolved
`applesauce-factory`, stranded at 4.0.0 while the family is at 6.2). Merging is cheap; splitting is
expensive. Start coarser than feels right.

**R3 — Differential dataflow / DBSP / Z-sets.** Solves recursive-view maintenance under deletion.
We have no recursion (D23), so it is pure complexity tax, and the TS implementations are alpha with
no published recompute baselines.

**R4 — Zanzibar's Leopard index and SpiceDB's quantized-staleness model.** Take the epoch/zookie
token idea; reject deliberate staleness. Those systems *wait out* revocations because they are
distributed and cross-region; our store is a local synchronous map, and RC-3 makes serving stale
bytes when fresh inputs are locally available a **conformance failure**.

**R5 — applesauce as a dependency.** Steal the EventStore-plus-models shape, not the package. Its
kind-5 default deletes targets (see D37).

**R6 — NDK as the recommended transport.** See D19. Separately, the 2026-05-16 audit found NDK
"forces browser-only architecture (prevents SSR)".

**R7 — CommonMark's prose-embedded vector model.** See D33.

**R8 — A hand-maintained rule→package→test traceability matrix.** Rots within weeks and then lies.
Replaced by D34/D35.

**R9 — Relay provenance for censorship detection.** Absence of an event on a relay has at least five
innocent explanations (never published there, pruned, personal relay, `limit` cap, not yet
propagated), and proving censorship requires knowing it *was* published there — unknowable. Cost was
tracking completed `(filter, relay)` pairs. `source` still rides along in ingest metadata for free;
no indexes, no comparison logic, no claims.

**R10 — Performance budgets.** Explicitly declined.

**R11 — Treating NIP-01's serialization rule as a gap.** Investigated twice and retracted both
times. NIP-01's seven short escapes plus "all other characters verbatim" is a *precise rule that
exists to defeat encoder-specific escaping* — Go's `encoding/json` HTML-escapes by default, .NET
escapes all non-ASCII. `JSON.stringify` complies with every clause that matters, and `nostr-tools`'
`serializeEvent` *is* `JSON.stringify`, making it correct by ecosystem definition. Sub-0x20 control
characters are escaped identically by every standard encoder; lone surrogates are a real but obscure
JS↔Go asymmetry. **Use `nostr-tools`; do not write a serializer.** D14 stands on other grounds.

**R12 — Treating NIP-11's `max_content_length: 8196` as contradicting §4.6's ~30 KB advice.**
Retracted. That value is an illustrative example in the NIP document, not a deployed default.
strfry — the most widely deployed relay — uses `maxEventSize = 65536`, against which §4.6 is sound.

**R13 — Indexer prefix decisions.** Deferred by request. The *openness* of the §9 registry is
non-negotiable regardless (IR-4): the dead engine's closed `isValidIdentifierPrefix` would have
rejected the MVP's `pp`/`vendor`/`scheme` *and* the sec-certs mapping's `cc-cert-id`/`cc-scheme`.

---

## 4. Confidence register

Not everything above is equally established. Distinguish before relying on it.

**Verified directly** — everything in §1, plus: NIP-01's escape rules, NIP-51 kinds 30000/30002 and
private items via NIP-44, NIP-78 kind 30078, npm download counts (nostr-tools ~900k/wk vs NDK
~5.9k/wk), NDK's three defects read in a local checkout at commit `4b86acd`, and the availability of
both the `scrutiny-fabric` name and `@scrutiny-fabric` scope on npm.

**Verified 2026-07-27 against `hoytech/strfry/strfry.conf`** — all four relay limits confirmed:
`maxEventSize = 65536`, `maxNumTags = 2000`, `maxTagValSize = 1024`,
`rejectEventsNewerThanSeconds = 900`, `rejectEventsOlderThanSeconds = 94608000` (**exactly three
years**). The `created_at` hazard is therefore real, not speculative: publishing a Common Criteria
certificate with `created_at` set to its issue year is silently refused.

**Probable, not established:**
- NIP-44 pinning its vectors' SHA-256 in prose.
- libp2p's subpath-reversal quotation.
- **All benchmark numbers** (9.1 ms, 0.39 ms, 216 MB, 0.062 ms/patch): synthetic, single-machine,
  Node-only, guessed event mix. The *ratio* — admission ≈1000× cheaper than chain resolution — is
  robust; the absolute figures are not, and the 216 MB was never measured in a browser.

**Interpretation, could be wrong:**
- That §6.2 contradicts §6.0 (basis for S14).
- That DEL-5 revokes admission (basis for S13) — argued from key-compromise security, not from the
  text. Both are now settled by author ruling, but they were readings.
- That a publisher would map a certificate's issue date to `created_at`.

---

## 5. Open questions

1. Is the `@scrutiny-fabric` npm org actually creatable, or does an empty org already hold it?
2. Rename `scrutiny-fabric-tools`? "tools" reads oddly for a repo publishing a protocol library.
3. Add a prose attribution line to the spec itself, or leave attribution to LICENSE and README?
4. Should NDK's findings be reported upstream, and through which channel? NDK issue #393 reports
   that private disclosure was unavailable. Handoff prepared at `~/ndk/`.
5. Does the demo relay support NIP-77 Negentropy? Only affects whether sync is "design toward" or
   "available now".

---

## 6. Corrections

This document is append-only. A decision that turns out to rest on a false premise is corrected
here, with the evidence, rather than edited in place or quietly worked around.

**C1 (2026-07-27, Phase 2) — D31's producer recipe does not work in `diff@9.0.0`.**

D31 states: "Producer is `structuredPatch` + `formatPatch({isGit:true})` with names
`a/content`/`b/content`, which emits spec-canonical bytes natively." The second argument to
`formatPatch` is not an options object in v9. Passing **any** second argument makes it emit the
hunks alone, with no `--- a/content` / `+++ b/content` header block — a payload that violates C1
and matches no production of the §5.2 grammar. Verified against `diff@9.0.0`:

```js
formatPatch(p)                  // '===…===\n--- a/content\n+++ b/content\n@@ -1,1 +1,1 @@\n-a\n+b\n'
formatPatch(p, {isGit: true})   // '@@ -1,1 +1,1 @@\n-a\n+b\n'
formatPatch(p, {isGit: false})  // '@@ -1,1 +1,1 @@\n-a\n+b\n'   ← same, so it is not an isGit flag
```

Nor does the no-argument form emit spec-canonical bytes: it prefixes a bare `===…===` separator,
which §5.2's `index-preamble` admits only after an `Index: content` line. Recorded as
SPEC-FEEDBACK F8.

**What is unaffected.** D31's substance stands — jsdiff remains the v0.1 producer, behind the port,
with names `a/content` / `b/content` and `context: 3`. Only the exact call was wrong. The
"17/21 fixtures byte-identical" measurement in D31 was presumably taken against a different jsdiff
major or a different entry point, and should not be relied on until re-measured.

**Corrected recipe**, implemented in `patch.ts` as `makePatch` and to be reused by `build.ts` in
Phase 6: `structuredPatch('a/content', 'b/content', before, after, '', '', { context: 3 })`, then
`formatPatch(patch)` **with no second argument**, then strip a leading bare `===…` separator line
if present.

**C2 (2026-07-31, Phase 8) — D19's welshman row records a hazard that no longer exists.**

D19 states: "welshman … `netContext.isEventValid` is a mutable global." Read fresh against
`coracle-social/welshman@master` on 2026-07-31, `packages/net/src/context.ts` declares
`NetContext = { pool?, repository?, getAdapter? }` — no `isEventValid` at all. Verification is now a
per-call option with a safe default, in `net/src/request.ts`:
`const isEventValid = options.isEventValid || (event => verifyEvent(event))`.

**What is unaffected.** D19's verdict for welshman ("Yes via `request`/`requestOne`") stands and is
now stronger: the mutable-global attack surface is gone. Only the stated caveat is obsolete.

D19's other four rows re-verified and stand. Two refinements worth recording rather than leaving to
be rediscovered:

- **NDK's third defect is a mis-bind, not an unbind.** `NDKRelay`'s constructor does
  `(ndk?.validationRatioFn ?? …).bind(this)`, binding `NDK`'s method to the *relay* — which carries
  `lowestValidationRatio` but not `initialValidationRatio`. That `undefined` becomes `NaN` at the
  first 30-second tick after 10 validated events, and `shouldValidateEvent()` returns `false`
  permanently, per relay. The observable behaviour D19 recorded reproduces exactly; only the
  mechanism was described wrongly.
- **applesauce is worse than D37 records.** `EventStore.add` files a kind-5 deletion, and checks
  `this.deletes.check(event)`, *before* the verification branch; `DeleteManager` enforces only that
  the claimed author matches. An **unsigned** kind 5 carrying a victim's `pubkey` is therefore
  accepted and thereafter suppresses that victim's events. This is a stronger reason for D37's
  existing "do not use applesauce's `EventStore` defaults" note than the kind-5-removes-the-target
  behaviour already cited there.

**C3 (2026-07-31, Phase 8) — D28's 216 MB is arithmetically real and wrongly labelled.**

D28 states: "Eagerly materialising every per-position state … measured **216 MB** at sec-certs scale
versus ~25 MB lazy." Re-measured against the real corpus
(`investigations/sec-certs-mapping/data/main-dataset.json`, 6,737 certs), Node 25.6.1 with
`--expose-gc` and forced GC before each sample:

| depth | baseline corpus | eager `ChainState`/position | lazy `resolve()` |
|---:|---:|---:|---:|
| **1 (the real corpus)** | 18.16 MB | **3.68 MB** | **2.73 MB** |
| 64 | 487.45 MB | **206.91 MB** | 11.02 MB |

The figure reproduces at **depth ≈67**, driven by the quadratic `applied[]` arrays rather than by
content strings. The sec-certs mapping produces a chain depth of **0 or 1** — its only Patch is a
status transition, and maintenance updates map to Metadata+Binding (mapping REPORT.md, Decision A).
At that depth the eager/lazy gap is **0.95 MB**. The "~25 MB lazy" comparator was not reproduced at
any depth; the shipped lazy path costs 1.7–11 MB across a 0→64 sweep.

**What is unaffected.** The *decision* to compute lazily stands, but not for D28's reason: it costs
nothing, and `resolve.ts` already does it by interleaving overlay classification with the chain walk
and retaining only the running content. **The byte-bounded LRU is not warranted by this corpus and
was never built** — `RESOLVE.md` §211 already argued this, and the measurement confirms it. Strike
the LRU from D28 rather than implementing it.

Hazard #4 should be re-scoped. The number that decides whether a browser tab survives is not the
resolution cache but the **raw event corpus**: ~1.35 KB/event across an estimated 30k–110k events is
**40–150 MB**, 15–50× the entire caching question, and it is still unmeasured. D39's
content-addressed dedup, not D28's LRU, is what addresses it. D39's own figures verify: "~217 PP hub
metadata events across ~4,984 bindings" measured as 218 shared PPs across 5,016 edges.

The confidence register's own warning (§4, "all benchmark numbers … the 216 MB was never measured in
a browser") is vindicated and should stay. **It still has not been measured in a browser** — no
headless browser is installed. Chrome ships pointer compression that this Node build does not, so
the figures above are conservative upper bounds for a tab rather than underestimates.

**C4 (2026-07-31, Phase 8) — D7 resolved: `artifacts` is dropped as a numbered phase.**

D7 deferred `artifacts` and said it "may never ship"; hazard #1 called it "the weakest unit". Phase 8
owed a verdict rather than another restatement, and the corpus supplies one: the real sec-certs
Product content measures **median 287 bytes, maximum 2,088** — nothing in it approaches §4.6's ~30 KB
`imeta` threshold. The consumer that would motivate the package does not exist.

**Decision: remove Phase 9 from the plan's numbered sequence.** D7's shape decision (separate
package, Node-first, injectable hasher) stays on record for whenever a real consumer appears.

One constraint must survive the deferral, and is now enforced by machinery rather than memory:
**IM-4 is a MUST** ("implementations MUST warn before displaying or processing unverified
artifacts"), so `core` must never grow *partial* imeta support — shipping IM-1…3 without IM-4 would
be a conformance failure, not a missing convenience. IM-1…IM-4 are recorded in
`packages/core/test/_unowned.ts` with that reason, so the new registry-closure gate surfaces the
decision to anyone who starts.

**C5 (2026-07-31, Phase 8) — D29's oracle property is violated in shipped code.**

D29 states: "Every incremental path must agree with a from-scratch recompute … the only real defence
against the refcount bugs in D23." That defence is not in place for chain resolution, and the gap is
live. `overlayState` (`resolve.ts:519`) decides DEL-7's α/β degradation from the **whole observed
set**, while `chainEpochTargets` (`store.ts:189`) returns `[]` for a Binding and for any
non-SCRUTINY event, and for a Patch bumps only that patch's own root. `resolveRoot` (`store.ts:423`)
serves the cached resolution whenever `chainEpoch[rootId]` is unchanged. Reproduced:

```
memoised store, target absent  : orphaned/beta
memoised store, target present : orphaned/beta
fresh store over same final set: orphaned/alpha
```

An overlay anchored at root `R` whose `e reply` names an event outside `R`'s chain is frozen at
`beta` forever. This also violates **RC-3** (serving stale bytes when fresh inputs are locally
available) and is a **UR-1** confluence failure in effect, since the reported state depends on
arrival order.

**What is unaffected.** D29 stands as a decision — the finding is that nothing enforces it here. SG1
passes because it compares a `StoreView` projection that excludes resolutions. Fixing this changes
epoch semantics and therefore **D24**, so it is scoped as its own phase rather than patched; see
`AUDIT-2026-07-31.md` §2 for the three candidate fixes and the recommendation.

**C6 (2026-07-31, Phase 8) — D34's coverage claim was false for six rules.**

D34 states coverage is measured in "three honest buckets" so that a rule cannot be silently skipped.
That held for the Validity layer only: `v-coverage.test.ts` derives its expected set from the
generated registry, whereas every A/D gate compares its table against an `OWNED` array
**hand-transcribed** from the module-ownership table in `IMPLEMENTATION-PLAN.md`. That closes the
loop against a document rather than against the spec — in a project whose stated rule-citation
discipline is that no link in the chain is hand-written.

Measured: **21 real rules (plus reserved OV-1) appeared in no coverage table at all.** Six of them —
`PR-2`/`PR-3`/`PR-4`/`MD-2`/`MD-3`/`MD-4` — are actively emitted by `validate.ts:206-230`, making
them the only rules in the package that `issue()` can produce with no coverage entry anywhere.

**What is unaffected.** D34's principle (observed emission, never annotation) is right and is
retained. Only its enforcement was incomplete. Corrected in `a69a249`: `rule-closure.test.ts` now
asserts `union(every coverage table, _unowned.ts) == registry`, so an unclassified rule fails the
build the way an unclassified V rule always did. 139 rules — 126 owned, 13 declared unowned with
written reasons.

Two related findings recorded rather than fixed: the ownership table's range notation
(`E1…E6`, `P1…P4`) silently over-claims — `E4` appears only in `build.ts`, never in `validate.ts`,
the identical defect to the P2 double-listing `QUERY-BUILD.md` §2.2 found — and the `events` row
duplicates 17 rules from the `validate` row while `events.ts` mentions only ten of them. The table
should be **generated from the coverage tables**, per D36's own "derive, never duplicate".

**C7 (2026-07-31, Phase 8) — D6 and D7's dispositions are confirmed, not reversed.**

Phase 8 was scoped to be able to reverse either. Recorded so a later reader does not reopen them
without new evidence:

- **D6 stands.** The comparative analysis surfaced one argument for publishing adapters — a converter
  is genuinely needed, so four copy-paste adapters would each reimplement it — but that is an
  artifact of `EventFilter` not being a NIP-01 filter (`AUDIT-2026-07-31.md` §7), which is being
  fixed. Once it is, an adapter is a thin transport wrapper again and D6's reasoning is untouched.
  Phase 12 stays contingent. Note Phase 7 is additionally blocked: **`RelayTransport` does not
  exist** — `interfaces.ts` declares only `TrustProvider` and `EventStorage`, and the transport
  interface lives solely in the plan's D16 table.
- **D7 is resolved, not reversed** — see C4.

**C8 (2026-07-31, Phase 8) — the conformance-vector gap gets a decision, not another deferral.**

Appendix G.1 names four vector files. `application.json` (46 cases) and `validity.json` (19) are
vendored and digest-matched; `discovery.json` and `serialization.json` are reserved and absent from
both repos. The spec says so itself (`protocol-spec.md:1469`), so this is acknowledged
incompleteness rather than drift — but "rely on the substitute gate" has now been the answer for six
consecutive phases, and 31 D-layer rules have an empty corpus. Decision, three parts:

1. **Contribute `serialization.json` upstream.** §3's event-id serialization is `JSON.stringify` by
   ecosystem definition (R11), `id.ts` implements it, and a vector is just
   `event → serialized string → sha256`. No policy judgement is involved and this project is the
   reference implementation. There is no reason for the file to stay reserved.
2. **Formalise the project-local corpus.** `test/patch-regressions.ts` is already written "shaped to
   become conformance vectors verbatim once the corpus exists". Emit those cases as a vector-shaped
   JSON artifact so the substitute gate is exportable and can seed a real corpus.
3. **Report the blocker on `discovery.json` rather than inventing it.** D-layer vectors cannot take
   `validity.json`'s shape, because §6.0 gives D rules no disposition — which is exactly why
   `admit`'s and `query`'s partitions are legitimately all-`not-covered`. A vector asserting "what
   outcome?" has no outcome to assert for a D rule. That is a **spec** gap, and belongs in
   SPEC-FEEDBACK rather than in a file this project defines unilaterally.

Rejected: relying on the substitute gates indefinitely. They are good and have found real bugs — but
C5 above is precisely a defect none of them covers, and a gate suite written by the same people who
wrote the code has a blind spot an external corpus does not.

**C9 (2026-08-01, spec-and-plan pass) — D32 clarified: scope is the applier function and its
exports-map subpath, not patch-adjacent result/option types.**

D32 states: "`./patch` is internal, not a published subpath. Exposing the applier invites callers to
bypass the gate §5.3 says implementations "MUST still enforce". Do not publish a footgun." Read
verbatim, D32's own text names two things: a subpath (`./patch`) and an applier ("exposing the
applier invites callers to bypass the gate"). It says nothing about the inert result/option
vocabulary the applier happens to return or accept — `HaltReason`, `LimitKind`, `ApplyOptions`, and
`HaltRule` carry no gate-bypassing capability themselves; only the function that calls the gate does.
`PLAN-2026-08-01-rewrite-mandate.md` §2 extracts these four types into a dedicated
`packages/core/src/patch-types.ts` (types only, no functions), re-exported from `index.ts`'s root
barrel with no new exports-map subpath (D17), while `patch.ts`'s applier function itself and the
`./patch` subpath stay exactly as internal as D32 already requires.

**What is unaffected.** D32's substance stands unedited: `./patch` is still not a published subpath,
the applier function is still never exported, and §5.3's T1/T2/T3 gate still cannot be bypassed by
any public API this package ships. This is a clarification of scope, not a reversal — publishing
`HaltReason`/`LimitKind`/`ApplyOptions`/`HaltRule` via `patch-types.ts` does not touch what D32
forbids. `CONTEXT-WIDENING.md` §1.1 independently confirms and relies on this same reading when
justifying `patch-matcher.ts` as a second internal (never-exported) file alongside `./patch`.

**C10 (2026-08-01, spec-and-plan pass) — D24 amended: a fourth reducer index, `overlayAwaiting`,
drives chain-epoch invalidation for overlay targets.**

C5 showed `chainEpoch` never bumps for a root `R` whose overlay targets an event outside `R`'s own
chain, violating D29's oracle property (`AUDIT-2026-07-31.md` §2's P1). Amendment, per
`OVERLAY-AWAITING.md`'s finished design (superseding `PLAN-2026-08-01-rewrite-mandate.md` §3's
rougher sketch on the two points marked below):

`StoreState` gains `overlayAwaiting: Readonly<Record<string, readonly string[]>>` (target-event-id
-> root-id[]). **Populated only from observed Patch events**: whenever a Patch is observed, if both
`replyTarget(event)` and `rootTarget(event)` are defined, `overlayAwaiting[replyTarget(event)]` gains
`rootTarget(event)`, via the existing generic `addAwaiting` helper — unconditional for every observed
Patch (root-author or foreign, valid or not), mirroring `chainMembership`'s own precedent.
(`replyTarget` is hoisted, verbatim, from a private helper in `resolve.ts` into a new exported
function in `events.ts`, alongside the existing `rootTarget` export.)

`chainEpochTargets` gains a fifth, additive row, layered on top of its existing four: for **every**
observed or unobserved event, regardless of type, it looks up `overlayAwaiting[event.id]` (the
arriving/departing event's own id) and bumps `chainEpoch` for every root id found there. **This
consultation is not scoped to Patches** — refinement (b) to the mandate's sketch, which read only as
"consulted... for the arriving event's own id" without stating that this fires for every event type:
Patches are only where the index is *populated*; the bump-side lookup fires for any event type, since
the target an overlay depends on can be a Product, Metadata, Patch, or anything else.

The index is **never mutated on `unobserve`, in either dimension** — refinement (a) to the mandate's
sketch, which stated only that the target-keyed entry is retained: neither that entry itself nor a
Patch's own contribution to an entry's root-id array is ever removed (the array is coarse — multiple
Patches, from the same or different roots, can each contribute the same root id to the same target's
entry — so removing one contributor safely would need a per-Patch refcount the mandate does not
specify; removing without it risks deleting a still-live dependency and reintroducing C5's own failure
one level down). This follows `chainMembership`'s "stale-but-correct" precedent over
`bindingsAwaiting`'s active-cleanup precedent: `bindingsAwaiting`'s cleanup is keyed by exact Binding
identity (no multiplicity hazard), and no terminal verdict exists for an overlay dependency the way
BD-3/BD-4 gives one for Binding endpoints.

`STORE.md` §6's resolution-memo key is unchanged by this fix — it repairs `chainEpoch`'s precision at
the point the imprecision was introduced (`chainEpochTargets`'s row coverage), rather than patching
the memo key one layer up, superseding the audit's own cheaper "key the memo on `observedEpoch` when a
resolution contains an orphaned overlay" option.

**What is unaffected.** D24's three-epoch structure stands: `overlayAwaiting` adds a new *trigger* to
the existing per-root `chainEpoch`, not a fourth epoch. D26 (the overlay-cache key has no trust
component) is unbroken and cited only as precedent. D29 is the decision this fix repairs, not one it
revises — C5 remains on record as the correct historical finding; this entry records its fix landing.
D38 (cache raw events, never resolved content) is unbroken: the index stores ids only, never resolved
content. D15/D43 (plain data, pure/synchronous reducer) are unbroken: `overlayAwaiting` is a
`Readonly<Record<string, readonly string[]>>` field like every other `StoreState` field, and its
population/consultation stay inside the existing pure, synchronous reducer. Full derivation, a worked
trace of the P1 scenario, and the `StoreView`/gate consequences are recorded in `OVERLAY-AWAITING.md`,
not restated here.

**C11 (2026-08-01, spec-and-plan pass) — D29's oracle property was violated by a second, independent
gap: `store.add()` never called `validateEvent` at all (P5).**

`AUDIT-2026-07-31.md` P5 found that `createStore`'s `add()` never invokes `validateEvent` — a
consumer could ingest and resolve malformed Bindings, mis-tagged events, and PT-7-violating overlays
with no V-layer check ever running, so an incremental `resolveRoot` answer could disagree with what a
from-scratch validate-then-resolve pipeline would report for any V-invalid or V-pending event. This is
a distinct D29 violation from C5's — C5 is the `overlayAwaiting`/chain-epoch-target gap fixed by C10
above (the check ran, but its invalidation signal was imprecise); this is "the check never ran in the
first place" — and P5 was never given its own dated Corrections entry the way its sibling gap C5 was,
despite being recorded in the same `AUDIT-2026-07-31.md` audit pass.

Fixed by `VALIDATION-WIRING.md`: `store.add()` now calls `validateEvent` on every accepted event
(accepted meaning SIG-1-passing, regardless of V-verdict — never silently dropped for a validator bug,
per DEL-4's "never silently drop, preserve for audit" precedent applied to a different failure mode).
`rejectedBindings`/`bindingsAwaiting` generalize to `invalidIds`/`pendingAwaiting`, rule-agnostic
across every V rule that can produce an error or an `awaiting` array, not just Binding endpoints.
`resolveRoot`'s event feed excludes `invalidIds` before calling `resolve()`, closing the gap P5 found.

**What is unaffected.** D29 stands as a decision — this is its second repair, not a revision. D15,
D18, D19, D20, D24, D34 are all satisfied unchanged by this fix (`VALIDATION-WIRING.md` §6 verifies
each individually: no new class or port, SIG-1 gate untouched, verification-status shape untouched,
dedup-after-verify ordering untouched, no new epoch — only a new trigger for the existing per-root
`chainEpoch` — and coverage strengthened, not weakened). A related, out-of-scope gap was found while
writing `VALIDATION-WIRING.md` (`admit.ts`'s `computeAdmission`/`applyDelta` never check BD-3/BD-4
endpoint typing, so a Binding this fix correctly marks invalid via `invalidIds` still confers
admission credit to its wrongly-typed endpoints) — this is not a D29 disagreement (the oracle and the
incremental path agree with each other, on a spec-incorrect answer) and is explicitly deferred to its
own future decision and Corrections entry, touching D23's admission mechanism rather than this one.

**C12 (2026-08-01, spec-and-plan pass) — D21 clarified: "no trust package" governs the trust-deciding
mechanism, not `store`'s bookkeeping over an already-made decision.**

`TRUST-VIEW.md` §7 found that `store.ts`'s existing `trust(pubkeys)`/`untrust(pubkeys)` — a
`Set`-backed allowlist (`AdmitState.trusted`), now stated plainly as the documented, recommended path
for a `Store` consumer's admission view (`TRUST-VIEW.md` §5's new `admissionView()`/`viewRoot()`
methods) — reads, on D21's summary line taken in isolation ("Trust is a synchronous predicate, never a
set. No `trust` package"), as exactly what D21 forbids.

Clarification, not a reversal, read against D21's own rationale rather than its summary line: D21's
"no `trust` package" targets a *policy*-computing mechanism — web-of-trust expansion, NIP-51 list
fetching, reputation scoring — which §6.1 puts out of scope of the specification, and whose dependency
argument (NIP-51 fetching is relay IO; NIP-44 decryption needs a signer) is about computing *who* to
trust. `store.ts`'s `trust`/`untrust` compute no such policy; they are a bookkeeping sink for a trust
decision already made by the caller through whatever mechanism they chose — the same role
`IngestMeta.verified` plays for a verification decision `store.add()` does not itself compute. The
`Set` D21 rules out is a `Set` used as the *mechanism for deciding* who to trust; `AdmitState.trusted`
is storage for a decision made elsewhere, which is a different claim.

**What is unaffected.** `TrustProvider`'s synchronous-predicate requirement is untouched and still
required exactly as written. `computeAdmission`'s status as the conformance oracle (D29) is untouched,
and is in fact extended by `TRUST-VIEW.md` §6 to state plainly that `computeAdmission`/`TrustProvider`
hold this oracle role for `Store`'s trust surface specifically — matching AG1's already-established
incremental-equals-oracle property. `store.ts`'s `trust`/`untrust` were always compatible with D21
under this reading; only D21's own text did not make the distinction explicit until now.
