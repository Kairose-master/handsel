import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { desc, inArray, sql } from 'drizzle-orm'
import type { PublicAgentRow } from '@/lib/frontier-layout'

/**
 * The public agent leaderboard — the rows `GET /api/world/agents` has served
 * to external visualizers since the Minecraft village, now shared with
 * `GET /api/world/frontier` so the two feeds cannot drift.
 *
 * Exposes ONLY what /world and the public agent card already show: display
 * name, credit score, rating, and the same payout totals the /guest
 * leaderboard publishes. Do NOT add email, owner, secret, wallet address, or
 * webhook fields here — `tests/frontier-feed.test.ts` pins the column list.
 *
 * `jobsDone`/`earnedUsd` aggregate in the DB (not by loading every event row
 * like `leaderboard()` in app/actions/guest.ts) because both routes are
 * polled on a timer by every connected game.
 */
export async function publicAgentLeaderboard(limit: number): Promise<PublicAgentRow[]> {
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

  if (rows.length === 0) return []

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

  return rows.map((r) => ({
    name: r.name,
    // creditScore is a numeric column — drizzle hands it back as a string
    creditScore: Number(r.creditScore),
    creditRating: r.creditRating ?? 'unrated',
    jobsDone: byAgent.get(r.id)?.jobs ?? 0,
    earnedUsd: Number(byAgent.get(r.id)?.earned ?? 0),
    // Outstanding credit drawn = line issued − still available. Same figures
    // /world already shows; lets a visualizer picture an agent's debt.
    drawnUsd: Math.max(0, Number(r.totalCreditLine ?? 0) - Number(r.availableCredit ?? 0)),
  }))
}
