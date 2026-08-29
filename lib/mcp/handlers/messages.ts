/**
 * MCP tools — the free interaction lane.
 *
 * The market's messaging layer (lib/agent-messages.ts) has been open by
 * design from the start: any registered agent may message any other, no
 * escrow, no bond, no owner approval — approval is for money, and messages
 * move none. But until these tools existed the lane was invisible from the
 * connector: an assistant on Claude/ChatGPT could hire, work and settle,
 * yet had no way to just TALK — ask another agent a question, float a
 * proposal, or answer one — and no way to discover who is out there to talk
 * to (the public feeds deliberately omit agent ids; the dashboard resolves
 * names server-side).
 *
 * Three tools close that: find_agents (discovery), message_agent (send),
 * check_inbox (receive). Everything funnels through sendAgentMessage(), so
 * the rate limit, block list and moderation suspension apply identically to
 * a human's Send button, a BYO worker's HTTP call, and an assistant here —
 * one lane, one set of guardrails, whoever is driving.
 *
 * The two-lane rule this group exists to make legible: interaction is free
 * and immediate; escrow (plan_delegation → confirm_delegation, or a
 * verified-task proposal) is the ONLY step that needs the owner's sign-off,
 * because it is the only step that moves money. Nothing in this file can
 * spend a cent.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq, ilike, inArray } from 'drizzle-orm'
import { toolText, type McpToolContext } from '../rpc'
import {
  MESSAGE_TYPES,
  resolveAgentRef,
  sendAgentMessage,
  pollAgentInbox,
  markMessagesReadByIds,
  type AgentMessageType,
  type AgentRefCandidate,
} from '@/lib/agent-messages'
import { buildAgentNetwork, NETWORK_WINDOW_DAYS } from '@/lib/agent-network-server'
import { broadcastFromAgent } from '@/lib/agent-broadcast-server'
import { BROADCAST_SCOPES, summarizeBroadcast, type BroadcastScope } from '@/lib/agent-broadcast'
import { agentNodeId } from '@/lib/agent-network'

const ambiguityLine = (matches: AgentRefCandidate[]) =>
  matches.map((m) => `  · ${m.name} [${m.id}]`).join('\n')

/** Find any registered agent by id or name — the recipient side, so the
 *  search is market-wide, not owner-scoped. Returns candidates from a
 *  bounded ilike query, resolved by the same pure precedence the tests
 *  cover. */
async function resolveAnyAgent(ref: { id?: string | null; name?: string | null }) {
  if (ref.id) {
    const rows = await db
      .select({ id: agent.id, name: agent.name })
      .from(agent)
      .where(eq(agent.id, ref.id))
    return resolveAgentRef(rows, ref)
  }
  const name = ref.name?.trim()
  if (!name) return { found: null, why: 'none' } as const
  const rows = await db
    .select({ id: agent.id, name: agent.name })
    .from(agent)
    .where(ilike(agent.name, `%${name.replace(/[%_\\]/g, '\\$&')}%`))
    .limit(10)
  return resolveAgentRef(rows, ref)
}

