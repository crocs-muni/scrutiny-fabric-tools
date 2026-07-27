# `resolve` — canonical chain, self-fork, HALT, overlays

Phase 3 mini-spec. Written before any code, as Phase 2 was, because the ordering hazards here are
not visible from the rule list.

Governing text: §5.3 (application and HALT), §7.1–§7.4 (chain, self-fork, overlays), §7.6
(unresolved references and confluence), §10 (kind 5). Rules owned: CHN-1…3, RC-1/2, SF-1…6, H1/H2,
OV-2/3/4/6/8, DEL-1/2/3/6/7, PT-5/6/8/9, IX-3, BD-9.

---

## 0. Scope and shape

`resolve` answers one question: **given the events I have observed, what does this Product or
Metadata currently say, and what is anchored to it?**

It reads no trust state (D25). This is not a simplification — trust-filtering before chain
construction silently masks self-forks and HALT, because a root admitted only via a trusted Binding
may carry patches by an untrusted pubkey, yielding a chain that renders linear and complete when it
is neither. TR-7 makes trust a presentation-time filter over these results. `admit` (Phase 4) and
`store` (Phase 5) apply it; nothing here may.

```ts
resolve(rootId: string, events: readonly NostrEvent[], options?: ResolveOptions): Resolution
```

The parameter is an **array**, not a `Set`, even though it models a set. That is deliberate: the
Phase 3 gate's central property is that permuting it changes nothing, and a signature that accepts
an ordered thing is what makes that property expressible. An API taking a `Set` would hide the
hazard rather than remove it — `Set` has an iteration order too, and it is insertion order.

`Resolution` is **plain data**, with no methods and no closures. The confluence property compares
two resolutions with deep equality, and a function-valued property would compare by reference and
fail. The per-position content cache (§5) is therefore internal to a single `resolve` call and
never escapes in the result.

---

## 1. Partitioning the observed set

One pass, building:

| bucket | predicate |
|---|---|
| `root` | `id === rootId` |
| `patches` | `scrutinyEventType(e) === 'patch'` and its `e root` is `rootId` |
| `deletions` | `kind === 5` |
| — | everything else is ignored |

Two rules land here before anything else runs.

**BD-9 — a Binding is not a patchable root.** If the located root is a Binding, there is no chain to
build; a patch-based Binding update is not a thing, and the correction path is kind 5 plus a
replacement event. `resolve` returns an empty resolution naming the reason rather than constructing
a chain over an event type that has no `content` to patch.

**UR-2 — a patch whose root is unobserved is held, not discarded.** If `rootId` names no observed
event, every patch referencing it is `pending`, and the resolution carries them by id. §7.6 is
explicit that discarding a referencing event whose target has not arrived *violates confluence*,
because the same event set then yields different state depending on delivery order. Note that a
patch's root being unobserved is the one case where its authorship class (PT-5) cannot be computed
at all — root-author versus foreign needs the root's `pubkey` — and UR-3 forbids caching that
non-answer.

---

## 2. The kind 5 cascade

Three filters, in this order, then a fixed point.

**DEL-1 — pubkey match.** A deletion is honoured only when its `pubkey` equals the target event's
`pubkey`. A deletion whose target is not observed is *retained and applied if the target later
arrives* (DEL-8) — in a pure function over an observed set that is automatic, since honouring is
just a membership-and-pubkey test evaluated fresh each call. There is nothing stateful to get wrong,
which is the payoff of `resolve` being pure.

**DEL-6 — kind 5 cannot delete kind 5.** A deletion targeting another deletion has no effect. Not a
degenerate case worth skipping: it is the shape an attacker reaches for to "undelete" a retraction,
and NIP-09 defines no reversal.

**DEL-2 / CHN-2 — topology cascade.** Deleting a root-author patch removes it *and every canonical
descendant* — every root-author patch replying to it transitively. Computed as a fixed point over
the parent→children relation, which is order-independent by construction: the transitive closure of
a relation does not depend on the order edges were inserted.

Content reverts to the last surviving ancestor. This is also SF-5's resolution mechanism: deleting
any patch in one branch of a fork eliminates that branch entirely, and the chain resolves.

