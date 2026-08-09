/**
 * §7 chain resolution — canonical chain, kind 5 cascade, self-fork, HALT, and overlay classification.
 *
 * **Reads no trust state (D25).** Trust-filtering before chain construction silently masks
 * self-forks and HALT, because a root admitted only via a trusted Binding may carry patches by an
 * untrusted pubkey — yielding a chain that renders linear and complete when it is neither. TR-7
 * makes trust a presentation-time filter over these results; `admit` applies it, nothing here.
 *
 * The design, including where arrival order could leak and what stops it, is in `docs/RESOLVE.md`.
 */

import { type Issue, issue } from './errors.js'
import {
  DELETION_KIND,
  type NostrEvent,
  dedupeById,
  eTags,
  eTagsWithMarker,
  replyTarget,
  rootTarget,
  scrutinyEventType,
} from './events.js'
import type { ApplyOptions, HaltReason, LimitKind } from './patch-types.js'
import { applyPatchContent } from './patch.js'

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The canonical chain's state.
 *
 * `forked` carries no `tipId` — not "the tip is nothing" but "asking is a category error", since
 * SF-1 makes the chain undefined while a fork is unresolved. Same technique as `PatchHalt` carrying
 * no content: the wrong question cannot be typed.
 *
 * `tipId` is always a concrete event id, never `null` (RC-5, spec v0.6.1): "the tip is the last
 * event in the canonical chain... the root event itself where it carries none." An earlier
 * revision of this type used `null` as a sentinel for "the root is the tip," which is what
 * produced the RC-5 bug fixed in fix/spec-v061-drift — an overlay anchored to a never-patched
 * root compared its target id against `null` and always lost, misclassifying `stale` instead of
 * `clean`. The vendored `chain/root-only` and `chain/foreign-patch-never-enters-the-chain` vectors
 * both pin `tipId` to the root's own id for exactly this shape.
 */
export type ChainState =
  | {
      readonly status: 'resolved'
      /** The last applied patch, or the root event's own id where the chain carries none (RC-5). */
      readonly tipId: string
      readonly content: string
      readonly applied: readonly string[]
    }
  | {
      readonly status: 'halted'
      readonly content: string
      /** As `resolved`'s — the last successfully applied patch, or the root (RC-5). */
      readonly tipId: string
      readonly applied: readonly string[]
      /** The patch that failed pre-validation (H1). */
      readonly haltedAt: string
      readonly reason: HaltReason
    }
  | {
      readonly status: 'forked'
      /** Frozen at the shared parent of the competing patches (SF-2). */
      readonly content: string
      readonly forkParentId: string
      readonly branchIds: readonly string[]
    }
  | {
      /**
       * A ceiling stopped application before a verdict was reached (RL-3, RL-5).
       *
       * Distinct from `halted` because §5.4 forbids surfacing a resource limit as a HALT, and
       * distinct from `resolved` because patches remain that were deliberately not applied.
       *
       * `tipId` still carries the last *successfully applied* patch, exactly as it does on
       * `halted` — it is the last position with defined content, which overlay classification
       * needs (RC-5). The incompleteness is carried by `status`, not by the field.
       */
      readonly status: 'aborted'
      readonly content: string
      readonly tipId: string
      readonly applied: readonly string[]
      readonly abortedAt: string
      readonly limit: LimitKind
    }
  | {
      readonly status: 'absent'
      readonly reason: 'root-unobserved' | 'root-not-patchable'
    }

/**
 * §7.3's four overlay states, plus one this implementation had to add.
 *
 * `unclassified` is **not** one of §7.3's original four. It exists because a ceiling is not a
 * conflict (the overlay may well apply), not clean, not stale, and not orphaned (the target is
 * perfectly well defined). Reported as SPEC-FEEDBACK F11 when §5.4's resource limit had no
 * disposition anywhere; **v0.6.1 closed F11 by naming this exact outcome as OV-9**, so the fifth
 * state is now normative rather than an implementation invention.
 */
