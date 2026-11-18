---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

Rule 2a now checks every card scalar, not only those four characters or longer. `lostFacts()`
skipped a card value shorter than four characters before testing whether the prose mentioned it, so
a short count, year or code in a record card was silently exempt and the blocking `record.rule_2a`
question never fired; the length filter is gone and only the exemption rules (long hex, type
strings, `jcver-lte`, `«`-marked values) can excuse an omission.
