---
'@scrutiny-fabric/core': patch
---

Dev-toolchain bumps only; no API or runtime change: vitest 5.0.5 (which retires the `vite` 6.4.5 exact-pin override — vitest 5 declares a proper vite range that resolves patched versions without it), nostr-tools 2.25.2 (cross-check oracle here, runtime in mirror), fast-check 4.10.2.
