/**
 * MCP tools — governance.
 *
 * Proposals, votes, and delegating a vote to an agent.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */
import { agent } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { toolText, type McpToolContext } from '../rpc'

export async function handleGovernance(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'governance': {
      const { govSummary, listProposals, listPendingReviews } = await import('@/lib/governance')
      const [summary, proposals, reviews] = await Promise.all([
        govSummary(auth.userId),
        listProposals(auth.userId, 10),
        listPendingReviews(auth.userId),
      ])
      const head = `$LEDGER — balance ${summary.balance.toFixed(1)}, locked ${summary.locked.toFixed(1)}, voting power ${summary.votingPower.toFixed(1)} (earned ${summary.totalEarned.toFixed(1)} total).`
      const open = proposals.filter((p) => p.open)
      const propLines = open.length
        ? open.map((p) => `- ${p.id} "${p.title}" — For ${p.tally.for.toFixed(1)} / Against ${p.tally.against.toFixed(1)} / Abstain ${p.tally.abstain.toFixed(1)} · closes ${new Date(p.closesAt).toISOString().slice(0, 10)}${p.yourVote ? ` · you voted ${p.yourVote}` : ''}`).join('\n')
        : '(no open proposals)'
      const reviewLine = reviews.length
        ? `\n\n⚠ ${reviews.length} delegate recommendation(s) need your review (low confidence or minority-impact) — resolve them on /governance.`
        : ''
      return toolText(id, `${head}\n\nOpen proposals:\n${propLines}${reviewLine}\n\nVote with the vote tool. Earn $LEDGER by completing jobs; lock it on the /governance page for power.`)
    }
    case 'vote': {
      const proposalId = String(args.proposal_id ?? '')
      const choice = String(args.choice ?? '')
      if (!['for', 'against', 'abstain'].includes(choice)) return toolText(id, 'choice must be for / against / abstain.', true)
      const { castVote } = await import('@/lib/governance')
      try {
        const r = await castVote(auth.userId, proposalId, choice as 'for' | 'against' | 'abstain')
        return toolText(id, `Voted ${choice} with ${r.power.toFixed(1)} voting power.`)
      } catch (e) {
        return toolText(id, e instanceof Error ? e.message : String(e), true)
      }
    }
    case 'set_auto_vote': {
      const wanted = String(args.agent_id ?? '')
      const enabled = args.enabled === true
      const policy = String(args.policy ?? '')
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const target =
        agents.find((a) => a.id === wanted) ?? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
      if (!target) return toolText(id, `No agent with id or name "${wanted}".`, true)
      const { setAutoVote } = await import('@/lib/governance')
      try {
        await setAutoVote(target.id, auth.userId, enabled, policy)
        return toolText(
          id,
          enabled
            ? `${target.name} is now your voting delegate — it will vote on open proposals per: "${policy.trim().slice(0, 120)}". Lock $LEDGER on /governance to give it weight.`
            : `Auto-voting disabled for ${target.name}.`,
        )
      } catch (e) {
        return toolText(id, e instanceof Error ? e.message : String(e), true)
      }
    }
    default:
      return null
  }
}
