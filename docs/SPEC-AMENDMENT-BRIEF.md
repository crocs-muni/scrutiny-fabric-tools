# Spec amendment brief — v0.5.9 → v0.6.0

Work order for a session editing `docs/protocol-spec.md`. Nine changes. Each has a plain-language
motivation, the concrete change, and the rule rows to add or amend.

This replaces an earlier 18-item draft. An adversarial review found that draft contained real
contradictions with the existing spec, and that about half its items were documentation tidiness with
no effect on behaviour. Those are listed under "Deliberately not doing" at the end so nobody re-raises
them. **Delete this file once the amendments land.**

---

## Ground rules

1. `docs/protocol-spec.md` is the only normative document.
2. **Never renumber or reuse a rule ID.** New rules get new IDs. Amending a rule's text keeps its ID.
3. Every new MUST / SHOULD / MAY in prose gets a rule ID **and** a matching Appendix F row.
4. **Run `node tools/extract-rules.mjs` after every change.** It exits non-zero if the body rule
   tables and Appendix F disagree. It also catches a re-tag applied in one place but not the other.
5. Do not change the rule-table column headers — the extractor matches them exactly and will silently
   return zero rows.
6. Prose below is a draft. Improve the wording; keep the normative content.

## Why v0.6.0 and not v0.5.10

`scrutiny-v059` is already patch 9, and the version tag is fixed at three digits encoding
MAJOR/MINOR/PATCH — there is no `scrutiny-v0510`. Each MINOR line admits exactly ten PATCH revisions,
which is worth stating in the changelog since it will recur.

---

# 1 — A missing `k` tag must not invalidate an event

**Why.** A researcher publishes a note about ROCA and tags it `i: cve:CVE-2017-15361` so it can be
found by CVE. They omit the companion `k: cve` tag, which only restates the *type* of the first tag.

Today the spec says two different things about that event: §9 says it is fine but less discoverable,
while PR-4 and MD-4 say the `k` collection **MUST** contain one entry per distinct `i` prefix — and
those are Validity rules, so "must" means the event is rejected outright. One implementation shows the
advisory, another discards it. When 6,737 Common Criteria certificates are published, a small
generator bug in the companion tags means one client shows all of them and another shows none.

**Decision: the event is valid.** The `k` value is pure redundancy — derivable from the `i` value by
splitting on the first colon. Discarding a security advisory over a derivable tag is disproportionate.

**Change.** Amend PR-4 and MD-4 (same IDs), and re-tag them from **V** to **D** — this is
discoverability, not admissibility:

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| PR-4 | D | NIP-73 | The `k` collection SHOULD contain at minimum one entry per **distinct** `i` prefix kind present in the event. A missing or incomplete `k` collection does NOT invalidate the event; consumers MAY derive the kind from the `i` value's prefix (§9). Consumers MUST treat `k` as a set. |
| MD-4 | D | NIP-73 | *(identical text)* |

Then align §9's prose to cross-reference PR-4/MD-4 rather than stating the requirement independently,
and add one sentence: "Because the kind is derivable from the `i` value's prefix, a missing `k` tag
reduces discoverability via the `#k` relay filter but does not affect validity."

⚠️ This changes two rules from V to D. Update both the §4.1/§4.2 tables **and** Appendix F, or the
extractor will fail. Also check §6.0's V bullet list, which mentions the `i` tag value grammar.

---

# 2 — Patches that arrive before the thing they patch

**Why.** Infineon publishes a chip description. Later they publish a correction. You are connected to
two relays: relay B hands you the correction, relay A has the original. **The correction arrives
first**, pointing at an event you have never seen.

Throw it away and you show the uncorrected description **forever** — even after the original arrives,
because you never revisit the correction. The spec explicitly says "hold it" for Bindings whose
endpoints haven't arrived (BD-6) and for deletions whose target hasn't arrived (DEL-8), but says
nothing for patches. So one implementation holds and another drops, and they display different text
for the same product.

**Scope note.** An earlier draft tried to generalise this into one mechanism covering Bindings,
deletions and patches. That overreached: it contradicted the existing α/β rule in §10, which already
says an annotation whose target hasn't been gossiped yet should be *rendered* in a degraded form. The
genuine gap is narrower — it is specifically that a patch whose **root** is unobserved cannot be
classified at all, because deciding whether a patch is the author's own or a third party's requires
knowing the root's author.

**Change.** Insert as a new **§7.6** (adjacent to the chain and overlay machinery it concerns — *not*
§3, which is versioning and event identification):

