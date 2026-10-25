/**
 * gate/index.ts — stage-2 batch gate for the mirror importer.
 *
 * Reads `artifacts/<corpus>.ndjson` (one signed event per line), runs the per-event
 * verifier (`verify.ts`) and the rule-2a self-consume check (`selfConsume.ts`),
 * writes `artifacts/<corpus>.gate.json`, and returns { ok, exitCode, report }.
 *
 * Fail-closed: `report.ok` is true only when there are no errors and no lost facts
 * (`scorer.ts` adds the relay-probe verdict on top for `exitCode`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { GateReport, SignedEvent } from '../types.js'
import { type GateScore, type ProbeReport, scoreGate } from './scorer.js'
import { type LostFact, selfConsume } from './selfConsume.js'
import { type GateError, verifyStoredEvent } from './verify.js'

export * from './verify.js'
export * from './selfConsume.js'
export * from './scorer.js'

export interface GateEventsResult {
  eventCount: number
  errors: GateError[]
  lostFacts: LostFact[]
}

function hasEventFields(value: unknown): value is SignedEvent {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<SignedEvent>
  return typeof e.id === 'string' && typeof e.content === 'string' && Array.isArray(e.tags)
}

/** Verify an in-memory event list (no file I/O) — used by cli self-tests and tests. */
export function gateEvents(events: readonly unknown[], labelPrefix = 'event'): GateEventsResult {
  const errors: GateError[] = []
  const lostFacts: LostFact[] = []
  events.forEach((value, i) => {
    const provisional = typeof value === 'object' && value !== null ? value : null
    const id = provisional ? (provisional as Partial<SignedEvent>).id : undefined
    const label = typeof id === 'string' ? id : `${labelPrefix} ${i}`
    errors.push(...verifyStoredEvent(value, label))
    if (hasEventFields(value)) {
      const consumed = selfConsume(value, label)
      errors.push(...consumed.errors)
      lostFacts.push(...consumed.lostFacts)
    }
  })
  return { eventCount: events.length, errors, lostFacts }
}

export interface GateBatchOptions {
  /** Explicit output path; defaults to `<dir of ndjson>/<corpus>.gate.json`. */
  outPath?: string
  /** Artifacts directory to write into instead of the ndjson's own directory. */
  artifactsDir?: string
  /** Relay probe result to fold into the final verdict (optional). */
  probe?: ProbeReport | null
}

export interface GateBatchResult {
  /** Final verdict: gate clean AND probe publish-ready (see `scoreGate`). */
  ok: boolean
  /** 0 when `ok`, else 1 — cli may `process.exit(exitCode)`. */
  exitCode: 0 | 1
  /** The report written to `outPath` (`ok` = errors===0 && lostFacts===0). */
  report: GateReport
  outPath: string
  score: GateScore
}

function gateReport(errors: GateError[], lostFacts: LostFact[], eventCount: number): GateReport {
  return {
    ok: errors.length === 0 && lostFacts.length === 0,
    eventCount,
    errors,
    lostFacts,
  }
}

/**
 * Gate one NDJSON batch and write `artifacts/<corpus>.gate.json`.
 * Blank lines are skipped; a malformed line becomes an `NDJSON-PARSE` error.
 */
export async function gateBatch(
  ndjsonPath: string,
  opts: GateBatchOptions = {},
): Promise<GateBatchResult> {
  const abs = resolve(ndjsonPath)
  const corpus = basename(abs).replace(/\.ndjson$/i, '')
  const outPath = opts.outPath ?? join(opts.artifactsDir ?? dirname(abs), `${corpus}.gate.json`)

  const parseErrors: GateError[] = []
  const events: unknown[] = []
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.trim().length === 0) return
    try {
      events.push(JSON.parse(line))
    } catch (e) {
      parseErrors.push({
        event: `line ${i + 1}`,
        code: 'NDJSON-PARSE',
        detail: (e as Error).message,
      })
    }
  })

  const gated = gateEvents(events, 'line')
  const errors = [...parseErrors, ...gated.errors]
  const report = gateReport(errors, gated.lostFacts, gated.eventCount)
  const score = scoreGate(report, opts.probe ?? null)

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  return { ok: score.ok, exitCode: score.exitCode, report, outPath, score }
}
