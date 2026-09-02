'use server'

/**
 * The platform's own ledger. Reads only.
 *
 * Distinct from `app/actions/treasury.ts`, which is one AGENT's wallet. This
 * is the three places the platform's money sits, in one answer — and it adds
 * no key material and no write path. See lib/platform-treasury.ts for why
 * there is no button here.
 *
 * Every figure is fetched at request time and every failure becomes `null`
 * rather than `0`: on this page a zero is an alarm, and a false alarm is
 * worse than a gap.
 */
import { eq } from 'drizzle-orm'
import type { Address } from 'viem'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { buildTreasury, type EscrowHealth, type Treasury } from '@/lib/platform-treasury'

const safe = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read()
  } catch {
    return null
  }
}

export async function getPlatformTreasury(): Promise<Treasury> {
  // A signed-in session is NOT enough. The first draft of this gated on
  // `getSession()` alone, which would have shown every user of the platform
  // its fee balance, its house float and how many postings that float has
  // left — an operational map of when the market is cheapest to attack.
  // Same permission gate the other admin pages use.
  const { requirePermission } = await import('@/lib/admin')
  await requirePermission('treasury')

  const { onchainEnv } = await import('@/lib/onchain/config')
  const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
  const { withdrawableOf, escrowSolvencyOf } = await import('@/lib/onchain/labor-v2')
  const { publicClient } = await import('@/lib/onchain/clients')
  const { LABOR_MARKET_V2_ABI } = await import('@/lib/onchain/labor-v2-artifact')
  const { x402Stats } = await import('@/lib/x402-ledger')
  const { externalJobPricing, PRICE_ENV, BOUNTY_ENV } = await import('@/lib/external-job-pricing')
  const { isRealMoney } = await import('@/lib/onchain/real-money')

  const market = onchainEnv.laborMarketAddress as Address | undefined
  const feeRecipient = market
    ? await safe(
        () =>
          publicClient().readContract({
            address: market,
            abi: LABOR_MARKET_V2_ABI,
            functionName: 'feeRecipient',
          }) as Promise<Address>,
      )
    : null
  const feeCredit = feeRecipient ? await safe(() => withdrawableOf(feeRecipient)) : null

  const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID ?? null
  const [houseRow] = houseAgentId ? await db.select().from(agent).where(eq(agent.id, houseAgentId)) : []
  const houseAddress = houseRow?.smartAccountAddress ?? null
  const houseBalance = houseAddress ? await safe(() => usdcBalanceOf(houseAddress as Address)) : null

  const payTo = (process.env.X402_PAY_TO as string | undefined) ?? null
  const payToBalance = payTo ? await safe(() => usdcBalanceOf(payTo as Address)) : null

  const solvency = await safe(() => escrowSolvencyOf())
  const escrow: EscrowHealth = solvency
    ? solvency
    : { owedUsd: null, heldUsd: null, surplusUsd: null }

  const stats = await safe(() => x402Stats(1))
  const pricing = externalJobPricing({
    isRealMoney: isRealMoney(),
    price: process.env[PRICE_ENV],
    bounty: process.env[BOUNTY_ENV],
  })

  return buildTreasury({
    feeCredit,
    feeRecipient,
    houseBalance,
    houseAddress,
    payToBalance,
    payTo,
    escrow,
    chargedUsd: stats?.totalUsd ?? null,
    chargedCount: stats?.totalPayments ?? null,
    externalBountyUsd: pricing.open ? pricing.bountyUsd : null,
  })
}
