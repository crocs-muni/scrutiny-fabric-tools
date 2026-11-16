import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

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
  },
})
