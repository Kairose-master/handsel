/**
 * Pay-without-record reconciliation — the mirror of the double-credit bug.
 *
 * Releasing escrow is two steps that can come apart: `approveJob` moves the
 * money on-chain, then `creditWorkerForJob` writes the JOB_COMPLETED event
 * the credit score and the public profile are built from. If the second step
 * is lost — a receipt that never arrives, a delegation tick that throws
 * between them, a lambda that dies — the worker is PAID but has no record of
 * having earned it: their score doesn't move, their profile shows nothing,
 * and the retry is useless because `approveJob` now reverts against a
 * Completed job.
 *
 * That is worse than it sounds for this product specifically. The whole
 * claim is "a track record you cannot manufacture" — a track record that
 * silently drops real work is the same defect from the other direction.
 *
 * So: walk Completed jobs, find the ones with no completion event, and write
 * it. Safe only because creditWorkerForJob is idempotent on the job id — the
 * guard there and this sweep are two halves of one fix, and removing either
 * re-opens the other's failure.
 */
import { db } from '@/lib/db'
import { agent, agentEvent, jobSpec } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

/** Bounded per pass: each miss costs a credit recalculation. */
const MAX_PER_PASS = 5

export type ReconcileReport = { credited: number; examined: number; skipped?: string }

export async function reconcileUncreditedPayouts(): Promise<ReconcileReport> {
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { credited: 0, examined: 0, skipped: 'labor market not configured' }

  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs().catch(() => [])
  const completed = jobs.filter((j) => j.status === 'Completed')
  if (completed.length === 0) return { credited: 0, examined: 0 }

  // One query rather than one per job — but scoped to the completed jobs we
  // are actually examining, not to every completion event the market has
  // ever produced. The unscoped version was still O(all history) on a
  // traffic-driven tick: correct, and quietly more expensive every week.
  const wantedTaskIds = completed.map((j) => `job-${j.id}`)
  const events = await db
    .select({ taskId: agentEvent.taskId })
    .from(agentEvent)
    .where(and(eq(agentEvent.eventType, 'JOB_COMPLETED'), inArray(agentEvent.taskId, wantedTaskIds)))
  const credited = new Set(events.map((e) => e.taskId))

  let fixed = 0
  let examined = 0
  for (const job of completed) {
    if (fixed >= MAX_PER_PASS) break
    if (credited.has(`job-${job.id}`)) continue
    examined++
    try {
      // Only jobs this platform actually brokered — a Completed job with no
      // spec of ours is not ours to write history about.
      const [spec] = await db
        .select({ specHash: jobSpec.specHash, requesterAgentId: jobSpec.requesterAgentId })
        .from(jobSpec)
        .where(and(eq(jobSpec.specHash, job.specHash), eq(jobSpec.onchainJobId, job.id)))
      if (!spec) continue

      // A self-dealt job (same owner on both sides — every office pipeline)
      // is settled BY DESIGN with no credit event: withholding the event is
      // the self-dealing deterrent (see creditWorkerForJob). To this sweep
      // that used to look exactly like lost history, so it "reconciled" the
      // same office jobs every cycle forever — a false 'has been reconciled'
      // feed line each pass, and the whole MAX_PER_PASS budget burned on
      // jobs that can never be credited. The missing event is the record
      // working; skip silently.
      if (spec.requesterAgentId) {
        const { agentByAddress } = await import('@/lib/agent-by-address')
        const workerLookup = await agentByAddress(job.worker)
        if (workerLookup.found) {
          const [requester] = await db
            .select({ userId: agent.userId })
            .from(agent)
            .where(eq(agent.id, spec.requesterAgentId))
          if (requester && requester.userId === workerLookup.agent.userId) continue
        }
      }

      const { creditWorkerForJob } = await import('@/app/actions/labor')
      await creditWorkerForJob(job.worker, job.id, job.bounty, '(reconciled — payout confirmed on-chain)')

      const { logPlatformEvent } = await import('@/lib/platform-feed')
      await logPlatformEvent(
        'JOB_COMPLETED',
        `Job #${job.id} was paid on-chain but never recorded — the worker's track record has been reconciled`,
      ).catch(() => {})
      fixed++
    } catch (error) {
      console.error(`[credit-reconcile] crediting job ${job.id} failed:`, error)
    }
  }

  return { credited: fixed, examined }
}
