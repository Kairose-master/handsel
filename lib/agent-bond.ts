/**
 * What a worker has to stake before it can take a job, and whether it can.
 *
 * V2 accepting is not free: `acceptJob` pulls a bond in USDC out of the
 * worker's own account and holds it until the job settles. That is a
 * deliberate design — a bond is what makes abandoning work cost something —
 * but it has a consequence nothing in this codebase said out loud:
 *
 *   a brand-new agent cannot take its FIRST job.
 *
 * It holds $0, the bond needs USDC, and the only way to earn USDC is to
 * complete a job. `hire_office` makes that acute rather than theoretical: it
 * stands up a desk of specialists, reports success, and every one of them is
 * structurally incapable of claiming anything until someone funds its wallet
 * by hand. The failure surfaces as `TransferFailed()` reverting inside a
 * UserOperation simulation, which reads like an RPC problem and is not one.
 *
 * So the bond gets the same treatment gas got: computed up front, checked
 * before an accept is attempted, and surfaced wherever an agent's readiness
 * is shown. `lib/agent-usdc-funding.ts` is the other half — the way float
 * actually reaches a worker.
 */

/** The contract's `bondFor(bounty)`, in USD.
 *
 *  Mirrored rather than called per job: a sweep tests one balance against
 *  many bounties, and the schedule is a pair of immutables that cannot change
 *  for a deployed address. `bondScheduleOf()` reads them from the bytecode —
 *  never from env — and this turns them into an amount. */
export function bondForBounty(bountyUsd: number, schedule: { flat: number; bps: number }): number {
  if (!(bountyUsd > 0)) return schedule.flat
  // Integer micro-USDC throughout: the contract works in 6-decimal units and
  // floating point on dollars rounds a $0.1155 bond to something that is not
  // it, which is exactly the kind of off-by-a-cent that turns an affordability
  // check into a revert.
  const bountyUnits = Math.round(bountyUsd * 1e6)
  const flatUnits = Math.round(schedule.flat * 1e6)
  return (flatUnits + Math.floor((bountyUnits * schedule.bps) / 10_000)) / 1e6
}

/** Total float an agent needs to hold to claim every one of these bounties at
 *  once. Bonds are held simultaneously, so this sums rather than maxes. */
export function bondFloatFor(bountyUsds: readonly number[], schedule: { flat: number; bps: number }): number {
  const units = bountyUsds.reduce((sum, b) => sum + Math.round(bondForBounty(b, schedule) * 1e6), 0)
  return units / 1e6
}

export type BondReadiness =
  | { ready: true; heldUsd: number; needUsd: number }
  | { ready: false; heldUsd: number; needUsd: number; shortUsd: number }
  /** The schedule could not be read, so affordability is unknown. Distinct
   *  from `false` on purpose: a probe failure must never be reported as "this
   *  agent cannot work", for the same reason the gas preflight does not skip
   *  on an unreadable balance. */
  | { ready: 'unknown'; heldUsd: number; needUsd: null }

/** Can this agent post the bond for a bounty of this size right now? Pure, so
 *  the arithmetic that decides whether a claim is even attempted is testable
 *  without a chain. */
export function bondReadiness(
  heldUsd: number,
  bountyUsd: number,
  schedule: { flat: number; bps: number } | null,
): BondReadiness {
  if (!schedule) return { ready: 'unknown', heldUsd, needUsd: null }
  const needUsd = bondForBounty(bountyUsd, schedule)
  // Compared in micro-units for the same reason bondForBounty computes in
  // them: `0.1155 <= 0.1155` is not reliably true after two float divisions.
  const heldUnits = Math.round(heldUsd * 1e6)
  const needUnits = Math.round(needUsd * 1e6)
  if (heldUnits >= needUnits) return { ready: true, heldUsd, needUsd }
  return { ready: false, heldUsd, needUsd, shortUsd: (needUnits - heldUnits) / 1e6 }
}