Foreign patches are deleted by their own author only (DEL-3), and their deletion never touches
canonical bytes, because overlays were never part of them (RC-2).

---

## 3. Walking the chain — and where SF-4 actually lives

Surviving root-author patches (PT-5: `pubkey === root.pubkey`) form a parent→children map keyed by
`e reply`. Two exclusions apply while building it:

- **PT-6 / OV-8** — a root-author patch whose `e reply` points at a *foreign* patch is not a chain
  extension and is ignored for canonical-chain construction. It is not invalid; it simply is not a
  link.
- **CHN-3** — foreign patches never enter the chain at all. They are §6's problem.

Then walk forward from the root:

```
position ← root
loop:
  kids ← children[position]          // surviving root-author patches replying to `position`
  if |kids| = 0 → chain ends here
  if |kids| ≥ 2 → SELF-FORK at `position` (SF-1); stop the walk
  if |kids| = 1 → append, position ← that child
```

**The `|kids| ≥ 2` branch is the whole of SF-4.** The rule forbids picking a branch by `created_at`,
by event ID, or by any heuristic — and the way an implementation violates it is not by writing a
heuristic on purpose. It is by writing `kids[0]`. That single expression is a heuristic: it picks by
whichever event the input array happened to mention first, or by whatever order a `Map` bucket
accumulated. It would even be *confluent* if the array were pre-sorted by id, and still wrong.

The discipline, stated so it can be reviewed: **branch on `kids.length`; never index into `kids`
when `length > 1`.** The forked variant of the result type carries no tip precisely so that "read
the tip of a forked chain" cannot be written at all.

Sorting the two branch ids when *reporting* the fork (SF-3) is not a violation — reporting order is
presentation, and a deterministic report is required for the confluence property to compare equal.
Selection is forbidden; ordering an error message is not. The distinction is worth stating because
the same `sort()` call is correct in one place and a conformance failure in the other.

**SF-6 — multiple forks.** The walk stops at the first fork reached from the root, which is by
construction the earliest, and §7.2 freezes content there. Forks deeper in the topology are not on
the canonical chain and are not reported: they are unreachable, and surfacing them would imply the
chain extends past a point where it is undefined.

---

## 4. Two freeze conditions, and which one wins

§5.3 step 5 says a self-fork "applies before HALT", and that if the chain is forked, canonical bytes
freeze at the shared parent "regardless of whether the per-patch pre-validation would have failed."

Read literally that is a precedence rule, and it is wrong in one direction. Consider a chain
`root → p1 → p2` where `p2` has two children (a fork at `p2`), and `p1` fails pre-validation:

- HALT (H1) freezes at the root state — `p1` never applied.
- The fork freezes at `p2`.
- Honouring the fork's freeze point would require applying `p1` and `p2` **past a HALT**, which H1
  forbids outright: "no later patches are applied, even if they might themselves be individually
  valid."

The two rules give different answers and the spec asserts one has priority without bounding it to
the case where the fork is upstream. Recorded as **SPEC-FEEDBACK F10**.

Implementation, and the reasoning to review:

> **Content freezes at the earlier of the two points. The status names the earlier cause. Every
> condition found is surfaced as an annotation regardless of which one froze the chain.**

This satisfies both rules where they agree and satisfies H1 where they conflict, on the grounds that
H1's "no later patches are applied" is an unconditional prohibition while §5.3's precedence sentence
is about which condition to *report* when both are live. It also means the two cases are asymmetric
in a way worth knowing:

- **Fork upstream of any halt** — the walk stops at the fork parent, so patches beyond it are never
  applied and no downstream HALT is ever discovered. Status `forked`. This matches the spec exactly.
- **Halt upstream of the fork** — application stops at the halt; the fork is still real and still
  reported (SF-3 is a MUST), but it did not determine the content. Status `halted`.

**Implementation note, sharper than the above.** Once written out, the two cases collapse: the walk
*stops at* the fork, so every patch that could halt is at or before the fork parent. A fork is
therefore structurally never upstream of a halt within one resolution, and **a halt always wins when
both are live** — there is no comparison to perform. The freeze-at-the-earlier-point rule is still
the right way to state the intent, but the code needs no arithmetic to implement it.

---

## 5. Applying the chain

