/**
 * An office paying the bond for its own workers.
 *
 * Accepting a job stakes USDC out of the worker's account (lib/agent-bond.ts).
 * For a desk that is absurd on its face: the owner posted the job, the owner
 * escrowed the bounty, the owner picked which of their agents would do it, and
 * then that agent is turned away at the door for want of eleven cents of the
 * same owner's money. `fund_agent_usdc` exists for the manual case; this is
 * the automatic one, and it is deliberately much narrower.
 *
 * It fires ONLY for a job reserved to this exact worker — an office pipeline
 * step, assigned at post time by `assignedAgentFor`. That restriction is the
 * whole safety argument, and it is not a detail:
 *
 *   Anyone can post a job. If a worker topped itself up from the owner's
 *   wallet for ANY job it fancied, a stranger could post work priced to drain
 *   the funder into bonds — and a bond on abandoned work is burned, not
 *   returned. Gating on the reservation means only work the owner themselves
 *   created and assigned can move the owner's money.
 *
 * Three further limits, each closing a way the narrow case could still go
 * wrong:
 *
 *  - It tops up to the bond and no further. Not a round number, not a buffer.
 *    The amount is what the chain is about to charge, computed from the
 *    contract's own immutables.
 *  - It never sends from an agent that is not the caller's. `fundAgentUsdc`
 *    re-checks ownership on both ends; this passes the userId it read off the
 *    worker row, never anything a caller supplied.
 *  - A failure is not fatal. If the top-up cannot happen the accept proceeds
 *    and the chain refuses it, exactly as it does today. This may not become
 *    a new way for a claim to die.
 */
// Structural, not the full agent row: this module needs four fields and
// importing the schema type would drag the db into a file the scheduler side
// can reason about on its own.
type WorkerLike = {
  id: string
  name: string
  userId: string
  smartAccountAddress: string | null
}

/** Hard ceiling per top-up. A bond is a percentage of a bounty, so a
 *  pathological bounty implies a pathological bond; this bounds the blast
 *  radius of a mis-priced office job to something an owner would shrug at. */
export const MAX_AUTO_BOND_COVER_USD = 2

export type BondCoverOutcome =
  | { covered: false; why: 'not-reserved' | 'already-funded' | 'unknown-bond' | 'over-cap' | 'no-funder' }
  | { covered: false; why: 'failed'; error: string }
  | { covered: true; amountUsd: number; from: string; txHash: string }

/**
 * Make sure `worker` can stake the bond on `bounty`, if and only if this job
 * is reserved to it.
 *
 * Returns why it did nothing rather than throwing, so the caller can log a
 * reason and carry on to the accept either way.
 */
export async function coverBondForAssignedJob(input: {
  worker: WorkerLike
  specHash: string | undefined
  bountyUsd: number
}): Promise<BondCoverOutcome> {
  const { worker, specHash, bountyUsd } = input
  if (!specHash || !worker.smartAccountAddress) return { covered: false, why: 'not-reserved' }

  // The gate. `assignedAgentFor`, not `reservedAgentFor`: ownership of an
  // office's own work does not expire after the claim-priority window, and a
  // desk whose bond cover switched off after thirty minutes would be a worse
  // bug than the one this fixes.
  const { assignedAgentFor } = await import('@/lib/job-reservation')
  const assignedTo = await assignedAgentFor(specHash).catch(() => null)
  if (assignedTo !== worker.id) return { covered: false, why: 'not-reserved' }

  const { bondReadiness } = await import('@/lib/agent-bond')
  const { bondScheduleOf } = await import('@/lib/onchain/labor-v2')
  const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
  const [schedule, heldUsd] = await Promise.all([
    bondScheduleOf().catch(() => null),
    usdcBalanceOf(worker.smartAccountAddress as `0x${string}`).catch(() => null),
  ])
  if (schedule === null || heldUsd === null) return { covered: false, why: 'unknown-bond' }

  const verdict = bondReadiness(heldUsd, bountyUsd, schedule)
  if (verdict.ready !== false) return { covered: false, why: 'already-funded' }
  if (verdict.shortUsd > MAX_AUTO_BOND_COVER_USD) return { covered: false, why: 'over-cap' }

  // Whoever on this account can actually pay, excluding the worker itself.
  // Ordered by balance so a desk does not drain a wallet that is nearly empty
  // while a funded one sits idle.
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const siblings = await db
    .select({ id: agent.id, smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.userId, worker.userId))
  const balances = await Promise.all(
    siblings
      .filter((s) => s.smartAccountAddress && s.id !== worker.id)
      .map(async (s) => ({
        id: s.id,
        usd: await usdcBalanceOf(s.smartAccountAddress as `0x${string}`).catch(() => 0),
      })),
  )
  balances.sort((a, b) => b.usd - a.usd)
  const funder = balances[0]
  if (!funder || funder.usd <= 0) return { covered: false, why: 'no-funder' }

  // Round the shortfall UP to the cent. Sending the exact shortfall risks
  // landing a fraction under after rounding anywhere in the path, and a
  // top-up that leaves the worker one micro-unit short has done nothing at
  // all — the accept still reverts and the gas is still spent.
  const amountUsd = Math.ceil(verdict.shortUsd * 100) / 100

  const { fundAgentUsdc } = await import('@/lib/agent-usdc-funding')
  const res = await fundAgentUsdc(worker.userId, funder.id, worker.id, { amountUsd })
  if (!res.ok) return { covered: false, why: 'failed', error: res.error }
  return { covered: true, amountUsd: res.amountUsd, from: res.from, txHash: res.txHash }
}
