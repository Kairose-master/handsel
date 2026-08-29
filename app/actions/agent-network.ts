'use server'

/**
 * Server actions for /office/network — the graph, the desk tiles, and the
 * two ways to actually say something from it.
 *
 * The point of putting send and broadcast HERE, next to the graph, is that
 * seeing a node and talking to it should be the same gesture. Everything
 * still funnels through lib/agent-messages.ts, so nothing on this page can
 * reach a recipient that a direct message could not.
 */
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { buildAgentNetwork, readDeskStats, type NetworkDeskStats } from '@/lib/agent-network-server'
import { sendAgentMessage } from '@/lib/agent-messages'
import { broadcastFromAgent } from '@/lib/agent-broadcast-server'
import { summarizeBroadcast, type BroadcastScope } from '@/lib/agent-broadcast'
import type { AgentNetwork } from '@/lib/agent-network'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user
}

/** Confirms an agent belongs to the caller. Every send below starts here:
 *  the graph shows other people's agents, and "send AS" must never accept
 *  one of them. */
async function requireMyAgent(userId: string, agentId: string) {
  const [row] = await db
    .select({ id: agent.id, name: agent.name, userId: agent.userId })
    .from(agent)
    .where(eq(agent.id, agentId))
  if (!row || row.userId !== userId) throw new Error('Not your agent')
  return row
}

export type NetworkView = {
  network: AgentNetwork
  stats: NetworkDeskStats
  /** The viewer's own agents, for the "send as" picker. */
  myAgents: { id: string; name: string }[]
}

export async function myAgentNetwork(): Promise<NetworkView> {
  const user = await requireUser()
  const [network, stats, mine] = await Promise.all([
    buildAgentNetwork(user.id),
    readDeskStats(user.id),
    db.select({ id: agent.id, name: agent.name }).from(agent).where(eq(agent.userId, user.id)),
  ])
  return { network, stats, myAgents: mine }
}

export async function sendFromGraph(input: {
  fromAgentId: string
  toAgentId: string
  body: string
  type?: 'inquiry' | 'info'
}): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser()
  try {
    await requireMyAgent(user.id, input.fromAgentId)
    await sendAgentMessage({
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      type: input.type ?? 'inquiry',
      body: input.body,
    })
    revalidatePath('/office/network')
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Send failed' }
  }
}

export async function broadcastFromGraph(input: {
  fromAgentId: string
  scope: BroadcastScope
  body: string
}): Promise<{ ok: true; summary: string } | { error: string }> {
  const user = await requireUser()
  try {
    await requireMyAgent(user.id, input.fromAgentId)
    const result = await broadcastFromAgent({
      senderAgentId: input.fromAgentId,
      scope: input.scope,
      body: input.body,
    })
    if ('error' in result) return { error: result.error }
    revalidatePath('/office/network')
    return { ok: true, summary: summarizeBroadcast(result) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Broadcast failed' }
  }
}
