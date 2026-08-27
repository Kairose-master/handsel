/**
 * Moving gas money from one of your agents to another.
 *
 * The ETH counterpart to lib/agent-usdc-funding.ts, and the missing third
 * corner of a set that was two-thirds built: an agent could receive ETH from
 * outside, and `withdrawAgentEth` could send it back to the owner's payout
 * address, but there was no way to move it sideways. On a deployment with no
 * paymaster that gap is not cosmetic — ETH is the difference between an agent
 * that works and one that cannot transact at all — and it bit twice in one
 * session:
 *
 *  - `hire_office` used to mint a fresh agent per role, each with no ETH, so a
 *    second hire produced a desk that could never act (fixed by reuse, but a
 *    genuinely new role still starts empty);
 *  - three roles on an existing desk read `NO ETH — cannot transact if gas is
 *    unsponsored`, next to six siblings holding 0.001 each, with no in-app way
 *    to even out.
 *
 * The rules mirror the USDC version, because the risks are the same shape:
 *
 * Both ends must belong to the caller. Not just the source — a funder-only
 * check turns this into "send my ETH to any agent id", which is a transfer to
 * a stranger's wallet reachable from a connector.
 *
 * The source keeps a reserve. The transfer is itself a UserOperation paid out
 * of the same balance, so a send that empties the account either fails
 * outright or lands and leaves the funder unable to transact — and unable to
 * fund its own rescue. That is the same reasoning as the withdrawal's, so it
 * uses the same number rather than inventing a second one.
 */
import { formatEther, type Address } from 'viem'
import { ETH_WITHDRAW_RESERVE_WEI, ETH_WITHDRAW_DUST_WEI, parseEthAmount } from '@/lib/agent-eth-withdraw'

/** Kept in the funder so it can still act, and so this transfer can be paid
 *  for. Deliberately the withdrawal's reserve: both answer "how much must stay
 *  behind for this account to remain usable", and two numbers for one question
 *  drift. */
export const ETH_FUNDING_RESERVE_WEI = ETH_WITHDRAW_RESERVE_WEI

/** Below this the gas costs more than the transfer moves. */
export const ETH_FUNDING_DUST_WEI = ETH_WITHDRAW_DUST_WEI

/**
 * What a topped-up agent should end up holding when no amount is given.
 *
 * Matches AGENT_GAS_TOPUP in lib/onchain/account.ts — one working session's
 * worth, the same figure the oracle uses when it refills an EOA. Sizing the
 * default to the FLOOR instead would leave the agent one call from stopping,
 * which is the state this tool exists to get an agent out of.
 */
export const ETH_FUNDING_TARGET_WEI = 200_000_000_000_000n // 0.0002 ETH

export type EthFundingPlan =
  | { ok: true; amountWei: bigint; leavesWei: bigint }
  | {
      ok: false
      reason: 'nothing-to-send' | 'below-dust' | 'more-than-held' | 'already-funded'
      heldWei: bigint
      maxWei: bigint
    }

/**
 * How much the funder can actually send. Pure — the arithmetic that decides
 * how much of someone's money moves is testable without a chain.
 *
 * `requestedWei` omitted means "bring the destination up to
 * ETH_FUNDING_TARGET_WEI", which needs the destination's balance; pass it as
 * `targetHeldWei`.
 */
