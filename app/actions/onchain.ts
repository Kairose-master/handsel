'use server'

import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent, agentEvent, creditTransaction } from '@/lib/db/schema'
import { recalculateCredit } from '@/lib/credit-engine'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { nanoid } from 'nanoid'
import { asActionError } from '@/lib/action-error'

async function requireOwnedAgent(agentId: string) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const [found] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!found || found.userId !== session.user.id) throw new Error('Agent not found')
  return { agent: found, userId: session.user.id }
}

/** Read-only on-chain status for the UI. Safe to call when nothing is configured. */
export async function getOnchainInfo(agentId: string) {
  const { agent: ag } = await requireOwnedAgent(agentId)
  const { isOnchainConfigured, isAgentAccountConfigured, EXPLORER_URL, CHAIN } = await import('@/lib/onchain/config')

  const { isErc8004Configured } = await import('@/lib/onchain/erc8004')

  const info = {
    configured: isOnchainConfigured(),
    agentConfigured: isAgentAccountConfigured(),
    smartAccountAddress: ag.smartAccountAddress,
    available: null as number | null,
    outstanding: null as number | null,
    explorer: EXPLORER_URL,
    chainName: CHAIN.name,
    // Chain-derived, so the treasury card's environment label follows the
    // chain the money is actually on instead of asserting one.
    realMoney: (await import('@/lib/onchain/real-money')).isRealMoney(),
    erc8004Configured: isErc8004Configured(),
    erc8004Id: ag.erc8004Id ?? null,
  }

  if (info.configured && ag.smartAccountAddress) {
    try {
      const { readAvailable, readOutstanding } = await import('@/lib/onchain/credit')
      info.available = await readAvailable(ag.smartAccountAddress as `0x${string}`)
      info.outstanding = await readOutstanding(ag.smartAccountAddress as `0x${string}`)
    } catch (error) {
      console.error('[onchain] read failed:', error)
    }
  }
  return info
}

/** Derive and persist the agent's ERC-4337 smart account, then publish its
 *  current credit limit on-chain (via recalculation's mirror step). */
export async function provisionSmartAccount(agentId: string) {
  await requireOwnedAgent(agentId)
  const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isAgentAccountConfigured()) {
    throw new Error(
      'On-chain not configured (set AGENT_OWNER_PRIVATE_KEY plus ZERODEV_RPC for kernel mode, or AGENT_ACCOUNT_MODE=eoa)',
    )
  }

  try {
    const { getAgentAccountAddress } = await import('@/lib/onchain/account')
    const address = await getAgentAccountAddress(agentId)

    await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, agentId))
    await recalculateCredit(agentId) // publishes the limit to the registry now that we have an address

    // ERC-8004: the agent registers itself in the Identity Registry,
    // pointing at its public registration file. Best-effort mirror.
    try {
      const { isErc8004Configured, registerAgentErc8004 } = await import('@/lib/onchain/erc8004')
      if (isErc8004Configured()) {
        const { headers } = await import('next/headers')
        const h = await headers()
        const proto = h.get('x-forwarded-proto') ?? 'https'
        const host = h.get('x-forwarded-host') ?? h.get('host')
        await registerAgentErc8004(agentId, `${proto}://${host}/api/agents/${agentId}/card`)
      }
    } catch (error) {
      console.error('[erc8004] agent registration failed (non-blocking):', error)
    }

    revalidatePath('/profile')
    return { address }
  } catch (error) {
    throw asActionError(error, 'provisionSmartAccount')
  }
}

/** Draw credit on-chain (real USDC via UserOp) and mirror to off-chain books. */
export async function drawOnchain(agentId: string, amount: number, description?: string) {
  const { agent: ag, userId } = await requireOwnedAgent(agentId)

  // Same delinquency gate and loan term as the off-chain path — the on-chain
  // vault moves real USDC, so it is the LAST place terms may be skipped.
  await (await import('@/lib/db/ensure-columns')).ensureCreditTransactionColumns()
  const { canDrawMore } = await import('@/lib/loan-terms')
  const { creditTransaction: ctx } = await import('@/lib/db/schema')
  const { eq: eqOp } = await import('drizzle-orm')
  const openLoans = (
    await db.select().from(ctx).where(eqOp(ctx.userId, userId))
  ).filter((t) => t.type === 'credit_draw' && (t.status === 'active' || t.status === 'defaulted'))
  const gate = canDrawMore(new Date(), openLoans)
  if (!gate.ok) throw new Error(gate.reason)
  if (!ag.smartAccountAddress) throw new Error('Provision the smart account first')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive')

  try {
    const { drawOnchain: draw } = await import('@/lib/onchain/credit')
    const txHash = await draw(agentId, amount)

    const { dueAtFor, DEFAULT_TERM_DAYS } = await import('@/lib/loan-terms')
    await db.insert(creditTransaction).values({
      id: nanoid(),
      userId,
      fromAgentId: agentId,
      status: 'active',
      dueAt: dueAtFor(new Date(), DEFAULT_TERM_DAYS),
      termDays: DEFAULT_TERM_DAYS,
      amount: amount.toString(),
      type: 'credit_draw',
      description: description || `On-chain draw (${txHash.slice(0, 10)}…)`,
    })

    const credit = await recalculateCredit(agentId)
    revalidatePath('/profile')
    return { txHash, credit }
  } catch (error) {
    throw asActionError(error, 'drawOnchain')
  }
}

/** Repay an active draw on-chain, then settle the off-chain record and emit a
 *  repayment event so the score reflects the proven repayment. */
export async function repayOnchain(txId: string) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')

  const [tx] = await db.select().from(creditTransaction).where(eq(creditTransaction.id, txId))
  if (!tx || tx.userId !== session.user.id) throw new Error('Transaction not found')
  if (tx.status !== 'active' || tx.type !== 'credit_draw') {
    throw new Error('Transaction is not an active credit draw')
  }

  try {
    const { repayOnchain: repay } = await import('@/lib/onchain/credit')
    const txHash = await repay(tx.fromAgentId, parseFloat(tx.amount))

    await db
      .update(creditTransaction)
      .set({ status: 'settled', settledAt: new Date(), updatedAt: new Date() })
      .where(eq(creditTransaction.id, txId))

    await db.insert(agentEvent).values({
      id: nanoid(),
      agentId: tx.fromAgentId,
      taskId: `repay-${txId}`,
      eventType: 'REPAYMENT_COMPLETED',
      success: true,
      executionTime: 0,
      tokenCost: 0,
      qualityScore: '1.000',
      detail: { amount: tx.amount, transactionId: txId, txHash, onchain: true },
    })

    const credit = await recalculateCredit(tx.fromAgentId)
    revalidatePath('/profile')
    return { txHash, credit }
  } catch (error) {
    throw asActionError(error, 'repayOnchain')
  }
}
