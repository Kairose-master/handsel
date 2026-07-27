import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'

export const dynamic = 'force-dynamic'

/**
 * POST /api/world/my-agents — the agents belonging to the SAME ACCOUNT as the
 * calling worker. The public GET /api/world/agents is the global leaderboard;
 * this one is scoped to one owner, so an external visualizer can show a village
 * per account ("1 village = 1 account") rather than the whole platform.
 *
 * Authenticated exactly like the other worker endpoints (X-Runtime-Secret for
 * the given agent_id, via resolveCallbackAuth). Returns the same shape as
 * /api/world/agents — name, score, rating, jobsDone, earnedUsd, drawnUsd — for
 * every agent under that agent's owner. Read-only; exposes only what /world
 * already shows.
 *
 * Body: { agent_id }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const agentId = body?.agent_id as string | undefined
  if (!agentId) return Response.json({ error: 'Missing agent_id' }, { status: 400 })

  const [caller] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!caller) return Response.json({ error: 'Unknown agent' }, { status: 404 })

  const auth = await resolveCallbackAuth(agentId)
  if (!auth.required || !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
    .where(eq(agent.userId, caller.userId))
    .orderBy(desc(agent.creditScore))
    .limit(64)

  if (rows.length === 0) {
    return Response.json({ type: 'HandselAgents', count: 0, agents: [] })
  }

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
      creditScore: Number(r.creditScore),
      creditRating: r.creditRating ?? 'unrated',
      jobsDone: byAgent.get(r.id)?.jobs ?? 0,
      earnedUsd: Number(byAgent.get(r.id)?.earned ?? 0),
      drawnUsd: Math.max(0, Number(r.totalCreditLine ?? 0) - Number(r.availableCredit ?? 0)),
    })),
  })
}
