/**
 * Everything the runtime callback does AFTER the deliverable is safely stored:
 * grade it, move the escrow, recompute the worker's credit.
 *
 * One function, two callers — the callback itself (inline, so the worker gets
 * its verdict in the response) and the drain in `lib/ops-cycle.ts` (later, for
 * the ones that did not make it). Sharing the body is the point: a retry path
 * that reimplements the happy path drifts from it, and the drift only ever
 * shows up on the failures nobody was watching.
 *
 * Must be safe to run twice. It is: `settleVerifiedTask` returns early unless
 * the task is still `solving`, `settleLaborMarketJob` returns null unless the
 * job is still awaiting settlement, and `recalculateCredit` is a pure function
 * of the event log. The queue is at-least-once, so that is a requirement and
 * not an observation.
 */
import { db } from '@/lib/db'
import { agentTask } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { recalculateCredit } from '@/lib/credit-engine'
import { settleVerifiedTask } from '@/lib/callback/verified-task'
import { settleLaborMarketJob, type GradeReport } from '@/lib/callback/labor-market'

export type SettlementOutcome = {
  /** The proving-ground verdict, or null if this was not a verified task. */
  verified: boolean | null
  /** The labour-market verdict, or null if this run was not an accepted job.
   *  The desktop miner surfaces this, so its shape is a published interface. */
  grading: GradeReport | null
}

export async function settleTask(
  taskId: string,
  agentId: string,
  output: string,
): Promise<SettlementOutcome> {
  // Verified task? Grade against the hidden answer and settle the escrow.
  const verified = await settleVerifiedTask(taskId, agentId, output)
  if (verified !== null) {
    const { publishValidation } = await import('@/lib/onchain/erc8004')
    await publishValidation(agentId, verified ? 100 : 0, 'proving-ground', `task-${taskId}`)
  }

  // Labor Market job? Submit the REAL output on-chain — no manual "Submit
  // work" click, no placeholder text. The verdict comes back so the worker's
  // log can show paid / refunded / manual review.
  const grading = await settleLaborMarketJob(taskId, output)

  // Last, because it reads the events the two steps above just wrote.
  const credit = await recalculateCredit(agentId)
  await db
    .update(agentTask)
    .set({
      credit: {
        previousScore: credit.previousScore,
        score: credit.score,
        rating: credit.rating,
        creditLimit: credit.creditLimit,
        riskLevel: credit.riskLevel,
        calculationReason: credit.calculationReason,
        breakdown: credit.breakdown,
      },
      updatedAt: new Date(),
    })
    .where(eq(agentTask.id, taskId))

  return { verified, grading }
}

/**
 * Settle one queued task, reading the deliverable back off the task row.
 *
 * The output is not copied into the queue — it can be a quarter of a megabyte,
 * it is already stored, and a second copy is a second thing that can disagree
 * with the first.
 */
export async function settleQueuedTask(taskId: string, agentId: string): Promise<SettlementOutcome> {
  const [row] = await db.select().from(agentTask).where(eq(agentTask.id, taskId))
  if (!row) throw new Error(`task ${taskId} no longer exists`)
  return settleTask(taskId, agentId, row.output ?? '')
}
