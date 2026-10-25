---
'@scrutiny-fabric/core': patch
---

Dev-toolchain security bumps only; no API or runtime change: vitest 4.1.12 (fixes @vitest/mocker advisories), root `pnpm.overrides` floored to `vite` 6.4.5 / `zod` >=4.6.6 / `fast-uri` >=3.1.9 for the stryker and api-extractor dev chains, and the signers example moves to @noble v2 (v2 export names + `randomSecretKey`).
