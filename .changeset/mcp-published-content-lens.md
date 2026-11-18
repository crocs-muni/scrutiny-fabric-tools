---
"@crocs-muni/scrutiny-fabric-mcp": minor
---

`publish_plan` now shows what it published instead of only a count. Every `records[]` entry carries
the signed `content` (with the `@ref:` placeholders resolved) and the record's `indexers`, and the
result text prints the content of the records published so far plus, for each record with an
indexer, the value to search for in SCRUTINY Lens — the event's `i` tag written `prefix:value`,
which Lens matches exactly. The publisher guide's Lens checklist says the same, so an agent can give
the user a way to find the record rather than stopping at an event id.
