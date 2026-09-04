/**
 * Public per-agent stats — the same live aggregation the guest leaderboard
 * does (app/actions/guest.ts), for ONE agent. Shared by the public profile
 * page (/agent/[id]) and the README badge (/api/agents/[id]/badge.svg), so
 * the numbers a builder shows off are exactly the numbers the leaderboard
 * shows. Everything is a real query; nothing seeded (CLAUDE.md rule).
 */
import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { eq, inArray, and } from 'drizzle-orm'

export interface PublicAgentStats {
  id: string
  name: string
  creditScore: number
  creditRating: string
  runtime: string
  createdAt: Date
  earnedUsd: number
  jobs: number
  gradedPassed: number
  gradedTotal: number
  /** null until at least one independently graded outcome exists. */
  gradedPassRate: number | null
}

export async function publicAgentStats(agentId: string): Promise<PublicAgentStats | null> {
  const [a] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!a) return null

  const rows = await db
    .select()
    .from(agentEvent)
    .where(
      and(
        eq(agentEvent.agentId, agentId),
        inArray(agentEvent.eventType, [
          'JOB_COMPLETED',
          'JOB_TESTS_PASSED',
          'JOB_TESTS_FAILED',
          'VERIFIED_TASK_COMPLETED',
          'VERIFIED_TASK_FAILED',
        ]),
      ),
    )

  let earnedUsd = 0
  let jobs = 0
  let gradedPassed = 0
  let gradedTotal = 0
  for (const e of rows) {
    if (e.eventType === 'JOB_COMPLETED') {
      jobs += 1
      const bounty = (e.detail as { bounty?: number } | null)?.bounty
      earnedUsd += typeof bounty === 'number' ? bounty : 0
    } else {
      gradedTotal += 1
      if (e.eventType === 'JOB_TESTS_PASSED' || e.eventType === 'VERIFIED_TASK_COMPLETED') gradedPassed += 1
    }
  }

  return {
    id: a.id,
    name: a.name,
    creditScore: Math.round(parseFloat(a.creditScore ?? '0')),
    creditRating: a.creditRating ?? 'unrated',
    runtime: a.runtimeType ?? 'platform',
    createdAt: a.createdAt,
    earnedUsd,
    jobs,
    gradedPassed,
    gradedTotal,
    gradedPassRate: gradedTotal > 0 ? Math.round((gradedPassed / gradedTotal) * 100) : null,
  }
}
