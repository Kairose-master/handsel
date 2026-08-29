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
import { autoReplyFlags, setAutoReplyFlag } from '@/lib/agent-reply-server'
import { sendAgentMessage } from '@/lib/agent-messages'
import { broadcastFromAgent } from '@/lib/agent-broadcast-server'
import { summarizeBroadcast, type BroadcastScope } from '@/lib/agent-broadcast'
import type { AgentNetwork } from '@/lib/agent-network'
import { ANSWERABLE_RUNTIMES } from '@/lib/agent-reply'

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
  /** The viewer's own agents, for the "send as" picker. `autoReply` and
   *  `answerable` ride along so the switch can say why it would not fire —
   *  a pull-based runtime can be opted in and still never answer. */
  myAgents: { id: string; name: string; autoReply: boolean; answerable: boolean }[]
}

export async function myAgentNetwork(): Promise<NetworkView> {
  const user = await requireUser()
  const [network, stats, mine] = await Promise.all([
    buildAgentNetwork(user.id),
    readDeskStats(user.id),
    db
      .select({ id: agent.id, name: agent.name, runtimeType: agent.runtimeType })
      .from(agent)
      .where(eq(agent.userId, user.id)),
  ])
  const answering = await autoReplyFlags(mine.map((a) => a.id))
  return {
    network,
    stats,
    myAgents: mine.map((a) => ({
      id: a.id,
      name: a.name,
      autoReply: answering.has(a.id),
      answerable: (ANSWERABLE_RUNTIMES as readonly string[]).includes(a.runtimeType ?? ''),
    })),
  }
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

/**
 * Let one of the caller's agents answer incoming questions by itself.
 *
 * Deliberately not a silent success when the runtime cannot be called: the
 * result says so, because a switch that is on and can never fire is
 * indistinguishable from a broken feature (docs/failure-modes.md
 * invariant 34).
 */
export async function setAutoReplyForAgent(
  agentId: string,
  enabled: boolean,
): Promise<{ ok: true; answerable: boolean } | { error: string }> {
  const user = await requireUser()
  try {
    const [row] = await db
      .select({ id: agent.id, userId: agent.userId, runtimeType: agent.runtimeType })
      .from(agent)
      .where(eq(agent.id, agentId))
    if (!row || row.userId !== user.id) return { error: 'Not your agent' }
    await setAutoReplyFlag(agentId, enabled)
    revalidatePath('/office/network')
    return { ok: true, answerable: (ANSWERABLE_RUNTIMES as readonly string[]).includes(row.runtimeType ?? '') }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not change it' }
  }
}
