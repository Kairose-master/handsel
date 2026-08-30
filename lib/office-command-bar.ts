/**
 * The office's operational headline — the numbers an owner checks first.
 *
 * Modelled on the reference dashboard, with one rule applied throughout:
 * every figure here is a live query or it is not here. CLAUDE.md's "no fake
 * data, ever" is load-bearing on this page specifically, because a strip of
 * confident numbers across the top is the most believable place in a UI to
 * put a lie.
 *
 * What the reference has that this does NOT, and why:
 *
 *  - **Success rate.** There is no per-task success column. A job's outcome
 *    lives on-chain and in grading records; a percentage assembled from a
 *    partial view of those would be a number nobody could reproduce.
 *  - **Average task time.** `agent_tasks` has createdAt/updatedAt, but
 *    `updatedAt` moves for reasons other than completion, so the difference
 *    is not a duration.
 *  - **Cost per task / budget remaining.** No cost is recorded per task.
 *    `result.tokenCost` exists only when a runtime happens to report it, so
 *    summing it would silently mean "the runtimes that self-report", not
 *    "what this office spent".
 *  - **Office level / XP.** Invented gamification with no underlying fact.
 *
 * Burn IS real: `gas_spend` records estimated USD per sponsored operation,
 * which is money this account actually spent. It is labelled as gas rather
 * than as total burn, because gas is what it is.
 */

export type CommandBarView = {
  /** Real USDC + gas the office's own agents hold. */
  treasuryUsd: number | null
  /** Agents on this office's roster, and how many are provisioned to work. */
  agents: { total: number; provisioned: number }
  /** Tasks a runtime is executing right now. */
  runningTasks: number
  /** Deliverables submitted and waiting on a human or a grader. */
  waitingApproval: number
  /** Things only a person can clear — escalations raised to the owner. */
  humanDecisions: number
  /** Gas actually spent in the last 24h, from gas_spend. Null when nothing
   *  has been sponsored, which is different from zero-and-known. */
  gasUsd24h: number | null
}

/** A metric with no honest source is omitted, not zeroed — a confident 0 is
 *  a claim, and "we do not measure this" is a different statement. */
export function isMeasured<T>(value: T | null): value is T {
  return value !== null && value !== undefined
}

/** Gas per hour from a 24h total, for a headline that reads like a rate.
 *  Returns null rather than 0 when nothing was spent: an office that
 *  sponsored nothing has no rate, and printing "$0.00/h" invites the reader
 *  to conclude the meter is running and cheap. */
export function burnPerHour(gasUsd24h: number | null): number | null {
  if (gasUsd24h === null || gasUsd24h <= 0) return null
  return gasUsd24h / 24
}

/** `18 / 24` in the reference. Provisioned is the half that can actually
 *  take a job — an agent with no smart account cannot accept one, so a
 *  roster count on its own overstates the desk. */
export function agentsLabel(agents: { total: number; provisioned: number }): string {
  return `${agents.provisioned} / ${agents.total}`
}
