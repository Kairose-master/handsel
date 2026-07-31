'use server'

/**
 * Worker Console ("mining layer") data: what a GPU owner cares about —
 * is my worker online, what has it earned, how often does independent
 * grading pass its work, and how much work is waiting on the market.
 * Every number is a live query over the same tables that drive credit
 * scoring; earnings come from JOB_COMPLETED events' recorded bounties.
 */
import { headers } from 'next/headers'
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function getWorkerConsole() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')

  // A 'cloud' agent never polls on its own (see tickCloudAutoMineAgents'
  // doc comment) — this page polling every 10s while open is one of its
  // few real triggers. Deliberately only wired into an authenticated read
  // path, never guest.ts's publicJobs() — that page is intentionally
  // mutation-free for unauthenticated visitors (see Claude.md).
  try {
    const { tickCloudAutoMineAgents } = await import('@/lib/auto-mine')
    const h = await headers()
    const proto = h.get('x-forwarded-proto') ?? 'https'
    const host = h.get('x-forwarded-host') ?? h.get('host')
    await tickCloudAutoMineAgents(`${proto}://${host}/api/runtime/callback`)
  } catch (error) {
    console.error('[worker-console] cloud auto-mine sweep failed:', error)
  }

  const agents = await db.select().from(agent).where(eq(agent.userId, session.user.id))

  // Where each worker's USDC actually is, beyond its wallet: bonds the V2
  // market is holding on jobs it accepted, and settlement credits waiting for
  // withdraw(). Read once for all workers (one multicall + one immutable pair),
  // then filtered per worker below. Null — not zero — when unreadable: a zero
  // is a claim ("nothing is held"), and an RPC hiccup has no basis for it. The
  // mainnet incident this exists for: a worker earned 0.1, its wallet read
  // 0.465 vs 0.5 before the job, and the missing 0.035 was a bond in escrow
  // plus 0.135 claimable — invisible, so the job read as a loss.
  let fundsByAddress: Map<string, { bonded: number; claimable: number }> | null = null
  try {
    const { isV2Market, readJobsV2, bondScheduleOf, withdrawableOf } = await import('@/lib/onchain/labor-v2')
    if (await isV2Market()) {
      const [jobs, schedule] = await Promise.all([readJobsV2(), bondScheduleOf()])
      if (schedule) {
        const { workerFunds } = await import('@/lib/worker-funds')
        const provisioned = agents.filter((a) => a.smartAccountAddress)
        const entries = await Promise.all(
          provisioned.map(async (a) => {
            const address = a.smartAccountAddress as `0x${string}`
            const claimable = await withdrawableOf(address)
            const mine = jobs
              .filter((j) => j.worker.toLowerCase() === address.toLowerCase())
              .map((j) => ({ jobId: j.id, bounty: j.bounty, status: j.status }))
            const f = workerFunds({ wallet: 0, claimable, openJobs: mine, schedule })
            return [address.toLowerCase(), { bonded: f.bonded, claimable: f.claimable }] as const
          }),
        )
        fundsByAddress = new Map(entries)
      }
    }
  } catch (error) {
    console.error('[worker-console] funds read failed:', error)
  }

  const workers = await Promise.all(
    agents.map(async (a) => {
      const events = await db.select().from(agentEvent).where(eq(agentEvent.agentId, a.id))
      const count = (type: string) => events.filter((e) => e.eventType === type).length

      // Current streak: consecutive independent-grader passes, newest first,
      // broken by the first graded failure.
      const GRADED_PASS = new Set(['JOB_TESTS_PASSED', 'VERIFIED_TASK_COMPLETED'])
      const GRADED_ALL = new Set([...GRADED_PASS, 'JOB_TESTS_FAILED', 'VERIFIED_TASK_FAILED'])
      const graded = events
        .filter((e) => GRADED_ALL.has(e.eventType))
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
      let streak = 0
      for (const e of graded) {
        if (GRADED_PASS.has(e.eventType)) streak += 1
        else break
      }
      const earnedUsd = events
        .filter((e) => e.eventType === 'JOB_COMPLETED')
        .reduce((sum, e) => {
          const bounty = (e.detail as { bounty?: number } | null)?.bounty
          return sum + (typeof bounty === 'number' ? bounty : 0)
        }, 0)

      const funds = a.smartAccountAddress
        ? (fundsByAddress?.get(a.smartAccountAddress.toLowerCase()) ?? null)
        : null

      return {
        id: a.id,
        name: a.name,
        runtime: (a.runtimeType ?? 'platform') as 'platform' | 'webhook' | 'local' | 'cloud' | 'mcp',
        autoMine: a.autoMine,
        provisioned: Boolean(a.smartAccountAddress),
        online:
          a.runtimeType === 'local' &&
          a.lastPollAt !== null &&
          Date.now() - a.lastPollAt.getTime() < 30_000,
        creditScore: Math.round(parseFloat(a.creditScore)),
        rating: a.creditRating,
        jobsCompleted: count('JOB_COMPLETED'),
        earnedUsd,
        streak,
        testsPassed: count('JOB_TESTS_PASSED'),
        testsFailed: count('JOB_TESTS_FAILED'),
        verifiedPassed: count('VERIFIED_TASK_COMPLETED'),
        verifiedFailed: count('VERIFIED_TASK_FAILED'),
        /** USDC the market holds as this worker's bond on unsettled jobs.
         *  Returns to the worker on completion; null = unreadable, not zero. */
        bondedUsd: funds ? funds.bonded : null,
        /** USDC settlement has credited and `withdraw()` has not collected. */
        claimableUsd: funds ? funds.claimable : null,
      }
    }),
  )

  // How much work is sitting on the market right now.
  let openJobs = 0
  let openBountyUsd = 0
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (isLaborMarketConfigured()) {
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs()
      const open = jobs.filter((j) => j.status === 'Open')
      openJobs = open.length
      openBountyUsd = open.reduce((s, j) => s + j.bounty, 0)
    }
  } catch {
    /* market unreadable — show zeros rather than stale numbers */
  }

  return { workers, market: { openJobs, openBountyUsd } }
}
