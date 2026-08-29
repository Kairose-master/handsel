/**
 * Sending a broadcast. lib/agent-broadcast.ts decides who and how many;
 * this resolves the room from the database and does the fan-out.
 *
 * Every send is one `sendAgentMessage` call — the same function the
 * dashboard's Send button, the BYO worker's HTTP endpoint and the MCP
 * message_agent tool all use. That is the whole safety story: there is no
 * bulk insert here that could skip a block list, and a recipient who
 * blocked the sender simply produces one failed delivery among the others.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { connectedOfficesOf, officeSlotsByAgentId } from '@/lib/office'
import { sendAgentMessage } from '@/lib/agent-messages'
import {
  planBroadcast,
  type BroadcastCandidate,
  type BroadcastDelivery,
  type BroadcastResult,
  type BroadcastScope,
} from '@/lib/agent-broadcast'

/**
 * The room a scope resolves to, for a given sender.
 *
 * `office` — agents of the SAME owner sitting in the same office slot. An
 * agent with no slot has no colleagues by this definition, which is the
 * honest answer rather than falling back to "everyone in the account".
 *
 * `connected` — every agent belonging to an account the sender's owner has
 * an office connection with. Mutual by construction, so no further consent
 * check is needed here.
 */
export async function resolveBroadcastRoom(
  senderAgentId: string,
  scope: BroadcastScope,
): Promise<{ owner: string; candidates: BroadcastCandidate[] } | { error: string }> {
  const [sender] = await db
    .select({ id: agent.id, userId: agent.userId })
    .from(agent)
    .where(eq(agent.id, senderAgentId))
  if (!sender) return { error: 'Sender agent not found' }

  if (scope === 'office') {
    const mine = await db
      .select({ id: agent.id, name: agent.name, userId: agent.userId })
      .from(agent)
      .where(eq(agent.userId, sender.userId))
    const slots = await officeSlotsByAgentId(mine.map((a) => a.id))
    const senderSlot = slots.get(senderAgentId)
    if (senderSlot == null) {
      return { error: 'This agent is not in an office yet — assign it to an office slot first.' }
    }
    return {
      owner: sender.userId,
      candidates: mine
        .filter((a) => slots.get(a.id) === senderSlot)
        .map((a) => ({ agentId: a.id, name: a.name, userId: a.userId })),
    }
  }

  const others = await connectedOfficesOf(sender.userId)
  if (others.length === 0) return { owner: sender.userId, candidates: [] }
  const rows = await db
    .select({ id: agent.id, name: agent.name, userId: agent.userId })
    .from(agent)
    .where(inArray(agent.userId, others))
  return { owner: sender.userId, candidates: rows.map((a) => ({ agentId: a.id, name: a.name, userId: a.userId })) }
}

export async function broadcastFromAgent(input: {
  senderAgentId: string
  scope: BroadcastScope
  body: string
  type?: 'inquiry' | 'info'
}): Promise<BroadcastResult | { error: string }> {
  const room = await resolveBroadcastRoom(input.senderAgentId, input.scope)
  if ('error' in room) return room

  const plan = planBroadcast(input.senderAgentId, room.candidates)
  const deliveries: BroadcastDelivery[] = []
  for (const r of plan.recipients) {
    try {
      await sendAgentMessage({
        fromAgentId: input.senderAgentId,
        toAgentId: r.agentId,
        type: input.type ?? 'inquiry',
        body: input.body,
      })
      deliveries.push({ agentId: r.agentId, name: r.name, ok: true })
    } catch (error) {
      // One refusal is not the others' problem — record it and keep going.
      deliveries.push({
        agentId: r.agentId,
        name: r.name,
        ok: false,
        error: error instanceof Error ? error.message : 'send failed',
      })
    }
  }

  return {
    scope: input.scope,
    delivered: deliveries.filter((d) => d.ok).length,
    failed: deliveries.filter((d) => !d.ok).length,
    overflow: plan.overflow,
    deliveries,
  }
}
