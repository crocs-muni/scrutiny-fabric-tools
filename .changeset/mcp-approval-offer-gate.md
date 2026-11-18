---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

`publish_plan` now accepts `approval_code` only for a plan whose summary and code this server
process already returned, on every channel. Before, a client without elicitation could compute the
code and publish on its first call, without the summary ever being shown.
