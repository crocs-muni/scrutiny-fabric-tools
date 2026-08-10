# Spec changes — index

One file per finding (F1, F2, …). Statuses are the source of truth for where each finding stands
against the spec repo (`crocs-muni/scrutiny-fabric`). D2: gaps are batched into amendment briefs,
never worked around locally. The spec repo is read-only from here — amendments are their own session.

## Status legend

- **proposed** — reported, not yet resolved in the spec
- **applied vX.Y.Z** — the amendment landed in spec vX.Y.Z; the entry is kept for the record
- **archived** — superseded or withdrawn

## Index

| ID | Title | Status | Rules | Spec version filed against |
|---|---|---|---|---|
| [F1](F01.md) | P1 is unsatisfiable for short content | applied v0.6.1 | P1, T2, C7 | v0.6.0 |
| [F2](F02.md) | P2's stated remedy does not work | applied v0.6.1 | P2 | v0.6.0 |
| [F3](F03.md) | The consumer grammar's `*VCHAR` excludes SP and non-ASCII | applied v0.6.1 | C2, C7, E5 | v0.6.0 |
| [F4](F04.md) | §6.0's Validity manifest cites §5.1 (A-layer) | applied v0.6.1 | PB-1, PB-2 | v0.6.0 |
| [F5](F05.md) | A payload with two header blocks has two incompatible readings | applied v0.6.1 (→ C8) | C7, C1 | v0.6.0 |
| [F6](F06.md) | T2 and T3 disagree about which file a pure insertion indexes | applied v0.6.1 | T2, T3 | v0.6.0 |
| [F7](F07.md) | The grammar's `hunk-line` cannot match a blank context line | applied v0.6.1 | C7, C5 | v0.6.0 |
| [F8](F08.md) | The reference producer emits a separator the grammar does not admit | applied v0.6.1 | C3 | v0.6.0 |
| [F9](F09.md) | C5 names an English string that GNU diff and git localise | applied v0.6.1 | C5 | v0.6.0 |
| [F10](F10.md) | Self-fork precedence over HALT is stated unconditionally | applied v0.6.1 (→ SF-7) | SF-2, SF-7, H1 | v0.6.0 |
| [F11](F11.md) | §5.4's resource limit has no disposition in §7.3 or chain states | applied v0.6.1 (→ OV-9/RL-5) | RL-3, OV-9, RL-5 | v0.6.0 |
| [F12](F12.md) | RL-2's ceiling unit ("bytes compared") is free to exhaust | proposed | RL-2, RL-3 | v0.6.0 |
| [F13](F13.md) | Patch's own `e root` has no endpoint-typing rule | applied v0.7.0 | PT-10 (new), PT-11 (new), BD-3–7, UR-2 | v0.6.0 |
| [F14](F14.md) | Version-tag digit ceiling and lexicographic ordering claim | applied v0.7.0 | TAG-2 (rewritten), VER-1 (rewritten) | v0.6.0 |
| [F15](F15.md) | VER-1's "as numbers" ordering collides past ~2^53 | applied v0.7.1 | VER-1, TAG-2 | v0.7.0 |
| [F16](F16.md) | Root-author patch with unobserved `e reply` parent — no rule covers it | applied v0.8.0 (→ UR-4) | CHN-1, PT-6, UR-4 (new) | v0.7.0 |
| [F17](F17.md) | T2's pure-insertion position can be out of range — clamp or HALT? | applied v0.7.1 | T2, C6 | v0.7.0 |

## Amendment briefs

Batched spec-repo amendment sessions (D2 — never file from here, always batch):

| Brief | Findings | Spec PR | Result |
|---|---|---|---|
| `docs/START-SESSION-SPEC-FEEDBACK-F15-F17.md` | F15, F16, F17 | [spec-repo PR #18](https://github.com/crocs-muni/scrutiny-fabric/pull/18) | F15+F17 → v0.7.1; F16 → v0.8.0 (UR-4) |

## Historical sources

The original prose feedback files are kept for the record and superseded by this index:

- `docs/SPEC-FEEDBACK-v0.6.0.md` — F1–F14 (original batch, filed against spec v0.6.0)
- `docs/SPEC-FEEDBACK-v0.7.0.md` — F15–F17 (filed against spec v0.7.0)
- `docs/START-SESSION-SPEC-FEEDBACK-F15-F17.md` — the amendment brief for PR #18
