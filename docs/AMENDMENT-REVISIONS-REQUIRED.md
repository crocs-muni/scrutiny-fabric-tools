# Revisions required before executing the amendment brief

An adversarial review of `SPEC-AMENDMENT-BRIEF.md` against the v0.5.9 specification returned
**23 findings** and a verdict of **not safe to execute as written**.

Four findings were spot-checked verbatim against the spec and all four confirmed. Confidence in the
remainder is correspondingly high, but each item below should still be verified against the spec text
while being fixed — do not take this file on trust.

**Do not run Session A until the items marked 🔴 are resolved.**

## Confirmed by direct quotation

| Brief claim | Spec text | Line |
|---|---|---|
| UR-1: a pending patch "is not rendered" | *"render β until the target arrives; on arrival, upgrade to α"* | §10:949 |
| A4: a PT-6 violation is "permanently invalid" | PT-6, layer **A**: *"is **ignored** for canonical-chain construction"* | §4.4:380 |
| A3: order-dependence "which §7.1's model does not permit" | *"Late-arriving events **MAY** retroactively change classification"* | §7.1:677 |
| A2/TR-7 forbid trust-filtering before classification | *"For each foreign patch **admitted under §6**, classify…"* | §7.4:759 |
| A2 replaces the §6.2 sentence | The same sentence exists a second time, unamended | §7.5:773 |

---

## Execution order

The brief treats A2, A3 and A4 as independent. They all touch the same admission-and-resolution
machinery, and A3 depends on A4. Land them in this order:

```
1. A2  (smallest, self-contained)  →  2. A4 (rewritten)  →  3. A3  →  4. A5, A6, A7, A8, A11
                                                              A1, A9, A10, A12 anytime
```

---

## 🔴 A4 — substantial rewrite required

The largest amendment and the one with the most defects. Rewrite before anything else.

- [ ] **Remove the rendering claim.** UR-1's "not rendered" and the §4.4 clause contradict DEL-7's
      α/β rule, which explicitly covers not-yet-gossiped targets and says render β. Scope the patch
      clause to *chain participation only*: "…does not enter the canonical chain and is not rendered
      **as a canonical chain link**. A foreign patch whose target is unobserved renders per the α/β
      rule (§10, DEL-7)." Restrict UR-1's non-rendering to Bindings.
- [ ] **Split PT-6 from PT-7.** PT-7 (V) violation → permanently invalid. PT-6 (A) violation →
      admitted, ignored for canonical-chain construction. Treating a PT-6 failure as invalid rejects
      a V-valid event on an A ground, which TR-1 forbids and §6.0 explicitly rules out.
- [ ] **Fix UR-3's order-dependence.** Authorship class (PT-5) needs the *root's* pubkey. A patch can
      arrive with its reply target but without its root, leaving PT-6/PT-7 unevaluable. Caching
      "permanently invalid" then is order-dependent — violating UR-2, the rule A4 exists to add.
      UR-3 must permit caching only when no further observation can change the verdict, and §4.4 must
      require *both* root and reply target observed before evaluating lineage. BD-7's cache is safe
      only because endpoint typing cannot change; classification can.
- [ ] **Re-tag the layers.** UR-1 generalises BD-6, which §6.0 lists under **D** — the general rule
      and its instance cannot sit in different layers. UR-3 generalises BD-7 (**V**), the same
      mismatch inverted; either re-tag or split it (classification is V, caching is D). UR-2 as A is
      strained: confluence is a property of ingestion, not of applying an event to chain state.
- [ ] **Relocate.** §3 is titled "Versioning & event identification". Unresolved-reference resolution
      is neither. A reader looks in §4.3, §6, §7.1 or §10. Move to a new subsection of §6 or §7.
      (Numbering is safe either way — §3.3/§3.4 are unused and nothing cites §3.2 as terminal.)
- [ ] **Expand the cross-reference list from 3 sites to 12.** The brief names BD-6, BD-7, DEL-8.
      Also affected: §3.2's eventual-consistency row · §4.3's three lifecycle bullets · §7.1 +
      RC-3/RC-4 · §7.3 "Overlays anchored at unapplied targets" + OV-3 · §7.3's Orphaned row · §10's
      α/β table + DEL-7 · DEL-9 · §8.2 + DQ-2 · §5.3 step 5 + H1 · §7.2's Resolution row + SF-5 ·
      §5.3 step 1 (the actual gap) · Appendix C's "Orphaned overlay" glossary entry.
