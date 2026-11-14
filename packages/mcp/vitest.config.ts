import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Mirror the `paths` mapping in tsconfig.json: core is consumed from source here, because its
 * `exports` point at `dist` and `pnpm -r test` does not build. A fresh checkout stays green; a
 * `node --experimental-strip-types src/index.ts` start still needs `pnpm build` (A4 wiring).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@scrutiny-fabric/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The NIP-46 adversarial cases wait on a deliberate timeout; keep it short but deterministic.
    testTimeout: 10_000,
  },
})
