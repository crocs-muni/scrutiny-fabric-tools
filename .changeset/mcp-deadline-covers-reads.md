---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

`publish_plan`'s 20 s budget now covers every wait in a run, not just the primary publish: the resume read that asks the relay which unacknowledged events it stored, each mirror write, and the fetch-back verification read all run under the same deadline and are aborted when it passes. A run that reached the deadline mid-read now returns `partial` with a resume hint instead of hanging until the socket gave up, so the call cannot outlive its budget.