- [ ] **Amend §6.0's V bullet**, which currently scopes observation-dependent V evaluation to
      "endpoint typing … per the §4.3 pending-endpoint lifecycle". A4 extends it to patch lineage.
- [ ] **Narrow the claim.** Keep UR-2 (confluence) — that is the real contribution and is genuinely
      absent from the spec. But drop the assertion that §3.3 *subsumes* the three per-type rules:
      kind 5 has no "permanently invalid" terminal state (DEL-1 leaves an unhonoured deletion a
      perfectly valid event), Bindings resolve to V-validity while patches resolve to A-layer chain
      participation, and the patch reply-target case already has an answer in DEL-7. **The genuine
      gap is narrower than claimed: the unobserved `e root` case**, where PT-5 cannot classify at all
      and §5.3 step 1 has no starting point.
- [ ] **Correct two false statements in the motivation.** It claims the generalisation makes the spec
      "shorter" — it adds a section, three rules and three Appendix F rows while retaining BD-6,
      BD-7 and DEL-8 in full. And it cites OV-4 for the broken determinism; OV-4 governs *overlay
      classification*. The rule a dropped orphan patch breaks is **RC-2** plus §5.3.

## 🔴 A3 — blocked on A4, and three omissions

- [ ] **Delete the arrival-order argument.** §7.1 says the opposite of what the brief claims. The
      key-compromise argument (§6.3) is sound and load-bearing; the order argument is not. If an
      order argument is wanted, cite A4's UR-2 — which is why A3 must land after A4.
- [ ] **Amend DQ-2 and §8.2 to include Bindings.** DQ-2 requires the deletion poll only for "every
      chain root and every patch they cache". If a Binding's retraction now revokes admission, a
      client following DQ-2 literally never learns of it and shows a de-admitted endpoint
      indefinitely. **A3 is unimplementable without this.**
