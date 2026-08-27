/**
 * Getting gas money back out of an agent.
 *
 * On a deployment with no paymaster the owner funds each agent's kernel
 * account with ETH so it can act at all. That is real money, and until this
 * existed there was no way to retrieve it — every surface showed USDC and
 * nothing showed, or returned, the ETH underneath it.
 *
 * Two rules the shape here exists to enforce.
 *
 * It can only ever pay the account's saved payout address, the same one USDC
 * withdrawals use. A withdrawal that took an arbitrary destination would be a
 * new way to move an agent's money to an address nobody vetted, reachable from
 * a connector; reusing the vetted one adds no surface.
 *
 * And it never empties the account. The withdrawal is itself a UserOperation
 * paid for out of the same balance, so a true sweep either fails outright or —
 * worse — lands and leaves the account below the floor, unable to transact and
 * unable to fund its own rescue. A reserve stays behind by default; taking it
 * has to be asked for explicitly, by an owner who has decided the agent is
 * done.
 */
import { parseEther, type Address } from 'viem'

/** Left behind so the account can still act after a withdrawal, and so the
 *  withdrawal itself can be paid for. Matches AGENT_GAS_TOPUP in
 *  lib/onchain/account.ts — one working session's worth. */
export const ETH_WITHDRAW_RESERVE_WEI = 200_000_000_000_000n // 0.0002 ETH

/** Below this a transfer costs more than it moves. */
export const ETH_WITHDRAW_DUST_WEI = 20_000_000_000_000n // 0.00002 ETH

export type EthWithdrawPlan =
  | { ok: true; amountWei: bigint; leavesWei: bigint }
  | { ok: false; reason: 'nothing-to-withdraw' | 'below-dust' | 'more-than-held'; heldWei: bigint; maxWei: bigint }

/**
 * How much this agent can actually send, given what it holds and what has to
 * stay behind. Pure — no chain access, so the arithmetic that decides how much
 * of someone's money moves is testable on its own.
 *
 * `requestedWei` omitted means "as much as is safe".
 */
export function planEthWithdrawal(input: {
  heldWei: bigint
  requestedWei?: bigint
  /** Take the reserve too. For an agent being retired — after this it cannot
   *  transact again without being funded afresh. */
  drain?: boolean
}): EthWithdrawPlan {
  const reserve = input.drain ? 0n : ETH_WITHDRAW_RESERVE_WEI
  const maxWei = input.heldWei > reserve ? input.heldWei - reserve : 0n
  if (maxWei <= 0n) {
    return { ok: false, reason: 'nothing-to-withdraw', heldWei: input.heldWei, maxWei: 0n }
  }
  const amountWei = input.requestedWei ?? maxWei
  if (amountWei > maxWei) {
    return { ok: false, reason: 'more-than-held', heldWei: input.heldWei, maxWei }
  }
  if (amountWei < ETH_WITHDRAW_DUST_WEI) {
    return { ok: false, reason: 'below-dust', heldWei: input.heldWei, maxWei }
  }
  return { ok: true, amountWei, leavesWei: input.heldWei - amountWei }
}

/** Parse a human "0.001" into wei, refusing anything that isn't a plain
 *  positive decimal — parseEther is lenient about oddities that should not
 *  reach a transfer amount. */
export function parseEthAmount(input: string): bigint | null {
  const trimmed = input.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  try {
    const wei = parseEther(trimmed)
    return wei > 0n ? wei : null
  } catch {
    return null
  }
}

export type EthWithdrawResult =
  | { ok: true; txHash: string; amountWei: string; to: Address }
  | { ok: false; error: string }

/**
 * Send an agent's ETH to the account's saved payout address.
 *
 * Ownership is checked here so neither entry point can forget, the same way
 * lib/mcp-worker-wiring.ts and lib/agent-provision.ts do it.
 */
export async function withdrawAgentEth(
  userId: string,
  agentId: string,
  opts: { requestedWei?: bigint; drain?: boolean } = {},
): Promise<EthWithdrawResult> {
  const { db } = await import('@/lib/db')
  const { agent, user } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')

  const [owned] = await db
    .select({ id: agent.id, name: agent.name, userId: agent.userId, smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.id, agentId))
  if (!owned || owned.userId !== userId) return { ok: false, error: 'Agent not found' }
  if (!owned.smartAccountAddress) return { ok: false, error: `${owned.name} has no on-chain account` }

  const [row] = await db.select({ payoutAddress: user.payoutAddress }).from(user).where(eq(user.id, userId))
  const to = row?.payoutAddress
  if (!to) return { ok: false, error: 'Set a payout wallet on the profile page first — that is the only place this can send' }

  const { ethBalanceOfWei, transferEth } = await import('@/lib/onchain/treasury')
  const heldWei = await ethBalanceOfWei(owned.smartAccountAddress as Address)
  const plan = planEthWithdrawal({ heldWei, requestedWei: opts.requestedWei, drain: opts.drain })
  if (!plan.ok) {
    const held = `${Number(plan.heldWei) / 1e18} ETH`
    const max = `${Number(plan.maxWei) / 1e18} ETH`
    if (plan.reason === 'nothing-to-withdraw') {
      return {
        ok: false,
        error: `${owned.name} holds ${held}, which is at or under the ${Number(ETH_WITHDRAW_RESERVE_WEI) / 1e18} ETH reserve kept so it can still transact. Pass drain to take it anyway — the agent cannot act afterwards until it is funded again.`,
      }
    }
    if (plan.reason === 'more-than-held') {
      return { ok: false, error: `${owned.name} can send at most ${max} right now (holds ${held}, keeping a reserve).` }
    }
    return { ok: false, error: `That is below the dust floor — the transfer would cost more than it moves.` }
  }

  try {
    const txHash = await transferEth(agentId, to as Address, plan.amountWei)
    return { ok: true, txHash, amountWei: plan.amountWei.toString(), to: to as Address }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
