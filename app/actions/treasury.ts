'use server'

import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent, agentEvent, user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { nanoid } from 'nanoid'
import {
  enforceSpendingPolicy,
  isValidAddress,
  policyForAgent,
  policyForUserRow,
  spentLast24h,
  WALLET_CAP_HARD_MAX_USD,
  WALLET_DAILY_CAP_USD,
  WALLET_MAX_TX_USD,
} from '@/lib/treasury-policy'
import { asActionError } from '@/lib/action-error'
import { doTransfer, sweepAgentToAddress, type SweepResult } from '@/lib/treasury-sweep'

async function requireOwnedAgent(agentId: string) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const [found] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!found || found.userId !== session.user.id) throw new Error('Agent not found')
  return found
}

async function requireUserId() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getTreasury(agentId: string) {
  const ag = await requireOwnedAgent(agentId)
  const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
  const policy = await policyForAgent(agentId)

  const { CHAIN, onchainEnv } = await import('@/lib/onchain/config')

  const info = {
    configured: isAgentAccountConfigured() && Boolean(ag.smartAccountAddress),
    address: ag.smartAccountAddress,
    usdc: null as number | null,
    /** USDC the labor market holds as this agent's bond on unsettled jobs.
     *  Comes back on completion — it left the wallet without being spent,
     *  which is exactly the movement that made a paid job read as a loss.
     *  Null = unreadable (or not a V2 market), never zero-by-default. */
    bondedUsd: null as number | null,
    /** USDC settlement credited and `withdraw()` has not collected yet. */
    claimableUsd: null as number | null,
    spent24h: 0,
    maxPerTx: policy.maxPerTxUsd,
    dailyCap: policy.dailyCapUsd,
    // Reported so a deposit can be VERIFIED rather than trusted. "Send USDC" is
    // ambiguous: a chain carries many contracts willing to answer to that name,
    // and the only one this balance counts is the configured one. Someone
    // pasting an address into an exchange should be able to check the token
    // they are picking against the token that will actually arrive.
    chainName: CHAIN.name,
    chainId: CHAIN.id,
    tokenAddress: (onchainEnv.usdcAddress || null) as string | null,
  }
  if (info.configured) {
    try {
      const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
      info.usdc = await usdcBalanceOf(ag.smartAccountAddress as `0x${string}`)
      info.spent24h = await spentLast24h(agentId)
    } catch (error) {
      console.error('[treasury] read failed:', error)
    }
    // Separate try: a failure here must not blank the wallet balance above,
    // and vice versa — the two reads answer different questions.
    try {
      const { isV2Market, readJobsV2, bondScheduleOf, withdrawableOf } = await import('@/lib/onchain/labor-v2')
      if (await isV2Market()) {
        const address = ag.smartAccountAddress as `0x${string}`
        const [jobs, schedule, claimable] = await Promise.all([
          readJobsV2(),
          bondScheduleOf(),
          withdrawableOf(address),
        ])
        if (schedule) {
          const { workerFunds } = await import('@/lib/worker-funds')
          const mine = jobs
            .filter((j) => j.worker.toLowerCase() === address.toLowerCase())
            .map((j) => ({ jobId: j.id, bounty: j.bounty, status: j.status }))
          const f = workerFunds({ wallet: 0, claimable, openJobs: mine, schedule })
          info.bondedUsd = f.bonded
          info.claimableUsd = f.claimable
        }
      }
    } catch (error) {
      console.error('[treasury] funds read failed:', error)
    }
  }
  return info
}


/** Owner-initiated withdrawal/payment to any external address. Same policy
 *  and same ledger as agent-initiated transfers. */
export async function sendFromTreasury(agentId: string, to: string, amountUsd: number, memo?: string) {
  const ag = await requireOwnedAgent(agentId)
  if (!ag.smartAccountAddress) throw new Error('Provision the smart account first')
  if (!isValidAddress(to)) throw new Error('Invalid recipient address')

  await enforceSpendingPolicy(agentId, amountUsd)

  try {
    const txHash = await doTransfer(agentId, ag.smartAccountAddress, to, amountUsd, memo ?? '')
    revalidatePath('/profile')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'sendFromTreasury')
  }
}