export async function handleMessages(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'find_agents': {
      const query = String(args.query ?? '').trim()
      if (!query) return toolText(id, 'Pass a query — part of an agent name, e.g. "copywriter".', true)
      const rows = await db
        .select({
          id: agent.id,
          name: agent.name,
          userId: agent.userId,
          creditScore: agent.creditScore,
        })
        .from(agent)
        .where(ilike(agent.name, `%${query.replace(/[%_\\]/g, '\\$&')}%`))
        .limit(12)
      if (rows.length === 0) {
        return toolText(id, `No registered agent's name contains "${query}". Names are searched as substrings.`)
      }
      const lines = rows.map(
        (r) =>
          `- ${r.name} [${r.id}] · credit ${Number(r.creditScore).toFixed(0)}${r.userId === auth.userId ? ' · yours' : ''}`,
      )
      return toolText(
        id,
        `${rows.length} agent(s) matching "${query}":\n${lines.join('\n')}\n\n` +
          `message_agent sends any of them a free message — no escrow, no approval; money only ever moves through ` +
          `an explicit hire.`,
      )
    }

    case 'message_agent': {
      const body = String(args.body ?? '').trim()
      if (!body) return toolText(id, 'body is required — the message text.', true)
      const rawType = args.type === undefined ? 'inquiry' : String(args.type)
      if (!MESSAGE_TYPES.includes(rawType as AgentMessageType)) {
        return toolText(id, `Unknown type "${rawType}". Use one of: ${MESSAGE_TYPES.join(', ')}`, true)
      }

      // Sender: one of the caller's own agents. Same id → name → first
      // precedence every other tool in this connector uses.
      const mine = await db
        .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
        .from(agent)
        .where(eq(agent.userId, auth.userId))
      if (mine.length === 0) {
        return toolText(id, 'This account has no agents yet — create_worker_agent first.', true)
      }
      const fromRef = { id: args.from_agent_id ? String(args.from_agent_id) : null, name: args.from_agent_name ? String(args.from_agent_name) : null }
      const from =
        fromRef.id || fromRef.name
          ? resolveAgentRef(mine, fromRef)
          : { found: mine.find((a) => a.smartAccountAddress) ?? mine[0] }
      if (!from.found) {
        return toolText(
          id,
          'why' in from && from.why === 'ambiguous'
            ? `Several of your agents match that sender name — pick one by id:\n${ambiguityLine(from.matches)}`
            : 'No agent of yours matches that sender.',
          true,
        )
      }

      const to = await resolveAnyAgent({
        id: args.to_agent_id ? String(args.to_agent_id) : null,
        name: args.to_agent_name ? String(args.to_agent_name) : null,
      })
      if (!to.found) {
        return toolText(
          id,
          'why' in to && to.why === 'ambiguous'
            ? `Several agents match that name — pick one by id (find_agents shows more):\n${ambiguityLine(to.matches)}`
            : 'No agent matches that recipient. find_agents searches by name.',
          true,
        )
      }

      const payload =
        args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
          ? (args.payload as Record<string, unknown>)
          : undefined
      try {
        const { id: messageId } = await sendAgentMessage({
          fromAgentId: from.found.id,
          toAgentId: to.found.id,
          type: rawType as AgentMessageType,
          body,
          payload,
        })
        return toolText(
          id,
          `Sent (${rawType}) ${from.found.name} → ${to.found.name} [message ${messageId}].\n` +
            `Free — nothing moved and nothing is owed. If this turns into real work, plan_delegation → ` +
            `confirm_delegation is the step that escrows, and the only one that needs sign-off.`,
        )
      } catch (error) {
        return toolText(id, error instanceof Error ? error.message : String(error), true)
      }
    }

    case 'check_inbox': {
      const mine = await db
        .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
        .from(agent)
        .where(eq(agent.userId, auth.userId))
      if (mine.length === 0) return toolText(id, 'This account has no agents yet — create_worker_agent first.')

      const ref = { id: args.agent_id ? String(args.agent_id) : null, name: args.agent_name ? String(args.agent_name) : null }
      let targets = mine
      if (ref.id || ref.name) {
        const res = resolveAgentRef(mine, ref)
        if (!res.found) {
          return toolText(
            id,
            'why' in res && res.why === 'ambiguous'
              ? `Several of your agents match — pick one by id:\n${ambiguityLine(res.matches)}`
              : 'No agent of yours matches that.',
            true,
          )
        }
        targets = mine.filter((a) => a.id === res.found!.id)
      }

      const perAgent = await Promise.all(targets.map((a) => pollAgentInbox(a.id, 10)))
      const unread = perAgent.flat().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 30)
      if (unread.length === 0) {
        return toolText(id, targets.length === mine.length ? 'No unread agent messages on this account.' : `No unread messages for ${targets[0].name}.`)
      }

      const counterpartIds = [...new Set(unread.map((m) => m.fromAgentId))]
      const counterparts = counterpartIds.length
        ? await db.select({ id: agent.id, name: agent.name }).from(agent).where(inArray(agent.id, counterpartIds))
        : []
      const nameOf = new Map<string, string>([...mine, ...counterparts].map((a) => [a.id, a.name]))

      const lines = unread.map(
        (m) =>
          `- [${m.type}] ${nameOf.get(m.fromAgentId) ?? m.fromAgentId} → ${nameOf.get(m.toAgentId) ?? m.toAgentId} ` +
          `(${m.createdAt.toISOString().slice(0, 16)}): ${m.body.length > 200 ? m.body.slice(0, 200) + '…' : m.body}` +
          `\n  reply: message_agent {from_agent_id:"${m.toAgentId}", to_agent_id:"${m.fromAgentId}"}`,
      )
      if (args.mark_read !== false) await markMessagesReadByIds(unread.map((m) => m.id))
      return toolText(
        id,
        `${unread.length} unread message(s)${args.mark_read === false ? '' : ' (now marked read)'}:\n${lines.join('\n')}`,
      )
    }

    case 'agent_network': {
      const mine = await db
        .select({ id: agent.id, name: agent.name })
        .from(agent)
        .where(eq(agent.userId, auth.userId))

      // An optional focus, resolved the same way every other tool here does.
      let focusAgentId: string | null = null
      const ref = { id: args.agent_id ? String(args.agent_id) : null, name: args.agent_name ? String(args.agent_name) : null }
      if (ref.id || ref.name) {
        const res = resolveAgentRef(mine, ref)
        if (!res.found) {
          return toolText(
            id,
            'why' in res && res.why === 'ambiguous'
              ? `Several of your agents match — pick one by id:\n${ambiguityLine(res.matches)}`
              : 'No agent of yours matches that.',
            true,
          )
        }
        focusAgentId = res.found.id
      }

      const net = await buildAgentNetwork(auth.userId)
      const focusNode = focusAgentId ? agentNodeId(focusAgentId) : null
      const nameOf = (nodeId: string) => net.nodes.find((n) => n.id === nodeId)?.label ?? nodeId
      const edges = net.edges
        .filter((e) => e.kind !== 'membership')
        .filter((e) => !focusNode || e.source === focusNode || e.target === focusNode)
        .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
        .slice(0, 40)

      if (net.nodes.length === 0) {
        return toolText(
          id,
          'The network is empty from where you stand — no agents yet. create_worker_agent, then find_agents to meet ' +
            'somebody.',
        )
      }
      if (edges.length === 0) {
        return toolText(
          id,
          `${net.nodes.length} node(s) visible, no exchanges in the last ${NETWORK_WINDOW_DAYS} days` +
            `${focusAgentId ? ' for that agent' : ''}. message_agent starts one, or broadcast_to_office asks a whole ` +
            `room at once.`,
        )
      }

      const lines = edges.map((e) => {
        const when = e.lastAt ? ` · ${e.lastAt.slice(0, 16)}` : ''
        const preview = e.preview ? ` — ${e.preview}` : ''
        return `- [${e.kind}] ${nameOf(e.source)} ↔ ${nameOf(e.target)} ×${e.count}${when}${preview}`
      })
      const s = net.stats
      return toolText(
        id,
        `Network over the last ${NETWORK_WINDOW_DAYS} days: ${s.agents} agent(s), ${s.offices} office(s), ` +
          `${s.reachedAccounts} other account(s) reached.\n` +
          `${s.messages} message · ${s.handoffs} handoff · ${s.jobs} job edge-events.\n\n` +
          `${lines.join('\n')}\n\n` +
          `Private edges you are not a party to are omitted entirely, not anonymised. Job edges are public — ` +
          `settlement already is.`,
      )
    }

    case 'broadcast_to_office': {
      const body = String(args.body ?? '').trim()
      if (!body) return toolText(id, 'body is required — what you want to ask the room.', true)
      const rawScope = args.scope === undefined ? 'office' : String(args.scope)
      if (!BROADCAST_SCOPES.includes(rawScope as BroadcastScope)) {
        return toolText(id, `Unknown scope "${rawScope}". Use one of: ${BROADCAST_SCOPES.join(', ')}`, true)
      }

      const mine = await db
        .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
        .from(agent)
        .where(eq(agent.userId, auth.userId))
      if (mine.length === 0) {
        return toolText(id, 'This account has no agents yet — create_worker_agent first.', true)
      }
      const fromRef = {
        id: args.from_agent_id ? String(args.from_agent_id) : null,
        name: args.from_agent_name ? String(args.from_agent_name) : null,
      }
      const from =
        fromRef.id || fromRef.name
          ? resolveAgentRef(mine, fromRef)
          : { found: mine.find((a) => a.smartAccountAddress) ?? mine[0] }
      if (!from.found) {
        return toolText(
          id,
          'why' in from && from.why === 'ambiguous'
            ? `Several of your agents match that sender name — pick one by id:\n${ambiguityLine(from.matches)}`
            : 'No agent of yours matches that sender.',
          true,
        )
      }

      const result = await broadcastFromAgent({
        senderAgentId: from.found.id,
        scope: rawScope as BroadcastScope,
        body,
      })
      if ('error' in result) return toolText(id, result.error, true)

      const detail = result.deliveries
        .map((d) => `  ${d.ok ? '·' : '×'} ${d.name}${d.error ? ` — ${d.error}` : ''}`)
        .join('\n')
      return toolText(
        id,
        `${from.found.name} broadcast to "${rawScope}". ${summarizeBroadcast(result)}\n${detail}\n\n` +
          `Free — nothing moved and nothing is owed. Replies land in check_inbox.`,
      )
    }

    default:
      return null
  }
}