§5.3 steps 2–7, over the linear chain from §3:

```
content ← root.content                    // step 2
for each patch in chain order:
    if patch is a no-op (N1/N2) → record the link, content unchanged   // PT-8
    result ← applyPatchContent(content, patch.content)                 // step 3, patch.ts
    if result is halt  → HALT here (H1); freeze at previous content
    if result is limit → NOT a halt (RL-3/§5.4); see below
    content ← result.content
```

**PT-8 — no-op patches participate in topology but change nothing.** A prose-only or header-only
patch is a valid chain link. `patch.ts` already returns a `noop` variant for both shapes, so this
needs no special case here beyond not treating it as a failure.

**A resource limit is not a HALT.** `patch.ts` distinguishes them structurally, and that distinction
must survive into the resolution: a ceiling leaves the event valid and is a `limit` annotation, not
an H1. RL-4 forbids caching abandoned content, and since the `limit` variant carries no content
there is nothing to cache — the property is preserved by never reaching for a field that does not
exist.

**H2 — the protocol error annotation** needs the event id, the author, and the failure reason.
`patch.ts` deliberately does not carry the first two (they never reach that module); `resolve`
assembles them from the halting patch event plus the halt's `reason`/`detail`. This is the caller
Phase 2 deferred two type decisions for, and this is where they get made:

> Hoist `issues` onto all four `ApplyResult` variants (empty on success) and surface the cited rule
> on `PatchHalt`. Right now a consumer must switch on `status` purely to learn whether the field
> exists, and must re-scan the issue list for the non-H1 entry to learn which rule fired. Both were
> left alone in Phase 2 as speculative; `resolve` is the real caller that makes them concrete.

**Per-position content, and why D28's LRU is not needed here.** OV-2 needs the canonical bytes *at
each overlay's target position*, not just at the tip. Materialising every position eagerly measured
216 MB at sec-certs scale against ~25 MB lazily, which is what D28 responds to with a byte-bounded
LRU.

Within a single `resolve` pass there is a strictly better answer than caching: **classify each
overlay at the moment its target's content is live.** The chain walk already visits every position
in sequence, so when content-at-N is in hand, every overlay anchored to N is classified right there
and the content is then discarded with the loop variable. Nothing beyond the running content is ever
retained — O(1) rather than O(bounded), with no eviction policy, no replay-on-miss, and no cache to
get wrong.

The one thing the interleaved pass cannot know yet is *clean versus stale*, since that depends on
the final tip. So the walk records only whether each overlay applied, and the clean/stale split is
decided at the end from `tipId`. Cross-call caching remains `store`'s concern in Phase 5, where
D24's epochs can invalidate it correctly; **D28 stands, but it describes a Phase 5 problem.**

---

## 6. Overlay classification

A foreign patch (PT-5: `pubkey ≠ root.pubkey`) is classified against its `e reply` target. OV-4
requires this be a pure function of `(overlay payload, target's resolved content)` and deterministic
across compliant clients.

```
target ← overlay's `e reply`

if target not in the observed set          → orphaned (β)      DEL-7
if target is not a chain position          → orphaned          OV-3
   (deleted, cascaded away, at-or-after the
    halt point, or at-or-after a fork parent)
else:
   base   ← resolved content at target's position               OV-2
   result ← applyPatchContent(base, overlay.content)
   if result does not apply                → conflict
   else if target is the canonical tip     → clean
   else                                    → stale
```

**OV-3 is the rule most likely to be got wrong**, because the tempting implementation classifies
against the *tip* and calls anything that fails a conflict. Three distinct situations must all
produce `orphaned`, not `conflict`: a target downstream of a HALT, a target inside an unresolved
self-fork, and a target that is itself a fork sibling. None of them has a defined resolved content,
and `conflict` would assert the overlay was evaluated against bytes that do not exist.

**Clean versus stale turns on tip-ness, not on applicability.** Both apply cleanly; `stale` means
the canonical chain has advanced past the target since the overlay was signed. An implementation
that collapses them loses the only signal a UI has for "this annotation addressed an older
revision."