- [ ] **Amend TR-4, TR-5 and §6.4.** TR-4 states admission unconditionally ("When a Binding is
      admitted, both of its endpoints … are admitted"). Amending DEL-5 alone leaves two rules with
      opposite readings — the exact ambiguity A3 exists to remove. Add "…for as long as the Binding
      is not retracted (§10, DEL-5)".
- [ ] **Define what happens to a de-admitted endpoint's overlays.** Concrete case: the user trusts
      `auditor_pk` directly and reaches Product P only via a researcher's Binding B. The auditor
      publishes an overlay on P's chain. B is deleted. The overlay is still admitted under TR-2 and
      OV-7, but its target's chain has left the view — and the spec has no state for
      "admitted-but-not-visible target". This is also where DEL-4's *"MUST NOT silently drop
      annotations"* bites. Pick a behaviour; do not leave it to implementations.

## 🟡 A2 — small fixes, ship first

- [ ] **Re-tag TR-7 as D.** The brief's own justification — "tagged A because the *failure mode* is
      an A-layer failure" — is the precise reasoning §6.0 forbids ("partitioned by **subject**, not
      by normative strength"). TR-7's subject is when a D-layer visibility gate may be applied, and
      all its §6.2 siblings are D.
- [ ] **Amend §7.4 step 5**, which currently says "For each foreign patch admitted under §6,
      classify…" — trust before classification, exactly what TR-7 forbids.
- [ ] **Amend §7.5's duplicate sentence** ("untrusted events are filtered out before any other
      processing occurs"). A2 replaces only the §6.2 copy.
- [ ] **Extend §6.0's enumeration** from `TR-2..TR-6` to include TR-7.

## 🟡 A6 — two additions; the V tag is right, the placement isn't

- [ ] **Amend §3.2's inherited-semantics table**, which assigns signature verification and event-id
      derivation to NIP-01 under a preamble requiring implementations to "defer to the base-layer
      specification rather than re-derive semantics". As written, a reader can cite §3.2 to argue
      SIG-1 is out of scope. §3.2's closing paragraph already provides the mechanism for a
      SCRUTINY-specific restriction.
- [ ] **Extend SIG-1 to kind 5 and kind 1040.** It currently says "before an event enters SCRUTINY
      processing", but kind 5 events are explicitly *not* SCRUTINY events (§3.2, §8.2) — so DEL-1's
      author-match check is worthless without verifying the kind 5 itself. **An unverified forged
      kind 5 deletes chain history and triggers DEL-2's cascade.** This is the most consequential
      practical hole in the brief.
- [ ] **Move it out of §6.2.** §6.2 is trust admission and every other rule there is D-layer. A
      V-layer precondition on all events belongs in §3 or a new §6.0 subsection.
- [ ] Sequence against A2 — both edit the head of §6.2.

## 🟡 A5 — determinism carve-out and a wording fix

- [ ] **Resolve the determinism conflict.** RC-2 defines canonical bytes as a function of root plus
      chain, OV-4 requires classification "deterministic across compliant clients", and §7.1 requires
      non-UI consumers to serve canonical bytes by event id. **Configurable ceilings mean two
      conformant clients produce different canonical bytes for the same event id.** State that a
      resource-limit abort produces a distinct "resource-limit exceeded" state — *not* HALT, which
      would be indistinguishable from a genuine patch failure — and that the resulting bytes MUST NOT
      be served or cached as canonical (RC-3).
- [ ] **Fix "may be refused by consumers."** Refusing to render a V-valid event is what TR-1 forbids.
      The correct framing is an **A-layer** outcome: abort application, preserve the event, emit an
      annotation. So RL-2/RL-3 as A is right; only the prose is loose. Note H2 is scoped narrowly to
      "an invalid patch" and does not cover an oversized Product `content` — widen H2 or add a new
      annotation kind.
- [ ] **Sequence against A6.** SIG-1 is V and requires hashing the whole event, so it runs *before*
      any A-layer ceiling — meaning a 10 MB event gets fully hashed before the size bound can reject
      it. State that the total-size bound is enforceable at ingest/transport before SIG-1, and that
      declining to verify an oversized event does not classify it V-invalid.
- [ ] **Correct the motivation's factual error:** it claims the spec "bounds `i` tags (IX-2) and
      nothing else". PR-2, PR-3, MD-2 and MD-3 also bound `i` and `k` tags, and §4.6 bounds payload
      size operationally. Also: the proposed ≤1000 tags/event is unreachable given the ≤64 `i` +
      ≤64 `k` ceilings — either drop it or justify it differently.

## 🟡 A7, A8, A11 — normative-statement hygiene

All three violate the brief's own Ground Rule 3 (every MUST/SHOULD/MAY gets an ID and an Appendix F
row) and its own verification checklist.

- [ ] **A7** has four normative statements inside a section labelled non-normative (SHOULD use these
      `d` values · SHOULD support private entries · SHOULD NOT publish public entries by default ·
      MUST NOT store credentials unencrypted). Either de-normativise all four and move it to an
      appendix — which also avoids a non-normative subsection sitting among §6's rule tables — or
      register all four. Either way, **add NIP-51, NIP-78 and NIP-44 to §3.1's dependency table**,
      and update §11, which already lists "Vendor identity discovery. NIP-51 list events".
- [ ] **A8** promises "SHA-256 digests are pinned below" but the inserted table has only `File` and
      `Shape` columns — the SHOULD is unsatisfiable as drafted. Add the digest column. Also three
      unregistered SHOULDs, and `serialization.json` depends on A6 landing.
- [ ] **A11** adds "Publishers MUST NOT backdate `created_at`" with no rule ID, no layer and no
      Appendix F row — the only amendment adding a bare MUST. Register it (D layer; the
      justification is relay policy). Place it in the **§4 preamble** rather than duplicating a note
      across §4.1 and §4.2. Reword §7.5's *"Publishers MAY lie about `created_at`"* to "cannot be
      prevented from setting an arbitrary `created_at`" so the two do not read as contradictory.

## 🟢 A1, A9, A10, A12 — proceed, with nits

- [ ] **A1:** the checklist item "No occurrence of `scrutiny-v059` remains" **is wrong and would
      corrupt the changelog** — the v0.5.9 entry legitimately contains "`scrutiny-v058` →
      `scrutiny-v059`", and the new v0.6.0 entry must contain "`scrutiny-v059` → `scrutiny-v060`".
      Restrict it to §3, the §4 examples, and Appendix D. Two further collateral edits: Appendix B's
      "NOT borrowed" list says **merges (planned for v060)** — false once v0.6.0 ships without them;
      and §3's forward-compatibility prose uses "a v0.5.9 implementation encountering
      `scrutiny-v060`" as its higher-version example, which goes stale.
