/**
 * Hearing the appeals that were filed.
 *
 * `POST /api/jobs/appeal` records a claim; this decides it. They are separate
 * call paths on purpose — an appeal a worker can file and immediately benefit
 * from is not an appeal, it is a button that clears failures.
 *
 * ## What this does NOT do: move money
 *
 * An overturned verdict does not release escrow. On V2 a failing verdict never
 * settled on its own either — `returnFailedJobToMarket` records and stops, and
 * `expireReview` settles at the on-chain review deadline. `lib/dispute-policy.ts`
 * has the reason: a grader verdict is evidence, and evidence that moves escrow
 * on its own is evidence the accused party authored. A panel of language models
 * agreeing with a worker is exactly that kind of evidence, and it must not be
 * able to pay one.
 *
 * So an appeal changes two things and no others: **the recorded verdict**, and
 * **the credit event that verdict wrote.** The escrow follows the same path it
 * was already on.
 *
 * ## Which appeals can actually be heard today
 *
 * `recompute` — yes, for the lanes whose grading is a pure function of stored
 * inputs (mutation-graded test suites, Python code against stored test code).
 * Re-running those is deterministic and cheap.
 *
 * `recompute` for CI-graded repo jobs — no. The grader is GitHub Actions on the
 * requester's repository; "run it again" means re-triggering someone else's CI,
 * which is a different mechanism with a different owner.
 *
 * `panel` — no, and the reason is structural rather than a missing afternoon.
 * Every agent-dispatch path in `lib/agent-tasks.ts` is fire-and-forget with a
 * callback: local workers poll, cloud and MCP workers run inside `after()`,
 * platform workers post back to `/api/runtime/callback`. A panel therefore
 * cannot be convened inside a sweep pass — it needs a two-phase design (dispatch
 * N tasks, resolve when N callbacks have landed) that does not exist yet. The
 * pure core is in `lib/appeal-panel.ts` and is tested; nothing calls it.
 *
 * Unhearable appeals are left `open` rather than resolved against the worker.
 * `recomputeOutcome` already treats an unrunnable check as "the original stands"
 * — our inability to hear an appeal is not evidence for either party.
 */
import { db } from '@/lib/db'
import { agentEvent, jobSpec } from '@/lib/db/schema'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { recomputeOutcome, type AppealOutcome } from '@/lib/appeal'
import { acquireOpsLease, releaseOpsLease } from '@/lib/ops-lease'
import { logPlatformEvent } from '@/lib/platform-feed'

const LEASE_MS = 4 * 60_000

/**
 * Appeals resolved per pass.
 *
 * A recompute runs a grader, which is the most expensive thing this sweep can
 * do, and a sweep whose cost scales with the backlog is a sweep that eventually
 * times out and then never completes at all — the same reasoning as
 * `MAX_WITHDRAWALS_PER_PASS`.
 */
export const MAX_APPEALS_PER_PASS = 3

/**
 * Re-run the grader that produced the verdict.
 *
 * Returns `null` for any lane whose verdict is not a pure function of what we
 * stored — that is not a failure, it is the honest answer to "can this be
 * recomputed", and `recomputeOutcome` handles it by leaving the verdict alone.
 */
export async function rerunGrade(
  spec: typeof jobSpec.$inferSelect,
  output: string,
): Promise<boolean | null> {
  try {
    // Resolved from the title exactly as the original grading path does, so a
    // rerun cannot silently grade against a different suite than the one that
    // produced the verdict being appealed.
    const { resolveTestSuiteSpec } = await import('@/lib/test-suite-jobs')
    const suite = !spec.testCode ? resolveTestSuiteSpec(spec.title) : null
    if (suite) {
      const { gradeTestSuiteSubmission } = await import('@/lib/test-suite-grading')
      return (await gradeTestSuiteSubmission(suite, output)).passed
    }
    if (spec.testCode && !spec.repoFullName) {
      const { extractPythonCode, gradeSubmission } = await import('@/lib/code-grading')
      const code = extractPythonCode(output)
      // No code block is not a grading outage — it is the same deterministic
      // fail the original run produced, so it must agree rather than abstain.
      if (!code) return false
      return (await gradeSubmission(code, spec.testCode)).passed
    }
    return null
  } catch (error) {
    // A thrown grader is an outage, not a verdict. Abstain.
    console.error('[appeal] rerun failed:', error)
    return null
  }
}

