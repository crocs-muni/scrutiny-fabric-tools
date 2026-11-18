/**
 * One publish run at a time per plan. Spec §3 accepts a single cooperating publisher per machine,
 * so this is an in-process queue: two tool calls never open the same journal snapshot and sign the
 * same refs twice.
 */

/** Tail of the queue per `root\0plan_hash`: settles when the run at the head is done, pass or fail. */
const tails = new Map<string, Promise<void>>()

export async function withRunLock<T>(
  root: string,
  planHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${root}\0${planHash}`
  const previous = tails.get(key) ?? Promise.resolve()
  const run = (async () => {
    await previous
    return fn()
  })()
  // The tail swallows the outcome: a failed run must not poison the next holder.
  const tail = run.then(
    () => {},
    () => {},
  )
  tails.set(key, tail)
  try {
    return await run
  } finally {
    // A call arriving while one is in flight overwrites the tail; the last one to do so deletes
    // the key, so the map holds only plans with a run in flight or queued.
    if (tails.get(key) === tail) tails.delete(key)
  }
}
