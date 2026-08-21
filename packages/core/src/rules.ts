// GENERATED FILE — do not edit by hand.
//
// Source:      tools/rules.json (extracted from Appendix F of the SCRUTINY Fabric protocol spec)
// Regenerate:  pnpm rules:gen
// Verify:      pnpm rules:check
//
// 142 rules: V=46, A=64, D=31, 1 reserved.

/**
 * The layer a rule belongs to (§6.0). The partition is by *subject*, not by normative strength —
 * a MUST may appear in any layer.
 *
 * - `V` — Validity. Is the event well-formed and admissible at all?
 * - `A` — Application. Given an admitted event, does applying it to chain state succeed?
 * - `D` — Discovery. How do consumers find, gate visibility, and resolve events?
 *
 * The distinction is enforced, not decorative: TR-1 forbids rejecting a V-valid event because it
 * violates an A or D rule.
 */
export type RuleLayer = 'V' | 'A' | 'D'

/** Every rule ID in Appendix F. */
export type RuleId =
  | 'TAG-1'
  | 'TAG-2'
  | 'TAG-3'
  | 'TAG-4'
  | 'TAG-5'
  | 'VER-1'
  | 'VER-2'
  | 'VER-3'
  | 'VER-4'
  | 'OTS-1'
  | 'SIG-1'
  | 'CA-1'
  | 'PR-1'
  | 'PR-2'
  | 'PR-3'
  | 'PR-4'
  | 'PR-5'
  | 'MD-1'
  | 'MD-2'
  | 'MD-3'
  | 'MD-4'
  | 'MD-5'
  | 'BD-1'
  | 'BD-2'
  | 'BD-3'
  | 'BD-4'
  | 'BD-5'
  | 'BD-6'
  | 'BD-7'
  | 'BD-8'
  | 'BD-9'
  | 'BD-10'
  | 'BD-11'
  | 'BD-12'
  | 'PT-1'
  | 'PT-2'
  | 'PT-3'
  | 'PT-4'
  | 'PT-5'
  | 'PT-6'
  | 'PT-7'
  | 'PT-8'
  | 'PT-9'
  | 'PT-10'
  | 'PT-11'
  | 'IX-1'
  | 'IX-2'
  | 'IX-3'
  | 'IX-4'
  | 'IM-1'
  | 'IM-2'
  | 'IM-3'
  | 'IM-4'
  | 'IM-5'
  | 'PB-1'
  | 'PB-2'
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'N1'
  | 'N2'
  | 'N3'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'T1'
  | 'T2'
  | 'T3'
  | 'H1'
  | 'H2'
  | 'CHN-1'
  | 'CHN-2'
  | 'CHN-3'
  | 'RL-1'
  | 'RL-2'
  | 'RL-3'
  | 'RL-4'
  | 'RL-5'
  | 'TR-1'
  | 'TR-2'
  | 'TR-3'
  | 'TR-4'
  | 'TR-5'
  | 'TR-6'
  | 'TR-7'
  | 'RC-1'
  | 'RC-2'
  | 'RC-3'
  | 'RC-4'
  | 'RC-5'
  | 'SF-1'
  | 'SF-2'
  | 'SF-3'
  | 'SF-4'
  | 'SF-5'
  | 'SF-6'
  | 'SF-7'
  | 'OV-1'
  | 'OV-2'
  | 'OV-3'
  | 'OV-4'
  | 'OV-5'
  | 'OV-6'
  | 'OV-7'
  | 'OV-8'
  | 'OV-9'
  | 'UR-1'
  | 'UR-2'
  | 'UR-3'
  | 'UR-4'
  | 'DQ-1'
  | 'DQ-2'
  | 'DQ-3'
  | 'DQ-4'
  | 'IR-1'
  | 'IR-2'
  | 'IR-3'
  | 'IR-4'
  | 'DEL-1'
  | 'DEL-2'
  | 'DEL-3'
  | 'DEL-4'
  | 'DEL-5'
  | 'DEL-6'
  | 'DEL-7'
  | 'DEL-8'
  | 'DEL-9'
  | 'DEL-10'
  | 'DEL-11'