/** Apply an outcome to the job row and to the credit event the verdict wrote. */
export async function applyAppealOutcome(
  spec: typeof jobSpec.$inferSelect,
  outcome: AppealOutcome,
): Promise<void> {
  const result = spec.testResult
  if (!result?.appeal) return

  await db
    .update(jobSpec)
    .set({
      testResult: {
        ...result,
        passed: outcome.passed,
        appeal: {
          ...result.appeal,
          status: 'resolved',
          resolvedAt: new Date().toISOString(),
          overturned: outcome.overturned,
          reason: outcome.reason,
        },
      },
    })
    .where(eq(jobSpec.specHash, spec.specHash))

  if (!outcome.overturned) return

  // The credit event is the part that actually cost the worker something. An
  // appeal that corrects the recorded verdict and leaves the score alone is
  // cosmetic, which is what the §24 fix was accused of being before it grew
  // teeth.
  //
  // The row is addressed deterministically by the same taskId the grading path
  // writes, so this cannot touch anything else.
  const taskId = `job-${spec.onchainJobId}-tests`
  if (outcome.passed === null) {
    // `null` writes no credit event anywhere else in this codebase, so an
    // appeal that lands on `null` must leave none behind either. Deleted rather
    // than amended — but never silently: the platform feed keeps the record,
    // and testResult.appeal keeps originalPassed.
    await db.delete(agentEvent).where(eq(agentEvent.taskId, taskId))
  } else if (outcome.passed === true) {
    await db
      .update(agentEvent)
      .set({
        eventType: 'JOB_TESTS_PASSED',
        success: true,
        qualityScore: '1.000',
        detail: sql`COALESCE(${agentEvent.detail}, '{}'::jsonb) || '{"appealOverturned": true}'::jsonb`,
      })
      .where(eq(agentEvent.taskId, taskId))
  }

  await logPlatformEvent(
    'APPEAL_UPHELD',
    `An appeal on job ${spec.onchainJobId} changed the recorded verdict — ${outcome.reason}`,
  ).catch(() => {})
}

/** Resolve what can be resolved. Called from the ops cycle. */
export async function sweepAppeals(): Promise<string> {
  if (!(await acquireOpsLease('appeals', LEASE_MS))) return 'skipped: leased'
  try {
    const open = await db
      .select()
      .from(jobSpec)
      .where(
        and(
          isNotNull(jobSpec.testResult),
          sql`${jobSpec.testResult}->'appeal'->>'status' = 'open'`,
          sql`${jobSpec.testResult}->'appeal'->>'route' = 'recompute'`,
        ),
      )
      .limit(MAX_APPEALS_PER_PASS)

    if (open.length === 0) return '0 hearable'

    let resolved = 0
    let abstained = 0
    for (const spec of open) {
      try {
        const { agentTask } = await import('@/lib/db/schema')
        const [task] = spec.agentTaskId
          ? await db.select().from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
          : []
        // The submission as stored. Without it there is nothing to re-run
        // against, and re-running against an empty string would manufacture a
        // failure the worker never earned.
        const output = task?.output ?? ''
        if (!output) {
          abstained++
          continue
        }
        const rerun = await rerunGrade(spec, output)
        if (rerun === null) {
          // Left open deliberately: unhearable is not decided-against.
          abstained++
          continue
        }
        await applyAppealOutcome(spec, recomputeOutcome({ original: spec.testResult!.appeal!.originalPassed, rerun }))
        resolved++
      } catch (error) {
        console.error(`[appeal] resolving ${spec.specHash} failed:`, error)
        abstained++
      }
    }
    return `${resolved} resolved${abstained ? `, ${abstained} left open` : ''}`
  } finally {
    await releaseOpsLease('appeals')
  }
}
