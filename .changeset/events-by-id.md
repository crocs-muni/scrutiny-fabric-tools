---
"@scrutiny-fabric/core": minor
---

Add `eventsById(ids)`, the §8.2 traversal leg for fetching events a previous leg discovered (binding endpoints, a patch's root; spec-feedback F21, crocs-muni/scrutiny-fabric#42): `{ids:[...]}`. Kind-agnostic with no `#t` — DQ-1's kind-5 carve-out proves the lookup space isn't kind-1-only, and the id already pins everything (SIG-1), so every extra filter key is a footgun. Pass-through: no dedup, no validation; the relay-side mirror of `EventStorage.get`. Unblocks scrutiny-lens's second hop (#78).
