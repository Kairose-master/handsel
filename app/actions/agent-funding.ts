'use server'

/**
 * Move gas and USDC between the owner's own agents, from the dashboard.
 *
 * `fundAgentEth`, `fundAgentUsdc` and `withdrawAgentEth` have existed for a
 * long time and were reachable from exactly one place a person could use:
 * the MCP connector. Every other caller is an automatic internal path —
 * lineage seeding, office bond cover, the automaton — none of which an owner
 * can invoke by hand. So an owner looking at an agent with no gas had no way
 * to give it any without wiring up an assistant.
 *
 * That is not a cosmetic gap on this product specifically.
 * docs/failure-modes.md §30 is "We hired a desk of ten agents that could not
 * take a single job", and invariant 8 draws the rule out of it: *a
 * capability an agent cannot fund is not a capability* — standing up a
 * worker means giving it everything the chain will charge it, gas AND bond.
 * The dashboard could stand agents up and could not feed them.
 *
 * Money movement, so the guards are the ones the underlying calls already
 * enforce, restated here rather than assumed: both agents must belong to the
 * caller (the lib checks ownership against `userId`, which comes from the
 * session and never from the request body), and the source keeps its
 * reserve so funding a peer cannot strand the funder.
 */
import { getSession } from '@/lib/get-session'
import type { EthFundingResult } from '@/lib/agent-eth-funding'
import type { UsdcFundingResult } from '@/lib/agent-usdc-funding'

async function requireUserId(): Promise<string> {
  const session = await getSession()
  if (!session?.user?.id) throw new Error('Sign in first.')
  return session.user.id
}

/** Agents this account owns, with the balances a funding decision needs. */
export async function myFundableAgents(): Promise<
  { id: string; name: string; address: string | null; ethWei: string | null; usdc: number | null }[]
> {
  const userId = await requireUserId()
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db
    .select({ id: agent.id, name: agent.name, address: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.userId, userId))

  // Balances are read best-effort and per agent: one unreadable wallet must
  // not blank the whole picker, or a single RPC hiccup makes funding look
  // impossible rather than uncertain.
  const { ethBalanceOfWei, usdcBalanceOf } = await import('@/lib/onchain/treasury')
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      ethWei: r.address ? await ethBalanceOfWei(r.address as `0x${string}`).then(String).catch(() => null) : null,
      usdc: r.address ? await usdcBalanceOf(r.address as `0x${string}`).catch(() => null) : null,
    })),
  )
}

export async function sendAgentEth(fromAgentId: string, toAgentId: string, amount: string): Promise<EthFundingResult> {
  const userId = await requireUserId()
  const { fundAgentEth, parseEthAmount } = await import('@/lib/agent-eth-funding')
  const wei = parseEthAmount(amount)
  if (wei === null) return { ok: false, error: 'Amount must be a plain positive decimal, e.g. "0.002".' }
  return fundAgentEth(userId, fromAgentId, toAgentId, { requestedWei: wei })
}

export async function sendAgentUsdc(fromAgentId: string, toAgentId: string, amount: string): Promise<UsdcFundingResult> {
  const userId = await requireUserId()
  const { fundAgentUsdc, parseUsdcAmount } = await import('@/lib/agent-usdc-funding')
  const amountUsd = parseUsdcAmount(amount)
  if (amountUsd === null) return { ok: false, error: 'Amount must be a plain positive decimal, e.g. "0.25".' }
  return fundAgentUsdc(userId, fromAgentId, toAgentId, { amountUsd })
}