/** The wallet earnings get swept to on "Withdraw all earnings". Saved once,
 *  reused by every future one-click withdrawal — no re-typing an address
 *  per agent, per payout. */
export async function getPayoutAddress() {
  const userId = await requireUserId()
  const [row] = await db.select({ payoutAddress: user.payoutAddress }).from(user).where(eq(user.id, userId))
  return { payoutAddress: row?.payoutAddress ?? null }
}

export async function setPayoutAddress(address: string) {
  const userId = await requireUserId()
  const trimmed = address.trim()
  if (trimmed && !isValidAddress(trimmed)) throw new Error('Invalid wallet address')
  await db
    .update(user)
    .set({ payoutAddress: trimmed || null, updatedAt: new Date() })
    .where(eq(user.id, userId))
  revalidatePath('/mine')
  return { payoutAddress: trimmed || null }
}

/** The account's own spending caps (per-transfer / per-24h, per agent),
 *  plus the platform defaults for display. */
export async function getSpendingSettings() {
  const userId = await requireUserId()
  let row: { walletMaxTxUsd: string | null; walletDailyCapUsd: string | null } | undefined
  try {
    ;[row] = await db
      .select({ walletMaxTxUsd: user.walletMaxTxUsd, walletDailyCapUsd: user.walletDailyCapUsd })
      .from(user)
      .where(eq(user.id, userId))
  } catch (error) {
    // Columns may not exist until the migration runs — show defaults.
    console.error('[treasury] spending settings read failed (migration pending?):', error)
  }
  const effective = policyForUserRow(row)
  return {
    maxTxUsd: row?.walletMaxTxUsd ? Number(row.walletMaxTxUsd) : null,
    dailyCapUsd: row?.walletDailyCapUsd ? Number(row.walletDailyCapUsd) : null,
    effective,
    defaults: { maxPerTxUsd: WALLET_MAX_TX_USD, dailyCapUsd: WALLET_DAILY_CAP_USD },
    hardMaxUsd: WALLET_CAP_HARD_MAX_USD,
  }
}

/** Set (or clear, with null) the account's own spending caps. The caps
 *  guard the owner's funds against a runaway agent — sizing them is the
 *  owner's call, not the deployment operator's. Bounded by a hard platform
 *  ceiling so the guard can't be typo'd away entirely. */
