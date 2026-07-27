/**
 * Settling a verified task — the proving-ground lane, where the answer is
 * checked against a hidden one rather than graded by a model.
 *
 * Split out of app/api/runtime/callback/route.ts. Unchanged apart from being
 * exported: this runs two UserOperations and is one of the two reasons that
 * route needed a five-minute budget.
 */
import { db } from '@/lib/db'
import { agentEvent, verifiableTask } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { extractAnswer } from '@/lib/verifiable/problems'
/**
 * If this agent run was the solve of a verified task: grade the output
 * against the hidden ground-truth answer (grader ≠ solver), and on a correct
 * answer settle the on-chain escrow via commit-reveal from the solver's
 * smart account. Both outcomes are recorded as VERIFIED_TASK_* events — the
 * factual quality signal the credit engine weighs above self-evaluation.
 */
export async function settleVerifiedTask(
  agentTaskId: string,
  solverAgentId: string,
  output: string,
): Promise<boolean | null> {
  const [row] = await db
    .select()
    .from(verifiableTask)
    .where(eq(verifiableTask.agentTaskId, agentTaskId))
  if (!row || row.status !== 'solving') return null

  const submitted = extractAnswer(output)
  const correct = submitted !== null && submitted === row.answer

  try {
    if (correct && row.onchainId) {
      await db
        .update(verifiableTask)
        .set({ status: 'settling', submittedAnswer: submitted, updatedAt: new Date() })
        .where(eq(verifiableTask.id, row.id))

      const { commitAndReveal } = await import('@/lib/onchain/verified')
      const { revealTx } = await commitAndReveal(
        row.solverAgentId,
        row.onchainId,
        row.answer,
        row.salt as `0x${string}`,
      )

      await db
        .update(verifiableTask)
        .set({ status: 'completed', settleTxHash: revealTx, updatedAt: new Date() })
        .where(eq(verifiableTask.id, row.id))

      await db.insert(agentEvent).values({
        id: nanoid(),
        agentId: solverAgentId,
        taskId: `verified-${row.id}`,
        eventType: 'VERIFIED_TASK_COMPLETED',
        success: true,
        executionTime: 0,
        tokenCost: 0,
        qualityScore: '1.000', // graded fact, not self-opinion
        detail: {
          difficulty: row.difficulty,
          bounty: row.bountyUsd,
          problem: row.problem,
          txHash: revealTx,
          onchain: true,
        },
      })
      return true
    } else {
      await db
        .update(verifiableTask)
        .set({ status: 'failed', submittedAnswer: submitted, updatedAt: new Date() })
        .where(eq(verifiableTask.id, row.id))

      await db.insert(agentEvent).values({
        id: nanoid(),
        agentId: solverAgentId,
        taskId: `verified-${row.id}`,
        eventType: 'VERIFIED_TASK_FAILED',
        success: false,
        executionTime: 0,
        tokenCost: 0,
        qualityScore: '0.000',
        detail: {
          difficulty: row.difficulty,
          problem: row.problem,
          submitted: submitted ?? '(no FINAL_ANSWER found)',
        },
      })
      return false
    }
  } catch (error) {
    console.error('[runtime/callback] verified settlement failed:', error)
    await db
      .update(verifiableTask)
      .set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(verifiableTask.id, row.id))
  }
  return null
}
