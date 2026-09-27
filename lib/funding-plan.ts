/**
 * Funding plan — how a set of jobs is turned into on-chain posts, and what
 * that costs in UserOps. Pure; `lib/delegation.ts` consumes it.
 *
 * The per-job path posts every subtask as its own ERC-4337 UserOp (one
 * approval + one postJob each). `groupWaveByPayer` is the batching rule: the
 * root wave of a plan, grouped by the wallet that pays, becomes one UserOp
 * per payer. `userOpsFor` states the saving so a status line can say it and
 * a test can pin it — the number of bundler round trips, not a gas estimate,
 * because the round trips are what the free-tier bundler rate-limits and
 * what dominated wall-clock on every multi-step desk.
 */

/** Group items by the wallet that pays for them, preserving first-seen
 *  order of payers and the items' own order within a payer. */
export function groupWaveByPayer<T>(items: readonly T[], payerOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = payerOf(item)
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return groups
}

/** UserOps a wave costs, per-job vs batched. */
export function userOpsFor(waveSizesByPayer: readonly number[]): { perJob: number; batched: number; saved: number } {
  const perJob = waveSizesByPayer.reduce((s, n) => s + n, 0)
  const batched = waveSizesByPayer.filter((n) => n > 0).length
  return { perJob, batched, saved: perJob - batched }
}

/** One line for a confirm reply or a log. */
export function fundingPlanInWords(waveSizesByPayer: readonly number[]): string {
  const { perJob, batched, saved } = userOpsFor(waveSizesByPayer)
  if (saved <= 0) return `${perJob} job${perJob === 1 ? '' : 's'} posted in ${batched} transaction${batched === 1 ? '' : 's'}`
  return `${perJob} jobs posted in ${batched} transaction${batched === 1 ? '' : 's'} (batched — ${saved} fewer than one per job)`
}
