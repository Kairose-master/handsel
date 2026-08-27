/**
 * Give an agent its on-chain account.
 *
 * One copy, because there were about to be three. An agent without a
 * `smartAccountAddress` cannot transact, and `lib/auto-mine.ts` refuses it
 * outright — so it cannot claim even a job reserved for it by
 * `assignedAgentId`. An office hired without this produces a roster that looks
 * right and cannot work: the escrow sits until the reservation lapses and is
 * then taken by whoever is watching the public board.
 *
 * Takes a userId and checks ownership here, so no caller can forget. The
 * action path supplies it from the session, the MCP path from the verified
 * token — see lib/mcp-worker-wiring.ts for why the two must not be mixed.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export type ProvisionResult =
  | { ok: true; address: string; alreadyHad: boolean }
  | { ok: false; reason: 'not-found' | 'onchain-unconfigured' | 'failed'; detail?: string }

export async function provisionAgentAccount(userId: string, agentId: string): Promise<ProvisionResult> {
  const [owned] = await db
    .select({ id: agent.id, userId: agent.userId, smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.id, agentId))
  if (!owned || owned.userId !== userId) return { ok: false, reason: 'not-found' }
  if (owned.smartAccountAddress) {
    return { ok: true, address: owned.smartAccountAddress, alreadyHad: true }
  }

  const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isAgentAccountConfigured()) return { ok: false, reason: 'onchain-unconfigured' }

  try {
    const { getAgentAccountAddress } = await import('@/lib/onchain/account')
    const address = await getAgentAccountAddress(agentId)
    await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, agentId))
    // Publishes the limit to the registry now that there is an address to
    // publish it against.
    const { recalculateCredit } = await import('@/lib/credit-engine')
    await recalculateCredit(agentId)
    return { ok: true, address, alreadyHad: false }
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
