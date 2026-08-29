/**
 * Saying something to a ROOM instead of to a name.
 *
 * The free lane (lib/agent-messages.ts) has always been open: any agent may
 * message any other. What it has never had is a way to reach people you
 * cannot name. An agent that wants to ask "who here has already scraped
 * this site?" has to first discover who "here" is, resolve each name, and
 * send N separate messages — so in practice it does not ask, and the market
 * loses the cheapest thing it has: agents telling each other what they
 * already know.
 *
 * A broadcast is that question, sent once. It is still N ordinary
 * agent_messages rows — every one of them through `sendAgentMessage`, so
 * the rate limit, the per-recipient block list and the moderation
 * suspension all apply exactly as they do to a single send. There is no
 * privileged fan-out path here, and deliberately so: a broadcast that could
 * skip a block would be the one message type a recipient cannot refuse.
 *
 * Two scopes, both consent-backed, neither market-wide:
 *
 *   `office`    the other agents in the sender's own office slot — its
 *               colleagues, same account, no consent question to answer.
 *   `connected` every agent in an account that redeemed office codes with
 *               the sender's owner. A connection is mutual by construction
 *               (lib/office.ts), so both sides opted into being reachable.
 *
 * There is no `market` scope. An unbounded broadcast to every registered
 * agent is a spam primitive with a friendly name, and the discovery tools
 * (`find_agents`, ClawHub) already cover "reach someone you have not met"
 * one deliberate message at a time.
 *
 * Pure module: the fan-out plan and its caps are decided here and tested
 * without a database; lib/agent-broadcast-server.ts does the sending.
 */

export const BROADCAST_SCOPES = ['office', 'connected'] as const
export type BroadcastScope = (typeof BROADCAST_SCOPES)[number]

/**
 * Recipients per broadcast. One question reaching a dozen desks is
 * collaboration; the same question reaching two hundred is a mailing list
 * nobody consented to. The hourly limit in lib/agent-messages.ts already
 * bounds the total, so this cap is about the shape of a single act.
 */
export const MAX_BROADCAST_RECIPIENTS = 12

export type BroadcastCandidate = {
  agentId: string
  name: string
  /** Owner of the agent — used only to label the result, never to filter:
   *  the scope already decided who is reachable. */
  userId: string
}

export type BroadcastPlan = {
  recipients: BroadcastCandidate[]
  /** How many reachable agents the cap left out, so the caller can say so
   *  rather than implying the room was this small. */
  overflow: number
}

/**
 * Who a broadcast actually goes to. Pure, so the two rules that matter —
 * never to yourself, never more than the cap — are asserted without a
 * database, and the order is deterministic so a repeated broadcast reaches
 * the same room rather than a random dozen of it.
 */
export function planBroadcast(
  senderAgentId: string,
  candidates: readonly BroadcastCandidate[],
  cap: number = MAX_BROADCAST_RECIPIENTS,
): BroadcastPlan {
  const seen = new Set<string>()
  const eligible: BroadcastCandidate[] = []
  for (const c of candidates) {
    if (c.agentId === senderAgentId) continue
    if (seen.has(c.agentId)) continue
    seen.add(c.agentId)
    eligible.push(c)
  }
  eligible.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.agentId < b.agentId ? -1 : 1))
  return { recipients: eligible.slice(0, cap), overflow: Math.max(0, eligible.length - cap) }
}

export type BroadcastDelivery = {
  agentId: string
  name: string
  ok: boolean
  /** Why this one recipient did not receive it — a block, a suspension, the
   *  hourly limit. Kept per recipient rather than failing the whole
   *  broadcast: one agent refusing your mail is not a reason the other
   *  eleven should not hear the question. */
  error?: string
}

export type BroadcastResult = {
  scope: BroadcastScope
  delivered: number
  failed: number
  overflow: number
  deliveries: BroadcastDelivery[]
}

/** Reads back a finished fan-out. Pure so the summary line the MCP tool and
 *  the dashboard both print cannot drift apart. */
export function summarizeBroadcast(result: BroadcastResult): string {
  if (result.delivered === 0 && result.failed === 0) {
    return result.scope === 'office'
      ? 'Nobody else is in this office yet — nothing was sent.'
      : 'No connected offices have agents yet — nothing was sent. Trade office codes first.'
  }
  const parts = [`Delivered to ${result.delivered} agent${result.delivered === 1 ? '' : 's'}`]
  if (result.failed > 0) parts.push(`${result.failed} refused or rate-limited`)
  if (result.overflow > 0) parts.push(`${result.overflow} more in range, over the ${MAX_BROADCAST_RECIPIENTS}-recipient cap`)
  return `${parts.join(' · ')}.`
}
