# Six questions for the live session

Type these into Lens against the relay the corpus was published to (local run, or
`wss://relay.scrutiny.cloud` after the production publish). Each entry gives the question, the
result the presenter must see, the corpus feature it exercises, and the check that tells you the
corpus is broken rather than the model.

Questions 1–5 are prose, so Lens routes them through its AI layer; question 6 is a typed
`prefix:value` identifier, which routes straight to a tag search with no AI round-trip. Run
question 6 first: it needs no model, so it separates "the events are there" from "the AI is up".

## 1. Which tests cover fault injection?

**Expected.** The fault-injection evaluation `ODR_AS-SE1_PSR_006` by the Helvetia Institute for
Hardware Security: result "fail on the boot path", a laser pulse during firmware verification
skipped the signature check. It appears on both the `AS-SE1` family card and the
`AS-SE1-C2P-T301` part card, with `Fault-injection evaluation` in Files.

**Exercises.** An `imeta` artifact and a bridge: one record bound to two Products.

**Fails if.** Files is empty (the artifact did not land), or the record shows under one product
only (the second Binding is missing). An answer that names the ISAP or AES-GCM report instead
means the shared record's binding labels are being read as the wrong edge.

## 2. Which firmware versions does the laser fault injection advisory affect, and which release fixes it?

**Expected.** "firmware 2.0.0 and earlier" is affected, and "firmware 2.1.0, released
2026-11-20, contains the fix". Open the advisory's drawer history: one row, `edited ×1`, whose
diff replaces "a firmware fix is in development and this record is updated when it ships" with
the released fix.

**Exercises.** The Patch. The root content deliberately does *not* name the fixed release, so the
answer is only available after the patch resolves.

**Fails if.** The answer says the fix is still in development (the patch did not land), or the
drawer shows no history row (the patch targeted an id other than the advisory's tip). A second
history row means the run was published twice into the same relay from different content — not
from this corpus.

## 3. Which Acme Secure product has no certification record?

**Expected.** `AS-SE1-B2S-T005`, the discontinued evaluation board: identity only, no `cc:`
indexer and no documents bound to it. The family card and the T301 card both carry
BSI-DSZ-CC-1234-2026.

**Exercises.** Product identity and the `cc:` facet. This is the node that proves the graph is
not "everything is certified": it has a name, a part number, a lifecycle and nothing else.

**Fails if.** The answer names `AS-SE1` or `AS-SE1-C2P-T301`, or claims a certificate for the
board. There is none in the corpus, and the model must not invent one.

## 4. How many versions of the PUF evaluation report are attached?

**Expected.** Two: `PUF evaluation v1.0` (2026-05-12) and `PUF evaluation v1.1` (2026-09-30),
both in Files on `ODR_AS-SE1_PSR_001`. They were attached at first publication because `imeta`
on a root cannot change afterwards (report §4.3).

**Exercises.** Multiple artifacts on one root, and the immutability rule the corpus is shaped
around: a new version is a new record or a second `imeta` at publish time, never an edit.

**Fails if.** Only one file is listed (a row was dropped), or the drawer shows an edit on this
record (someone re-rooted instead of publishing both versions at once).

## 5. Is TEST-ACME-DEMO-0001 a vendor claim?

**Expected.** No. The node renders retracted; its kind-5 reason says the record was created only
to show the retracted state and points at `ODR_AS-SE1_PSR_006` for the real evidence. The
record's own headline starts with "TEST RECORD (demo)".

**Exercises.** The retraction — and the rule that a retraction only counts from the same author
(DEL-1), so the demo must not retract a record another key published.

**Fails if.** The node renders active (the retraction did not land, or came from another key),
or the reason reads as a generic "retracted" with no explanation.

## 6. `advisory:ODR_AS-SE1_SA_2026030100`

**Expected.** The advisory card, immediately: Lens treats a typed `prefix:value` as an
identifier and searches the `i` tag directly. Files shows `Advisory
ODR_AS-SE1_SA_2026030100`; the card's affected value is `2.0.0 and earlier`.

**Exercises.** Deterministic tag routing, the `advisory` indexer, and the artifact. No AI call
is needed, so this question works when the model layer does not.

**Fails if.** Nothing is found: the `i` value is a spelling, so a stray case or separator change
(`ODR_AS-SE1_SA_2026030100` must match exactly) makes the record unreachable. A result without
Files means the artifact is on a different record.

## Reset

The relay has no publisher-facing delete, so a clean reset is a fresh relay or a fresh data
directory. Re-running the corpus against the same relay is harmless: the ids are identical, so
the relay keeps its first copies and adds nothing.
