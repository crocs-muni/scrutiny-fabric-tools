---
"@crocs-muni/scrutiny-fabric-mcp": minor
---

`keygen` works without a terminal: when stdin is not a TTY it now reads one backup-password line
from stdin instead of refusing outright, the same channel `import` already used. A script or an
agent can therefore create the publisher key and keep the password it piped; the key is still never
accepted as an argument and never printed, and an empty or multi-line password stores nothing. The
`signer.missing` fix text and the `signer.missing` draft question no longer claim a terminal is
needed.
