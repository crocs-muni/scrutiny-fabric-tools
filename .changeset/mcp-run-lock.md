---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

Concurrent `publish_plan` calls for one plan hash now run one after the other: the second call opens the journal the first one closed, so a ref is never signed or published twice.
