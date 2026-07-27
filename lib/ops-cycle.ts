/**
 * The ops cycle — every background sweep, in one list, with one runner.
 *
 * These sweeps used to live inline in /api/cron/settle, driven by a GitHub
 * Actions schedule. Measured on the live deployment, that schedule asks for
 * every 5 minutes and delivers roughly every 80–100 — GitHub treats
 * `schedule:` as best-effort and throttles it hard. Everything that isn't
 * webhook-driven inherited that latency: settlement retries, abandoned-claim
 * refunds, board restocking, loan notices. For hours at a time, they simply
 * did not run.
 *
 * So the work moved here, where anything can drive it: the authenticated
 * cron still runs the full cycle, and ordinary traffic can drive the
 * latency-critical subset after serving its response. One list, two
 * entry points, no drift — the alternative (a second hand-maintained list
 * of "the important ones") rots the first time somebody adds a sweep.
 *
 * FAST steps are the ones a visitor can feel and that cost little: money
 * that should have moved, escrow that should have been freed, an empty
 * board. The slow rest (delegation ticks, faucet, LLM auto-votes, cloud
 * mining fan-out) stays on the cron, where a 300s budget is guaranteed.
 */

export type OpsStep = {
  name: string
  /** Cheap + visitor-facing: safe to run opportunistically on traffic. */
  fast?: boolean
  run: (ctx: { origin: string }) => Promise<unknown>
}

export const OPS_STEPS: OpsStep[] = [
  {
    name: 'sweep',
    fast: true,
    run: async () => {
      const { sweepStuckGradedJobs } = await import('@/lib/labor-settle')
      await sweepStuckGradedJobs()
      return 'ok'
    },
  },
  {
    // First, and fast: this is the one sweep that knows for certain money is
    // owed — a row here means a deliverable was accepted and its settlement
    // did not finish. Everything else in this list is looking for trouble;
    // this one has already been told.
    name: 'settlementQueue',
    fast: true,
    run: async () => {
      const { drainSettlementQueue } = await import('@/lib/callback/settlement-drain')
      return drainSettlementQueue()
    },
  },
  {
    // A bounty whose issue is gone. The refund used to be one webhook
    // delivery, fired once, with two silent exits — so a single RPC hiccup at
    // the moment an issue closed stranded the escrow with no defect anywhere
    // and nothing scheduled to notice. Fast — the file's own definition of
    // fast is "escrow that should have been freed", and this is exactly that.
    // Bounded by RECONCILE_MAX_LOOKUPS per pass rather than by how many
    // bounties exist, which is what makes it safe to ride on visitor traffic.
    name: 'bountyReconcile',
    fast: true,
    run: async () => {
      const { reconcileBounties } = await import('@/lib/bounty-reconcile')
      return reconcileBounties()
    },
  },
  {
    name: 'disputedReposted',
    fast: true,
    run: async () => {
      const { sweepDisputedJobs } = await import('@/lib/labor-settle')
      return sweepDisputedJobs()
    },
  },
  {
    name: 'abandonedClaims',
    fast: true,
    run: async () => {
      const { reclaimAbandonedJobs } = await import('@/lib/stale-claim')
      const r = await reclaimAbandonedJobs()
      // Warnings are reported separately: a tick that warns 3 and reclaims 0
      // is the escalation working, not the sweep failing to find anything.
      const { formatBlocked } = await import('@/lib/stale-claim')
      return r.skipped ?? `${r.reclaimed}/${r.examined} reclaimed, ${r.warned} warned${formatBlocked(r.blocked)}`
    },
  },
  {
    name: 'exhaustedRefunds',
    fast: true,
    run: async () => {
      const { refundExhaustedJobs } = await import('@/lib/exhausted-refund')
      const r = await refundExhaustedJobs()
      return r.skipped ?? `${r.refunded}/${r.examined} refunded`
    },
  },
  {
    name: 'uncreditedPayouts',
    fast: true,
    run: async () => {
      const { reconcileUncreditedPayouts } = await import('@/lib/credit-reconcile')
      const r = await reconcileUncreditedPayouts()
      return r.skipped ?? `${r.credited}/${r.examined} reconciled`
    },
  },
  {
    name: 'boardRestock',
    fast: true,
    run: async () => {
      const { restockBoard } = await import('@/lib/board-stock')
      const r = await restockBoard()
      return r.skipped ?? `open ${r.openBefore} → +${r.posted}`
    },
  },
  {
    name: 'pricesRaised',
    run: async () => {
      const { sweepPriceRaises } = await import('@/lib/price-raise')
      return sweepPriceRaises()
    },
  },
  {
    name: 'raisesResumed',
    fast: true,
    run: async () => {
      const { resumeOrphanedRaises } = await import('@/lib/price-raise')
      return resumeOrphanedRaises()
    },
  },
  {
    name: 'keysIssued',
    run: async () => {
      const { ensureFleetKeys } = await import('@/lib/agent-keys')
      return ensureFleetKeys()
    },
  },
  {
    name: 'fleetTick',
    run: async ({ origin }) => {
      const { tickCloudAutoMineAgents } = await import('@/lib/auto-mine')
      const { reapStuckTasks } = await import('@/lib/agent-tasks')
      await reapStuckTasks()
      await tickCloudAutoMineAgents(`${origin}/api/runtime/callback`)
      return 'ok'
    },
  },
  {
    name: 'houseTopUp',
    run: async () => {
      const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID
      if (!houseAgentId) return 'no house agent configured'
      const { houseBalanceUsd, ensureHouseFunds } = await import('@/lib/house-funding')
      const { balanceUsd } = await houseBalanceUsd(houseAgentId)
      if (balanceUsd !== null && balanceUsd < 50) return (await ensureHouseFunds(houseAgentId, 100)).note
      return balanceUsd === null ? 'balance unreadable' : `ok ($${balanceUsd.toFixed(2)})`
    },
  },
  {
    name: 'loansDefaulted',
    run: async () => {
      const { sweepDefaultedLoans } = await import('@/lib/loan-sweep')
      return sweepDefaultedLoans()
    },
  },
  {
    name: 'loanReminders',
    run: async () => {
      const { sweepLoanReminders } = await import('@/lib/loan-sweep')
      return sweepLoanReminders()
    },
  },
  {
    name: 'delegations',
    run: async () => {
      const { db } = await import('@/lib/db')
      const { delegation } = await import('@/lib/db/schema')
      const { eq } = await import('drizzle-orm')
      const { tickDelegation } = await import('@/lib/delegation')
      let active: (typeof delegation.$inferSelect)[] = []
      try {
        active = await db.select().from(delegation).where(eq(delegation.status, 'posted'))
      } catch {
        return 'table missing (migration pending)'
      }
      if (active.length === 0) return { active: 0 }
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs().catch(() => [])
      let ticked = 0
      let failed = 0
      for (const row of active) {
        await tickDelegation(row, jobs)
          .then(() => { ticked++ })
          .catch((e) => {
            failed++
            console.error(`[ops-cycle] delegation tick failed for ${row.id}:`, e)
          })
      }
      return { active: active.length, ticked, failed }
    },
  },
  {
    name: 'faucet',
    run: async () => {
      const { tickJobFaucet } = await import('@/lib/job-faucet')
      return tickJobFaucet({ force: true })
    },
  },
  {
    name: 'autoVotes',
    run: async () => {
      const { runAutoVotes } = await import('@/lib/governance')
      return runAutoVotes()
    },
  },
  {
    name: 'onchainReveals',
    run: async () => {
      const { revealOnchainVotes } = await import('@/lib/governance')
      return revealOnchainVotes()
    },
  },
]

