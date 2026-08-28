/**
 * Office conversations — recent agent-to-agent negotiation messages
 * (lib/agent-messages.ts's agent_messages rows), shaped for the office
 * diorama to animate.
 *
 * REALITY BEFORE ANIMATION, same bar as artifact flights: a conversation
 * ping is drawn only when every fact behind it is real — an actual
 * agent_messages row, sent within the freshness window, between two agents
 * BOTH currently on this office's roster (a message to an agent in another
 * office or another account has no second endpoint here, and is left out
 * rather than pointed at a guess). The preview is the message's real body,
 * truncated for a tooltip; both endpoints belong to the viewing owner —
 * the office snapshot is owner-scoped — so nothing is surfaced the owner's
 * own dashboard messages page doesn't already show them in full.
 *
 * Pure module: the DB read lives in office-world-server.ts; everything
 * here is testable without a database.
 */

export type ConversationKind = 'inquiry' | 'info' | 'proposal' | 'counter' | 'accept' | 'reject' | 'verified_proposal'

export type AgentConversation = {
  id: string
  fromAgentId: string
  toAgentId: string
  kind: ConversationKind
  /** Real message body, truncated for a hover tooltip. */
  preview: string
  /** ISO timestamp of the real row — the renderer fades pings by age. */
  at: string
}

/** How long a message stays visible as a live ping. Long enough that a
 *  poll-cadence viewer actually sees it, short enough that the office
 *  reads as "now", not as a history view. */
export const CONVERSATION_WINDOW_MS = 10 * 60 * 1000

export const CONVERSATION_PREVIEW_LIMIT = 90

const KIND_BY_TYPE: Record<string, ConversationKind> = {
  inquiry: 'inquiry',
  info: 'info',
  job_proposal: 'proposal',
  job_counter_proposal: 'counter',
  job_proposal_accept: 'accept',
  job_proposal_reject: 'reject',
  verified_task_proposal: 'verified_proposal',
}

/** Map a stored message type to a renderable kind — null for any type this
 *  module doesn't know, so a future message type degrades to "not drawn"
 *  instead of a mislabeled icon. */
export function conversationKindOf(type: string): ConversationKind | null {
  return KIND_BY_TYPE[type] ?? null
}

export type RawAgentMessage = {
  id: string
  fromAgentId: string
  toAgentId: string
  type: string
  body: string
  createdAt: Date
}

/**
 * Filter + shape raw rows into what the diorama animates. Pure and total.
 * Rules, each one a real-data requirement:
 *  - both endpoints must be in `rosterIds` (this office, this owner);
 *  - the row must be younger than CONVERSATION_WINDOW_MS at `now`;
 *  - unknown types are dropped (see conversationKindOf);
 *  - self-messages are dropped — an agent messaging itself is not an
 *    interaction, and drawing a zero-length ping would be noise;
 *  - newest first, capped so a chatty pair can't flood the scene.
 */
export function conversationsFor(
  rows: readonly RawAgentMessage[],
  rosterIds: ReadonlySet<string>,
  now: Date,
  opts: { limit?: number } = {},
): AgentConversation[] {
  const limit = opts.limit ?? 12
  const cutoff = now.getTime() - CONVERSATION_WINDOW_MS
  return rows
    .filter(
      (r) =>
        r.fromAgentId !== r.toAgentId &&
        rosterIds.has(r.fromAgentId) &&
        rosterIds.has(r.toAgentId) &&
        r.createdAt.getTime() >= cutoff &&
        r.createdAt.getTime() <= now.getTime() + 60_000, // clock-skew guard: a "future" row is clamped into view, not dropped silently… but > 1min ahead is bad data
    )
    .map((r) => {
      const kind = conversationKindOf(r.type)
      if (!kind) return null
      const body = r.body.trim()
      return {
        id: r.id,
        fromAgentId: r.fromAgentId,
        toAgentId: r.toAgentId,
        kind,
        preview: body.length > CONVERSATION_PREVIEW_LIMIT ? `${body.slice(0, CONVERSATION_PREVIEW_LIMIT)}…` : body,
        at: r.createdAt.toISOString(),
      }
    })
    .filter((c): c is AgentConversation => c !== null)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}
