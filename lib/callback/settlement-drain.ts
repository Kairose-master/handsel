/**
 * The other end of `lib/callback/settlement-queue.ts`: finish the settlements
 * the callback did not.
 *
 * Separate from the queue module so the queue's pure scheduling logic can be
 * unit-tested without pulling in the on-chain settlement path behind it.
 *
 * Runs from the ops cycle, which on this deployment is driven mostly by
 * ordinary traffic — the Vercel cron fires once a day (hobby plan), so a
 * cron-only drain would mean a failed settlement waiting up to twenty-four
 * hours for its second chance. Traffic-driven is the difference between
 * minutes and a day.
 *
 * Which is also why the batch is small. This work is slow and unbounded on
 * the outside (a model grading, a bundler including), and it rides on a
 * request that has already answered a visitor. Draining two at a time and
 * coming back is better than starting twenty and being killed halfway — and
 * being killed halfway is survivable anyway: the lock expires and the rows
 * come back.
 */
import { claimSettlements, completeSettlement, deferSettlement } from '@/lib/callback/settlement-queue'

/** How many settlements one pass will attempt. See the note above. */
export const DRAIN_BATCH = 2

export type DrainReport = {
  claimed: number
  settled: number
  deferred: number
}

export async function drainSettlementQueue(): Promise<DrainReport | string> {
  let batch
  try {
    batch = await claimSettlements(DRAIN_BATCH)
  } catch (error) {
    // The table self-migrates on first write from the callback path, so an
    // error here on a fresh database just means nothing has settled yet.
    return `queue unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
  if (batch.length === 0) return { claimed: 0, settled: 0, deferred: 0 }

  const { settleQueuedTask } = await import('@/lib/callback/settle')
  let settled = 0
  let deferred = 0

  // Sequential, deliberately. These are on-chain sends from the operator's
  // paymaster; running them concurrently competes for the same nonce and for
  // the same daily gas allowance (lib/onchain/gas-policy.ts).
  for (const row of batch) {
    try {
      const outcome = await settleQueuedTask(row.taskId, row.agentId)
      await completeSettlement(row.taskId)
      // A verdict that came out of the QUEUE has no dispatcher waiting on it
      // — the callback already answered 'settlement: queued'. Re-dispatch
      // here or the task sits 'running' until the reap (§68, second sequel).
      if (outcome.grading?.settled === 'retry' && typeof outcome.grading.reason === 'string' && outcome.grading.reason.trim()) {
        console.info(`[settlement-drain] ${row.taskId}: grading asked for another attempt — re-dispatching with the grader's reasons`)
        const { redispatchAfterRetry } = await import('@/lib/agent-tasks')
        await redispatchAfterRetry(row.taskId, outcome.grading.reason).catch((e) =>
          console.error(`[settlement-drain] ${row.taskId}: re-dispatch after retry failed:`, e),
        )
      }
      settled++
      console.log(`[settlement-drain] settled ${row.taskId} on attempt ${row.attempts + 1}`)
    } catch (error) {
      await deferSettlement(row.taskId, error)
      deferred++
    }
  }

  return { claimed: batch.length, settled, deferred }
}
