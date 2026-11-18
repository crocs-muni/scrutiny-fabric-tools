---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

The 20 s deadline now aborts the publish it interrupted: `publish_plan` passes an `AbortSignal` to `RelayClient.publish`, which stops before the next attempt and cuts a back-off wait short, so a run that returned `partial` no longer keeps sending EVENT frames (up to three resends after 1 s, 4 s and 10 s) to the relay behind the user's back.