export async function setSpendingSettings(input: { maxTxUsd: number | null; dailyCapUsd: number | null }) {
  const userId = await requireUserId()

  const validate = (v: number | null, label: string) => {
    if (v === null) return null
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${label} must be a positive number`)
    if (v > WALLET_CAP_HARD_MAX_USD) throw new Error(`${label} cannot exceed $${WALLET_CAP_HARD_MAX_USD.toLocaleString()}`)
    return v.toFixed(2)
  }
  const maxTx = validate(input.maxTxUsd, 'Per-transfer cap')
  const dailyCap = validate(input.dailyCapUsd, 'Daily cap')
  if (maxTx !== null && dailyCap !== null && Number(maxTx) > Number(dailyCap)) {
    throw new Error('Per-transfer cap cannot exceed the daily cap')
  }

  try {
    await db
      .update(user)
      .set({ walletMaxTxUsd: maxTx, walletDailyCapUsd: dailyCap, updatedAt: new Date() })
      .where(eq(user.id, userId))
  } catch {
    throw new Error('Saving caps requires a pending database migration — ask the operator to run /api/admin/migrate')
  }
  revalidatePath('/mine')
  return getSpendingSettings()
}

/** Sweep a single agent's earnings to the saved payout address — the
 *  granular alternative to withdraw-all when only one worker matters. */
export async function withdrawAgentEarnings(agentId: string) {
  const ag = await requireOwnedAgent(agentId)
  const userId = await requireUserId()
  const [row] = await db.select({ payoutAddress: user.payoutAddress }).from(user).where(eq(user.id, userId))
  const to = row?.payoutAddress
  if (!to) {
    // RETURNED, not thrown. A server action that throws reaches the browser as
    // "An error occurred in the Server Components render" with the message
    // replaced by a digest — so `throw new Error('Set a payout wallet first')`
    // told the user nothing at all in production, which is exactly how this was
    // found (POST /mine 500, digest 1363688840).
    //
    // A returned value crosses the boundary intact. WorkerCard already renders
    // `result.error`, so this needs no client change — and it cannot be gated
    // client-side the way the Withdraw-all button now is, because the per-agent
    // card never receives the payout address.
    return {
      to: '',
      result: { agentId: ag.id, name: ag.name, sent: 0, error: 'Set a payout wallet on this page first' },
    }
  }

  const result = await sweepAgentToAddress(ag, to, 'Withdraw earnings')
  revalidatePath('/mine')
  revalidatePath('/profile')
  return { to, result: result ?? { agentId: ag.id, name: ag.name, sent: 0, error: undefined } }
}

/**
 * One click, every worker settled: sweeps each owned agent's USDC balance
 * to the saved payout address, respecting the same per-tx/24h caps as a
 * manual send (per agent, since the ledger that enforces the cap is keyed
 * per agent). An agent that would exceed its cap sends what it can and
 * reports the shortfall rather than failing the whole batch — the rest
 * still settle.
 */
export async function withdrawAllEarnings(): Promise<{
  to: string
  totalSent: number
  results: SweepResult[]
  /** A precondition the caller can fix, returned rather than thrown — see the
   *  note in withdrawAgentEarnings. Absent on success. */
  error?: string
}> {
  const userId = await requireUserId()
  const [row] = await db.select({ payoutAddress: user.payoutAddress }).from(user).where(eq(user.id, userId))
  const to = row?.payoutAddress
  if (!to) {
    // Returning empty `results` alone would make the client say "No USDC to
    // withdraw yet", which is a different and false claim — nothing was
    // checked. So the reason travels with it.
    return { to: '', totalSent: 0, results: [], error: 'Set a payout wallet on this page first' }
  }

  const agents = await db
    .select()
    .from(agent)
    .where(eq(agent.userId, userId))
  const provisioned = agents.filter((a) => a.smartAccountAddress)

  const results: SweepResult[] = []

  for (let i = 0; i < provisioned.length; i++) {
    // Space the transfers out — the bundler RPC rate-limits back-to-back
    // user operations (free tier), which is exactly what a multi-agent
    // sweep produces.
    if (i > 0) await new Promise((r) => setTimeout(r, 2000))
    const r = await sweepAgentToAddress(provisioned[i], to, 'Withdraw all earnings')
    if (r) results.push(r) // null = zero balance, skipped silently (same as before)
  }

  revalidatePath('/mine')
  revalidatePath('/profile')
  const totalSent = results.reduce((sum, r) => sum + r.sent, 0)
  return { to, totalSent, results }
}

const TEST_MINT_MAX_USD = 5000

/** Self-mint test USDC (testnet only — MockUSDC.mint is permissionless).
 *  Not subject to the spending policy: minting isn't spending, it's the
 *  faucet step users need before they can draw credit or post jobs. */
export async function mintTestUsdc(agentId: string, amountUsd: number) {
  const ag = await requireOwnedAgent(agentId)
  if (!ag.smartAccountAddress) throw new Error('Provision the smart account first')
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('Amount must be positive')
  if (amountUsd > TEST_MINT_MAX_USD) throw new Error(`Max ${TEST_MINT_MAX_USD} mUSDC per mint`)

  try {
    const { mintTestUsdc: mint } = await import('@/lib/onchain/treasury')
    const txHash = await mint(agentId, amountUsd, ag.smartAccountAddress as `0x${string}`)

    // Separate event type from WALLET_TRANSFER — minting isn't spending and
    // must NOT count toward the 24h spending cap that gates real transfers.
    await db.insert(agentEvent).values({
      id: nanoid(),
      agentId,
      taskId: `mint-${nanoid(8)}`,
      eventType: 'WALLET_MINT',
      success: true,
      executionTime: 0,
      tokenCost: 0,
      qualityScore: null,
      detail: { amountUsd, to: ag.smartAccountAddress, memo: 'Test USDC mint', txHash, initiator: 'owner' },
    })

    revalidatePath('/profile')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'mintTestUsdc')
  }
}
