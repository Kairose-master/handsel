/**
 * Office Treasury — the real numbers behind the diorama's Treasury room.
 *
 * Two DIFFERENT scopes, and the view keeps them labeled apart rather than
 * blending them into one figure: this OFFICE's own agents' wallets (yours),
 * and the MARKET's own solvency (everyone's, on the contract you happen to
 * be pointed at). A number from one scope read as the other would be a
 * quieter version of the environment-mislabeling bug this repo has already
 * shipped once (docs/failure-modes.md's "no user-facing string may assert
 * an environment from a constant") — so every field here says which scope
 * it is, and nothing here is invented: an unreadable balance is `null` and
 * counted in `walletReadErrors`, never silently treated as zero.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { officeSlotsByAgentId } from '@/lib/office'
import { usdcBalanceOf, ethBalanceOfWei } from '@/lib/onchain/treasury'
import { escrowSolvencyOf, feeConfigOf, withdrawableOf } from '@/lib/onchain/labor-v2'
import type { Address } from 'viem'
// The type — not the value — comes from the client-safe data module, so a
// 'use client' page can import it without dragging @/lib/db (pg) into the
// browser bundle. See that type's own comment for why.
import type { OfficeTreasuryView } from '@/lib/office-world-data'

export type { OfficeTreasuryView }
export type OfficeWalletTotals = OfficeTreasuryView['office']

/**
 * Turn per-wallet read outcomes into the office's totals. Pure — no chain or
 * DB access — so the null-vs-zero-vs-partial rules are testable without
 * mocking a provider: 0 wallets is a true zero (no agents, no money, not an
 * unknown); every wallet failing is `null` (we asked and could not tell);
 * anything in between sums the successes and counts the rest in
 * `walletReadErrors`, so a non-null total is always a floor, never a guess
 * dressed up as a fact.
 */
export function summarizeWalletReads(
  results: ReadonlyArray<{ usdc: { ok: true; value: number } | { ok: false }; eth: { ok: true; value: bigint } | { ok: false } }>,
): Omit<OfficeWalletTotals, 'agentCount'> {
  let usdcTotal = 0
  let usdcOk = 0
  let ethTotalWei = 0n
  let ethOk = 0
  let readErrors = 0
  for (const r of results) {
    if (r.usdc.ok) {
      usdcTotal += r.usdc.value
      usdcOk += 1
    } else {
      readErrors += 1
    }
    if (r.eth.ok) {
      ethTotalWei += r.eth.value
      ethOk += 1
    } else {
      readErrors += 1
    }
  }
  return {
    walletCount: results.length,
    usdcTotal: results.length === 0 || usdcOk > 0 ? usdcTotal : null,
    ethTotalWei: results.length === 0 || ethOk > 0 ? ethTotalWei.toString() : null,
    walletReadErrors: readErrors,
  }
}

/** Build the real Treasury view for `userId`'s agents in office `slot`.
 *  Never throws — a failing read leaves that field null/zero-counted rather
 *  than breaking the whole room. */
export async function buildOfficeTreasury(userId: string, slot: number): Promise<OfficeTreasuryView> {
  const everyAgent = await db.select().from(agent).where(eq(agent.userId, userId))
  const slotByAgentId = await officeSlotsByAgentId(everyAgent.map((a) => a.id))
  const myAgents = everyAgent.filter((a) => slotByAgentId.get(a.id) === slot)
  const wallets = myAgents.filter((a) => a.smartAccountAddress).map((a) => a.smartAccountAddress as Address)

  const walletReads = await Promise.all(
    wallets.map(async (address) => {
      const [usdc, eth] = await Promise.allSettled([usdcBalanceOf(address), ethBalanceOfWei(address)])
      if (usdc.status === 'rejected') console.error('[office-treasury] USDC read failed for', address, usdc.reason)
      if (eth.status === 'rejected') console.error('[office-treasury] ETH read failed for', address, eth.reason)
      return {
        usdc: usdc.status === 'fulfilled' ? ({ ok: true, value: usdc.value } as const) : ({ ok: false } as const),
        eth: eth.status === 'fulfilled' ? ({ ok: true, value: eth.value } as const) : ({ ok: false } as const),
      }
    }),
  )

  const [solvency, fee] = await Promise.all([escrowSolvencyOf(), feeConfigOf()])
  let feeBalance: number | null = null
  if (fee) {
    try {
      feeBalance = await withdrawableOf(fee.feeRecipient)
    } catch (error) {
      console.error('[office-treasury] fee balance read failed:', error)
    }
  }

  return {
    office: { agentCount: myAgents.length, ...summarizeWalletReads(walletReads) },
    market: {
      solvency,
      fee: fee ? { ...fee, balanceUsd: feeBalance } : null,
    },
  }
}
