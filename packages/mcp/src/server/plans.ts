/**
 * The plan store under `<root>/.scrutiny/plans/` (spec §5.1). `draft_plan` writes every drafted
 * plan as `<plan_hash>.json`; `publish_plan` reads it back and re-drafts it to prove nothing
 * changed since the user saw it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileFacts } from '../plan/files.js'

export function planPath(root: string, planHash: string): string {
  return join(root, '.scrutiny', 'plans', `${planHash}.json`)
}

export interface StoredPlan {
  readonly plan: unknown
  /** True when the draft, including its network checks, raised no blocking question. */
  readonly ready: boolean
}

export async function savePlan(
  root: string,
  planHash: string,
  stored: StoredPlan,
): Promise<string> {
  const path = planPath(root, planHash)
  await mkdir(join(root, '.scrutiny', 'plans'), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  await rename(temp, path)
  return path
}

export async function loadPlan(root: string, planHash: string): Promise<StoredPlan | null> {
  if (!/^[0-9a-f]{64}$/u.test(planHash)) return null
  try {
    const parsed = JSON.parse(
      await readFile(planPath(root, planHash), 'utf8'),
    ) as Partial<StoredPlan>
    return { plan: parsed.plan, ready: parsed.ready === true }
  } catch {
    return null
  }
}

/** Reads a plan file named relative to `root`; null when it escapes the root or cannot be read. */
export async function readPlanFile(
  root: string,
  path: string,
): Promise<
  { readonly kind: 'ok'; readonly plan: unknown } | { readonly kind: 'outside' | 'unreadable' }
> {
  const facts = await fileFacts(root, path, false)
  if (facts.kind === 'outside') return { kind: 'outside' }
  if (facts.kind !== 'exists') return { kind: 'unreadable' }
  try {
    return { kind: 'ok', plan: JSON.parse(await readFile(join(root, path), 'utf8')) as unknown }
  } catch {
    return { kind: 'unreadable' }
  }
}
