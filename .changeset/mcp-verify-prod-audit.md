---
---

`pnpm verify` runs the repo's own prod-only audit script instead of the built-in
all-dependencies audit, which fails on a dev-only advisory.
