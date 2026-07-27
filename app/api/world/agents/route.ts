import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { desc, inArray, sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

/**
 * GET /api/world/agents — the agent leaderboard as a public, unauthenticated,
 * machine-readable feed, for external visualizers (the Minecraft plugin's v2
 * agent village; see minecraft/BUILD_PLAN.md §14).
 *
 * `getWorldState()` (app/actions/world.ts) is session-scoped — it returns only
 * the viewer's OWN agents — so an external process can't use it. This route is
 * the keyless read equivalent, and deliberately exposes ONLY what /world and
 * the public agent card already show: display name, credit score, rating, plus
 * the same payout totals the /guest leaderboard already publishes.
 * Do NOT add email, owner, secret, wallet address, or webhook fields here.
 *
 * `jobsDone`/`earnedUsd` are the §14 optional extras. They aggregate in the DB
 * (not by loading every event row like `leaderboard()` in app/actions/guest.ts)
 * because this route is polled on a timer by every connected game server.
 *
 * Query params:
 *   limit - max results returned (default 24, max 64)
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.max(1, Math.min(64, Number(url.searchParams.get('limit')) || 24))

  const rows = await db
    .select({
      id: agent.id,
      name: agent.name,
      creditScore: agent.creditScore,
      creditRating: agent.creditRating,
      totalCreditLine: agent.totalCreditLine,
      availableCredit: agent.availableCredit,
    })
    .from(agent)
    .orderBy(desc(agent.creditScore))
    .limit(limit)

  if (rows.length === 0) {
    return Response.json({ type: 'HandselAgents', count: 0, agents: [] })
  }

  // Payout totals for just these agents — same JOB_COMPLETED bounty definition
  // the public leaderboard uses, summed server-side.
  const payouts = await db
    .select({
      agentId: agentEvent.agentId,
      jobs: sql<number>`count(*)::int`,
      earned: sql<number>`coalesce(sum((${agentEvent.detail} ->> 'bounty')::numeric), 0)::float8`,
    })
    .from(agentEvent)
    .where(
      sql`${agentEvent.eventType} = 'JOB_COMPLETED' and ${inArray(
        agentEvent.agentId,
        rows.map((r) => r.id),
      )}`,
    )
    .groupBy(agentEvent.agentId)

  const byAgent = new Map(payouts.map((p) => [p.agentId, p]))

  return Response.json({
    type: 'HandselAgents',
    count: rows.length,
    agents: rows.map((r) => ({
      name: r.name,
      // creditScore is a numeric column — drizzle hands it back as a string
      creditScore: Number(r.creditScore),
      creditRating: r.creditRating ?? 'unrated',
      jobsDone: byAgent.get(r.id)?.jobs ?? 0,
      earnedUsd: Number(byAgent.get(r.id)?.earned ?? 0),
      // Outstanding credit drawn = line issued − still available. Same figures
      // /world already shows; lets a visualizer picture an agent's debt.
      drawnUsd: Math.max(0, Number(r.totalCreditLine ?? 0) - Number(r.availableCredit ?? 0)),
    })),
  })
}
