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

/**
 * The gas pool — one agent this account sponsors everyone else's gas out of.
 *
 * The automatic counterpart to the manual funding above, and connector-only
 * for the same reason everything else in this sweep was: `setGasPool` /
 * `disableGasPool` were called from `lib/mcp/handlers/office.ts` and nowhere
 * a person could reach. Funding by hand keeps one agent alive; the pool is
 * what keeps a desk alive without somebody watching it, which is the whole
 * premise of an office that runs unattended.
 *
 * `setGasPool`'s own comment says "Ownership of sourceAgentId is the
 * caller's to establish" — the lib deliberately does not check it. So this
 * checks it, explicitly, before calling. Without that, an account could
 * nominate somebody else's agent as the wallet its gas is drained from.
 */
export async function myGasPool(): Promise<{
  pool: { sourceAgentId: string; enabled: boolean } | null
  sponsoredWei: string
  windowBudgetWei: string
  targetWei: string
}> {
  const userId = await requireUserId()
  const { getGasPool, sponsoredInWindow, LOCAL_GAS_WINDOW_BUDGET_WEI, LOCAL_GAS_TARGET_WEI } = await import(
    '@/lib/local-paymaster'
  )
  const [pool, sponsored] = await Promise.all([getGasPool(userId), sponsoredInWindow(userId).catch(() => 0n)])
  return {
    pool,
    sponsoredWei: sponsored.toString(),
    windowBudgetWei: LOCAL_GAS_WINDOW_BUDGET_WEI.toString(),
    targetWei: LOCAL_GAS_TARGET_WEI.toString(),
  }
}

export async function setMyGasPool(sourceAgentId: string): Promise<{ ok: true } | { error: string }> {
  const userId = await requireUserId()
  try {
    // The ownership check the lib explicitly leaves to its caller. Resolved
    // against this account's own agents, so a nominated id that is not one
    // of ours refuses rather than silently designating a stranger's wallet.
    const { db } = await import('@/lib/db')
    const { agent } = await import('@/lib/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const [owned] = await db
      .select({ id: agent.id, addr: agent.smartAccountAddress })
      .from(agent)
      .where(and(eq(agent.id, sourceAgentId), eq(agent.userId, userId)))
    if (!owned) return { error: 'That agent is not on this account.' }
    if (!owned.addr) return { error: 'Provision that agent first — a pool with no wallet cannot sponsor anything.' }

    const { setGasPool } = await import('@/lib/local-paymaster')
    await setGasPool(userId, sourceAgentId, true)
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not set the gas pool.' }
  }
}

export async function disableMyGasPool(): Promise<{ ok: true } | { error: string }> {
  const userId = await requireUserId()
  try {
    const { disableGasPool } = await import('@/lib/local-paymaster')
    await disableGasPool(userId)
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not disable the gas pool.' }
  }
}
