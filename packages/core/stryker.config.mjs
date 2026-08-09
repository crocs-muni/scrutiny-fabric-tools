/**
 * StrykerJS mutation testing — Quality audit 2026-08-08, §4 Step 5.
 *
 * Scope is deliberately the three modules whose verdicts are the load-bearing
 * correctness rules of the protocol (patch: T1/T2/T3/C5/RL-3; admit: TR-2…7,
 * DEL-4/5; resolve: CHN/SF/RL/OV/DEL). Strength-auditing all 15 modules costs
 * hours for diminishing returns. Narrow further from the CLI:
 * `pnpm test:mutate --mutate src/patch.ts`.
 *
 * Deliberate deviations from common setups, each with a reason:
 *
 * - No @stryker-mutator/typescript-checker. Stryker 9.x disables checkers by
 *   default; vitest transforms TS with esbuild (types stripped), so only
 *   runtime semantics are ever exercised — a mutant that is type-invalid but
 *   behaviourally identical is indistinguishable at runtime and would cost
 *   tsc time for nothing. Same call as n8n-io/n8n and other pnpm+vitest setups.
 * - `ignoreStatic: false` (the default). Module-level constants here carry
 *   real verdict semantics — `EMPTY_ADMIT_STATE`'s deep freeze, the RL-3
 *   ceilings — so static mutants are exactly what this audit wants examined,
 *   even though each one re-runs every covering test file.
 *
 * Relationship to `pnpm verify`: a full mutation run takes minutes, so like
 * `changeset:check` it is NOT folded into the verify gate — committed config
 * + script, thresholds ratcheted to the audited baseline (see
 * docs/QUALITY-AUDIT-2026-08-08.md §2 and §4 Step 5).
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: ['src/patch.ts', 'src/admit.ts', 'src/resolve.ts'],
  // No `progress` reporter: runs are long and usually unattended; clear-text
  // summary + machine-readable JSON + browsable HTML is the useful trio.
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  ignoreStatic: false,
  // Property gates measure up to ~8s/file; a 30s floor and 2x factor leave
  // room for real property work while still failing a spinning loop-mutant
  // comparatively fast.
  timeoutMS: 30_000,
  timeoutFactor: 2,
  // Each worker is a single-thread vitest process (~0.5 GB). 6 is safe on a
  // 14-core dev box and does not thrash modest CI runners; override with
  // STRYKER_CONCURRENCY=2 on weaker machines.
  concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 6),
  // Non-hidden name: the official troubleshooting note flags hidden temp
  // dirs as a Windows failure mode. `stryker-tmp/` is gitignored.
  tempDirName: 'stryker-tmp',
  cleanTempDir: true,
  // Stale build output and regenerable reports must not enter the sandbox.
  ignorePatterns: ['dist', 'reports', 'coverage', 'stryker-tmp'],
  allowEmpty: false,
  // Ratchet: `break` set from the first audited (post-fix) scores so the
  // script fails on regression, not on an invented number. high/low are
  // informational color bands only.
  thresholds: { high: 85, low: 65, break: null },
}