export function planEthFunding(input: {
  heldWei: bigint
  /** What the destination holds now. Only consulted when no amount is given. */
  targetHeldWei: bigint
  requestedWei?: bigint
  /** Send past the reserve. For an owner deliberately draining a funder. */
  drain?: boolean
}): EthFundingPlan {
  const reserve = input.drain ? 0n : ETH_FUNDING_RESERVE_WEI
  const maxWei = input.heldWei > reserve ? input.heldWei - reserve : 0n
  if (maxWei <= 0n) {
    return { ok: false, reason: 'nothing-to-send', heldWei: input.heldWei, maxWei: 0n }
  }

  let amountWei = input.requestedWei
  if (amountWei === undefined) {
    // Top up to the target rather than sending a fixed amount: repeating this
    // call on an already-funded agent should be a no-op, not a second
    // transfer. Idempotence is what makes it safe to call from a script.
    if (input.targetHeldWei >= ETH_FUNDING_TARGET_WEI) {
      return { ok: false, reason: 'already-funded', heldWei: input.heldWei, maxWei }
    }
    amountWei = ETH_FUNDING_TARGET_WEI - input.targetHeldWei
  }

  if (amountWei > maxWei) return { ok: false, reason: 'more-than-held', heldWei: input.heldWei, maxWei }
  if (amountWei < ETH_FUNDING_DUST_WEI) return { ok: false, reason: 'below-dust', heldWei: input.heldWei, maxWei }
  return { ok: true, amountWei, leavesWei: input.heldWei - amountWei }
}

export { parseEthAmount }

export type EthFundingResult =
  | { ok: true; txHash: string; amountWei: string; from: string; to: string; toAddress: Address }
  | { ok: false; error: string }

/**
 * Send ETH from one of the caller's agents to another of them.
 *
 * Ownership of BOTH ends is checked here so no entry point can forget — the
 * same shape as lib/agent-usdc-funding.ts and lib/agent-eth-withdraw.ts.
 */
export async function fundAgentEth(
  userId: string,
  fromAgentId: string,
  toAgentId: string,
  opts: { requestedWei?: bigint; drain?: boolean } = {},
): Promise<EthFundingResult> {
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
  // The same message for "does not exist" and "is not yours": an owner-scoped
  // lookup that distinguishes them is an existence oracle for other people's
  // agent ids.
  if (!from || from.userId !== userId) return { ok: false, error: 'Funding agent not found' }
  if (!to || to.userId !== userId) return { ok: false, error: 'Destination agent not found' }
  if (!from.smartAccountAddress) return { ok: false, error: `${from.name} has no on-chain account` }
  if (!to.smartAccountAddress) {
    return { ok: false, error: `${to.name} has no on-chain account — provision it first, or the ETH goes nowhere useful` }
  }

  const { ethBalanceOfWei, transferEth } = await import('@/lib/onchain/treasury')
  const [heldWei, targetHeldWei] = await Promise.all([
    ethBalanceOfWei(from.smartAccountAddress as Address),
    ethBalanceOfWei(to.smartAccountAddress as Address),
  ])

  const plan = planEthFunding({ heldWei, targetHeldWei, requestedWei: opts.requestedWei, drain: opts.drain })
  if (!plan.ok) {
    const held = `${formatEther(plan.heldWei)} ETH`
    const max = `${formatEther(plan.maxWei)} ETH`
    if (plan.reason === 'already-funded') {
      return {
        ok: false,
        error: `${to.name} already holds ${formatEther(targetHeldWei)} ETH, at or above the ${formatEther(ETH_FUNDING_TARGET_WEI)} ETH a working agent needs. Pass an amount to send more anyway.`,
      }
    }
    if (plan.reason === 'nothing-to-send') {
      return {
        ok: false,
        error: `${from.name} holds ${held}, at or under the ${formatEther(ETH_FUNDING_RESERVE_WEI)} ETH kept back so it can still transact. Pass drain to send it anyway — ${from.name} cannot act afterwards until it is funded again.`,
      }
    }
    if (plan.reason === 'more-than-held') {
      return { ok: false, error: `${from.name} can send at most ${max} right now (holds ${held}, keeping a reserve).` }
    }
    return { ok: false, error: 'That is below the dust floor — the transfer would cost more than it moves.' }
  }

  try {
    const txHash = await transferEth(fromAgentId, to.smartAccountAddress as Address, plan.amountWei)
    return {
      ok: true,
      txHash,
      amountWei: plan.amountWei.toString(),
      from: from.name,
      to: to.name,
      toAddress: to.smartAccountAddress as Address,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
