---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

A `notifications/cancelled` that arrives while a run is busy no longer lets the run write again: the engine now re-checks the abort signal after a blob upload returns and before every mirror publish, so a cancel during an upload stops the run before the event citing that blob is signed and published, and a cancel during a mirror write stops the remaining mirrors, instead of finishing the slice as `complete`.
