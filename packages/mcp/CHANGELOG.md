# @crocs-muni/scrutiny-fabric-mcp

## 0.2.0

### Minor Changes

- 48d0654: `.html` is now a publishable artifact type (`text/html`), so a publisher can attach the HTML
  reports and dashboards that a PDF-only map forced them to drop or re-export. The extension joins
  `.pdf`, `.json`, `.txt`, `.csv`, `.md` and `.zip` in the extension map (spec §9.1); `.html` stays
  out of the profile-picture map, and an HTML file offered as `picture` still raises `artifact.type`.
  The refusal text and the spec name the new type, and the spec records that a blob is served as
  active content from the relay's origin, so a published page must be publisher-authored and
  self-contained.
- 375a926: `keygen` works without a terminal: when stdin is not a TTY it now reads one backup-password line
  from stdin instead of refusing outright, the same channel `import` already used. A script or an
  agent can therefore create the publisher key and keep the password it piped; the key is still never
  accepted as an argument and never printed, and an empty or multi-line password stores nothing. The
  `signer.missing` fix text and the `signer.missing` draft question no longer claim a terminal is
  needed.
- dcd86ca: `publish_plan` now shows what it published instead of only a count. Every `records[]` entry carries
  the signed `content` (with the `@ref:` placeholders resolved) and the record's `indexers`, and the
  result text prints the content of the records published so far plus, for each record with an
  indexer, the value to search for in SCRUTINY Lens — the event's `i` tag written `prefix:value`,
  which Lens matches exactly. The publisher guide's Lens checklist says the same, so an agent can give
  the user a way to find the record rather than stopping at an event id.

### Patch Changes

- f287025: `publish_plan` now accepts `approval_code` only for a plan whose summary and code this server
  process already returned, on every channel. Before, a client without elicitation could compute the
  code and publish on its first call, without the summary ever being shown.
- 964d58f: The upload authorization now uses BUD-02 standard base64, which the khatru server accepts.
- f3c3028: A `notifications/cancelled` that arrives while a run is busy no longer lets the run write again: the engine now re-checks the abort signal after a blob upload returns and before every mirror publish, so a cancel during an upload stops the run before the event citing that blob is signed and published, and a cancel during a mirror write stops the remaining mirrors, instead of finishing the slice as `complete`.
- 6a15573: Closing the relay client now stops the resends and the dial: `close()` marks the client stopped before dropping the socket, `publish()` refuses a new attempt once stopped and rethrows the failed attempt's cause instead of retrying, and a lazy connect after close rejects rather than opening a socket — so a host that closes the publisher after its own timeout no longer gets writes from the run it abandoned.
- fc4cf64: `publish_plan`'s 20 s budget now covers every wait in a run, not just the primary publish: the resume read that asks the relay which unacknowledged events it stored, each mirror write, and the fetch-back verification read all run under the same deadline and are aborted when it passes. A run that reached the deadline mid-read now returns `partial` with a resume hint instead of hanging until the socket gave up, so the call cannot outlive its budget.
- cf9af3c: The 20 s deadline now aborts the publish it interrupted: `publish_plan` passes an `AbortSignal` to `RelayClient.publish`, which stops before the next attempt and cuts a back-off wait short, so a run that returned `partial` no longer keeps sending EVENT frames (up to three resends after 1 s, 4 s and 10 s) to the relay behind the user's back.
- fe00e4f: A record appended after a torn last line is kept, so a resumed run does not lose a transition.
- 5eee22b: Rule 2a now checks every card scalar, not only those four characters or longer. `lostFacts()`
  skipped a card value shorter than four characters before testing whether the prose mentioned it, so
  a short count, year or code in a record card was silently exempt and the blocking `record.rule_2a`
  question never fired; the length filter is gone and only the exemption rules (long hex, type
  strings, `jcver-lte`, `«`-marked values) can excuse an omission.
- 02e435c: Concurrent `publish_plan` calls for one plan hash now run one after the other: the second call opens the journal the first one closed, so a ref is never signed or published twice.
