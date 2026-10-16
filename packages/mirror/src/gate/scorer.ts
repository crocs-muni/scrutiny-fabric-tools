/**
 * gate/scorer.ts — final verdict + process exit-code semantics for the gate.
 *
 * The gate's own verdict (GateReport.ok) is exactly
 *   errors.length === 0 && lostFacts.length === 0.
 * The scorer adds the relay probe (stage-3 preflight, written by the probe unit) as
 * a duck-typed input: a probe that is not publish-ready makes the batch fail even
 * when every event is clean.
 */

import type { GateReport } from '../types.js'
import type { GateError } from './verify.js'

/**
 * Shape of the relay probe JSON (NIP-11-driven). Duck-typed on purpose: only
 * `verdict`, `supported_nips` and `relay` are read, the rest is passed through.
 */
export interface ProbeReport {
  relay?: string
  verdict?: string
  supported_nips?: number[]
  [key: string]: unknown
}

/** NIPs the publish stage requires: NIP-01 (events) + NIP-42 (relay auth). */
export const REQUIRED_NIPS: readonly number[] = [1, 42]

const PUBLISH_READY_VERDICTS: Record<string, true> = {
  ok: true,
  pass: true,
  reachable: true,
  supported: true,
}

export interface GateScore {
  /** errors===0 && lostFacts===0 && no probe blocker. */
  ok: boolean
  /** 0 when ok, 1 otherwise. */
  exitCode: 0 | 1
  reasons: string[]
  /** Findings contributed by the probe (empty when no probe was supplied). */
  probeErrors: GateError[]
}

export function scoreGate(report: GateReport, probe?: ProbeReport | null): GateScore {
  const probeErrors: GateError[] = []
  if (probe) {
    const verdict = typeof probe.verdict === 'string' ? probe.verdict.toLowerCase() : null
    if (verdict !== null && PUBLISH_READY_VERDICTS[verdict] !== true) {
      probeErrors.push({
        event: null,
        code: 'PROBE-VERDICT',
        detail: `relay probe verdict '${probe.verdict}' is not publish-ready`,
      })
    }
    if (Array.isArray(probe.supported_nips)) {
      const missing = REQUIRED_NIPS.filter((n) => !(probe.supported_nips as number[]).includes(n))
      if (missing.length > 0) {
        probeErrors.push({
          event: null,
          code: 'PROBE-NIPS',
          detail: `relay NIP-11 supported_nips lacks required ${missing.join(', ')}`,
        })
      }
    }
  }

  const baseOk = report.errors.length === 0 && report.lostFacts.length === 0
  const ok = baseOk && probeErrors.length === 0

  const reasons: string[] = []
  if (report.errors.length > 0) reasons.push(`${report.errors.length} gate error(s)`)
  if (report.lostFacts.length > 0) reasons.push(`${report.lostFacts.length} lost fact(s)`)
  for (const e of probeErrors) reasons.push(`${e.code}: ${e.detail}`)
  if (ok) reasons.push('clean: no errors, no lost facts, publish-ready probe')

  return { ok, exitCode: ok ? 0 : 1, reasons, probeErrors }
}
