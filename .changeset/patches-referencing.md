---
"@scrutiny-fabric/core": minor
---

Add `patchesReferencing(eventId)`, the §8.2 traversal leg the spec implies but never writes out (#75; spec-feedback F19, crocs-muni/scrutiny-fabric#39): `{kinds:[1], '#t':['scrutiny-patch'], '#e':[eventId]}`. Anchored at a chain root, one query returns the whole patch chain (every patch carries `e` with marker `root`, PT-1); chain order is rebuilt client-side from `e reply` parentage (PT-2, §5.3), and role classification is `classifyByRole`'s existing job (S3-13). `#t` carries the event-type tag alone — NIP-01 ORs values within a filter key, so adding `scrutiny-fabric` would void DQ-4's type MUST.
