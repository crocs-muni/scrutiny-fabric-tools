import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** The real-relay e2e (spec §14.1 item 1): builds relay/cmd/relay, so it needs Go. */
export default defineConfig({
  resolve: {
    alias: {
      '@scrutiny-fabric/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/e2e/**/*.test.ts'],
  },
})
