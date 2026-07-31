import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * The property gates (G1/G2, AG1/AG2, SG1/SG2/SG5) run thousands of generated cases and take
     * 2–4 s each on an idle machine — close enough to vitest's 5 s default that a loaded runner
     * pushes them over it. Found during the Phase 8 audit: five gates failed under load and passed
     * unchanged at a higher timeout, on a tree with no source changes at all.
     *
     * These gates *are* the substitute for the unpublished D-layer conformance corpus, so a gate
     * that fails for reasons unrelated to conformance is worse than no gate — it teaches a reader
     * to re-run until green. Budget generously; a genuine hang still fails, just later.
     */
    testTimeout: 120_000,
  },
})
