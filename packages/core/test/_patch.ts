/**
 * Shared helpers for the patch-matcher suites.
 *
 * `body` was three byte-identical copies before this file existed, and the narrow-then-assert
 * dance around {@link ApplyResult} was written out at every call site purely to satisfy the
 * discriminated union.
 */

import { expect } from 'vitest'
import type { ApplyResult, HaltReason } from '../src/patch-types.js'

/** A payload with the C1 header block and the given hunk lines. */
export const body = (...lines: string[]): string =>
  `--- a/content\n+++ b/content\n${lines.join('\n')}\n`

/** A one-line rendering of a result, for assertion messages and outcome logs. */
export const describeResult = (r: ApplyResult): string =>
  r.status === 'halt'
    ? `halt(${r.reason}): ${r.detail}`
    : r.status === 'limit'
      ? `limit(${r.limit})`
      : r.status

/** Assert the patch applied and produced exactly `content`. */
export function expectApplied(result: ApplyResult, content: string, ctx?: string): void {
  if (result.status !== 'applied') {
    expect.fail(`expected applied${ctx ? ` (${ctx})` : ''}, got ${describeResult(result)}`)
  }
  expect(result.content, ctx).toBe(content)
}

/** Assert the patch halted for exactly `reason`. */
export function expectHalt(result: ApplyResult, reason: HaltReason, ctx?: string): void {
  if (result.status !== 'halt') {
    expect.fail(`expected halt(${reason})${ctx ? ` (${ctx})` : ''}, got ${describeResult(result)}`)
  }
  expect(result.reason, ctx).toBe(reason)
}