export type OverlayState = 'clean' | 'conflict' | 'stale' | 'orphaned' | 'unclassified'

export interface Overlay {
  readonly id: string
  readonly author: string
  readonly targetId: string
  readonly state: OverlayState
  /** DEL-7, orphaned only: α when the target is observed, β when it is not. */
  readonly degradation?: 'alpha' | 'beta'
}

/** One competing patch in a self-fork. `createdAt` is reported (SF-3), never used to choose (SF-4). */
export interface ForkBranch {
  readonly id: string
  readonly author: string
  readonly createdAt: number
}

export type Annotation =
  | {
      /** H2 — an invalid patch, with the event id, author and reason H2 requires. */
      readonly kind: 'protocol-error'
      readonly eventId: string
      readonly author: string
      readonly reason: HaltReason
      readonly message: string
      readonly issues: readonly Issue[]
    }
  | {
      /** RL-3 — a ceiling was hit. Never a HALT. */
      readonly kind: 'resource-limit'
      readonly eventId: string
      readonly author: string
      readonly message: string
      readonly issues: readonly Issue[]
    }
  | {
      /** SF-3 — surfaced even when a HALT upstream is what actually froze the content. */
      readonly kind: 'self-fork'
      readonly parentId: string
      readonly branches: readonly ForkBranch[]
      readonly message: string
      readonly issues: readonly Issue[]
    }

/**
 * Plain data, with no methods and no closures.
 *
 * The confluence gate compares two resolutions with deep equality, and a function-valued property
 * would compare by reference and fail. Any per-position content the overlay pass needs is computed
 * during the chain walk and never escapes.
 */
export interface Resolution {
  readonly chain: ChainState
  /** Sorted by `(targetId, id)`. */
  readonly overlays: readonly Overlay[]
  /**
   * Patches retained pending an observation target — every patch when the root is unobserved
   * (UR-2, `chain.status` is `absent`), otherwise the root-author patches whose `e reply` parent
   * lineage reaches an unobserved event (UR-4, spec v0.8.0); re-evaluated on the target's arrival.
   * Sorted; excludes patches the root author already retracted.
   */
  readonly pending: readonly string[]
  readonly annotations: readonly Annotation[]
}

