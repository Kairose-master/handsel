/**
 * Who actually calls LaborMarketV2's permissionless exits.
 *
 * The contract grew four of them — `expireOpen`, `reclaimJob`, `expireReview`,
 * `expireDispute` — each with a deadline, each callable by a stranger, each
 * tested against a real EVM. Then a grep for their names across `lib/`, `app/`
 * and `sdk/` returned **nothing**. The same was true of `withdraw()`: settlement
 * credits rather than transfers, and no code drained a credited balance.
 *
 * "Permissionless" means anyone MAY call it. It does not mean anyone WILL. Two
 * rounds of audit established that the contract *can* do the right thing when
 * a deadline passes; this file is what makes something *do* it. Without it the
 * timeouts are a property of the bytecode and not of the product, and the money
 * they were built to free sits exactly as long as it did before they existed.
 *
 * ## Why the decision is a pure function
 *
 * `dueDeadlines` takes jobs and a clock and returns the calls to make. It
 * touches no chain, no database and no wall clock, which is the only reason the
 * boundary conditions below can be tested at all — every one of them is an
 * off-by-one against a timestamp, and the contract's own guards are `>=`.
 *
 * The mapping mirrors the contract exactly, and the tests assert that each of
 * the four money-holding states maps to exactly one function. Getting this
 * table wrong is not a missed sweep; it is calling `reclaimJob` on a job that
 * is owed to a worker.
 */

/** LaborMarketV2's `Status` enum, in its on-chain numeric order.
 *
 *  `Expired` is index 7 and V1's decoder had seven entries with a `?? 'Open'`
 *  fall-through — so under V1's table every timeout-settled job reads back as an
 *  OPEN JOB ON THE BOARD. That is harmless today only because the V1 ABI in
 *  `lib/onchain/config.ts` targets a contract with no `Expired` state at all;
 *  it becomes a live defect the moment an address points at V2. The guard test
 *  parses this list against the enum in the Solidity source, so appending a
 *  state to the contract without appending it here fails the build. */
export const V2_JOB_STATUS = [
  'Open',
  'Accepted',
  'Submitted',
  'Completed',
  'Cancelled',
  'Disputed',
  'Refunded',
  'Expired',
] as const

export type V2JobStatus = (typeof V2_JOB_STATUS)[number]

/** The permissionless exits, named as the contract names them. */
export type ExitFn = 'expireOpen' | 'reclaimJob' | 'expireReview' | 'expireDispute'

/** Only the fields the decision needs. Deadlines are unix SECONDS, matching
 *  `block.timestamp`; a zero means the contract never set one. */
export type DeadlineJob = {
  id: number
  status: V2JobStatus
  openDeadline: number
  deliveryDeadline: number
  reviewDeadline: number
  disputeDeadline: number
}

export type DueExit = { jobId: number; fn: ExitFn; dueAt: number }

/**
 * Which state holds money, which deadline governs it, and which function frees
 * it. One row per money-holding state; every other state is terminal and has
 * nothing to do.
 */
const EXITS: ReadonlyArray<{ status: V2JobStatus; deadline: keyof DeadlineJob; fn: ExitFn }> = [
  { status: 'Open', deadline: 'openDeadline', fn: 'expireOpen' },
  { status: 'Accepted', deadline: 'deliveryDeadline', fn: 'reclaimJob' },
  { status: 'Submitted', deadline: 'reviewDeadline', fn: 'expireReview' },
  { status: 'Disputed', deadline: 'disputeDeadline', fn: 'expireDispute' },
]

/**
 * The deadline governing a job's current state, or null when that state holds no
 * money and has nothing pending.
 *
 * The same table `dueDeadlines` uses, exposed for READERS rather than sweepers.
 * A UI needs it for the reason the sweep exists at all: the contract's status
 * enum changes only when somebody CALLS an exit, so `Open` means "open, OR
 * lapsed and not yet settled". Those two are identical in `status` and differ in
 * whether `acceptJob` reverts — which is how the board came to offer Accept on a
 * job that had been unacceptable for 46 minutes, and why pressing it produced a
 * digest instead of a sentence.
 */
export function governingDeadline(job: DeadlineJob): number | null {
  const exit = EXITS.find((e) => e.status === job.status)
  if (!exit) return null
  const at = job[exit.deadline] as number
  // Same zero-guard as dueDeadlines: a missing deadline is "unknown", never
  // "overdue since 1970".
  return at > 0 ? at : null
}

/** Whether the state is stale: the deadline passed and no exit has run yet. */
export function hasLapsed(job: DeadlineJob, nowSec: number): boolean {
  const at = governingDeadline(job)
  // `>=` matches every guard in the contract, and dueDeadlines below.
  return at !== null && nowSec >= at
}

/**
 * The calls that are due right now, oldest deadline first.
 *
 * Oldest-first because a capped pass must not starve the job that has been
 * waiting longest — the failure mode of a newest-first sweep is one stuck job
 * that is never reached while the queue keeps being served.
 *
 * @param nowSec seconds since epoch, passed in rather than read, so a test can
 *               sit exactly on a deadline boundary.
 */
export function dueDeadlines(jobs: readonly DeadlineJob[], nowSec: number): DueExit[] {
  const due: DueExit[] = []
  for (const job of jobs) {
    const exit = EXITS.find((e) => e.status === job.status)
    if (!exit) continue // terminal: Completed, Cancelled, Refunded, Expired
    const dueAt = job[exit.deadline] as number
    // A zero deadline means the contract never wrote one, which for a job in
    // this status should be impossible. Treat it as "not due" rather than as
    // "due since 1970": the states are read off-chain, and a decode that went
    // wrong must not be able to produce a settlement call.
    if (dueAt <= 0) continue
    // `>=` and not `>`, because that is what every guard in the contract uses.
    // At exactly the deadline the call succeeds on-chain, so a sweep that waits
    // one more second is a sweep that disagrees with the thing it is calling.
    if (nowSec < dueAt) continue
    due.push({ jobId: job.id, fn: exit.fn, dueAt })
  }
  return due.sort((a, b) => a.dueAt - b.dueAt || a.jobId - b.jobId)
}

/** Most exits to attempt in one pass.
 *
 *  Small on purpose. These ride the ops cycle, which runs on visitor traffic,
 *  and each one is a sponsored UserOp costing the operator real gas. A sweep
 *  bounded by "how many jobs exist" is a sweep whose cost is set by an
 *  attacker; oldest-first means a small cap still drains the queue. */
export const MAX_EXITS_PER_PASS = 3
