# Spec amendment brief — v0.5.9 → v0.6.0

Self-contained work order for a session editing `docs/protocol-spec.md`. Every amendment below has a
motivation and, where the wording is settled, proposed prose to insert. Rule-table rows are given in
the document's existing format.

**Delete this file once the amendments land.** It is an input, not documentation.

---

## Ground rules for the editing session

1. **`docs/protocol-spec.md` is the only normative document.** Do not create parallel specifications.
2. **Preserve rule-ID stability.** Never renumber or reuse an existing ID. New rules get new IDs; a
   retired rule becomes a *reserved* cross-reference, as OV-1 already does.
3. **Every new normative statement gets a rule ID and an Appendix F row.** A MUST/SHOULD/MAY in prose
   with no registered ID is a defect — v0.5.9's changelog records three such rules being discovered
   and registered after the fact (DQ-3, DQ-4, DEL-10/11).
4. **Update the Changelog section** with a v0.6.0 entry in the established style.
5. **Update every `scrutiny-v059` occurrence** to `scrutiny-v060`, including all examples in §4 and
   Appendix D.
6. Prose in this brief is a *draft*. Improve the wording; preserve the normative content.

## Why v0.6.0 and not v0.5.10

Not a stylistic choice. VER-1 states the three digits of `scrutiny-vMMP` encode MAJOR/MINOR/PATCH,
and TAG-2 fixes the form as `^scrutiny-v\d{3}$`. `scrutiny-v059` is already patch 9, so there is no
representable 0.5.10 — `scrutiny-v0510` fails the regex. The only alternative would be changing the
version-tag scheme itself, which breaks TAG-2, VER-1, and every event already published.

Worth recording in the changelog as a known property: **each MINOR line admits exactly ten PATCH
revisions.** A future amendment may want to widen the scheme; that is a breaking change and belongs
in §11.

---

# Amendments

## A1 — Version bump

`scrutiny-v059` → `scrutiny-v060` throughout; header to v0.6.0; new changelog entry.

## A2 — §6.2: filtering order (settled)

**Motivation.** §6.2 currently reads *"Untrusted, unreachable events are filtered out before any
other processing."* Taken literally this instructs implementations to do the thing §6.0/TR-1 forbids
— reject a V-valid event on a D-layer ground — and it produces a silent, plausible-looking wrong
answer. A root admitted via a trusted Binding (TR-4) may have canonical patches authored by a pubkey
the user does not trust directly; filtering those out before chain construction conceals root
self-forks (SF-1, SF-3) and HALT conditions (H1), yielding a chain that renders as linear and
complete when it is neither.

**Replace** that sentence with:

> Untrusted, unreachable events are excluded from the user's view. Filtering is a
> **presentation-time** operation: it determines what the user is shown, not what the implementation
> computes. Canonical-chain construction (§5.3), self-fork detection (§7.2), and overlay
> classification (§7.3) are evaluated over the full set of V-valid observed events without reference
> to the trust set; the trust set is then applied to the results.
>
> Implementations MUST NOT filter events by trust before chain construction. Doing so silently
> conceals root self-forks and HALT conditions in the chain of a root that is admitted via a trusted
> Binding (§6.4), because that root's own patches may be authored by a pubkey the user does not trust
> directly — yielding a chain that renders as linear and complete when it is neither. This is also
> required by §6.0: a V-valid event MUST NOT be rejected by a D rule, and trust admission is a
> D-layer concern.

**New rule** (new ID; do not fold into TR-2):

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| TR-7 | A | — | Trust filtering is applied at presentation time, to the results of chain and overlay computation. Implementations MUST NOT filter by trust before canonical-chain construction, self-fork detection, or overlay classification. |

Tagged **A** because the failure mode is an A-layer failure (wrong canonical bytes), even though the
rule constrains when a D rule may be applied.

## A3 — §10: Binding deletion revokes admission (settled)

**Motivation.** The current sentence — *"Its endpoints remain valid independently; retracting a
binding does not affect the Product or Metadata it connected"* — uses a V-layer word ("valid") in
D-layer prose, leaving it genuinely ambiguous whether a deleted Binding still confers TR-4 admission.
Two implementations will visibly disagree. The reading below is chosen because the alternative makes
admission monotone in Bindings, which lets a compromised key permanently inject events into a user's
view, and makes admission depend on arrival order.

**Replace** the "Binding events" bullet with:

