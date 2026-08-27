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
  | {
      ok: true
      address: string
      alreadyHad: boolean
      /** The account exists, but publishing the credit limit to the registry
       *  afterwards failed. The agent CAN transact and claim — the mirror is
       *  bookkeeping and the next recalculation retries it. Reported so the
       *  caller can mention it without calling the provisioning a failure. */
      mirrorFailed?: string
    }
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

  let address: string
  try {
    const { getAgentAccountAddress } = await import('@/lib/onchain/account')
    address = await getAgentAccountAddress(agentId)
    await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, agentId))
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }

  // Separate try, because this runs AFTER the address is saved and a failure
  // here does not undo it. Folded into the block above, a broken credit mirror
  // reported nine successfully provisioned agents as nine failures — the
  // caller then tells the user to fix something that is already done, or
  // worse, not to spend against agents that are in fact ready.
  try {
    const { recalculateCredit } = await import('@/lib/credit-engine')
    await recalculateCredit(agentId)
  } catch (error) {
    return {
      ok: true,
      address,
      alreadyHad: false,
      mirrorFailed: error instanceof Error ? error.message : String(error),
    }
  }
  return { ok: true, address, alreadyHad: false }
}