- [ ] **A9:** the id is a hash over the full NIP-01 canonical serialization, not "over its own tags";
      the argument should be that the id *commits to* the `e` tags. Also contains a SHOULD inside a
      paragraph labelled non-normative, and forward-references §3.4 (so it depends on A5's final
      placement).
- [ ] **A10:** mark it "**Note (non-normative).**" to match §4.6's and A9's style; lowercase "should
      note" in a normative section is the ambiguity Ground Rule 3 exists to prevent.
- [ ] **A12:** make the two path prefixes in Appendix E consistent — it cites the directory as
      `scrutiny-fabric-tools/investigations/diff-parity/` but the report as bare
      `investigations/diff-parity/REPORT.md`.

---

# Additional amendments — pre-existing spec defects

Found by the rule-registry extractor (`tools/extract-rules.mjs`), **not caused by the proposed
amendments**. These exist in v0.5.9 today. Fold them into the brief as new amendments during A0.

The extractor validated the registry itself as **completely clean** — 123 rules, 47 V / 50 A / 25 D /
1 reserved, and zero mismatches between the 20 per-section rule tables and Appendix F on IDs, layers,
`inheritsFrom`, sections, duplicates, or ID format. v0.5.9's cleanup was done properly. What follows
is normative language that never reached a rule table, and drift between prose and registry.

## 🔴 A13 — §9 contradicts PR-4 / MD-4 on `k` tags (implementation-blocking)

Confirmed by quotation:

- **§9:902** — "The event **SHOULD** carry at least one `k` tag for each distinct prefix kind present
  in its `i` tags."
- **PR-4 / MD-4**, layer **V** — "The `k` collection **MUST** contain at minimum one entry per
  distinct `i` prefix kind present in the event."

Same proposition, different RFC 2119 keyword. Because PR-4/MD-4 are **V**, this decides whether an
event with an `i` tag and no matching `k` tag is **admissible or rejected**. An implementation cannot
be written until it is resolved.

- [ ] Decide MUST or SHOULD, and make §9 and PR-4/MD-4 agree. If MUST stays, §9's sentence must say
      MUST and cite PR-4/MD-4.

## 🔴 A14 — §5.2's consumer grammar contradicts N2, and is invalid ABNF

**§5.2:495** — `patch-payload = [ index-preamble ] [ diff-git-line ] header-block [ hunk-block ]+`

Two defects:

1. `[ x ]+` is not valid ABNF — ABNF uses prefix repetition (`*x`, `1*x`); postfix `+` is regex/EBNF.
2. Read as "one or more", it **contradicts N2**, which declares a header-only block with **zero
   hunks** a valid no-op that "Consumers MUST NOT reject as malformed."

The grammar block carries a "conforming consumer MUST accept" obligation (§5.2:492) with no rule ID,
so nothing in the registry constrains it.

- [ ] Change to `*hunk-block`, and register the grammar's MUST-accept obligation as a rule.

## 🟡 A15 — twelve unregistered normative statements

Genuinely normative, no rule ID. Register each or explicitly de-normativise.

| § | Statement |
|---|---|
| 3.1 | Publishers SHOULD inspect NIP-11 `min_pow_difficulty` before publishing (no PoW rule exists at all) |
| 3.2 | "implementations MUST defer to the base-layer specification rather than re-derive semantics" — **§3.2 has no rule table whatsoever** |
| 4.3 | Third parties who believe a Binding is wrong SHOULD publish a competing Binding — the *only* stated dispute mechanism for edges |
| 4.3 | Implementations MAY surface long-pending Bindings in audit views |
| 4.6 | imeta is RECOMMENDED for SBOMs, CSAF, in-toto/SLSA, signed PDFs, reports — no IM rule says *when* to use imeta |
| 5.2 | "Producers SHOULD emit payloads conforming to the consumer grammar" — the umbrella obligation P1–P4 never state |
| 7.3 | Conflict row: default rendering SHOULD show target-time / proposed / current side-by-side (OV-5 only requires *exposing* the classification) |
| 7.5 | Implementations SHOULD query multiple relays and cross-reference — the protocol's stated defence against relay malice, in a section with no rule table |
| 7.5 | Implementations SHOULD warn when trust-radius expansion admits many unseen pubkeys — the only stated Sybil mitigation |
| 8.0 | Clients SHOULD check NIP-11 before relying on NIP-50 search (DQ-3 covers verifying *results*, not the capability pre-check) |
| 9 | The `k`-tag SHOULD — see A13 |
| 10 | Default mode SHOULD treat a retracted root as absent; audit mode SHOULD surface full history |

