/** Public labor metrics. Contract job state and database event observations
 * are separate populations; neither bounty sum proves a withdrawal. */
import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { eq, inArray, sql } from 'drizzle-orm'
import { readMarketSnapshot } from '@/lib/market-snapshot'

const RATING_BANDS = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'C', 'D', 'unrated']
const GRADED_PASS = new Set(['JOB_TESTS_PASSED', 'VERIFIED_TASK_COMPLETED'])
const GRADED_ALL = [...GRADED_PASS, 'JOB_TESTS_FAILED', 'VERIFIED_TASK_FAILED']

export async function computeLaborIndex() {
  const [portfolioStats] = await db
    .select({
      agentCount: sql<number>`count(*)`,
      avgScore: sql<number>`avg(${agent.creditScore})`,
      totalCreditLine: sql<number>`coalesce(sum(${agent.totalCreditLine}), 0)`,
    })
    .from(agent)

  const agents = await db.select({ creditRating: agent.creditRating }).from(agent)
  const ratingCounts = new Map<string, number>()
  for (const a of agents) {
    const band = a.creditRating ?? 'unrated'
    ratingCounts.set(band, (ratingCounts.get(band) ?? 0) + 1)
  }
  const totalAgents = agents.length

  const gradedEvents = await db
    .select({ eventType: agentEvent.eventType })
    .from(agentEvent)
    .where(inArray(agentEvent.eventType, GRADED_ALL))
  const gradedTotal = gradedEvents.length
  const gradedPassed = gradedEvents.filter((e) => GRADED_PASS.has(e.eventType)).length

  const completedEvents = await db
    .select({ detail: agentEvent.detail })
    .from(agentEvent)
    .where(eq(agentEvent.eventType, 'JOB_COMPLETED'))
  const recordedCompletionBountyUsd = completedEvents.reduce((sum, e) => {
    const bounty = (e.detail as { bounty?: number } | null)?.bounty
    return sum + (typeof bounty === 'number' ? bounty : 0)
  }, 0)

  const { jobs, snapshot } = await readMarketSnapshot()
  const open = jobs?.filter((j) => j.status === 'Open')
  const completed = jobs?.filter((j) => j.status === 'Completed')
  const openJobs = open?.length ?? null
  const openBountyUsd = open ? open.reduce((sum, j) => sum + j.bounty, 0) : null

  return {
    generatedAt: new Date().toISOString(),
    snapshot,
    metricSemantics: {
      version: 2,
      completedJobs: 'Unique Completed jobs in snapshot.chainId and snapshot.contractAddress at snapshot.blockNumber.',
      completedBountyUsd: 'Gross bounty of Completed contract jobs, not settlement credits or withdrawals.',
      databaseScope: 'Supply, grading and event observations come from the database, not the block-pinned contract snapshot.',
      databaseEvents: 'All stored JOB_COMPLETED rows; not deduplicated or chain/contract scoped. Missing numeric bounty contributes zero.',
      verifiedPayoutUsd: 'Not reconciled; null does not mean zero. Credits, withdrawals and transfers require separate evidence.',
      deprecated: {
        completedJobsLifetime: { replacement: 'quality.completedJobs', legacyMeaning: 'Database JOB_COMPLETED row count', removal: 'Next major API version, after migration notice; no removal scheduled.' },
        totalPaidOutUsd: { replacement: 'quality.recordedCompletionBountyUsd', legacyMeaning: 'Sum of stored numeric completion-event bounties; not verified payouts', removal: 'Next major API version, after migration notice; no removal scheduled.' },
      },
    },
    supply: {
      agentCount: Number(portfolioStats?.agentCount ?? 0),
      avgCreditScore: portfolioStats?.avgScore ? Math.round(Number(portfolioStats.avgScore)) : null,
      totalCreditLineUsd: Number(portfolioStats?.totalCreditLine ?? 0),
      ratingDistribution: RATING_BANDS.map((band) => ({
        band,
        count: ratingCounts.get(band) ?? 0,
        share: totalAgents > 0 ? Math.round(((ratingCounts.get(band) ?? 0) / totalAgents) * 1000) / 1000 : 0,
      })).filter((r) => r.count > 0),
    },
    demand: {
      openJobs,
      openBountyUsd,
    },
    quality: {
      completedJobs: completed?.length ?? null,
      completedBountyUsd: completed ? completed.reduce((sum, j) => sum + j.bounty, 0) : null,
      recordedCompletionEvents: completedEvents.length,
      recordedCompletionBountyUsd,
      verifiedPayoutUsd: null,
      // Deprecated aliases retain their original values until a major API migration.
      completedJobsLifetime: completedEvents.length,
      totalPaidOutUsd: recordedCompletionBountyUsd,
      // Share of independently-graded outcomes (acceptance tests +
      // verified tasks) that came back a pass — the closest thing this
      // market has to a real "default rate" proxy: null, not 0, when
      // there isn't enough graded history yet to mean anything.
      gradedPassRate: gradedTotal > 0 ? Math.round((gradedPassed / gradedTotal) * 1000) / 1000 : null,
      gradedEventsTotal: gradedTotal,
    },
  }
}

export type LaborIndex = Awaited<ReturnType<typeof computeLaborIndex>>