> ### 7.6 Unresolved references
>
> Under the eventual-consistency model of §3.2, an event may be observed before the events it
> references. Bindings whose endpoints are unobserved are covered by §4.3; deletions whose target is
> unobserved by §10; annotations whose target is unobserved by §10's α/β rule.
>
> A Patch whose `e root` target has not been observed cannot be classified: the root-author versus
> foreign distinction (§4.4) requires the root event's `pubkey`. Such a Patch MUST be retained and
> re-evaluated when the root is observed. It does not participate in the canonical chain until then.
> Its rendering, if any, is governed by §10's α/β rule, not by this section.
>
> Whatever the mechanism, the requirement is the same in every case: **ingestion is confluent.** The
> state an implementation reaches MUST depend only on the *set* of events it has observed, never on
> the order in which they arrived. Discarding a referencing event whose target has not yet arrived
> violates this, because the same event set then yields different state depending on delivery order.
>
> A classification MAY be cached as permanent only when no further observation could change it. A
> Binding's endpoint typing cannot change once observed, so BD-7's cached rejection is safe. A Patch's
> authorship class can change when its root arrives, so it MUST NOT be cached as invalid while the
> root is unobserved.

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| UR-1 | A | — | Ingestion MUST be confluent: the state an implementation reaches depends only on the set of events observed, never on arrival order. |
| UR-2 | A | — | A Patch whose `e root` is unobserved MUST be retained and re-evaluated on the root's arrival. It does not participate in the canonical chain until then. |
| UR-3 | D | — | A classification MAY be cached as permanent only when no further observation could change it. A Patch's authorship class MUST NOT be cached while its root is unobserved. |

**Do not** touch PT-6. A root-author patch replying to a foreign patch is *ignored for chain
construction*, which is an Application-layer outcome — not invalidity. Conflating the two would reject
a valid event on the wrong grounds.

Add a forward reference from **§5.3 step 1** ("walk root-author patches … from the root forward") to
§7.6, since that step is where the gap actually bites.

---

# 3 — Deleting a link removes the connection

**Why.** A researcher publishes "this chip is affected by ROCA", then separately publishes a **link**
joining that note to the chip. You trust the researcher, so you see both. The researcher then deletes
just the link.

Do you still see the note attached to the chip? The spec does not clearly say — §10 says the link is
"hidden from default views" and that "its endpoints remain valid independently," which uses a
validity word to answer a visibility question.

It is not cosmetic. If links keep working after deletion, anyone who steals a key can attach content
to a product **permanently**: publish a link, the content becomes visible, delete the link, the
content stays. That defeats §6.3's guarantee that untrusted actors cannot extend a trusted user's
graph.

**Decision: deleting the link removes the connection.**

**Change 3a.** Replace §10's "Binding events" bullet:

> **Binding events:** **edge retraction.** The Binding event is hidden from default views, and it
> ceases to confer admission on its endpoints (§6.4). Its endpoints remain *valid* SCRUTINY events —
> a retracted Binding never invalidates, deletes, or cascades into the Product or Metadata it
> connected — but an endpoint that was admitted **only** by way of this Binding is no longer
> reachable, and leaves the default view together with its canonical chain. An endpoint admitted by
> any surviving path, whether direct trust or another admitted Binding, is unaffected.
>
> Admission MUST NOT outlive the assertion that produced it. Were it to persist, a compromised key
> could permanently insert events into a user's view by publishing a Binding and then deleting it,
> defeating §6.3's guarantee that untrusted actors cannot extend a trusted user's graph.
>
> A foreign overlay that is independently admitted (§6, OV-7) but whose target has left the default
> view by this rule is rendered per §10's α/β degradation rule, as though its target were
> unobtainable. It is not silently dropped (DEL-4).

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| DEL-5 | D | — | Deletion of a Binding hides the edge from default views **and revokes the admission it conferred** (TR-4). Endpoints remain V-valid and are never cascade-deleted; an endpoint with no surviving admission path leaves the default view along with its canonical chain. An independently-admitted overlay whose target has left the view renders per the α/β rule, not dropped. |

