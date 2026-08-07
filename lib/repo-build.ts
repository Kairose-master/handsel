/**
 * The repo-goal lane of the build service (docs/build-service.md,
 * increment 2) — the pure piece: turning a budget into a bounty.
 *
 * v1 decision, made explicit rather than left implicit, because the doc
 * calls out that it must be: **a build is exactly one repo job**, not a
 * planner-decomposed N. `lib/delegation.ts` has zero repo-goal awareness
 * today (confirmed by grep, not assumed), so decomposing a goal into
 * multiple repo jobs is a future increment, not this one. A build's whole
 * budget therefore funds one job's bounty plus the platform's posting fee
 * (`lib/platform-fee.ts`), and never more than that — the split below is
 * what keeps "give a budget, get a deliverable, failed attempts cost
 * nothing" honest at goal scale instead of just subtask scale.
 */
import { parseUnits, formatUnits } from 'viem'
import { feeForBounty, platformFeeBps } from '@/lib/platform-fee'

const USDC_DECIMALS = 6

/** Base units (string, matches lib/build-envelope.ts) → a USD float, for the
 *  fee math below. The reverse of `usdToBaseUnits`. */
export function baseUnitsToUsd(baseUnits: string): number {
  return Number(formatUnits(BigInt(baseUnits), USDC_DECIMALS))
}

/** A USD float → base units (string). Rounds to the cent first — the same
 *  precision every USD amount in this codebase already carries — so a float
 *  artifact like 9.799999999999999 never becomes a base-unit amount one
 *  atomic unit off from what a human reading "$9.80" would expect. */
export function usdToBaseUnits(usd: number): string {
  return parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS).toString()
}

/**
 * The largest (bountyUsd, feeUsd) pair whose sum fits inside budgetUsd, at
 * the given fee rate. Returns null when the budget cannot fund even a
 * 1-cent bounty — the honest "this budget is too small to build anything"
 * answer, not a build posted for $0.
 *
 * Starts from the closed-form estimate (budget / (1 + bps/10000)) and steps
 * down by a cent if rounding pushed the sum over budget — bounded to a
 * handful of iterations since `platformFeeBps()` is capped at 20%.
 */
export function bountyFromBudget(
  budgetUsd: number,
  bps: number = platformFeeBps(),
): { bountyUsd: number; feeUsd: number } | null {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return null
  // Floor, not round: budgetUsd can carry sub-cent precision inherited from
  // base units, and rounding UP here could let a derived (bounty + fee) exceed
  // the actual base-unit budget by a cent — draw() would then reject a build
  // that looked fundable. Flooring means the worst case is a build refused
  // for being a fraction of a cent short, never one that overspends.
  const budgetCents = Math.floor(budgetUsd * 100)

  let bountyCents = Math.floor(budgetCents / (1 + bps / 10000))
  while (bountyCents >= 1) {
    const bountyUsd = bountyCents / 100
    const feeUsd = feeForBounty(bountyUsd, bps)
    if (Math.round((bountyUsd + feeUsd) * 100) <= budgetCents) {
      return { bountyUsd, feeUsd }
    }
    bountyCents -= 1
  }
  return null
}
