'use server'

/**
 * Real data for the dashboard chrome (sidebar / header).
 *
 * The shell previously showed v0-mockup leftovers — a hardcoded "Base L2"
 * block number, a fake "$2.41M treasury" chip, a fictional "Meridian Labs"
 * account. For a product whose entire pitch is verified-not-claimed
 * numbers, fabricated chrome is self-sabotage ("No fabricated numbers,
 * ever" applies to the frame, not just the page). Everything returned
 * here is a live query; anything unavailable returns null and the UI
 * hides it rather than inventing it.
 */
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

export async function getShellStatus() {
  const session = await getSession()

  let chain: { name: string; block: number; realMoney: boolean } | null = null
  let vaultUsd: number | null = null

  try {
    const { isOnchainConfigured, CHAIN, onchainEnv } = await import('@/lib/onchain/config')
    if (isOnchainConfigured()) {
      const { publicClient } = await import('@/lib/onchain/clients')
      const { isRealMoney } = await import('@/lib/onchain/real-money')
      const block = await publicClient().getBlockNumber()
      // DERIVED from the configured chain id, never asserted by the UI — a
      // hardcoded "Testnet" badge over a mainnet balance is the same defect as
      // a hardcoded balance, and "Mainnet" hardcoded the other way would be
      // worse. The badge follows the chain the money is actually on.
      chain = { name: CHAIN.name, block: Number(block), realMoney: isRealMoney() }

      if (onchainEnv.usdcAddress && onchainEnv.vaultAddress) {
        const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
        vaultUsd = await usdcBalanceOf(onchainEnv.vaultAddress as `0x${string}`)
      }
    }
  } catch {
    // RPC hiccup: show nothing rather than something stale/false.
  }

  const [stats] = await db
    .select({ agentCount: sql<number>`count(*)` })
    .from(agent)

  return {
    user: session?.user ? { name: session.user.name ?? 'Account', email: session.user.email ?? '' } : null,
    chain,
    vaultUsd,
    agentCount: Number(stats?.agentCount ?? 0),
  }
}
