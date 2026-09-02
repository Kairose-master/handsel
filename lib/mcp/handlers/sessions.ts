/**
 * MCP tools — sessions (lib/session.ts).
 *
 * open_session says what every turn is graded against and what a turn pays;
 * session_say posts one turn (one escrowed job carrying the thread);
 * session_status reads the thread back; close_session stops new turns.
 * Only session_say moves money, and it moves exactly one turn's bounty plus
 * the posting fee — the same escrow every job on this market uses.
 */
import { toolText, type McpToolContext } from '../rpc'

export async function handleSessions(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'open_session': {
      const { openSession } = await import('@/lib/session-server')
      const r = await openSession({
        userId: auth.userId,
        requesterAgentId: typeof args.agent_id === 'string' ? args.agent_id : null,
        title: String(args.title ?? ''),
        standingCriteria: String(args.standing_criteria ?? ''),
        turnPriceUsd: Number(args.turn_price_usd),
        maxTurns: args.max_turns === undefined ? undefined : Number(args.max_turns),
        wallMs: args.wall_minutes === undefined ? undefined : Number(args.wall_minutes) * 60_000,
      })
      if (!r.ok) return toolText(id, `Session refused (${r.reason}): ${r.message}`, true)
      const s = r.session
      return toolText(
        id,
        `🧵 Session ${s.id} opened — "${s.title}"\n` +
          `$${s.turnPriceUsd} per turn · up to ${s.maxTurns} turns · closes ${s.wallDeadline}\n` +
          `Nothing is escrowed yet. session_say posts the first turn; whichever worker takes it is bound to the session and every later turn is reserved for it.`,
      )
    }
    case 'session_say': {
      const { say } = await import('@/lib/session-server')
      const r = await say({ userId: auth.userId, sessionId: String(args.session_id ?? ''), message: String(args.message ?? '') })
      if (!r.ok) return toolText(id, `Turn refused (${r.reason}): ${r.message}`, true)
      return toolText(
        id,
        `Turn ${r.turn.seq} posted${r.turn.onchainJobId !== null ? ` as job #${r.turn.onchainJobId}` : ''} (tx ${r.txHash.slice(0, 14)}…).\n` +
          `The bounty is escrowed; it releases only if this turn passes grading against the standing criteria plus your message. ` +
          `session_status to watch it; note_to_worker on the job to clarify it while it runs.`,
      )
    }
    case 'session_status': {
      const { listSessions, sessionView } = await import('@/lib/session-server')
      const { renderSession } = await import('@/lib/session')
      if (!args.session_id) {
        const mine = await listSessions(auth.userId)
        if (mine.length === 0) return toolText(id, 'No sessions yet. open_session starts one.')
        return toolText(
          id,
          mine
            .map((s) => `${s.id} · ${s.status}${s.closedBy ? ` (${s.closedBy})` : ''} · ${s.turns}/${s.maxTurns} turns · $${s.turnPriceUsd}/turn · ${s.title}`)
            .join('\n'),
        )
      }
      const v = await sessionView({ userId: auth.userId, sessionId: String(args.session_id) })
      if (!v) return toolText(id, 'No such session, or not yours.', true)
      return toolText(id, renderSession(v.session, v.turns, Date.now()))
    }
    case 'close_session': {
      const { closeSession } = await import('@/lib/session-server')
      const r = await closeSession({ userId: auth.userId, sessionId: String(args.session_id ?? '') })
      if (!r.ok) return toolText(id, `Close refused (${r.reason}): ${r.message}`, true)
      return toolText(
        id,
        `Session ${r.session.id} closed by the ${r.session.closedBy}. No further turns.` +
          (r.openTurn ? ` Turn ${r.openTurn.seq} is still in flight and settles on its own — its escrow releases on a pass, or returns on the job's own terms.` : ''),
      )
    }
    default:
      return null
  }
}
