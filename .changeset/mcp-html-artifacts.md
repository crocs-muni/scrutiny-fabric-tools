---
"@crocs-muni/scrutiny-fabric-mcp": minor
---

`.html` is now a publishable artifact type (`text/html`), so a publisher can attach the HTML
reports and dashboards that a PDF-only map forced them to drop or re-export. The extension joins
`.pdf`, `.json`, `.txt`, `.csv`, `.md` and `.zip` in the extension map (spec §9.1); `.html` stays
out of the profile-picture map, and an HTML file offered as `picture` still raises `artifact.type`.
The refusal text and the spec name the new type, and the spec records that a blob is served as
active content from the relay's origin, so a published page must be publisher-authored and
self-contained.
