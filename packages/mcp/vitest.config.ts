import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Same reason as tsconfig.json's `paths`: tests run before core's dist is guaranteed to exist.
    alias: {
      '@crocs-muni/scrutiny-fabric': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The real-relay e2e needs Go and runs on its own (`pnpm e2e`, vitest.e2e.config.ts).
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
})
