/**
 * Company Treasury — the account-wide numbers behind the "company HQ" HUD.
 *
 * Deliberately account-wide, not office-wide: `lib/office-treasury.ts`'s view
 * is scoped to one office slot because the diorama it feeds IS one office.
 * The local paymaster (lib/local-paymaster.ts) was built one level UP from
 * that — one gas pool per ACCOUNT, sourced from a single designated agent —
 * because a real cross-account paymaster isn't buildable here (see that
 * file's own header) but an account rolling its own offices' gas into one
 * pool is. So "the company" is this account's own agents across every
 * office it has, never other accounts' — there is no platform-wide pool to
 * read, by design, and this file does not pretend otherwise.
 *
 * The gas pool itself is not a ledger balance: `account_gas_pool` stores
 * WHICH agent is the source, and its live on-chain ETH balance IS the pool.
 * Reading it is one more live balance read, not a new kind of number.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { usdcBalanceOf, ethBalanceOfWei } from '@/lib/onchain/treasury'
import {
  getGasPool,
  sponsoredInWindow,
  LOCAL_GAS_TARGET_WEI,
  LOCAL_GAS_POOL_RESERVE_WEI,
  LOCAL_GAS_WINDOW_BUDGET_WEI,
} from '@/lib/local-paymaster'
import { summarizeWalletReads } from '@/lib/office-treasury'
import type { Address } from 'viem'
// Types come from the client-safe data module (never from this file
// directly) so the 'use client' HUD can import them without dragging @/lib/db
// into the browser bundle. Same rule, same reason, as OfficeTreasuryView.
import type { CompanyTreasuryView, CompanyGasPoolStatus, CompanyGasHealth } from '@/lib/office-world-data'

export type { CompanyTreasuryView }
export type GasPoolStatus = CompanyGasPoolStatus
export type GasPoolHealth = CompanyGasHealth

/**
 * One word for the HUD's gauge color. Pure — every input already resolved,
 * so this never touches the chain or the DB.
 *
 * Order matters: not-configured and disabled are states the owner chose,
 * checked before anything about the balance. `unknown` (a failed read) is
 * checked before any balance-based verdict — reporting "empty" or "ok" from
 * a `null` balance would be reporting a guess as a fact.
 */
export function gasPoolHealth(status: GasPoolStatus): GasPoolHealth {
  if (!status.configured) return 'unconfigured'
  if (!status.enabled) return 'disabled'
  if (status.spendableWei == null) return 'unknown'
  const spendable = BigInt(status.spendableWei)
  if (spendable <= 0n) return 'empty'
  const budget = BigInt(status.budgetWei)
  // A failed read of today's spend does not make the pool "low" — it makes
  // that one fact unknown. The BALANCE-based check below still applies.
  const spentToday = status.spentTodayWei == null ? null : BigInt(status.spentTodayWei)
  const budgetMostlySpent = spentToday !== null && budget > 0n && spentToday * 10n >= budget * 9n // >= 90%
  if (budgetMostlySpent || spendable < LOCAL_GAS_TARGET_WEI / 2n) return 'low'
  return 'ok'
}

/** Build the account-wide Company HQ view. Never throws — a failing read
 *  leaves that field null/unconfigured rather than breaking the whole HUD. */
export async function buildCompanyTreasury(userId: string): Promise<CompanyTreasuryView> {
  const myAgents = await db.select().from(agent).where(eq(agent.userId, userId))
  const wallets = myAgents.filter((a) => a.smartAccountAddress).map((a) => a.smartAccountAddress as Address)

  const walletReads = await Promise.all(
    wallets.map(async (address) => {
      const [usdc, eth] = await Promise.allSettled([usdcBalanceOf(address), ethBalanceOfWei(address)])
      if (usdc.status === 'rejected') console.error('[company-treasury] USDC read failed for', address, usdc.reason)
      if (eth.status === 'rejected') console.error('[company-treasury] ETH read failed for', address, eth.reason)
      return {
        usdc: usdc.status === 'fulfilled' ? ({ ok: true, value: usdc.value } as const) : ({ ok: false } as const),
        eth: eth.status === 'fulfilled' ? ({ ok: true, value: eth.value } as const) : ({ ok: false } as const),
      }
    }),
  )

  const pool = await getGasPool(userId).catch((error) => {
    console.error('[company-treasury] gas pool config read failed:', error)
    return null
  })

  let gasPool: GasPoolStatus = { configured: false }
  if (pool) {
    const [source] = await db.select().from(agent).where(eq(agent.id, pool.sourceAgentId))
    const spentToday = await sponsoredInWindow(userId).catch((error) => {
      console.error('[company-treasury] sponsorship-window read failed:', error)
      return null
    })
    let heldWei: bigint | null = null
    if (source?.smartAccountAddress) {
      try {
        heldWei = await ethBalanceOfWei(source.smartAccountAddress as Address)
      } catch (error) {
        console.error('[company-treasury] gas pool source balance read failed:', error)
      }
    }
    gasPool = {
      configured: true,
      enabled: pool.enabled,
      sourceAgentId: pool.sourceAgentId,
      sourceAgentName: source?.name ?? 'Unknown agent',
      heldWei: heldWei === null ? null : heldWei.toString(),
      spendableWei: heldWei === null ? null : (heldWei > LOCAL_GAS_POOL_RESERVE_WEI ? heldWei - LOCAL_GAS_POOL_RESERVE_WEI : 0n).toString(),
      spentTodayWei: spentToday === null ? null : spentToday.toString(),
      budgetWei: LOCAL_GAS_WINDOW_BUDGET_WEI.toString(),
      reserveWei: LOCAL_GAS_POOL_RESERVE_WEI.toString(),
    }
  }

  return {
    agentCount: myAgents.length,
    usdc: summarizeWalletReads(walletReads),
    gasPool,
    gasHealth: gasPoolHealth(gasPool),
  }
}