> **Binding events:** **edge retraction.** The Binding event is hidden from default views, and it
> ceases to confer admission on its endpoints (§6.4). Its endpoints remain *valid* SCRUTINY events —
> a retracted Binding never invalidates, deletes, or cascades into the Product or Metadata it
> connected — but an endpoint that was admitted **only** by way of this Binding is no longer
> reachable, and leaves the default view together with its canonical chain. An endpoint admitted by
> any surviving path, whether direct trust or another admitted Binding, is unaffected.
>
> The asymmetry with root deletion is deliberate. A retracted root hides one author's own statement
> while preserving everyone else's assertions about it. A retracted Binding withdraws the *edge* that
> made an otherwise-untrusted endpoint visible, and admission MUST NOT outlive the assertion that
> produced it: were it to persist, a compromised key could permanently insert events into a user's
> view by publishing a Binding and then deleting it, defeating §6.3's guarantee that untrusted actors
> cannot extend a trusted user's graph. It would also make admission depend on arrival order —
> whether the deletion was observed before or after the endpoint — which §7.1's eventual-consistency
> model does not permit.

**Amend DEL-5** (same ID, revised text):

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| DEL-5 | D | — | Deletion of a Binding hides the edge from default views **and revokes the TR-4 admission it conferred**. Endpoints remain V-valid and are never cascade-deleted; an endpoint with no surviving admission path leaves the default view along with its canonical chain. |

## A4 — New §3.3: unresolved references under eventual consistency

**Motivation.** The spec solves the same problem twice and omits it once:

| Case | Current rule |
|---|---|
| Binding with unobserved endpoints | BD-6, BD-7 |
| Kind 5 whose target has not arrived | DEL-8 |
| **Patch whose `e root` or `e reply` target has not arrived** | **none** |

§5.3 step 1 says to walk patches "from the root forward" — but if the root is absent there is nothing
to walk from, and no rule says what becomes of the orphan patch. One implementation drops it, another
holds it; identical event sets then produce different content, which breaks OV-4's determinism
requirement. Under a multi-relay mesh this is routine, not exotic: a patch fetched from relay B whose
root lives on relay A.

Generalising is the better fix than patching one rule: it makes the spec **shorter**, replacing two
special cases and a gap with one rule the three cases cite.

**Insert as a new §3.3**, after §3.2 (inherited semantics) and before §4:

> ### 3.3 Unresolved references under eventual consistency
>
> Several SCRUTINY constructs reference other events by id: a Binding references its two endpoints
> (§4.3), a Patch references its root and its reply target (§4.4), and a kind 5 deletion references
> its target (§10). Under the eventual-consistency model inherited from Nostr (§3.2) a referencing
> event may be observed before the event it references, or the referenced event may never arrive at
> all.
>
> Implementations MUST resolve such references lazily rather than discarding the referencing event.
> An event with one or more unobserved references is held **pending**: admitted to local storage, not
> rendered, and re-evaluated whenever a referenced event is observed. On resolution the event
> transitions either to admitted or to **permanently invalid**, according to the rules of its own
> event type. A permanently-invalid classification SHOULD be cached so that the event is not
> re-evaluated on every change to the observed set.
>
> The consequence that matters for interoperability is that **ingestion MUST be confluent**: the
> state an implementation reaches MUST depend only on the *set* of events it has observed, never on
> the order in which they arrived. Discarding a referencing event whose target has not yet arrived
> violates this, because the same event set then yields different state depending on delivery order.
>
> Per-type resolution rules are given in §4.3 (Binding endpoints), §4.4 (Patch lineage), and §10
> (kind 5 targets).

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| UR-1 | A | — | An event with unobserved references MUST be held pending — admitted to local storage, not rendered — and re-evaluated when a referenced event is observed. It MUST NOT be discarded. |
| UR-2 | A | — | Ingestion MUST be confluent: the state reached depends only on the observed event set, never on arrival order. |
| UR-3 | D | — | A permanently-invalid classification SHOULD be cached to avoid re-evaluation on every observed-set change. |

**Then, in §4.4**, add to the append-only paragraph:

> A Patch whose `e root` or `e reply` target has not been observed is held pending per §3.3. It does
> not enter the canonical chain and is not rendered until its lineage resolves. A Patch whose
> `e reply` target is observed and is not a permitted target for its authorship class (PT-6, PT-7)
> is permanently invalid.

Cross-reference §3.3 from BD-6/BD-7 and DEL-8 rather than duplicating the mechanism.

## A5 — New §3.4: resource limits