**α/β (DEL-7).** α is "target obtainable, classify against the target's universe"; β is "target
unobtainable, render the payload standalone." In a pure function over an observed set, *obtainable*
means *present in `events`* — there is no fetching here. A deleted-but-observed target is α: §10
keeps deleted events for audit, and the classification is computed in the target's universe
independent of the live chain. An unobserved target is β. The overlay is **never re-anchored** to
the target's parent or to the tip; DEL-7 says so explicitly, and re-anchoring is the intuitive wrong
answer.

**Trust does not appear here.** OV-7 gates *visibility*, at presentation time, over these results
(TR-7). Classifying only trusted overlays would make the result depend on the trust set, which D25
forbids and which would make the confluence property meaningless.

---

## 7. Where arrival order could leak, and what stops it

The confluence gate (UR-1) is not satisfied by `resolve` being a pure function. Pure functions of an
*array* can and do depend on element order. Every place it could leak, and the defence:

| leak | defence |
|---|---|
| `kids[0]` when a parent has several children | branch on `length`; the forked variant has no tip (§3) |
| `Map`/`Set` iteration order reaching the output | every output list is sorted by a total, content-derived key before it is returned |
| a fold that is not commutative | the cascade is a fixed point; the chain walk is determined by the parent relation, not by traversal order |
| first-writer-wins on a duplicate key | duplicate ids cannot occur in a set of signed events; a repeated id in the input array is deduplicated by id before anything reads it |
| a patch dropped because its root had not been seen | UR-2: retained in `pending`, never discarded (§1) |
| a deletion dropped because its target had not been seen | DEL-8: honoured by re-evaluation, which purity gives for free (§2) |
| `created_at` used as a tiebreaker anywhere | it is read for *reporting* only; SF-4 and §7.2's closing note make it non-normative — NIP-03 timestamps are audit evidence, not a tiebreaker |

The last row deserves emphasis: `created_at` is attacker-controlled (§7.5 — signing proves identity,
not time), so any use of it as a tiebreaker is both a conformance failure and a vulnerability.

---

## 8. Result type

```ts
type ChainState =
  | { status: 'resolved'; content: string; tipId: string | null; applied: readonly string[] }
  | { status: 'halted';   content: string; tipId: string | null; applied: readonly string[]
                        ; haltedAt: string; reason: HaltReason }
  | { status: 'forked';   content: string; forkParentId: string
                        ; branchIds: readonly string[] }        // no tipId — SF-1, structurally
  | { status: 'aborted';  content: string; tipId: string | null; applied: readonly string[]
                        ; abortedAt: string; limit: LimitKind } // RL-3 — see below
  | { status: 'absent';   reason: 'root-unobserved' | 'root-not-patchable' }

type OverlayState = 'clean' | 'conflict' | 'stale' | 'orphaned' | 'unclassified'

interface Overlay {
  readonly id: string
  readonly author: string
  readonly targetId: string
  readonly state: OverlayState
  readonly degradation?: 'alpha' | 'beta'    // orphaned only (DEL-7)
}

interface Resolution {
  readonly chain: ChainState
  readonly overlays: readonly Overlay[]      // sorted by (targetId, id)
  readonly pending: readonly string[]        // UR-2, sorted
  readonly annotations: readonly Annotation[] // H2 errors, SF-3 fork reports, RL-3 limits
}
```

`tipId` is `null`, not absent, when the chain resolves with zero patches — the tip is genuinely the
root. `forked` has no `tipId` field at all, which is a different statement: not "the tip is nothing"
but "asking is a category error." Same technique as Phase 2's halt variant carrying no `content`.

**Two variants the spec does not provide, both forced by §5.4 and recorded as SPEC-FEEDBACK F11.** A
resource ceiling can be hit while applying the chain and while classifying an overlay, and §5.4
insists it be surfaced as something distinct and *never* as a HALT — but neither §7.4's chain
procedure nor §7.3's four-state overlay table has a slot for it.

- `aborted` is not `resolved`, because patches remain that were deliberately not applied and naming
  the last applied patch the tip would claim a completeness we do not have — which RC-3 obliges
  non-UI consumers to serve on. And it is not `halted`, because §5.4 forbids exactly that.
