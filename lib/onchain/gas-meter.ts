/**
 * The gas gate: enforce `lib/onchain/gas-policy.ts` against the ledger.
 *
 * Impure half. The policy decides; this counts, records, and refuses. Kept
 * apart so the interesting decisions stay testable without a database.
 */
import { db } from '@/lib/db'
import { agentEvent, sponsoredOp } from '@/lib/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { IS_REAL_MONEY } from './config'
import { dailyOpAllowance, decideSponsoredOp, type GasDecision } from './gas-policy'
import { collateralizedVolume } from '@/lib/credit-engine/scoring'

/** Start of the current UTC day. A rolling window would be fairer and would
 *  also mean every check scans a moving range; a day boundary is one index
 *  seek and is easy for an agent to reason about. */
function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** Sponsored operations this agent has already caused today, or null if the
 *  count could not be read — which the policy treats as a refusal, not as
 *  zero. */
async function usedToday(agentId: string, now: Date): Promise<number | null> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sponsoredOp)
      .where(and(eq(sponsoredOp.agentId, agentId), gte(sponsoredOp.at, dayStart(now))))
    return row?.n ?? 0
  } catch (error) {
    console.error('[gas-meter] could not read sponsored-op usage for', agentId, error)
    return null
  }
}

/**
 * Settled volume backing this agent's allowance, discounted exactly the way
 * the lending ceiling discounts it — repeat counterparties halved, pooled
 * counterparties sharing a bucket. Reusing `collateralizedVolume` is the
 * point: gas abuse is then bounded by the same convergent maths as borrowing,
 * rather than by a second set of rules that could disagree with the first.
 *
 * A read failure yields 0, which means the cold-start allowance. That is the
 * safe direction: an agent temporarily gets less gas, not more.
 */
async function settledVolumeUsd(agentId: string): Promise<number> {
  try {
    const rows = await db.select().from(agentEvent).where(eq(agentEvent.agentId, agentId))
    const trades = rows
      .filter((e) => e.eventType === 'JOB_COMPLETED')
      .map((e) => {
        const d = (e.detail ?? {}) as Record<string, unknown>
        return {
          amountUsd: typeof d.bounty === 'number' ? d.bounty : 0,
          counterparty: typeof d.requesterAgentId === 'string' ? d.requesterAgentId : null,
          counterpartyScore: typeof d.requesterScore === 'number' ? d.requesterScore : null,
          createdAt: e.createdAt,
        }
      })
    return collateralizedVolume(trades)
  } catch (error) {
    console.error('[gas-meter] could not read settled volume for', agentId, '— using the cold-start allowance:', error)
    return 0
  }
}

export type GasGateResult = GasDecision & { agentId: string }

/**
 * Claim one sponsored operation for `agentId`.
 *
 * Records BEFORE returning allow, so two concurrent requests cannot both see
 * the same headroom. The count is not transactional against the insert, so a
 * simultaneous pair can still both pass at the boundary — the window is one
 * operation wide, which is the right trade against putting a lock on every
 * on-chain call. It bounds the budget; it is not a precise quota.
 */
export async function claimSponsoredOp(agentId: string, now: Date = new Date()): Promise<GasGateResult> {
  const allowance = dailyOpAllowance({
    settledVolumeUsd: await settledVolumeUsd(agentId),
    isRealMoney: IS_REAL_MONEY,
  })
  const decision = decideSponsoredOp(await usedToday(agentId, now), allowance)
  if (!decision.allow) {
    console.warn(`[gas-meter] refused a sponsored operation for ${agentId}: ${decision.reason}`)
    return { ...decision, agentId }
  }

  try {
    await db.insert(sponsoredOp).values({ id: nanoid(), agentId, at: now })
  } catch (error) {
    // Refuse rather than proceed unrecorded. An operation the meter cannot see
    // is one the next check will not count, and a meter with holes in it is
    // the unmetered paymaster with extra steps.
    console.error('[gas-meter] could not record a sponsored operation for', agentId, error)
    return {
      allow: false,
      used: decision.used,
      allowance,
      remaining: 0,
      agentId,
      reason: 'The sponsored-gas meter could not record this operation, so it was refused rather than sent unmetered.',
    }
  }
  return { ...decision, agentId }
}

/** Throwing wrapper for call sites that have no sensible way to report a
 *  refusal. The message is the one an operator or an agent should read. */
export async function requireSponsoredOp(agentId: string, now: Date = new Date()): Promise<void> {
  const result = await claimSponsoredOp(agentId, now)
  if (!result.allow) throw new Error(result.reason)
}