/** Run steps, collecting a per-step result. One failing sweep never stops
 *  the others — the report carries its error string instead. */
export async function runOpsCycle(origin: string, opts?: { fastOnly?: boolean }): Promise<Record<string, unknown>> {
  const steps = opts?.fastOnly ? OPS_STEPS.filter((s) => s.fast) : OPS_STEPS
  const report: Record<string, unknown> = {}

  // Index creation belongs on a background path, not on a request a user is
  // waiting behind: CREATE INDEX takes a lock, and on a table big enough for
  // the index to matter that is the last request that should hold it.
  // Memoised, so this is a no-op after the first successful pass.
  const { ensureEventIndexes } = await import('@/lib/db/event-index')
  await ensureEventIndexes().catch(() => false)

  for (const step of steps) {
    try {
      report[step.name] = await step.run({ origin })
    } catch (e) {
      report[step.name] = String(e)
    }
  }
  return report
}

/** How often traffic may drive the fast cycle. */
export const TRAFFIC_TICK_INTERVAL_MS = 5 * 60_000

/**
 * Opportunistic tick, for calling from `after()` on a public route: takes a
 * cross-instance lease so exactly one request per interval does the work,
 * and never throws into its caller.
 */
export async function maybeRunTrafficTick(origin: string): Promise<boolean> {
  try {
    const { acquireOpsLease } = await import('@/lib/ops-lease')
    if (!(await acquireOpsLease('traffic-tick', TRAFFIC_TICK_INTERVAL_MS))) return false
    const report = await runOpsCycle(origin, { fastOnly: true })
    console.log('[ops-cycle] traffic tick:', JSON.stringify(report))
    return true
  } catch (error) {
    console.error('[ops-cycle] traffic tick failed:', error)
    return false
  }
}
