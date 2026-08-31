/**
 * Benchmark loop, server half: run the pure plan against the live tool
 * record and post what it says, from the house faucet wallet, on the same
 * mint-if-low → insert-spec → postJob path the faucet's own house jobs use.
 *
 * Open to the market rather than reserved: a benchmark exists to measure
 * whichever tool-attached worker actually takes it, and reservation
 * machinery would let the loop steer the sample. Ops-cycle FULL subset only
 * — this posts escrow on-chain, which is cron-budget work, never a
 * visitor's request.
 */
import { planBenchmarkSweep, benchmarkSpecFor, BENCHMARK_TITLE_PREFIX, BENCHMARK_DEFAULT_DAILY_BUDGET_USD, BENCHMARK_BOUNTY_USD } from '@/lib/benchmark-loop'

export async function runBenchmarkSweep(): Promise<{ posted: number; skipped: string | null }> {
  const now = Date.now()

  // Candidates: tools that already have at least one graded job. A tool
  // with no record yet gets its first receipt from real use, not from the
  // refresher — this loop keeps evidence fresh, it does not bootstrap it.
  let candidates: { toolId: string; lastGradedAt: number }[] = []
  try {
    const { toolRecords } = await import('@/lib/tool-record-server')
    candidates = (await toolRecords()).map((r) => ({ toolId: r.toolId, lastGradedAt: r.lastGradedAt }))
  } catch (error) {
    return { posted: 0, skipped: `tool record unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }

  // Spend already committed today, counted from the specs themselves (the
  // bounty is a constant, and job_spec deliberately does not cache prices).
  let spentTodayUsd = 0
  try {
    const { db } = await import('@/lib/db')
    const { jobSpec } = await import('@/lib/db/schema')
    const { and, gte, like, sql } = await import('drizzle-orm')
    const dayStart = new Date(new Date(now).setUTCHours(0, 0, 0, 0))
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobSpec)
      .where(and(like(jobSpec.title, `${BENCHMARK_TITLE_PREFIX}%`), gte(jobSpec.createdAt, dayStart)))
    spentTodayUsd = (row?.n ?? 0) * BENCHMARK_BOUNTY_USD
  } catch {
    // Unreadable spend counts as budget spent — failing CLOSED, because the
    // alternative is a loop that cannot see its own spending and posts anyway.
    return { posted: 0, skipped: 'spend count unreadable — treating the daily budget as spent' }
  }

  let realMoney = false
  try {
    const { isRealMoney } = await import('@/lib/onchain/real-money')
    realMoney = isRealMoney()
  } catch {
    realMoney = true // unknown deployment reads as real — fail closed
  }

  const budgetRaw = process.env.BENCHMARK_DAILY_BUDGET_USD
  const dailyBudgetUsd = budgetRaw !== undefined && budgetRaw.trim() !== '' ? Number(budgetRaw) : BENCHMARK_DEFAULT_DAILY_BUDGET_USD

  const plan = planBenchmarkSweep({
    now,
    enabled: process.env.BENCHMARK_LOOP === 'true',
    realMoney,
    allowRealMoney: process.env.BENCHMARK_ALLOW_REAL_MONEY === 'true',
    dailyBudgetUsd: Number.isFinite(dailyBudgetUsd) ? dailyBudgetUsd : 0,
    spentTodayUsd,
    candidates,
  })
  if (plan.post.length === 0) return { posted: 0, skipped: plan.skipped }

  const { isLaborMarketConfigured, isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured() || !isAgentAccountConfigured()) {
    return { posted: 0, skipped: 'onchain not configured' }
  }
  const { ensureFaucetAgent } = await import('@/lib/job-faucet')
  const faucet = await ensureFaucetAgent()
  if (!faucet?.smartAccountAddress) return { posted: 0, skipped: 'no faucet wallet' }

  // Testnet self-refuel, same constants-by-reference as the faucet's lanes.
  try {
    const { usdcBalanceOf, mintTestUsdc } = await import('@/lib/onchain/treasury')
    const balance = await usdcBalanceOf(faucet.smartAccountAddress as `0x${string}`)
    if (balance < 5) await mintTestUsdc(faucet.id, 20, faucet.smartAccountAddress as `0x${string}`)
  } catch (error) {
    console.error('[benchmark] refuel failed (posting may still succeed):', error)
  }

  const { db } = await import('@/lib/db')
  const { jobSpec } = await import('@/lib/db/schema')
  const { nanoid } = await import('nanoid')
  const { sealForInsert } = await import('@/lib/spec-hash')
  const { postJob } = await import('@/lib/onchain/labor')
  const { logPlatformEvent } = await import('@/lib/platform-feed')

  let posted = 0
  for (const run of plan.post) {
    try {
      const spec = benchmarkSpecFor(now)
      const sealed = sealForInsert(faucet.id, spec, nanoid())
      await db.insert(jobSpec).values({ ...sealed, requesterAgentId: faucet.id, autoApprove: true })
      if (posted > 0) await new Promise((r) => setTimeout(r, 2000)) // bundler rate limit
      await postJob(faucet.id, run.bountyUsd, 0, sealed.specHash)
      posted++
      await logPlatformEvent(
        'JOB_POSTED',
        `Benchmark loop posted "${spec.title}" — $${run.bountyUsd} bounty (stale record: ${run.toolId})`,
      )
    } catch (error) {
      console.error('[benchmark] post failed:', error)
      return { posted, skipped: error instanceof Error ? error.message : String(error) }
    }
  }
  return { posted, skipped: null }
}
