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

export type GasReadiness =
  | { ready: true; how: 'sponsored' }
  | { ready: true; how: 'self-funded'; weiHeld: string }
  | { ready: false; address: string; weiHeld: string; floorWei: string }

/**
 * Can this agent actually send a transaction yet?
 *
 * Provisioning gives an agent an address; it does not give it the means to
 * use one. Where the deployment has no paymaster, every agent pays its own
 * gas out of its own kernel account, and a freshly provisioned account holds
 * nothing — so it cannot accept a job, including a job posted for it and
 * escrowed on its behalf.
 *
 * That is not hypothetical. A Cloud Options Desk was hired, wired to four
 * verified vendor servers, provisioned, and funded with $6.84 of real escrow,
 * and then sat still: every claim failed on `holds 0 wei, under the floor`.
 * Nothing in the hire said so, because nothing had looked. Now it does, and
 * the answer is reported with the address so the fix is a transfer rather
 * than an investigation.
 *
 * Never throws — a readiness probe must not be the thing that breaks a hire.
 * An unreadable balance reports ready:false with the address, which is the
 * safe direction: it prompts a look rather than implying all is well.
 */
export async function agentGasReadiness(address: string): Promise<GasReadiness> {
  try {
    const { PAYMASTER_DISABLED } = await import('@/lib/gas-budget')
    const { paymasterClient } = await import('@/lib/onchain/paymaster')
    if (!PAYMASTER_DISABLED && paymasterClient()) return { ready: true, how: 'sponsored' }

    const { AGENT_GAS_FLOOR } = await import('@/lib/onchain/account')
    const { publicClient } = await import('@/lib/onchain/clients')
    const balance = await publicClient().getBalance({ address: address as `0x${string}` })
    if (balance >= AGENT_GAS_FLOOR) return { ready: true, how: 'self-funded', weiHeld: balance.toString() }
    return { ready: false, address, weiHeld: balance.toString(), floorWei: AGENT_GAS_FLOOR.toString() }
  } catch (error) {
    console.error('[agent-provision] gas readiness probe failed:', error)
    return { ready: false, address, weiHeld: 'unknown', floorWei: 'unknown' }
  }
}