export interface ResolveOptions {
  /** Passed through to the applier for both chain patches and overlays (§5.4). */
  readonly apply?: ApplyOptions
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const byIdAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Honoured kind 5 deletions, as a set of deleted event ids.
 *
 * DEL-1 (pubkey must match the target's), DEL-6 (a kind 5 cannot delete a kind 5), and DEL-8 — a
 * deletion whose target is unobserved is simply not honoured *yet*. In a pure function over an
 * observed set that is automatic: honouring is a membership-and-pubkey test re-evaluated on every
 * call, so there is no stale cache to invalidate when the target finally arrives.
 */
function honouredDeletions(
  deletions: readonly NostrEvent[],
  byId: ReadonlyMap<string, NostrEvent>,
): Set<string> {
  const deleted = new Set<string>()
  for (const deletion of deletions) {
    for (const ref of eTags(deletion)) {
      const target = byId.get(ref.id)
      if (target === undefined) continue // DEL-8
      // Stryker disable next-line ConditionalExpression: even without this skip, honouring a
      // kind5-on-kind5 only adds a *deletion id* to `deleted` — and every reader of that set
      // compares it against patch ids (cascade, overlay skip, pending exclusion). A deletion id
      // can never equal a patch id (D18 content hash), so the skip is behaviourally inert; it
      // remains as the rule's own restatement. Full-suite verified (no test can observe it).
      if (target.kind === DELETION_KIND) continue // DEL-6
      if (target.pubkey !== deletion.pubkey) continue // DEL-1
      deleted.add(ref.id)
    }
  }
  return deleted
}

/**
 * DEL-2 / CHN-2 — a deleted root-author patch takes its canonical descendants with it.
 *
 * A fixed point over the parent relation, which is order-independent by construction: the
 * transitive closure of a relation does not depend on the order its edges were inserted.
 */
function cascade(candidates: readonly NostrEvent[], deleted: ReadonlySet<string>): Set<string> {
  const removed = new Set<string>(candidates.filter((p) => deleted.has(p.id)).map((p) => p.id))
  // Stryker disable next-line BooleanLiteral,ConditionalExpression: the fixed point's extra
  // rounds are unobservable — `removed` only feeds `surviving` → `children`, and the chain walk
  // prunes every descendant of a removed patch regardless (its surviving parent already cut the
  // route). First-order removal determines every result field the same way the full closure does.
  for (let changed = true; changed; ) {
    changed = false
    // Stryker disable next-line BlockStatement: emptying this loop leaves the first-order set,
    // which the comment on the loop above shows is all the result ever observes.
    for (const patch of candidates) {
      // Stryker disable next-line ConditionalExpression: same unobservability as the loop-level
      // mutants — processing or skipping an already-removed patch cannot change any output.
      if (removed.has(patch.id)) continue
      const parent = replyTarget(patch)
      // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: skip,
      // flip, or empty the propagation arm — every variant only changes the contents of
      // `removed`, whose only consumer (`surviving` → the children map the walk prunes equally)
      // the loop-level comment above shows is unobservable.
      if (parent !== undefined && removed.has(parent)) {
        removed.add(patch.id)
        // Stryker disable next-line BooleanLiteral: provably killed by the current suite — the
        // S5-11 adversarial edge-order cascade pin fails when hand-applied — yet the vitest
        // runner never ran its covering tests per-mutant (stryker-js #6073-class; audit §4).
        changed = true
      }
    }
  }
  return removed
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/**
 * Resolve a Product or Metadata against the observed event set.
 *
 * `events` is an **array**, not a `Set`, although it models one. That is deliberate: UR-1 requires
 * the result depend only on the set of events observed and never on arrival order, and a signature
 * accepting an ordered thing is what makes that property expressible. A `Set` parameter would hide
 * the hazard rather than remove it — `Set` iterates in insertion order too.
 */
export function resolve(
  rootId: string,
  events: readonly NostrEvent[],
  options: ResolveOptions = {},
): Resolution {
  const byId = dedupeById(events)

  const patches: NostrEvent[] = []
  const deletions: NostrEvent[] = []
  for (const event of byId.values()) {
    if (event.kind === DELETION_KIND) deletions.push(event)
    else if (scrutinyEventType(event) === 'patch' && rootTarget(event) === rootId) {
      patches.push(event)
    }
  }

  const root = byId.get(rootId)

  // UR-2: a patch whose root is unobserved cannot be classified at all — root-author versus foreign
  // needs the root's pubkey — so it is retained, never discarded. §7.6 is explicit that discarding
  // a referencing event whose target has not arrived is itself a confluence violation.
  if (root === undefined) {
    return {
      chain: { status: 'absent', reason: 'root-unobserved' },
      overlays: [],
      pending: patches.map((p) => p.id).sort(byIdAsc),
      annotations: [],
    }
  }

  // BD-9: a Binding is corrected by kind 5 plus a replacement, never by a patch. Nothing else has
  // patchable `content` either, so anything that is not a Product or Metadata has no chain.
  const rootType = scrutinyEventType(root)
  if (rootType !== 'product' && rootType !== 'metadata') {
    return {
      chain: { status: 'absent', reason: 'root-not-patchable' },
      overlays: [],
      pending: [],
      annotations: [],
    }
  }

  const deleted = honouredDeletions(deletions, byId)

  // PT-5 — authorship classification.
  const rootAuthored = patches.filter((p) => p.pubkey === root.pubkey)
  const foreign = patches.filter((p) => p.pubkey !== root.pubkey)

  // PT-6 / OV-8 — a root-author patch replying to a foreign patch is not a chain extension. It is
  // not invalid; it simply is not a link, and the root author must re-issue against a canonical
  // parent to adopt the change.
  //
  // UR-4 (spec v0.8.0, F16): while a root-author patch's `e reply` target is UNOBSERVED, PT-6 is
  // unevaluable — the parent's authorship class is unknown — so the patch is neither admitted to
  // nor excluded from the chain on that basis. It is *held*: it takes no position in the walk
  // (CHN-1), counts for nothing in fork detection (SF-1's carve-out — two patches sharing a held
  // or unobserved parent are not a fork until the target arrives), is re-evaluated the moment the
  // target is observed, and its own children are held with it. A patch whose *observed* parent is
  // foreign is PT-6-ignored instead — permanently, for this event set — and is never pending.
  const eligibility = new Map<string, 'chain' | 'held' | 'ignored'>()
  const classify = (patch: NostrEvent): 'chain' | 'held' | 'ignored' => {
    const prior = eligibility.get(patch.id)
    if (prior !== undefined) return prior
    // Stryker disable next-line StringLiteral: `eligibility` is read only through the two strict
    // `=== 'chain'` and `=== 'held'` filters below, and any non-'chain' value behaves identically
    // through both — the literal's own value never leaves this map. Same equivalence for the two
    // other 'ignored' assignments further down (`parentId === undefined` and the PT-6 arm).
    eligibility.set(patch.id, 'ignored') // cycle guard — a self-referential line is never a chain
    let cls: 'chain' | 'held' | 'ignored'
    const parentId = replyTarget(patch)
    // Stryker disable next-line BlockStatement: skipping this arm leaves cls unset (undefined),
    // which the two strict `=== 'chain'` / `=== 'held'` readers treat exactly like 'ignored' —
    // see the StringLiteral note on the memo-set above. The S5-10 no-reply pin covers the shape.
    if (parentId === undefined) {
      // Stryker disable next-line StringLiteral: same equivalence — the literal's value never
      // leaves the eligibility map, only the two strict filters read them.
      cls = 'ignored' // PT grammar requires the reply marker; nothing here to hold a verdict for
    } else if (parentId === rootId) {
      cls = 'chain'
    } else {
      const parent = byId.get(parentId)
      if (parent === undefined) {
        cls = 'held' // UR-4 — the target may still arrive
        // Stryker disable next-line ConditionalExpression,BlockStatement: two different cases —
        // the flip is provably killed by the full suite (the S5-11 well-parented PT-6 pin fails
        // when the condition is hand-removed, and classify(parent) pollutes eligibility with a
        // verdict computed for the *foreign* parent), and the emptying variant leaves cls unset
        // (undefined), which the two strict `=== 'chain'` / `=== 'held'` readers below treat
        // exactly like 'ignored'. The vitest runner never ran the covering tests per-mutant
        // (stryker-js #6073-class); justified in docs/QUALITY-AUDIT-2026-08-08.md §4 Step 5.
      } else if (parent.pubkey !== root.pubkey) {
        // Stryker disable next-line StringLiteral: same equivalence as the memo-set literal —
        // the eligibility value leaves this map only through the two strict filters.
        cls = 'ignored' // PT-6 — replying to a foreign patch is never chain material
      } else {
        cls = classify(parent)
      }
    }
    eligibility.set(patch.id, cls)
    return cls
  }

  for (const patch of rootAuthored) classify(patch)

  // Stryker disable next-line MethodExpression,ConditionalExpression: widening this filter is
  // unobservable — every non-'chain' classification implies unreachability from the root through
  // the surviving children map: 'held' (parent unobserved), PT-6 'ignored' (the parent is
  // foreign and never canonical), grammar 'ignored' (no parent to key under), cycle 'ignored'
  // (trapped inside the cycle). The eligibility map is already the memoized guard; this filter
  // is defence-in-depth and classifying again with a wider set cannot place any of those on a
  // walk-reachable position.
  const linkable = rootAuthored.filter((p) => eligibility.get(p.id) === 'chain')

  const removed = cascade(linkable, deleted)
  const surviving = linkable.filter((p) => !removed.has(p.id))

  const children = new Map<string, NostrEvent[]>()
  for (const patch of surviving) {
    const parentId = replyTarget(patch)
    // Stryker disable next-line ConditionalExpression: provably killed by the current suite —
    // keying a patch under `undefined` makes it unreachable in the walk but only as long as the
    // walk's `children.get` of a never-`undefined` position cannot find it; the S5-10 no-reply
    // pin fails when hand-applied, yet the vitest runner never ran its covering tests per-mutant
    // (stryker-js #6073-class; audit §4 Step 5).
    if (parentId === undefined) continue
    const bucket = children.get(parentId)
    if (bucket === undefined) children.set(parentId, [patch])
    else bucket.push(patch)
  }

  // --- the walk ------------------------------------------------------------
  const chainPatches: NostrEvent[] = []
  let fork: { parentId: string; branches: NostrEvent[] } | undefined
  // Stryker disable next-line ArrayDeclaration: the seed only guards re-encountering an id, and
  // the children map's *values* are patches only — the root id can never appear among them, so
  // `visited` would never be consulted about rootId in any reachable shape.
  const visited = new Set<string>([rootId])
  let position = rootId

  for (;;) {
    const kids = children.get(position) ?? []
    // Stryker disable next-line ConditionalExpression: when kids is empty, the very next guard
    // breaks on `next === undefined` with the identical result — the two breaks are different
    // spellings of the same exit for this case.
    if (kids.length === 0) break
    if (kids.length > 1) {
      // SF-1. The walk stops here, which is also SF-6: the first fork reached from the root is by
      // construction the earliest, and forks deeper in the topology are not on the canonical chain.
      //
      // Note what is *not* written: `kids[0]`. That single expression is SF-4's violation — it
      // picks a branch by whichever event the input happened to mention first, and would even be
      // confluent if the array were pre-sorted by id, and still wrong. Branch on the count only.
      fork = { parentId: position, branches: kids }
      break
    }
    const next = kids[0]
    // Stryker disable next-line ConditionalExpression,LogicalOperator: both guards feast on
    // cycles, and `classify` keeps cycles out of `linkable` entirely — `children` is acyclic by
    // construction (PT-9 + the memo on the classifying walk), so there is no reachable bad input
    // for them to reject. That is what the inline comment already says; Step 5 confirmed no test
    // in the full suite can observe a removal here.
    if (next === undefined || visited.has(next.id)) break // cycle: malformed, and unreachable via PT-9
    visited.add(next.id)
    chainPatches.push(next)
    position = next.id
  }

  // --- application, with overlays classified in step (§5.3 steps 2-7) -------
  //
  // Overlays targeting position N are classified at the moment content-at-N is live, rather than
  // caching every position for a later pass. D28 rejects eager materialisation of all positions
  // (216 MB versus ~25 MB at sec-certs scale); interleaving is strictly better than the LRU it
  // proposes, because nothing beyond the running content is ever retained. Cross-call caching is
  // `store`'s concern in Phase 5, where D24's epochs can invalidate it correctly.
  const annotations: Annotation[] = []
  const overlaysByTarget = new Map<string, NostrEvent[]>()
  for (const overlay of foreign) {
    // DEL-3: a deleted overlay is hidden from default overlay rendering. Canonical bytes are
    // unaffected, because overlays were never part of them (RC-2).
    if (deleted.has(overlay.id)) continue
    const targetId = replyTarget(overlay)
    if (targetId === undefined) continue // PT-2 is a V rule; validate.ts already rejects this
    const bucket = overlaysByTarget.get(targetId)
    if (bucket === undefined) overlaysByTarget.set(targetId, [overlay])
    else bucket.push(overlay)
  }

  /** Overlays that applied cleanly against their target, pending the clean-versus-stale decision. */
  const applies = new Map<string, boolean>()
  const classifyAgainst = (positionId: string, content: string): void => {
    for (const overlay of overlaysByTarget.get(positionId) ?? []) {
      const result = applyPatchContent(content, overlay.content, options.apply)
      if (result.status === 'limit') {
        annotations.push({
          kind: 'resource-limit',
          eventId: overlay.id,
          author: overlay.pubkey,
          message: `overlay ${overlay.id} hit the ${result.limit} ceiling and was not classified`,
          issues: result.issues,
        })
        continue // left out of `applies`; surfaces as `unclassified`
      }
      applies.set(overlay.id, result.status !== 'halt')
    }
  }

  let content = root.content
  const applied: string[] = []
  let halted: { at: NostrEvent; reason: HaltReason } | undefined
  let aborted: { at: NostrEvent; limit: LimitKind } | undefined

  classifyAgainst(rootId, content)

  for (const patch of chainPatches) {
    // PT-8: a no-op patch is a valid chain link that contributes no change. `applyPatchContent`
    // already returns a `noop` variant for both shapes, so it needs no special case beyond not
    // being treated as a failure.
    const result = applyPatchContent(content, patch.content, options.apply)

    if (result.status === 'halt') {
      halted = { at: patch, reason: result.reason }
      annotations.push({
        kind: 'protocol-error',
        eventId: patch.id,
        author: patch.pubkey,
        reason: result.reason,
        message: `patch ${patch.id} failed pre-validation (${result.rule}): ${result.detail}`,
        issues: result.issues,
      })
      break
    }
    if (result.status === 'limit') {
      aborted = { at: patch, limit: result.limit }
      annotations.push({
        kind: 'resource-limit',
        eventId: patch.id,
        author: patch.pubkey,
        message: `patch ${patch.id} hit the ${result.limit} ceiling; application stopped here`,
        issues: result.issues,
      })
      break
    }

    content = result.content
    applied.push(patch.id)
    classifyAgainst(patch.id, content)
  }

  // RC-5 — the tip is the root event itself where the chain carries no (successfully applied)
  // patches, never "nothing." `applied.at(-1)` is `undefined` in exactly that case (zero patches
  // applied, whether because none exist or because the first one HALTed/aborted before applying),
  // and `rootId` is always the fallback — never a sentinel a caller must special-case.
  const tip = applied.at(-1) ?? rootId

  if (fork !== undefined) {
    const branches: ForkBranch[] = fork.branches
      .map((b) => ({ id: b.id, author: b.pubkey, createdAt: b.created_at }))
      // Sorting the *report* is not SF-4: a deterministic report is required for two resolutions of
      // the same set to compare equal. Sorting to *select* a branch is the violation.
      .sort((a, b) => byIdAsc(a.id, b.id))
    annotations.push({
      kind: 'self-fork',
      parentId: fork.parentId,
      branches,
      message: `root self-fork: ${branches.length} root-author patches reply to ${fork.parentId}; the canonical chain is undefined until one branch is deleted by its author`,
      issues: [
        issue('SF-3', 'warning', 'root self-fork; canonical bytes are frozen at the shared parent'),
      ],
    })
  }

  // --- which freeze condition determined the content -----------------------
  //
  // A fork is structurally never upstream of a halt in the same resolution: the walk stops *at* the
  // fork, so every patch that could halt is at or before the fork parent. A halt therefore always
  // wins when both are live, because H1 forbids applying later patches unconditionally. Reported as
  // F10 when v0.6.0's §5.3 step 5 stated fork-before-HALT unconditionally, which this contradicted;
  // **v0.6.1 closed F10 by adopting the earlier-in-chain-order rule (SF-7)**, which is exactly what
  // this computes. No longer a departure. The fork is still surfaced above, so SF-3's MUST holds
  // either way.
  const chain: ChainState =
    halted !== undefined
      ? {
          status: 'halted',
          content,
          tipId: tip,
          applied,
          haltedAt: halted.at.id,
          reason: halted.reason,
        }
      : aborted !== undefined
        ? {
            status: 'aborted',
            content,
            tipId: tip,
            applied,
            abortedAt: aborted.at.id,
            limit: aborted.limit,
          }
        : fork !== undefined
          ? {
              status: 'forked',
              content,
              forkParentId: fork.parentId,
              branchIds: fork.branches.map((b) => b.id).sort(byIdAsc),
            }
          : { status: 'resolved', content, tipId: tip, applied }

  // --- overlay states ------------------------------------------------------
  //
  // A forked chain has no tip (SF-1), so nothing anchored to it can be `clean`; well-formed
  // overlays against the frozen prefix are `stale`, which is what §7.3's condition literally says.
  const tipForOverlays = chain.status === 'forked' ? null : tip
  const definedPositions = new Set<string>([rootId, ...applied])

  const overlays: Overlay[] = []
  for (const [targetId, bucket] of overlaysByTarget) {
    for (const overlay of bucket) {
      overlays.push({
        id: overlay.id,
        author: overlay.pubkey,
        targetId,
        ...overlayState(overlay.id, targetId, definedPositions, byId, applies, tipForOverlays),
      })
    }
  }
  overlays.sort((a, b) => byIdAsc(a.targetId, b.targetId) || byIdAsc(a.id, b.id))

  annotations.sort(
    (a, b) =>
      byIdAsc(a.kind, b.kind) ||
      byIdAsc(
        // Stryker disable next-line ConditionalExpression,StringLiteral: at most one self-fork
        // annotation exists per resolution — the walk stops at the first fork it reaches (SF-6) —
        // so a same-kind tie can never put a 'self-fork' through this ternary, and non-fork ties
        // always take the false arm, which every condition-flip here leaves unchanged.
        a.kind === 'self-fork' ? a.parentId : a.eventId,
        // Stryker disable next-line ConditionalExpression,StringLiteral: the same single-fork
        // guarantee as the ternary above (SF-6); ties are always between non-fork kinds.
        b.kind === 'self-fork' ? b.parentId : b.eventId,
      ),
  )

  // UR-4's retained set: held root-author patches, minus any the root author already retracted —
  // a retracted patch never joins the chain however many targets arrive, and listing it would
  // misreport a completed decision as a pending one (DEL-1/§10).
  const pending = rootAuthored
    .filter((p) => eligibility.get(p.id) === 'held' && !deleted.has(p.id))
    .map((p) => p.id)
    .sort(byIdAsc)

  return { chain, overlays, pending, annotations }
}

/**
 * OV-3 and DEL-7 — the part most likely to be got wrong.
 *
 * The tempting implementation classifies against the *tip* and calls anything that fails a
 * conflict. Three distinct situations must all yield `orphaned` instead: a target downstream of a
 * HALT, a target inside an unresolved self-fork, and a target that is itself a fork sibling. None
 * has a defined resolved content, and `conflict` would assert the overlay was evaluated against
 * bytes that do not exist.
 */
function overlayState(
  overlayId: string,
  targetId: string,
  definedPositions: ReadonlySet<string>,
  byId: ReadonlyMap<string, NostrEvent>,
  applies: ReadonlyMap<string, boolean>,
  tipId: string | null,
): { state: OverlayState; degradation?: 'alpha' | 'beta' } {
  if (!definedPositions.has(targetId)) {
    // DEL-7: α when the target can still be located, β when it cannot. "Obtainable" here means
    // "present in the observed set" — this function fetches nothing. A deleted-but-observed target
    // is α, because §10 preserves deleted events for audit. The overlay is never re-anchored.
    return { state: 'orphaned', degradation: byId.has(targetId) ? 'alpha' : 'beta' }
  }
  const applied = applies.get(overlayId)
  if (applied === undefined) return { state: 'unclassified' } // RL-3 — see OverlayState
  if (!applied) return { state: 'conflict' }
  // Clean versus stale turns on tip-ness, not applicability. Both apply; `stale` means the chain
  // advanced past the target since the overlay was signed, which is the only signal a UI has for
  // "this annotation addressed an older revision".
  return { state: targetId === tipId ? 'clean' : 'stale' }
}