- [ ] Register or de-normativise each. Note §3.2, §7.5, §8.0, §8.1 and §8.2 have **no rule table at
      all** while carrying normative directives.

## 🟡 A16 — four registry entries weaken their prose

The registry is the conformance-test surface, so an obligation lost there is lost in practice.

| Rule | Prose says | Registry says |
|---|---|---|
| SF-5 | "The root author **MUST** emit a NIP-09 kind 5 deletion targeting any patch in one of the forked branches" | "the root author emits…" — MUST dropped |
| RC-2 | "overlays … **MUST NOT** be folded into the canonical answer" | "Foreign overlays are NOT part of canonical bytes" — imperative lost |
| OV-8 | "The root author who wishes to incorporate a foreign change **MUST** emit their own patch … replying to a canonical parent" | only the "is ignored for chain construction" half registered |
| §9 vs PR-4 | see A13 | |

- [ ] Restore the normative keyword in each registry entry.

## 🟢 A17 — §6.0's layer manifest is wrong in one place and incomplete

- [ ] **§6.0's V bullet cites "§5.2 E\*"**, which sweeps in **E7 — tagged A** in the rule tables and
      separately (correctly) listed in the A bullet. Change to `E1–E6`.
- [ ] §6.0 cites 14 of 47 V rules and 45 of 50 A rules (OTS-1, PT-5, PT-6, PT-8, PT-9 absent), and
      **TR-1 and IR-4 appear in no bullet at all**. Not a contradiction, but §6.0 cannot serve as the
      layer index — only the tables can. Either complete it or say explicitly that it is illustrative.
- [ ] **Appendix F section skew:** TR-1…TR-6 are cited as `§6` though the table is under §6.4;
      DQ-1…DQ-4 as `§8` though the table is under §8.3. Every other prefix cites its exact defining
      subsection, so the `§` column is not a reliable deep-link target. Normalise or document.

## 🟢 A18 — ID grammar is split

Two incompatible grammars coexist: `PREFIX-N` (18 prefixes) everywhere, and bare `LETTER+N` (`E`, `N`,
`C`, `P`, `T`, `H`) confined to §5.2/§5.3. A new bare-form rule is indistinguishable from a typo.

- [ ] Either keep the bare form strictly within §5.2/§5.3, or normalise everything to `PREFIX-N` while
      the version is bumping anyway. Note normalising renames rules, which breaks citation stability —
      probably not worth it.

## Guard rails for the editing session

`tools/extract-rules.mjs` is a CI gate: it exits non-zero on any registry inconsistency, and was
validated by mutation testing (layer flips, deleted rows, malformed and duplicate IDs, section moves).
**Run it after every amendment.** It also cross-checks §6.0's prose against the tables, so a re-tag
applied to the tables but not to §6.0 is caught — a live risk given the BD-6/BD-7 re-tag under
discussion.

Two brittleness warnings for whoever edits:

- Body rule tables are found by exact header match on `| # | Layer | Inherits from | Rule |`.
  **Adding or renaming a column silently yields zero rows** and 123 spurious errors. Don't change the
  table header.
- Cells split on raw `|`. No rule currently contains a pipe; if a new rule needs one (a regex
  alternation, say), escape it as `\|` in the spec.

---

## 🟡 Cross-cutting — terminology

- [ ] The spec already overloads **"admitted"** in two senses: V-admissibility (§3, BD-5 "MUST NOT be
      admitted") and trust admission to a user's view (TR-2..TR-6). A4 adds a third ("admitted to
      local storage") and then uses bare "admitted" as a resolution terminal state. A3 depends on the
      distinction being crisp. Use "V-admitted" / "stored" / "admitted to the user's view" explicitly,
      and define both existing senses in Appendix C, which currently defines neither.