**Change 3b — TR-4 and TR-5 currently contradict this.** TR-4 says admission is unconditional ("When
a Binding is admitted, both of its endpoints … are admitted"). Amending §10 alone leaves two rules
with opposite readings, which is the ambiguity this change exists to remove. Add to both TR-4 and
TR-5, and to §6.4's prose: "…for as long as the Binding is not retracted (§10, DEL-5)."

**Change 3c — this is unimplementable without amending DQ-2 and §8.2.** DQ-2 requires polling for
deletions only for "every chain root and every patch they cache." Bindings are absent. A client
following DQ-2 literally never learns a Binding was retracted and shows a de-admitted endpoint
indefinitely. Add "and every Binding" to DQ-2 and to §8.2's deletion-query prose.

---

# 4 — A hostile event must not be able to freeze a client

**Why.** Anyone can publish anything; that is the point. So someone publishes a product description
with a 50 MB body and 10,000 changes. A client computing the current text locks up.

The spec bounds only `i` and `k` tag counts. Real relays bound more — strfry, the most widely deployed,
caps events at 64 KB — but a library has to defend itself regardless. The expensive operation is the
uniqueness check in §5.3: proving a change's context appears exactly once means scanning the whole
document for each change, so cost scales with document size × number of changes.

**Change.** Insert as a new **§5.4**, immediately after the application rules it concerns:

> ### 5.4 Resource limits
>
> SCRUTINY is permissionless, so implementations process adversarial input by default. The determinism
> check of §5.3 (T1) is the most expensive operation: establishing that a hunk's context occurs exactly
> once requires scanning the full target content for each hunk, so cost scales with the product of
> content length and hunk count.
>
> Producers SHOULD respect the following bounds, which reflect limits deployed relays enforce.
>
> | Bound | Recommended | Basis |
> |---|---|---|
> | Total event size | ≤ 64 KB; prefer `imeta` above ~30 KB (§4.6) | strfry `maxEventSize = 65536` |
> | Length of a single tag value | ≤ 1024 bytes | strfry `maxTagValSize = 1024` |
> | Hunks per patch payload | ≤ 64 | T1 cost |
> | Patches per canonical chain | ≤ 1000 | Chain-resolution cost |
>
> Consumers SHOULD enforce configurable ceilings. Because an adversary optimises against whichever
> unit is counted, consumers SHOULD additionally bound the *total work* of patch application, measured
> in bytes compared, rather than relying on hunk or patch counts alone.
>
> An event exceeding a consumer's ceiling remains valid (§6.0) and MUST NOT be treated as invalid.
> Exceeding a ceiling aborts *application* and MUST be surfaced as a distinct **resource-limit
> exceeded** annotation — never as HALT (§5.3 H1), which denotes a patch that genuinely failed to
> apply. Because ceilings are local, content whose computation was abandoned for resource reasons MUST
> NOT be served or cached as canonical bytes (§7.1 RC-3).

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| RL-1 | D | — | Producers SHOULD respect the recommended bounds of §5.4. |
| RL-2 | A | — | Consumers SHOULD enforce configurable ceilings and SHOULD bound total patch-application work (bytes compared), not only hunk or patch counts. |
| RL-3 | A | — | Exceeding a ceiling aborts application and MUST be surfaced as a distinct resource-limit-exceeded annotation, never as HALT. The event remains V-valid. |
| RL-4 | A | — | Content abandoned for resource reasons MUST NOT be served or cached as canonical bytes. |

The relay figures are **verified** against `hoytech/strfry/strfry.conf`: `maxEventSize = 65536`,
`maxNumTags = 2000`, `maxTagValSize = 1024`. No need to re-check. Note the tag-count bound is omitted
from the table above because §4.1/§4.2's ≤64 `i` + ≤64 `k` ceilings already bind well below it.

---

# 5 — Verify every event, including deletions

**Why.** A signature in Nostr signs the event's **id**, which is a hash of its contents. So checking
only the signature does not protect the contents: a relay can alter the body while keeping the
original id and signature, and a signature-only check still passes. Only recomputing the id and
comparing catches it. Of five widely-used TypeScript Nostr libraries surveyed, one performs the
signature check without the id comparison.

**And the sharper point:** deletions are their own kind of event and are explicitly *not* SCRUTINY
events. So a rule phrased as "verify SCRUTINY events" leaves deletions unverified — meaning a hostile
relay can hand you a **forged deletion** and your implementation will honour it, wiping a product's
revision history and everything downstream. That is the most consequential gap here.

**Change.** Insert in **§3** (event identification — *not* §6.2, which is about trust):

> **Signature and identifier verification.** Before processing any event, implementations MUST verify
> both that its `sig` is a valid Schnorr signature for its `pubkey` over its `id`, and that its `id`
> equals the SHA-256 of its NIP-01 canonical serialization. Verifying the signature alone is
> insufficient: the signature commits to the `id`, so an event whose `content` or `tags` were altered
> while retaining the original `id` and `sig` still passes a signature-only check.
>
> This applies to **every event an implementation consumes**, including kind 5 deletions (§10) and
> kind 1040 attestations (§3.1) — not only events carrying a `scrutiny-fabric` tag. An unverified
> deletion is indistinguishable from a forged one, and honouring a forged deletion removes canonical
> history (§10 DEL-2). Relays are not trusted to have performed either check (§7.5). An event failing
> either check MUST NOT be processed or rendered.

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| SIG-1 | V | NIP-01 | Before processing any event — including kind 5 deletions and kind 1040 attestations — implementations MUST verify the signature **and** that `id` equals the SHA-256 of the NIP-01 canonical serialization. A signature-only check is insufficient. |

**Also amend §3.2's inherited-semantics table.** Its first row assigns signature verification and id
derivation to NIP-01, under a preamble requiring implementations to "defer to the base-layer
specification rather than re-derive semantics." As written, a reader can cite §3.2 to argue SIG-1 is
out of scope. Change that row to: "NIP-01 defines the signature scheme and id derivation; SCRUTINY
requires that both be *performed* before processing (SIG-1)." §3.2's closing paragraph already permits
SCRUTINY-specific restrictions.

**Ordering note:** SIG-1 requires hashing the whole event, so it runs before any size ceiling from
§5.4. State that the total-size bound is enforceable at ingest or transport *before* SIG-1, and that
declining to verify an oversized event does not make it V-invalid.

---

# 6 — A do-nothing patch is currently both valid and invalid

**Why.** `git diff` outputs nothing when two files are identical; `jsdiff` outputs a header with no
changes. §5.2 says **both** are valid "nothing changed" patches, and N2 says consumers "MUST NOT
reject this shape as malformed." But §5.2's own grammar line requires at least one change block:

```
patch-payload = [ index-preamble ] [ diff-git-line ] header-block [ hunk-block ]+
```

`[ x ]+` is also not valid ABNF — ABNF uses prefix repetition (`*x`, `1*x`); postfix `+` is regex.

**Change.** `header-block *hunk-block`. Register the grammar block's existing "a conforming consumer
MUST accept" obligation (§5.2, above the grammar) as a rule, since nothing in the registry currently
constrains it.

---

# 7 — "Filter by trust first" appears twice and breaks chain resolution

**Why.** §6.2 says untrusted events are "filtered out **before any other processing**." Taken
literally that produces a silent, plausible-looking wrong answer: a product you can only see because
you trust *someone else's* link to it may have corrections authored by a key you don't trust
directly. Filter those out first and you conceal both conflicting-edit conditions and stopped chains
— the text renders as complete and linear when it is neither.

**Change 7a.** Replace that sentence in §6.2:

> Untrusted, unreachable events are excluded from the user's view. Filtering is a
> **presentation-time** operation: it determines what the user is shown, not what the implementation
> computes. Canonical-chain construction (§5.3), self-fork detection (§7.2), and overlay
> classification (§7.3) are evaluated over the full set of V-valid observed events without reference
> to the trust set; the trust set is then applied to the results.
>
> Implementations MUST NOT filter events by trust before chain construction. Doing so silently
> conceals root self-forks and HALT conditions in the chain of a root admitted via a trusted Binding
> (§6.4), because that root's own patches may be authored by a pubkey the user does not trust
> directly. This also follows from §6.0: a V-valid event MUST NOT be rejected by a D rule.

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| TR-7 | D | — | Trust filtering is applied at presentation time, to the results of chain and overlay computation. Implementations MUST NOT filter by trust before canonical-chain construction, self-fork detection, or overlay classification. |

Tagged **D**: §6.0 partitions rules by *subject*, and this rule's subject is when a visibility gate
may be applied. Every other TR-* rule is D.

**Change 7b — the same instruction appears a second time.** §7.5's "Users" paragraph repeats it:
"untrusted events are filtered out before any other processing occurs (§6)." Rewrite it to match 7a.

**Change 7c — §7.4 step 5 contradicts TR-7 directly.** It currently reads "For each foreign patch
**admitted under §6**, classify against its `e reply` target's resolved content" — trust before
classification, exactly what TR-7 forbids. Change to: "For each foreign patch, classify against its
`e reply` target's resolved content per §7.3; trust gating (OV-7) is applied to the results at
presentation time."

**Change 7d.** Extend §6.0's enumeration `TR-2..TR-6` to include TR-7.

---

# 8 — Version bump to v0.6.0

Header, changelog entry, and `scrutiny-v059` → `scrutiny-v060` in §3, all §4 examples, and Appendix D.

⚠️ **Do not blanket-replace `scrutiny-v059`.** The changelog's v0.5.9 entry legitimately contains
"Version tag `scrutiny-v058` → `scrutiny-v059`", and the new v0.6.0 entry must contain
"`scrutiny-v059` → `scrutiny-v060`". A global replace corrupts the changelog.

Two collateral edits:

- **Appendix B**'s "NOT borrowed" list says "**merges** (planned for v060)". False once v0.6.0 ships
  without them — §11 still lists merges as future work. Change to "a future version".
- **§3's forward-compatibility prose** uses "a v0.5.9 implementation encountering `scrutiny-v060`" as
  its higher-version example, and "violates a v0.5.9 Validity invariant". Re-version both.

---

# 9 — `created_at` is publish time, not the historical date

**Why.** Mapping a Common Criteria certificate issued in 2012, the intuitive move is to set
`created_at` to the issue date. **Verified:** strfry defaults to
`rejectEventsOlderThanSeconds = 94608000` — exactly three years — and
`rejectEventsNewerThanSeconds = 900`. So backdated events are **silently refused**: no error, nothing
stored. Publishing the sec-certs corpus this way would appear to succeed and store nothing.

**Change.** Add to the **§4 preamble** (which already carries statements common to §4.1–§4.6), rather
than duplicating a note in §4.1 and §4.2:

> **`created_at` semantics.** `created_at` is the time the *event* was created, not the time of the
> fact it describes. Publishers mapping historical records — certification dates, disclosure dates,
> release dates — MUST NOT backdate `created_at` to the historical date. Deployed relays commonly
> reject events whose `created_at` falls outside a bounded window (commonly a few minutes ahead and
> one to three years behind), so backdated events are silently refused. Historical dates belong in
> `content`.

| # | Layer | Inherits from | Rule |
|---|---|---|---|
| CA-1 | D | — | Publishers MUST NOT backdate `created_at` to a historical date the event describes. Deployed relays reject events outside a bounded timestamp window; historical dates belong in `content`. |

Also reword §7.5's "Publishers MAY lie about `created_at` timestamps" to "cannot be prevented from
setting an arbitrary `created_at`", so the threat-model sentence and CA-1 don't read as contradictory.

---

# Deliberately not doing

Considered and dropped. All are documentation tidiness with no effect on behaviour; re-raising them
costs churn and citation instability.

- **Registering the twelve normative statements that live in prose but not in a rule table.** Genuine
  finding, no behavioural consequence. §3.2, §7.5, §8.0, §8.1 and §8.2 have no rule tables at all.
  Worth doing eventually; not now.
- **Restoring MUST wording in four registry summaries** (SF-5, RC-2, OV-8). The prose is authoritative
  and unambiguous; the summary table is an index.
- **Normalising the split rule-ID grammar** (`BD-3` vs bare `T1`). Renaming breaks every citation.
- **Nine of the twelve cross-references** an earlier draft proposed adding for the unresolved-reference
  section. More cross-links do not make a spec clearer. Two are kept: §5.3 step 1 → §7.6, and §7.6 →
  §10's α/β rule.
- **§6.0's layer manifest being incomplete** (it cites 14 of 47 Validity rules, and TR-1 and IR-4
  appear in no bullet). One genuine error there is worth the one-line fix while editing: its V bullet
  cites "§5.2 E\*", which sweeps in E7 — tagged A, and correctly listed in the A bullet too. Change to
  `E1–E6`.
- **Appendix F's section-granularity skew** (TR-* cited as §6 though the table is under §6.4; DQ-* as
  §8 though under §8.3). The extractor reports these as informational, not errors.

---

# Verification checklist

- [ ] `node tools/extract-rules.mjs` exits 0
- [ ] Rule count is 123 + 10 new (UR-1..3, RL-1..4, SIG-1, TR-7, CA-1) = **133**; layer tallies updated
- [ ] PR-4 and MD-4 re-tagged V → D in **both** their §4 tables and Appendix F
- [ ] Every new rule appears in its section table **and** Appendix F with identical layer and inheritance
- [ ] No rule ID renumbered or reused
- [ ] Header, changelog, §3, §4 examples and Appendix D show v0.6.0 — changelog history intact
- [ ] Appendix B no longer says merges are planned for v060
- [ ] §7.4 step 5, §7.5 and §6.2 all agree on filtering order
- [ ] TR-4, TR-5, §6.4, DQ-2 and §8.2 all reflect the Binding-deletion change
- [ ] §5.2's grammar reads `*hunk-block`
- [ ] §6.0 cites `E1–E6` and includes TR-7
- [ ] Appendix E's two path prefixes are consistent, and the cited path resolves in the public tools repo
