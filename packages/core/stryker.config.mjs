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
 * + script, thresholds ratcheted to the audited baseline (#48 §2 and §4 Step 5).
 *
 * Accepted residuals (Stryker-disable comments can't bind to these positions — see
 * #48 §4 Step 5 for the exact justifications):
 *
 * - resolve.ts `else if (parent.pubkey !== root.pubkey)` flip mutant: provably
 *   killed by the full suite (S5-11 PT-6 pin), never run per-mutant (runner
 *   attribution miss, stryker-js #6073-class).
 * - resolve.ts same-position block-emptying mutant: equivalent — the arm's
 *   assignment never lands in `eligibility` unset vs `'ignored'`, and the two
 *   strict readers below treat them identically.
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
  // Incremental mode is deliberately OFF, measured not assumed: it replayed a pre-fix verdict
  // for a mutant whose killer test had just been added (patch.ts ABANDONED, baseline vs S5-4),
  // i.e. test edits did not reliably invalidate cached verdicts. A gate whose scores can lag
  // the suite it measures is worse than a slow one; scoped runs here take ~1-5 minutes.
  incremental: false,
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
  // dirs as a Windows failure mode. `stryker-tmp/` is gitignored (declared
  // in the repo root .gitignore).
  tempDirName: 'stryker-tmp',
  cleanTempDir: true,
  // Stale build output and regenerable reports must not enter the sandbox.
  ignorePatterns: ['dist', 'reports', 'coverage', 'stryker-tmp'],
  allowEmpty: false,
  // Ratcheted to the Step-5 audited end state (2026-08-09): patch 100%,
  // admit ~99.3%, resolve ~99.3% (two accepted residuals, see config header
  // and the audit file). `break` deliberately sits well below the current
  // scores: it exists to catch catastrophic *regression*, and the vitest
  // runner's per-mutant attribution churns by a couple of mutants run to
  // run, so an over-tight floor would false-fail clean code.
  thresholds: { low: 85, high: 95, break: 80 },
}
