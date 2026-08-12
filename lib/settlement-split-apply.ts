/**
 * The IO half of settlement splits: move each recipient's share out of the
 * worker agent's smart account, on-chain, right after settlement credited
 * it. Best-effort BY DESIGN — the job is already settled and the worker
 * already paid when this runs; a split failure must never claw that back
 * or wedge the settlement path. What it must do instead is say so:
 * every outcome lands in the platform feed, and a partial split names
 * which shares moved and which are still owed.
 */
import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { logPlatformEvent } from '@/lib/platform-feed'
import { computeSplit, parseSplitSpec, type SplitAllocation } from '@/lib/settlement-split'

/** Resolve where an allocation's money goes. agentId → that agent's smart
 *  account (null if it has none — that share is refused, not guessed). */
async function resolveAddress(alloc: SplitAllocation): Promise<`0x${string}` | null> {
  if (alloc.address) return alloc.address as `0x${string}`
  if (!alloc.agentId) return null
  const [row] = await db.select({ addr: agent.smartAccountAddress }).from(agent).where(eq(agent.id, alloc.agentId))
  return (row?.addr as `0x${string}`) ?? null
}

export async function applySettlementSplit(spec: typeof jobSpec.$inferSelect, bountyUsd: number): Promise<void> {
  if (!spec.splitSpec || !spec.workerAgentId) return
  const parsed = parseSplitSpec(spec.splitSpec)
  if (!parsed.ok) {
    // A spec that was valid at posting time but unreadable now is a data
    // problem worth surfacing, not silently skipping.
    await logPlatformEvent('SPLIT_INCOMPLETE', `"${spec.title}" — stored split spec is invalid: ${parsed.error}`).catch(() => {})
    return
  }

  const { allocations, workerKeepsUsd } = computeSplit(bountyUsd, parsed.spec)
  if (allocations.length === 0) return

  const { transferUsdc } = await import('@/lib/onchain/treasury')
  const paid: string[] = []
  const failed: string[] = []
  for (const alloc of allocations) {
    try {
      const to = await resolveAddress(alloc)
      if (!to) {
        failed.push(`${alloc.role} ($${alloc.amountUsd.toFixed(2)} — recipient has no on-chain account)`)
        continue
      }
      const tx = await transferUsdc(spec.workerAgentId, to, alloc.amountUsd)
      paid.push(`${alloc.role} $${alloc.amountUsd.toFixed(2)} (${tx.slice(0, 10)}…)`)
    } catch (error) {
      failed.push(`${alloc.role} ($${alloc.amountUsd.toFixed(2)} — ${error instanceof Error ? error.message.slice(0, 80) : 'transfer failed'})`)
    }
  }

  if (failed.length === 0) {
    await logPlatformEvent(
      'SPLIT_PAID',
      `"${spec.title}" — settlement split: ${paid.join(', ')}; worker keeps $${workerKeepsUsd.toFixed(2)}`,
    ).catch(() => {})
  } else {
    // Partial is the honest word: which shares moved, which are still owed.
    await logPlatformEvent(
      'SPLIT_INCOMPLETE',
      `"${spec.title}" — split partial: paid [${paid.join(', ') || 'none'}], owed [${failed.join(', ')}] — needs a manual follow-up from the worker's account`,
    ).catch(() => {})
  }
}
