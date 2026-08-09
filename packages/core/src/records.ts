/**
 * Shared record-shaping helpers for modules whose output records are keyed by event ids
 * (`admit`'s `AdmitState`/`AdmissionIndex`, `store`'s `StoreState` lookups). Not in the
 * `exports` map — internal-only, the same role `./patch-matcher.js` plays for patch machinery.
 */

/**
 * Copy into a null-prototype record. Keys here are event ids — attacker-reachable strings before
 * SIG-1 has run — and `'__proto__'` as a key on a plain `{}` targets the output's prototype chain
 * instead of an own entry, silently diverging an incremental path from its oracle (2026-08-08
 * audit, S3-26). Both `admit` and `store` used to carry byte-identical copies of this builder
 * with duplicated rationale comments; the single copy lives here.
 */
export function toNullProtoRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out: Record<string, T> = Object.create(null) as Record<string, T>
  for (const [k, v] of entries) out[k] = v
  return out
}