**Motivation.** The specification bounds `i` tags (IX-2, a SHOULD) and nothing else. There is no
limit on `content` size, hunks per patch, patches per chain, or Bindings per event. On a permissionless
protocol every implementation processes adversarial input by default, and T1's uniqueness check is
inherently expensive — proving a hunk's context occurs exactly once means scanning the full content
per hunk. A hostile publisher can therefore construct a chain that stalls any *conformant* client,
which makes this a specification gap rather than an implementation bug.

**Insert as a new §3.4:**

> ### 3.4 Resource limits
>
> SCRUTINY is permissionless: any pubkey may publish any well-formed event, so implementations
> process adversarial input by default. Several operations have costs an adversary can inflate. The
> determinism check of §5.3 (T1) is the most significant: establishing that a hunk's context occurs
> exactly once requires scanning the full target content for each hunk, so cost scales with the
> product of content length and hunk count.
>
> Producers SHOULD respect the following bounds, which reflect limits deployed relays enforce in
> practice. An event exceeding them is not thereby invalid (§6.0), but it may be refused by relays or
> by consumers.
>
> | Bound | Recommended | Basis |
> |---|---|---|
> | Total event size | ≤ 64 KB; prefer `imeta` above ~30 KB (§4.6) | Common relay maximum |
> | Tags per event | ≤ 1000 | NIP-11 `max_event_tags`; deployed configurations |
> | Length of a single tag value | ≤ 1024 bytes | Deployed configurations |
> | Hunks per patch payload | ≤ 64 | T1 cost |
> | Patches per canonical chain | ≤ 1000 | Chain-resolution cost |
>
> Consumers SHOULD enforce configurable ceilings and MUST fail safely — surfacing a protocol error
> annotation (H2) rather than exhausting memory or blocking indefinitely. Because an adversary
> optimises against whichever unit is counted, consumers SHOULD additionally bound the *total work*
> of patch application, measured in bytes compared, rather than relying on hunk or patch counts alone.

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| RL-1 | D | — | Producers SHOULD respect the recommended bounds of §3.4. |
| RL-2 | A | — | Consumers SHOULD enforce configurable ceilings and MUST fail safely with a protocol error annotation rather than exhausting resources. |
| RL-3 | A | — | Consumers SHOULD bound total patch-application work (bytes compared), not only hunk or patch counts. |

⚠️ **Verify before publishing.** The 64 KB figure comes from strfry's `maxEventSize = 65536` default
and the tag figures from its `maxNumTags` / `maxTagValSize`. Confirm against
`hoytech/strfry/strfry.conf` rather than trusting this brief.

## A6 — §6: explicit signature and id verification

**Motivation.** §3.2 assigns signature verification to NIP-01, and BD-12 requires trust decisions to
be based on "the actual event pubkey, verified from the Nostr event signature" — but no rule states
the verification obligation itself, and NIP-01 defines the computation while remaining silent on
whether clients must perform it. §7.5 states relays MAY be malicious, which makes an unverified event
from a relay untrusted input.

The gap has a sharp edge: the signature commits to the **`id`**, which is a hash. A relay can alter
`content` or `tags` while retaining the original `id` and `sig`, and a signature-only check still
passes. Only recomputing the id and comparing catches it. This is not hypothetical — of five surveyed
TypeScript Nostr libraries, one widely-used client library performs the signature check without the
id comparison.

**Insert** at the head of §6.2, before the admission conditions:

> **Signature and identifier verification.** Before an event enters SCRUTINY processing,
> implementations MUST verify both that its `sig` is a valid Schnorr signature for its `pubkey` over
> its `id`, and that its `id` equals the SHA-256 of its NIP-01 canonical serialization. Verifying the
> signature alone is insufficient: the signature commits to the `id`, so an event whose `content` or
> `tags` were altered while retaining the original `id` and `sig` still passes a signature-only check.
> Relays are not trusted to have performed either check (§7.5). An event failing either check is not a
> SCRUTINY event and MUST NOT be processed or rendered.

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| SIG-1 | V | NIP-01 | Implementations MUST verify the event signature **and** that `id` equals the SHA-256 of the NIP-01 canonical serialization, before SCRUTINY processing. A signature-only check is insufficient. |

## A7 — New §6.5: portable trust, relay, and settings lists (non-normative)

