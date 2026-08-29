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
 * that should have moved and escrow that should have been freed. There used
 * to be a `boardRestock` here too, filling an empty board with translation
 * work the house posted to itself; it was removed when translation stopped
 * being something worth buying. An empty board is now a true statement about
 * demand rather than a gap to paper over. The slow rest (delegation ticks, faucet, LLM auto-votes, cloud
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
    // The ONLY thing on a V2 market that resolves a dispute — and it never
    // decides one. It opens and closes a dispute in the same pass, and only
    // when a refund is derivable from evidence the requester did not author.
    // Everything else settles on a deadline, which pays the worker.
    //
    // Deliberately AFTER `deadlines` and sharing nothing with it. If this step
    // throws on every pass, expireReview and expireDispute still settle
    // everything; the policy layer is allowed to be broken because the backstop
    // is not inside it. Capped at MAX_RULINGS_PER_PASS.
    name: 'disputeGate',
    fast: true,
    run: async () => {
      const { settleDisputes } = await import('@/lib/dispute-gate')
      return settleDisputes()
    },
  },
  {
    // The four permissionless exits, finally called by something.
    //
    // LaborMarketV2 grew expireOpen/reclaimJob/expireReview/expireDispute —
    // each deadline-gated, each callable by a stranger, each proven against a
    // real EVM — and a grep for their names across lib/, app/ and sdk/ returned
    // NOTHING. "Permissionless" means anyone MAY call it; it does not mean
    // anyone will. Until this step existed, the timeouts were a property of the
    // bytecode and not of the product.
    //
    // Its own step, deliberately apart from anything that decides policy. This
    // is the backstop the dispute design rests on — the answer to "what if
    // nobody acts" is a deadline, and a deadline nobody calls is not an answer.
    // A bug in a policy sweep must not be able to take it down with it, so they
    // share no step, no lease, and no failure.
    //
    // Fast, and bounded by MAX_EXITS_PER_PASS rather than by how many jobs
    // exist: escrow whose counterparty is gone is this file's own definition of
    // what a visitor actually feels. No-ops entirely against a V1 market.
    name: 'deadlines',
    fast: true,
    run: async () => {
      const { sweepDeadlines } = await import('@/lib/deadline-sweep')
      return sweepDeadlines()
    },
  },
  {
    // The other half of pull payments: something that pulls.
    //
    // V2 settlement credits rather than transfers, because pushing let one
    // blocklisted recipient revert an entire settlement. The price is a second
    // transaction — and `withdraw()` sat in lib/onchain/labor-v2.ts with zero
    // callers, exactly as the four exits did before `deadlines` existed. A
    // worker would finish jobs, see the dashboard say it earned, and hold no
    // tokens.
    //
    // AFTER `deadlines` and sharing nothing with it. Uncollected money is safe
    // where it is — `withdrawable` is a balance, not a deadline, and nothing
    // expires it — so this is allowed to be best-effort in a way the backstop is
    // not, and it must not be able to consume the lease the backstop needs.
    // Bounded by MAX_WITHDRAWALS_PER_PASS, which is smaller than
    // MAX_EXITS_PER_PASS for that reason. No-ops entirely against a V1 market.
    name: 'withdrawals',
    fast: true,
    run: async () => {
      const { sweepWithdrawals } = await import('@/lib/withdraw-sweep')
      return sweepWithdrawals()
    },
  },
  {
    // Appeals a worker filed against a failing verdict (docs/appeal.md). Only
    // the `recompute` route is hearable today; `panel` needs a two-phase
    // dispatch that does not exist, so those are left open rather than decided
    // against the worker. Nothing here moves escrow — an appeal changes the
    // recorded verdict and the credit event, and the settlement path is
    // untouched.
    name: 'appeals',
    fast: true,
    run: async () => {
      const { sweepAppeals } = await import('@/lib/appeal-resolve')
      return sweepAppeals()
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
    // The Office Automaton's standing mandate (lib/office-automaton.ts):
    // keep opted-in desks claim-ready by topping worker bond float up to a
    // small floor, inside a daily budget, out of the owner's own wallets.
    // NOT fast — it reads on-chain balances across every enabled office and
    // may send UserOperations, which is cron-budget work, not something to
    // ride on a visitor's request.
    name: 'officeAutomata',
    run: async () => {
      const { tickOfficeAutomatons } = await import('@/lib/office-automaton')
      return tickOfficeAutomatons()
    },
  },
  {
    // The lineage mandate (lib/lineage-mandate.ts): seed children from proven
    // agents, retire failing or starved ones. Refuses outright on a
    // real-money deployment unless explicitly allowed — see that module's
    // header for why an evolutionary loop is a rehearsal-first feature.
    name: 'lineageMandates',
    run: async () => {
      const { tickLineageMandates } = await import('@/lib/lineage-mandate')
      return tickLineageMandates()
    },
  },
  {
    // The Mail Desk (lib/mail-desk.ts): match incoming USDC transfers to
    // open email quotes by exact amount, commission what got paid, mail
    // what got finished. Chain-log scans, so full cycle only.
    name: 'mailOrders',
    run: async () => {
      const { tickMailOrders } = await import('@/lib/mail-desk')
      return tickMailOrders()
    },
  },
  {
    // The free lane's missing half (lib/agent-reply.ts): every unread
    // QUESTION addressed to an agent whose owner turned auto-reply on gets
    // answered by that agent's own runtime. An LLM call per reply, so cron
    // only — never on visitor traffic.
    name: 'agentReplies',
    run: async () => {
      const { tickAgentReplies } = await import('@/lib/agent-reply-server')
      return tickAgentReplies()
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

/** How long a full cycle holds the floor. Sized to the cron interval, not to
 *  how long the cycle takes: the point is that the next scheduled fire is a
 *  no-op while this one is still working, not that slow steps get a deadline. */
export const FULL_CYCLE_LEASE_MS = 5 * 60_000

/** Run steps, collecting a per-step result. One failing sweep never stops
 *  the others — the report carries its error string instead.
 *
 *  The full cycle takes a lease. The fast subset never needed one at this
 *  level — every money-moving step inside it already leases individually —
 *  but the full cycle adds `fleetTick` and `delegations`, and those write
 *  plan state rather than settling an on-chain fact. Two overlapping runs
 *  would each advance the same delegation a wave, which posts the same
 *  subtask twice. Per-call idempotence does not compose under concurrency,
 *  so the cycle serialises itself. */
export async function runOpsCycle(origin: string, opts?: { fastOnly?: boolean }): Promise<Record<string, unknown>> {
  const steps = opts?.fastOnly ? OPS_STEPS.filter((s) => s.fast) : OPS_STEPS
  const report: Record<string, unknown> = {}

  if (!opts?.fastOnly) {
    const { acquireOpsLease } = await import('@/lib/ops-lease')
    if (!(await acquireOpsLease('full-cycle', FULL_CYCLE_LEASE_MS))) {
      return { skipped: 'another full cycle holds the lease' }
    }
  }

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
