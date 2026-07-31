/**
 * Where a worker's money actually is, told in three places instead of one.
 *
 * A worker finished a job on mainnet, earned 0.1 USDC, and its wallet went from
 * 0.5 to 0.465 — so the first reading was that working had cost it money. Both
 * numbers were right. What was missing is that a worker's USDC lives in three
 * places at once and the wallet is only one of them:
 *
 *   - the WALLET, which is what every balance display shows
 *   - a BOND, posted on accept and held by the contract until the job settles
 *   - a CLAIM, credited by settlement and waiting for `withdraw()`
 *
 * Two of those are invisible, and both move in the direction that looks like
 * loss: the bond leaves the wallet, and the claim has not arrived in it. A
 * worker mid-job therefore shows its lowest number at exactly the moment it is
 * owed the most.
 *
 * Made worse here by a coincidence in the deployed parameters. `FLAT_FEE` and
 * `FLAT_BOND` are both 0.03, `FEE_BPS` and `BOND_BPS` are both 500, so the fee
 * a requester pays and the bond a worker posts are the SAME NUMBER at every
 * bounty. At 0.1 they are both 0.035, and the question that followed was whether
 * the bond had been taken as the fee. It had not — `LaborMarketV2` credits it
 * back to the worker as its own leg, and only `reclaimJob` ever takes it, by
 * burning it. But nothing on screen made that checkable.
 *
 * Pure, because the arithmetic is where the confusion is and the arithmetic
 * should be testable without a chain.
 */

/** The bond schedule, mirroring `bondFor` in LaborMarketV2. */
export type BondSchedule = {
  /** `FLAT_BOND` in whole USDC. */
  flat: number
  /** `BOND_BPS`, e.g. 500 for 5%. */
  bps: number
}

/** One job this worker has accepted and not yet settled. */
export type OpenCommitment = {
  jobId: number
  bounty: number
  /** Contract status name, for saying WHY the bond is still held. */
  status: string
}

export type WorkerFunds = {
  /** Spendable now. */
  wallet: number
  /** Posted as bond on jobs that have not settled. Comes back on completion. */
  bonded: number
  /** Credited by settlement, waiting for `withdraw()`. */
  claimable: number
  /** wallet + bonded + claimable. What the worker is worth. */
  total: number
  /** The jobs the bond is sitting on, so the number is traceable. */
  commitments: Array<OpenCommitment & { bond: number }>
}

/** `bondFor(bounty)` — flat plus a share, the same shape as the fee. */
export function bondFor(bounty: number, schedule: BondSchedule): number {
  if (!Number.isFinite(bounty) || bounty <= 0) return 0
  return round6(schedule.flat + (bounty * schedule.bps) / 10_000)
}

/**
 * Statuses where the contract is still holding the bond.
 *
 * Accepted and Submitted only. Once a job reaches Completed the bond has been
 * credited back and belongs to `claimable`; counting it in both would overstate
 * the total, which is the opposite error and just as wrong.
 */
const BOND_HELD_IN = new Set(['Accepted', 'Submitted', 'Disputed'])

export function isBondHeld(status: string): boolean {
  return BOND_HELD_IN.has(status)
}

/** Assemble the three places, from values the caller read. */
export function workerFunds(input: {
  wallet: number
  claimable: number
  openJobs: OpenCommitment[]
  schedule: BondSchedule
}): WorkerFunds {
  const commitments = input.openJobs
    .filter((j) => isBondHeld(j.status))
    .map((j) => ({ ...j, bond: bondFor(j.bounty, input.schedule) }))
  const bonded = round6(commitments.reduce((sum, c) => sum + c.bond, 0))
  const wallet = safe(input.wallet)
  const claimable = safe(input.claimable)
  return { wallet, bonded, claimable, total: round6(wallet + bonded + claimable), commitments }
}

/**
 * Whether the wallet alone is telling the worker something false.
 *
 * The condition for showing an explanation rather than just three numbers: the
 * wallet is down on where it started, and the difference is money the worker
 * still has somewhere else.
 */
export function walletUnderstates(funds: WorkerFunds): boolean {
  return funds.bonded + funds.claimable > 0 && funds.total > funds.wallet
}

const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