**Motivation.** §6.1 leaves the trust mechanism out of scope, correctly. But without a convention,
each client invents its own storage key and a user's curated trust set is stranded per application —
which for a decentralised protocol defeats the point. The `d` values must be **protocol-scoped**, not
application-scoped, or portability is lost. Marked non-normative so it does not contradict §6.1.

**Insert as §6.5:**

> ### 6.5 Portable trust, relay, and settings lists (non-normative)
>
> §6.1 leaves the trust mechanism out of scope. This subsection records a storage convention so that
> a user's curated trust set is portable between SCRUTINY-aware clients rather than re-curated in each
> one.
>
> | Purpose | Kind | Payload | `d` tag |
> |---|---|---|---|
> | Trusted pubkeys | 30000 — NIP-51 follow set | `p` tags | `scrutiny-fabric:trusted-pubkeys` |
> | Relay set | 30002 — NIP-51 relay set | `relay` tags | `scrutiny-fabric:relays` |
> | Application settings | 30078 — NIP-78 app data | JSON in `content` | `scrutiny-fabric:settings` |
>
> The `d` values are deliberately protocol-scoped rather than application-scoped: a list written by
> one client is readable by every other. Clients SHOULD use these `d` values when persisting a user's
> SCRUTINY trust set or relay preferences to Nostr.
>
> NIP-51 permits **private** list entries — encrypted to the author's own key with NIP-44 and carried
> in `content` rather than `tags`. Because trusting a pubkey can be a politically consequential signal
> in a security-metadata context, clients SHOULD support private entries and SHOULD NOT publish a
> trust set with public entries by default.
>
> NIP-78 offers no encryption guidance. Clients MUST NOT place credentials or other secrets in a kind
> 30078 event without encrypting them.

Non-normative, so no Appendix F rows — except the final MUST NOT, which should be registered if kept
as a MUST.

## A8 — New Appendix G: conformance vectors

**Motivation.** §11 lists test vectors as future work. They are now a deliverable, and the format
matters: the existing `docs/test-vectors.md` (removed in the 2026-07-27 cleanup, recoverable from git
history) demonstrated why prose-embedded vectors fail — its first vector's input JSON was
syntactically invalid, and it described patches diffing `a/i`/`b/i`, which C1 and IX-3 forbid.
Markdown also cannot carry byte-exact vectors when PB-1/PB-2 make byte-exactness normative
(no-trailing-newline, CRLF, BOM). NIP-44's model — separate JSON, grouped by category, digest pinned
in prose — fits, and unlike CommonMark's uniform examples, SCRUTINY's vectors have four distinct
shapes.

**Insert as Appendix G:**

> ## Appendix G — Conformance vectors
>
> Machine-readable conformance vectors accompany this specification as JSON files under
> `docs/vectors/`, grouped by category. Their SHA-256 digests are pinned below; an implementation
> SHOULD validate the digest before trusting a local copy.
>
> | File | Shape |
> |---|---|
> | `validity.json` | event → `{admitted, ruleIds[]}` |
> | `application.json` | `{root, patches[], deletions[]}` → `{canonicalBytes, haltAt, annotations[], overlays[]}` |
> | `discovery.json` | `{events[], trustedPubkeys[]}` → `admittedIds[]` |
> | `serialization.json` | event → canonical serialization bytes |
>
> Every vector carries the Appendix F rule ID it exercises. Vectors are **not normative** — the prose
> in the cited section remains authoritative — but a conforming implementation SHOULD pass all of
> them, and any divergence between a vector and the prose is a specification defect to be reported.
>
> Vectors are versioned with this specification. Implementations SHOULD record the vector release they
> were last verified against.

Then remove "**Test vectors.** Companion document…" from §11.

**Practical note for the editing session:** build the extraction/validation tooling and the file
skeletons, but author vectors *incrementally as rules are implemented*. Attempting all ~123 up front
is how this stalls. Expect roughly 60 static-vector, 25 harness-only (behavioural D-rules such as
BD-8 relay fallback and DQ-2 periodic polling), and 15 not-testable.

## A9 — §4.4: cycle impossibility (non-normative note)

**Motivation.** A real structural guarantee that every implementer would otherwise waste effort
defending against.

**Add** to §4.4, near the append-only paragraph:

> **Note (non-normative).** Patch lineage cannot contain cycles. A patch's `e reply` tag commits to
> its parent's event id, and an event's id is a hash over its own tags (NIP-01); constructing two
> patches that reference each other would require knowing each event's id before creating it.
> Implementations therefore do not need cycle detection when walking a chain. They SHOULD still bound
> traversal depth as a defence against unbounded chains (§3.4).