/** Appendix F metadata for a single rule. */
export interface Rule {
  readonly id: RuleId
  /** Spec section the rule is defined in, e.g. `'4.3'`. */
  readonly section: string
  /** `null` only for reserved IDs, which have no layer. */
  readonly layer: RuleLayer | null
  /** Base-layer source this rule inherits from (`'NIP-01'`, `'CommonMark §4.5'`, …), if any. */
  readonly inheritsFrom: string | null
  /** One-line summary. The spec prose remains the authoritative definition. */
  readonly summary: string
  /**
   * A retained-but-superseded ID. Reserved rules are never emitted as issues; the ID exists so
   * that older citations still dereference.
   */
  readonly reserved: boolean
}

/** Every rule in Appendix F, keyed by ID. */
export const RULES: Readonly<Record<RuleId, Rule>> = Object.freeze({
  'TAG-1': {
    id: 'TAG-1',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Exactly one `["t","scrutiny-fabric"]` tag.',
    reserved: false,
  },
  'TAG-2': {
    id: 'TAG-2',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Exactly one version `t` tag matching `^scrutiny-v\\d+\\.\\d+\\.\\d+$`.',
    reserved: false,
  },
  'TAG-3': {
    id: 'TAG-3',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Exactly one event-type `t` tag from the recognised set.',
    reserved: false,
  },
  'TAG-4': {
    id: 'TAG-4',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Tag names use kebab-case.',
    reserved: false,
  },
  'TAG-5': {
    id: 'TAG-5',
    section: '3',
    layer: 'V',
    inheritsFrom: 'NIP-01',
    summary: 'Unknown tags MUST be ignored.',
    reserved: false,
  },
  'VER-1': {
    id: 'VER-1',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Version tags order per-field by digit string (leading zeros ignored; greater length, then lexicographic); never host-number conversion, never whole-tag lexicographic.',
    reserved: false,
  },
  'VER-2': {
    id: 'VER-2',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Higher-version events MAY be admitted opaquely if V-valid.',
    reserved: false,
  },
  'VER-3': {
    id: 'VER-3',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Higher-version events violating Validity MUST NOT render.',
    reserved: false,
  },
  'VER-4': {
    id: 'VER-4',
    section: '3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'MUST NOT reject higher-version events *solely* for the version tag.',
    reserved: false,
  },
  'OTS-1': {
    id: 'OTS-1',
    section: '3',
    layer: 'A',
    inheritsFrom: 'NIP-03',
    summary: 'OTS is audit signal only; not used for chain construction or tip selection.',
    reserved: false,
  },
  'SIG-1': {
    id: 'SIG-1',
    section: '3',
    layer: 'V',
    inheritsFrom: 'NIP-01',
    summary: 'Every consumed event MUST have both its signature and its `id` verified before processing.',
    reserved: false,
  },
  'CA-1': {
    id: 'CA-1',
    section: '4',
    layer: 'D',
    inheritsFrom: null,
    summary: '`created_at` SHOULD NOT be backdated to a historical date; historical dates belong in `content`.',
    reserved: false,
  },
  'PR-1': {
    id: 'PR-1',
    section: '4.1',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Product `content` field is required.',
    reserved: false,
  },
  'PR-2': {
    id: 'PR-2',
    section: '4.1',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Product SHOULD carry ≤64 `i` tags.',
    reserved: false,
  },
  'PR-3': {
    id: 'PR-3',
    section: '4.1',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Product SHOULD carry ≤64 `k` tags.',
    reserved: false,
  },
  'PR-4': {
    id: 'PR-4',
    section: '4.1',
    layer: 'D',
    inheritsFrom: 'NIP-73',
    summary: '`k` SHOULD contain ≥1 entry per distinct `i` prefix; absence does not invalidate; treat as set.',
    reserved: false,
  },
  'PR-5': {
    id: 'PR-5',
    section: '4.1',
    layer: 'V',
    inheritsFrom: 'NIP-92',
    summary: '`imeta` attachments OPTIONAL.',
    reserved: false,
  },
  'MD-1': {
    id: 'MD-1',
    section: '4.2',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Metadata `content` field is required.',
    reserved: false,
  },
  'MD-2': {
    id: 'MD-2',
    section: '4.2',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Metadata SHOULD carry ≤64 `i` tags.',
    reserved: false,
  },
  'MD-3': {
    id: 'MD-3',
    section: '4.2',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Metadata SHOULD carry ≤64 `k` tags.',
    reserved: false,
  },
  'MD-4': {
    id: 'MD-4',
    section: '4.2',
    layer: 'D',
    inheritsFrom: 'NIP-73',
    summary: '`k` SHOULD contain ≥1 entry per distinct `i` prefix; absence does not invalidate; treat as set.',
    reserved: false,
  },
  'MD-5': {
    id: 'MD-5',
    section: '4.2',
    layer: 'V',
    inheritsFrom: 'NIP-92',
    summary: '`imeta` attachments OPTIONAL.',
    reserved: false,
  },
  'BD-1': {
    id: 'BD-1',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Exactly one `e root` tag.',
    reserved: false,
  },
  'BD-2': {
    id: 'BD-2',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Exactly one `e link` tag.',
    reserved: false,
  },
  'BD-3': {
    id: 'BD-3',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: '`e root` endpoint MUST be a `scrutiny-product`.',
    reserved: false,
  },
  'BD-4': {
    id: 'BD-4',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: '`e link` endpoint MUST be a `scrutiny-metadata`.',
    reserved: false,
  },
  'BD-5': {
    id: 'BD-5',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Binding with invalid endpoint typing MUST NOT be admitted.',
    reserved: false,
  },
  'BD-6': {
    id: 'BD-6',
    section: '4.3',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Binding with unobserved endpoints is pending; admitted but not rendered.',
    reserved: false,
  },
  'BD-7': {
    id: 'BD-7',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Endpoint contradiction → permanently invalid; SHOULD cache rejection.',
    reserved: false,
  },
  'BD-8': {
    id: 'BD-8',
    section: '4.3',
    layer: 'D',
    inheritsFrom: 'NIP-10',
    summary: 'Relay-hint advisory; MUST fall back to full relay set if not found on hint.',
    reserved: false,
  },
  'BD-9': {
    id: 'BD-9',
    section: '4.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'No patch-based Binding update; correct via kind 5 + replacement.',
    reserved: false,
  },
  'BD-10': {
    id: 'BD-10',
    section: '4.3',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Binding MUST NOT contain more than one `e root` or `e link`.',
    reserved: false,
  },
  'BD-11': {
    id: 'BD-11',
    section: '4.3',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Duplicate Binding collapse is a presentation concern.',
    reserved: false,
  },
  'BD-12': {
    id: 'BD-12',
    section: '4.3',
    layer: 'V',
    inheritsFrom: 'NIP-10',
    summary: 'Author-hint mismatch does NOT invalidate the referencing Binding.',
    reserved: false,
  },
  'PT-1': {
    id: 'PT-1',
    section: '4.4',
    layer: 'V',
    inheritsFrom: 'NIP-10',
    summary: 'Exactly one `e root` tag.',
    reserved: false,
  },
  'PT-2': {
    id: 'PT-2',
    section: '4.4',
    layer: 'V',
    inheritsFrom: 'NIP-10',
    summary: 'Exactly one `e reply` tag.',
    reserved: false,
  },
  'PT-3': {
    id: 'PT-3',
    section: '4.4',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Zero or one fenced `diff` / `patch` block.',
    reserved: false,
  },
  'PT-4': {
    id: 'PT-4',
    section: '4.4',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Multiple fenced blocks → only the first is the payload.',
    reserved: false,
  },
  'PT-5': {
    id: 'PT-5',
    section: '4.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Root-author vs foreign classification by `pubkey`.',
    reserved: false,
  },
  'PT-6': {
    id: 'PT-6',
    section: '4.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Root-author patch `e reply` MUST point at root or root-author patch (otherwise ignored for chain); unevaluable while the target is unobserved — held per UR-4.',
    reserved: false,
  },
  'PT-7': {
    id: 'PT-7',
    section: '4.4',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Foreign patch `e reply` MUST point at root or root-author patch; no overlay-to-overlay.',
    reserved: false,
  },
  'PT-8': {
    id: 'PT-8',
    section: '4.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'No-op patch participates in chain topology but contributes no change.',
    reserved: false,
  },
  'PT-9': {
    id: 'PT-9',
    section: '4.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Patches append-only; removal only via author\'s own kind 5.',
    reserved: false,
  },
  'PT-10': {
    id: 'PT-10',
    section: '4.4',
    layer: 'V',
    inheritsFrom: null,
    summary: '`e root` MUST reference a `scrutiny-product` or `scrutiny-metadata` event.',
    reserved: false,
  },
  'PT-11': {
    id: 'PT-11',
    section: '4.4',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Patch with an observed `e root` violating PT-10 MUST NOT be admitted.',
    reserved: false,
  },
  'IX-1': {
    id: 'IX-1',
    section: '4.5',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Publishers SHOULD include canonical `i` tags for top-level indexers.',
    reserved: false,
  },
  'IX-2': {
    id: 'IX-2',
    section: '4.5',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Events SHOULD carry ≤64 `i` tags.',
    reserved: false,
  },
  'IX-3': {
    id: 'IX-3',
    section: '4.5',
    layer: 'A',
    inheritsFrom: null,
    summary: '`i` and `k` tags on root events are immutable.',
    reserved: false,
  },
  'IX-4': {
    id: 'IX-4',
    section: '4.5',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Deeply nested indexers SHOULD NOT be duplicated as `i` tags.',
    reserved: false,
  },
  'IM-1': {
    id: 'IM-1',
    section: '4.6',
    layer: 'A',
    inheritsFrom: 'NIP-92',
    summary: 'SHOULD verify `x` hash by streaming and comparing SHA-256.',
    reserved: false,
  },
  'IM-2': {
    id: 'IM-2',
    section: '4.6',
    layer: 'A',
    inheritsFrom: null,
    summary: '`size` mismatch is a verification failure equal to hash mismatch.',
    reserved: false,
  },
  'IM-3': {
    id: 'IM-3',
    section: '4.6',
    layer: 'A',
    inheritsFrom: 'NIP-92',
    summary: 'Multi-URL `imeta`: first hash-matching mirror is accepted; mirror choice MUST NOT influence validity.',
    reserved: false,
  },
  'IM-4': {
    id: 'IM-4',
    section: '4.6',
    layer: 'A',
    inheritsFrom: null,
    summary: 'MUST warn before displaying unverified artifacts.',
    reserved: false,
  },
  'IM-5': {
    id: 'IM-5',
    section: '4.6',
    layer: 'V',
    inheritsFrom: null,
    summary: '`imeta` attachments not required to be referenced in `content`.',
    reserved: false,
  },
  'PB-1': {
    id: 'PB-1',
    section: '5.1',
    layer: 'A',
    inheritsFrom: null,
    summary: '`content` consumed verbatim; no normalization before diff/apply.',
    reserved: false,
  },
  'PB-2': {
    id: 'PB-2',
    section: '5.1',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Consumers MUST NOT normalize patch payload bytes before applying.',
    reserved: false,
  },
  'E1': {
    id: 'E1',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'CommonMark §4.5',
    summary: 'Backtick-fenced code block; tilde fences not recognised.',
    reserved: false,
  },
  'E2': {
    id: 'E2',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'CommonMark §4.5',
    summary: 'Opening fence ≥3 backticks; info string first token `diff` or `patch`.',
    reserved: false,
  },
  'E3': {
    id: 'E3',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'CommonMark §4.5',
    summary: 'Closing fence ≥ opening-fence length, when one exists; an unclosed block is a valid code block running to the end of `content`.',
    reserved: false,
  },
  'E4': {
    id: 'E4',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Variable-length fences: `max(3, N+1)`; a producer obligation, unobservable to a consumer.',
    reserved: false,
  },
  'E5': {
    id: 'E5',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'CommonMark §4.5',
    summary: 'Payload = bytes between fence lines, each terminated by `\\n`.',
    reserved: false,
  },
  'E6': {
    id: 'E6',
    section: '5.2',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Multiple matching fenced blocks: first is payload, rest ignored.',
    reserved: false,
  },
  'E7': {
    id: 'E7',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'No matching fenced block → no-op (§4.4).',
    reserved: false,
  },
  'N1': {
    id: 'N1',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Prose-only patch is a valid no-op.',
    reserved: false,
  },
  'N2': {
    id: 'N2',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Header-only fenced block (valid headers, zero hunks) is a valid no-op.',
    reserved: false,
  },
  'N3': {
    id: 'N3',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Both no-op shapes MUST be treated as successful no-op application.',
    reserved: false,
  },
  'C1': {
    id: 'C1',
    section: '5.2',
    layer: 'V',
    inheritsFrom: null,
    summary: '`---`/`+++` path tokens MUST be exactly `a/content` and `b/content`.',
    reserved: false,
  },
  'C2': {
    id: 'C2',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'unified-diff',
    summary: 'Trailing data on header/`@@` lines leaves a payload valid; tolerate and ignore it.',
    reserved: false,
  },
  'C3': {
    id: 'C3',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'unified-diff',
    summary: 'An `Index:` preamble leaves a payload valid; it MAY appear and MUST be tolerated.',
    reserved: false,
  },
  'C4': {
    id: 'C4',
    section: '5.2',
    layer: 'V',
    inheritsFrom: 'unified-diff',
    summary: 'A `diff --git` line leaves a payload valid; it MAY appear and MUST be tolerated.',
    reserved: false,
  },
  'C5': {
    id: 'C5',
    section: '5.2',
    layer: 'A',
    inheritsFrom: 'unified-diff',
    summary: 'A hunk line beginning with `\\` is a no-newline marker; key on the prefix, not the (localised) text.',
    reserved: false,
  },
  'C6': {
    id: 'C6',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: '`@@` line numbers advisory; consumers locate hunks by context match.',
    reserved: false,
  },
  'C7': {
    id: 'C7',
    section: '5.2',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Floor on acceptance: any payload matching the §5.2 grammar is valid, zero-hunk included; no stricter reading.',
    reserved: false,
  },
  'C8': {
    id: 'C8',
    section: '5.2',
    layer: 'A',
    inheritsFrom: 'unified-diff',
    summary: 'Multiple file sections permitted; a `---` at hunk-line position starts a section, not a removal.',
    reserved: false,
  },
  'P1': {
    id: 'P1',
    section: '5.2',
    layer: 'A',
    inheritsFrom: 'unified-diff',
    summary: 'Producers SHOULD emit `min(3, available)` context lines; not a validity criterion for consumers.',
    reserved: false,
  },
  'P2': {
    id: 'P2',
    section: '5.2',
    layer: 'V',
    inheritsFrom: null,
    summary: 'No `index <sha>..<sha>`, `mode`, `similarity index`, or rename metadata; `--no-index` does not suppress them.',
    reserved: false,
  },
  'P3': {
    id: 'P3',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Producers MUST emit UTF-8 with LF line endings in the payload; not a consumer rejection criterion.',
    reserved: false,
  },
  'P4': {
    id: 'P4',
    section: '5.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Producers SHOULD verify their patch applies cleanly before publishing.',
    reserved: false,
  },
  'T1': {
    id: 'T1',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Determinism: context+`-` lines MUST occur exactly once in current content.',
    reserved: false,
  },
  'T2': {
    id: 'T2',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Insertion carve-out: pure-insertion hunks apply at the `@@` `-`-line position, clamped to the content\'s line range.',
    reserved: false,
  },
  'T3': {
    id: 'T3',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Multi-hunk sequencing: each hunk checked against post-prior-hunks content.',
    reserved: false,
  },
  'H1': {
    id: 'H1',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'HALT: pre-validation failure freezes chain at last successful patch.',
    reserved: false,
  },
  'H2': {
    id: 'H2',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Invalid patches MUST be surfaced as protocol error annotations.',
    reserved: false,
  },
  'CHN-1': {
    id: 'CHN-1',
    section: '5.3',
    layer: 'A',
    inheritsFrom: 'NIP-10',
    summary: 'Canonical chain walks root-author patches via NIP-10 `e reply`.',
    reserved: false,
  },
  'CHN-2': {
    id: 'CHN-2',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Kind 5 cascade applied during chain build.',
    reserved: false,
  },
  'CHN-3': {
    id: 'CHN-3',
    section: '5.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Foreign patches never enter the canonical chain; same T/H rules apply to overlays.',
    reserved: false,
  },
  'RL-1': {
    id: 'RL-1',
    section: '5.4',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Producers SHOULD respect the recommended resource bounds of §5.4.',
    reserved: false,
  },
  'RL-2': {
    id: 'RL-2',
    section: '5.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Consumers SHOULD enforce configurable ceilings and bound total patch-application work in bytes compared, with a per-line floor on the match pattern.',
    reserved: false,
  },
  'RL-3': {
    id: 'RL-3',
    section: '5.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Ceiling exceeded → resource-limit-exceeded annotation, never HALT; event remains V-valid.',
    reserved: false,
  },
  'RL-4': {
    id: 'RL-4',
    section: '5.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Content abandoned for resource reasons MUST NOT be served or cached as canonical bytes.',
    reserved: false,
  },
  'RL-5': {
    id: 'RL-5',
    section: '5.4',
    layer: 'A',
    inheritsFrom: null,
    summary: 'A chain stopped by a ceiling is *aborted under a ceiling* — distinct from both resolved and HALT.',
    reserved: false,
  },
  'TR-1': {
    id: 'TR-1',
    section: '6',
    layer: 'V',
    inheritsFrom: null,
    summary: 'V-invalid events MUST NOT enter SCRUTINY processing; V-valid events MUST NOT be rejected by an A or D rule.',
    reserved: false,
  },
  'TR-2': {
    id: 'TR-2',
    section: '6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Event admitted if `pubkey` trusted OR reachable via a trusted Binding.',
    reserved: false,
  },
  'TR-3': {
    id: 'TR-3',
    section: '6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Binding admitted only if its `pubkey` is trusted; no transitive endpoint trust.',
    reserved: false,
  },
  'TR-4': {
    id: 'TR-4',
    section: '6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'A trusted Binding admits its `e root` and `e link` endpoints, until the Binding is retracted.',
    reserved: false,
  },
  'TR-5': {
    id: 'TR-5',
    section: '6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Root admission admits the root\'s canonical chain, for as long as the root\'s admission survives.',
    reserved: false,
  },
  'TR-6': {
    id: 'TR-6',
    section: '6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Foreign patches are NOT transitively admitted; require independent trust.',
    reserved: false,
  },
  'TR-7': {
    id: 'TR-7',
    section: '6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Trust filtering is presentation-time; MUST NOT precede chain construction, self-fork detection, or overlay classification.',
    reserved: false,
  },
  'RC-1': {
    id: 'RC-1',
    section: '7.1',
    layer: 'A',
    inheritsFrom: 'NIP-10',
    summary: 'Canonical chain = linear root-author patch sequence by `e reply`.',
    reserved: false,
  },
  'RC-2': {
    id: 'RC-2',
    section: '7.1',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Canonical bytes computed from root + canonical chain; overlays excluded.',
    reserved: false,
  },
  'RC-3': {
    id: 'RC-3',
    section: '7.1',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Non-UI consumers MUST recompute on observed-set change.',
    reserved: false,
  },
  'RC-4': {
    id: 'RC-4',
    section: '7.1',
    layer: 'A',
    inheritsFrom: null,
    summary: 'UI consumers SHOULD recompute on observed-set change.',
    reserved: false,
  },
  'RC-5': {
    id: 'RC-5',
    section: '7.1',
    layer: 'A',
    inheritsFrom: null,
    summary: 'The tip is the last chain event — the root itself where the chain carries no patches.',
    reserved: false,
  },
  'SF-1': {
    id: 'SF-1',
    section: '7.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Root self-fork: two root-author patches at same parent → chain undefined; a shared pending parent holds both (UR-4), no fork yet.',
    reserved: false,
  },
  'SF-2': {
    id: 'SF-2',
    section: '7.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Freeze patched content at shared parent while unresolved.',
    reserved: false,
  },
  'SF-3': {
    id: 'SF-3',
    section: '7.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Surface self-fork as an explicit error condition.',
    reserved: false,
  },
  'SF-4': {
    id: 'SF-4',
    section: '7.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'MUST NOT pick branch by `created_at`, event ID, or any heuristic.',
    reserved: false,
  },
  'SF-5': {
    id: 'SF-5',
    section: '7.2',
    layer: 'A',
    inheritsFrom: 'NIP-09',
    summary: 'Resolution: root author kind 5 deletion on one branch.',
    reserved: false,
  },
  'SF-6': {
    id: 'SF-6',
    section: '7.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Multiple forks resolved independently; freeze at earliest unresolved.',
    reserved: false,
  },
  'SF-7': {
    id: 'SF-7',
    section: '7.2',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Self-fork vs HALT: freeze at whichever is earlier in chain order; never apply past a HALT.',
    reserved: false,
  },
  'OV-1': {
    id: 'OV-1',
    section: '7.3',
    layer: null,
    inheritsFrom: null,
    summary: '*Reserved.* See **PT-7** (§4.4).',
    reserved: true,
  },
  'OV-2': {
    id: 'OV-2',
    section: '7.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Target-state snapshot: overlay evaluated against target\'s resolved content.',
    reserved: false,
  },
  'OV-3': {
    id: 'OV-3',
    section: '7.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Undefined target content → overlay is orphaned, not clean/conflict/stale.',
    reserved: false,
  },
  'OV-4': {
    id: 'OV-4',
    section: '7.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Classification is a pure deterministic function of (payload, target content).',
    reserved: false,
  },
  'OV-5': {
    id: 'OV-5',
    section: '7.3',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Clients SHOULD expose classification through their API/data layer.',
    reserved: false,
  },
  'OV-6': {
    id: 'OV-6',
    section: '7.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Overlay rendered against original target; "rebase preview" is non-normative.',
    reserved: false,
  },
  'OV-7': {
    id: 'OV-7',
    section: '7.3',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Foreign overlay visible only if its `pubkey` is in the user\'s trusted set.',
    reserved: false,
  },
  'OV-8': {
    id: 'OV-8',
    section: '7.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Root-author patch replying to foreign patch ignored for chain construction.',
    reserved: false,
  },
  'OV-9': {
    id: 'OV-9',
    section: '7.3',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Ceiling reached before classification → `unclassified`; never conflict, orphaned, clean or stale.',
    reserved: false,
  },
  'UR-1': {
    id: 'UR-1',
    section: '7.6',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Ingestion MUST be confluent: state depends on the observed set, never on arrival order.',
    reserved: false,
  },
  'UR-2': {
    id: 'UR-2',
    section: '7.6',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Patch with unobserved `e root` is retained and re-evaluated on the root\'s arrival.',
    reserved: false,
  },
  'UR-3': {
    id: 'UR-3',
    section: '7.6',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Classification cached as permanent only when no further observation could change it.',
    reserved: false,
  },
  'UR-4': {
    id: 'UR-4',
    section: '7.6',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Root-author patch with unobserved `e reply` target is retained and re-evaluated on arrival; no chain or fork participation until then.',
    reserved: false,
  },
  'DQ-1': {
    id: 'DQ-1',
    section: '8',
    layer: 'D',
    inheritsFrom: 'NIP-01',
    summary: 'Discovery queries assume NIP-01 `#t`/`#e`/`#i` filters; include `#t:["scrutiny-fabric"]`.',
    reserved: false,
  },
  'DQ-2': {
    id: 'DQ-2',
    section: '8',
    layer: 'D',
    inheritsFrom: 'NIP-09',
    summary: 'SHOULD issue `{kinds:[5], #e:[<id>]}` per cached root, patch, and Binding, periodically.',
    reserved: false,
  },
  'DQ-3': {
    id: 'DQ-3',
    section: '8',
    layer: 'D',
    inheritsFrom: 'NIP-50',
    summary: 'NIP-50 search results MUST be verified for valid `scrutiny-fabric` tags and intent match.',
    reserved: false,
  },
  'DQ-4': {
    id: 'DQ-4',
    section: '8',
    layer: 'D',
    inheritsFrom: 'NIP-10',
    summary: '`{"#e":[id]}` traversal results MUST be filtered for the expected `scrutiny-*` `t` tag and `e` markers inspected for role.',
    reserved: false,
  },
  'IR-1': {
    id: 'IR-1',
    section: '9',
    layer: 'V',
    inheritsFrom: null,
    summary: '`i` prefix is lowercase ASCII matching `[a-z0-9-]+`.',
    reserved: false,
  },
  'IR-2': {
    id: 'IR-2',
    section: '9',
    layer: 'V',
    inheritsFrom: null,
    summary: '`i` value is the source authority\'s canonical form, preserved verbatim.',
    reserved: false,
  },
  'IR-3': {
    id: 'IR-3',
    section: '9',
    layer: 'V',
    inheritsFrom: 'NIP-73',
    summary: 'Parsers split on the first `:` only.',
    reserved: false,
  },
  'IR-4': {
    id: 'IR-4',
    section: '9',
    layer: 'V',
    inheritsFrom: null,
    summary: 'Unknown prefixes valid; pass through as opaque indexers.',
    reserved: false,
  },
  'DEL-1': {
    id: 'DEL-1',
    section: '10',
    layer: 'A',
    inheritsFrom: 'NIP-09',
    summary: 'Kind 5 honored only when `pubkey` matches target event\'s `pubkey`.',
    reserved: false,
  },
  'DEL-2': {
    id: 'DEL-2',
    section: '10',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Root-author patch deletion → topology cascade in canonical chain.',
    reserved: false,
  },
  'DEL-3': {
    id: 'DEL-3',
    section: '10',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Foreign overlay deletion → hidden from default; canonical bytes unaffected.',
    reserved: false,
  },
  'DEL-4': {
    id: 'DEL-4',
    section: '10',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Root deletion → default-view retraction; annotations preserved for audit.',
    reserved: false,
  },
  'DEL-5': {
    id: 'DEL-5',
    section: '10',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Binding deletion → edge retraction and revocation of the admission it conferred; endpoints stay V-valid.',
    reserved: false,
  },
  'DEL-6': {
    id: 'DEL-6',
    section: '10',
    layer: 'A',
    inheritsFrom: 'NIP-09',
    summary: 'Kind 5 events cannot themselves be kind-5-deleted.',
    reserved: false,
  },
  'DEL-7': {
    id: 'DEL-7',
    section: '10',
    layer: 'A',
    inheritsFrom: null,
    summary: 'α/β degradation for orphaned overlays; not re-anchored.',
    reserved: false,
  },
  'DEL-8': {
    id: 'DEL-8',
    section: '10',
    layer: 'A',
    inheritsFrom: null,
    summary: 'Late-arriving deletion target → retroactive application; recompute content.',
    reserved: false,
  },
  'DEL-9': {
    id: 'DEL-9',
    section: '10',
    layer: 'A',
    inheritsFrom: null,
    summary: 'MUST cache received kind 5 events and apply during chain construction.',
    reserved: false,
  },
  'DEL-10': {
    id: 'DEL-10',
    section: '10',
    layer: 'D',
    inheritsFrom: null,
    summary: 'Clients SHOULD offer a "show deleted events" toggle exposing deleted events + descendants.',
    reserved: false,
  },
  'DEL-11': {
    id: 'DEL-11',
    section: '10',
    layer: 'D',
    inheritsFrom: 'NIP-09',
    summary: 'SCRUTINY-aware relays SHOULD store kind 5 deletions targeting scrutiny-fabric events alongside originals.',
    reserved: false,
  },
})

/** Every rule ID, in Appendix F order. */
export const RULE_IDS: readonly RuleId[] = Object.freeze(Object.keys(RULES) as RuleId[])

/** Whether an arbitrary string is a registered rule ID. */
export function isRuleId(value: string): value is RuleId {
  return Object.hasOwn(RULES, value)
}