- `unclassified` is not one of §7.3's four. A ceiling is not a `conflict` (the overlay may well
  apply, and saying otherwise is a false statement about its author), and not `orphaned` (the target
  is perfectly well defined, and `orphaned` would wrongly trigger the α/β rule).

Both carry the distinct RL-3 annotation §5.4 requires, and neither ever cites H1.

---

## 9. Rules that emit nothing, and why

Recorded here so the Phase 3 coverage partition (G4) has its reasons written before the code exists,
rather than reverse-engineered from whatever the tests happened to produce (D34).

| rule | why no code is emitted |
|---|---|
| RC-1, CHN-1, PT-5 | Definitions of the walk, not constraints that can fail. Covered behaviourally. |
| RC-2 | A prohibition on the implementation: overlays are never folded into canonical bytes. An implementation that obeys it emits nothing; one that violates it silently returns wrong content. Covered by asserting an overlay never changes `chain.content`. |
| RC-3, RC-4 | Recomputation obligations on the *consumer*, not on this function. `resolve` is pure, so recomputation is the caller calling again. |
| PT-6, OV-8, CHN-3 | Exclusions. A patch that is not a chain link is simply not in the chain; there is no rejection to report. |
| PT-8 | A permission: no-ops are valid links. Failure mode is treating one as an error, so it is covered positively. |
| PT-9 | Append-only is a producer obligation, unenforceable on receipt: an inserted patch is indistinguishable from a legitimately-published one. Same shape as P1 (F1). |
| IX-3 | `i`/`k` tags on roots are immutable. Structurally satisfied — patches carry a content diff and `resolve` never touches tags. |
| DEL-6 | "No effect" — the correct behaviour is to emit nothing and change nothing. Covered positively. |
| OV-6 | Rebase preview is explicitly outside the normative surface and is not implemented. |

Emitting rules — the whole of the partition's positive half: **H1**, **SF-3**, and **RL-3** passed
through from `patch.ts`. Three of thirty-two.

This list originally also named H2, OV-3 and DEL-7, drafted before the code existed. All three turned
out to have no code to emit, and the coverage gate caught the claim rather than the prose being
quietly right:

- **OV-3** and **DEL-7** express their outcome as a *state on the overlay* — `state: 'orphaned'` and
  `degradation: 'alpha' | 'beta'`. That is the stronger form. A caller reading the classification
  cannot miss it, whereas an annotation can go unread.
- **H2** requires an invalid patch be *surfaced* with its event id, author and reason. That is the
  shape of the annotation, not a code inside it; the issues it carries cite H1 and the specific
  determinism rule.

Listing them as emitting and then finding they were not is exactly what D34 is for: coverage is
measured by observed emission, never by intent — including the author's.

---

## 10. The gate

Defined in `IMPLEMENTATION-PLAN.md` under Phase 3; restated here as the acceptance criteria.

**G1 — confluence (UR-1).** `resolve(rootId, π(E)) ≡ resolve(rootId, E)` for any permutation π,
≥10 000 `fast-check` cases, deep equality.

**G2 — branch choice is not a heuristic (SF-4).** Build a self-fork, swap `created_at`, ids, tag
order and pubkey ordering between the competing patches, and assert the verdict never moves: still
`forked`, still deep-equal. G1 cannot catch a `(created_at, id)` tiebreaker — such an implementation
is perfectly confluent — which is why this property is separate.

**G3 — a forked chain exposes no tip.** `expect(chain).not.toHaveProperty('tipId')`, asserted at
runtime because the type is gone by then.

**G4 — rule-coverage partition** over the rules listed at the top, reusing `test/_coverage.ts`, with
§9 as the starting draft of the not-covered half.

**Generator bias, and floors under it.** Phase 2's lesson was that a property is only as good as its
bias — the round trip nominally covered T1 while barely reaching its rejecting branch, and needed a
second generator plus a floor assertion. The analogue: bias toward `created_at` ties, deletions
arriving before their targets, dangling `e root`/`e reply`, self-forks, overlays on every chain
position, and chains already frozen by a HALT — then log the outcome mix and assert a floor under
`forked`, `halted`, `orphaned` and `stale`, so no branch can quietly stop being exercised.

Every counterexample becomes a permanent regression case shaped to convert verbatim into a
conformance vector, as `test/patch-regressions.ts` is.