## A10 — §4.6: streaming-verification caveat

**Motivation.** IM-1 requires verifying the `x` hash "by streaming the artifact contents". On the web
platform this is not achievable with the obvious API — `crypto.subtle.digest` accepts only a complete
buffer and cannot hash incrementally. With the sec-certs corpus at roughly 11 GB of PDFs, buffering is
not an option.

**Add** after the IM-1 prose:

> **Note on streaming.** IM-1's streaming requirement bounds memory; it does not mandate a particular
> API. Implementations targeting the web platform should note that `crypto.subtle.digest` accepts only
> a complete buffer and cannot hash incrementally, so verifying large artifacts without buffering them
> entirely requires an incremental SHA-256 implementation.

## A11 — §4.1: `created_at` is publish time, not the historical date

**Motivation.** The intuitive mapping for a historical record — a Common Criteria certificate issued
in 2012, say — is to set `created_at` to the issue date. Deployed relays commonly reject events
outside a bounded timestamp window, so those events are silently refused. The failure is invisible:
the publisher sees no error and the events simply are not stored.

**Add** as a note in §4.1 (applies equally to §4.2):

> **Note on `created_at`.** `created_at` is the time the *event* was created, not the time of the fact
> it describes. Publishers mapping historical records — certification dates, disclosure dates, release
> dates — MUST NOT backdate `created_at` to the historical date: deployed relays commonly reject
> events whose `created_at` falls outside a bounded window, so backdated events are silently refused.
> Historical dates belong in `content`.

⚠️ Verify the relay window claim against `strfry.conf` (`rejectEventsOlderThanSeconds`,
`rejectEventsNewerThanSeconds`) before publishing, and consider citing the actual defaults.

## A12 — Appendix E: verify the citation resolves

Appendix E cites `scrutiny-fabric-tools/investigations/diff-parity/REPORT.md`. That directory was
gitignored, so the path did not resolve for any reader. Fixed on 2026-07-27 (commit `98a3755` in the
tools repo). **Confirm the path in Appendix E matches the committed location** and consider adding the
sec-certs mapping report alongside it, since it now exists publicly too.

---

# Explicitly NOT changing

Recorded so a future session does not re-derive these. All three were investigated and rejected.

**The NIP-01 serialization rule is not a gap.** Its seven short escapes plus "all other characters
verbatim" is a precise rule that exists to defeat encoder-specific escaping — Go's `encoding/json`
HTML-escapes by default; .NET escapes all non-ASCII. `JSON.stringify` complies with every clause that
matters, and `nostr-tools`' `serializeEvent` *is* `JSON.stringify`, making it correct by ecosystem
convention. Sub-0x20 control characters are escaped identically by every standard encoder; lone
surrogates are a real but obscure JS↔Go asymmetry, not a protocol defect. **No amendment.** (A6
stands on entirely separate grounds.)

**NIP-11's `max_content_length: 8196` does not contradict §4.6's ~30 KB advice.** That value is an
illustrative example in the NIP document, not a deployed default. strfry uses
`maxEventSize = 65536`, against which §4.6 is sound. **No amendment** — A5 adopts the real numbers.

**Indexer prefix additions are deferred.** `cc-cert-id`, `cc-scheme`, `cc-eal`, `cc-sar` (from the
sec-certs mapping) and `pp`, `vendor`, `scheme` (used by an existing client) are not being registered
in §9 yet. Note two things for whoever picks this up: IR-4 already makes unknown prefixes valid, so
nothing is blocked; but `i` tags are **immutable after publication** (IX-3), so publishing a large
corpus under a prefix that is later renamed is unfixable except by republishing everything. Settle the
vocabulary **before** any bulk publish.

---

# Verification checklist

- [ ] No occurrence of `scrutiny-v059` remains
- [ ] Header, changelog, and every §4 / Appendix D example show v0.6.0
- [ ] Every new MUST/SHOULD/MAY has a rule ID **and** an Appendix F row
- [ ] Appendix F row count matches the number of rule-table rows in the body
- [ ] No existing rule ID renumbered or reused; DEL-5's text amended in both §10 and Appendix F
- [ ] §3.3 is cross-referenced from §4.3, §4.4 and §10 rather than duplicated
- [ ] §11 no longer lists test vectors as future work
- [ ] strfry-derived numbers in A5 and A11 verified against `strfry.conf`
- [ ] Appendix E's cited path resolves in the public tools repo
