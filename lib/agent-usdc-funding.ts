/**
 * Moving bond float from one of your agents to another.
 *
 * The counterpart to lib/agent-bond.ts. A worker needs USDC before it can
 * accept its first job, and until this existed the only ways to get it there
 * were an external transfer per wallet or completing a job the agent could not
 * accept. For an office that is absurd: the owner already funded the desk, the
 * bounties are already escrowed, and every wallet involved belongs to the same
 * person — the float just has to reach the workers.
 *
 * The rules are narrower than the ETH withdrawal's, because this moves money
 * between accounts rather than out to a vetted one:
 *
 * Both ends must belong to the caller. Not one — both. A funder-only check
 * would turn this into "send my USDC to any agent id", which is a transfer to
 * a stranger's wallet reachable from a connector.
 *
 * The source keeps a reserve. An agent that is also a delegation prime pays
 * for escrow out of the same balance, and a funding call that empties it turns
 * "my worker can now claim" into "my prime can no longer post".
 */
import { bondFloatFor } from '@/lib/agent-bond'

/** Left in the source agent. One small bounty's worth of escrow, so funding a
 *  desk never silently disarms the account that pays for it. */
export const USDC_FUNDING_RESERVE_USD = 0.5

/** Below this the gas costs more than the transfer moves. */
export const USDC_FUNDING_DUST_USD = 0.01

export type UsdcFundingPlan =
  | { ok: true; amountUsd: number; leavesUsd: number }
  | {
      ok: false
      reason: 'nothing-to-send' | 'below-dust' | 'more-than-held'
      heldUsd: number
      maxUsd: number
    }

/** How much the source can actually send. Pure. */
export function planUsdcFunding(input: {
  heldUsd: number
  requestedUsd: number
  /** Send past the reserve. For an owner deliberately draining a funder. */
  drain?: boolean
}): UsdcFundingPlan {
  const reserve = input.drain ? 0 : USDC_FUNDING_RESERVE_USD
  const heldUnits = Math.round(input.heldUsd * 1e6)
  const maxUnits = Math.max(0, heldUnits - Math.round(reserve * 1e6))
  const maxUsd = maxUnits / 1e6
  if (maxUnits <= 0) return { ok: false, reason: 'nothing-to-send', heldUsd: input.heldUsd, maxUsd: 0 }
  const wantUnits = Math.round(input.requestedUsd * 1e6)
  if (wantUnits > maxUnits) return { ok: false, reason: 'more-than-held', heldUsd: input.heldUsd, maxUsd }
  if (wantUnits < Math.round(USDC_FUNDING_DUST_USD * 1e6)) {
    return { ok: false, reason: 'below-dust', heldUsd: input.heldUsd, maxUsd }
  }
  return { ok: true, amountUsd: wantUnits / 1e6, leavesUsd: (heldUnits - wantUnits) / 1e6 }
}

/** Parse a human "0.25" into USD, refusing anything that is not a plain
 *  positive decimal with at most 6 places — the token's precision. */
export function parseUsdcAmount(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Bond float a worker needs to hold to claim all of these bounties at once,
 *  rounded UP to the cent so a transfer never lands a hundredth short. */
export function suggestedFloatFor(
  bountyUsds: readonly number[],
  schedule: { flat: number; bps: number },
): number {
  return Math.ceil(bondFloatFor(bountyUsds, schedule) * 100) / 100
}

export type UsdcFundingResult =
  | { ok: true; txHash: string; amountUsd: number; from: string; to: string }
  | { ok: false; error: string }

/**
 * Send USDC from one of the caller's agents to another of them.
 *
 * Ownership of BOTH ends is checked here so no entry point can forget, the
 * same way lib/agent-eth-withdraw.ts and lib/mcp-worker-wiring.ts do it.
 */
export async function fundAgentUsdc(
  userId: string,
  fromAgentId: string,
  toAgentId: string,
  opts: { amountUsd: number; drain?: boolean },
): Promise<UsdcFundingResult> {
  if (fromAgentId === toAgentId) return { ok: false, error: 'Source and destination are the same agent.' }

  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { inArray } = await import('drizzle-orm')

  const rows = await db
    .select({ id: agent.id, name: agent.name, userId: agent.userId, smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(inArray(agent.id, [fromAgentId, toAgentId]))

  const from = rows.find((r) => r.id === fromAgentId)
  const to = rows.find((r) => r.id === toAgentId)
  // Same message for "does not exist" and "is not yours": an owner-scoped
  // lookup that distinguishes them is an existence oracle for other people's
  // agent ids.
  if (!from || from.userId !== userId) return { ok: false, error: 'Funding agent not found' }
  if (!to || to.userId !== userId) return { ok: false, error: 'Destination agent not found' }
  if (!from.smartAccountAddress) return { ok: false, error: `${from.name} has no on-chain account` }
  if (!to.smartAccountAddress) return { ok: false, error: `${to.name} has no on-chain account — provision it first` }

  const { usdcBalanceOf, transferUsdc } = await import('@/lib/onchain/treasury')
  const heldUsd = await usdcBalanceOf(from.smartAccountAddress as `0x${string}`)
  const plan = planUsdcFunding({ heldUsd, requestedUsd: opts.amountUsd, drain: opts.drain })
  if (!plan.ok) {
    if (plan.reason === 'nothing-to-send') {
      return {
        ok: false,
        error: `${from.name} holds $${plan.heldUsd.toFixed(2)}, at or under the $${USDC_FUNDING_RESERVE_USD.toFixed(2)} kept back so it can still escrow work. Pass drain to send it anyway.`,
      }
    }
    if (plan.reason === 'more-than-held') {
      return {
        ok: false,
        error: `${from.name} can send at most $${plan.maxUsd.toFixed(2)} right now (holds $${plan.heldUsd.toFixed(2)}, keeping a reserve).`,
      }
    }
    return { ok: false, error: 'That is below the dust floor — the transfer would cost more than it moves.' }
  }

  try {
    const txHash = await transferUsdc(fromAgentId, to.smartAccountAddress as `0x${string}`, plan.amountUsd)
    return { ok: true, txHash, amountUsd: plan.amountUsd, from: from.name, to: to.name }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
