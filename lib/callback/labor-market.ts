/**
 * Settling a labour-market job from a runtime callback: grade the deliverable,
 * then release or return the escrow.
 *
 * Split out of app/api/runtime/callback/route.ts, unchanged apart from being
 * exported. This is the slower of the two settlement paths — a model grading
 * a deliverable, then on-chain release — and the reason the callback route
 * carried maxDuration = 300.
 */
import { db } from '@/lib/db'
import { agentEvent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { logPlatformEvent } from '@/lib/platform-feed'
import { autoApprovePassedJob, returnFailedJobToMarket } from '@/lib/labor-settle'
/**
 * If this agent run was a Labor Market worker actually doing an accepted
 * job: submit the REAL output on-chain now, automatically. The requester
 * then reviews genuine work, not a placeholder — this is what makes
 * "the agent did the job" true instead of a UI button pretending it did.
 *
 * If the job carries acceptance tests (auto-graded code job), the submitted
 * code is additionally run against them on the PLATFORM runtime and the
 * pass/fail fact is recorded — as evidence on the job (for the requester and
 * any dispute reviewer) and as a graded-fact credit event for the worker
 * (JOB_TESTS_PASSED/FAILED — same trust class as VERIFIED_TASK_*, because a
 * test run is a fact, not an LLM's opinion of itself).
 */
/** What happened to the worker's submission — returned to the worker so its
 *  log can show the real outcome (paid / refunded / awaiting manual review)
 *  instead of stopping at "submitted". */
export type GradeReport = { passed: boolean | null; settled: 'paid' | 'refunded' | 'manual'; reason: string }

/** The requester's credit score right now, stamped onto graded events so the
 *  scoring engine can weight reputation by counterparty credibility without
 *  a join at score time. */
async function requesterScoreOf(requesterAgentId: string | null): Promise<number | null> {
  if (!requesterAgentId) return null
  try {
    const { agent } = await import('@/lib/db/schema')
    const [row] = await db.select({ creditScore: agent.creditScore }).from(agent).where(eq(agent.id, requesterAgentId))
    return row ? Number(row.creditScore) : null
  } catch {
    return null
  }
}

export async function settleLaborMarketJob(agentTaskId: string, output: string): Promise<GradeReport | null> {
  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.agentTaskId, agentTaskId))
  if (!spec || !spec.workerAgentId || spec.onchainJobId === null) return null

  let submitted = false
  try {
    const { keccak256, toHex } = await import('viem')
    const { submitWork } = await import('@/lib/onchain/labor')
    const resultHash = keccak256(toHex(output || '(empty output)'))
    await submitWork(spec.workerAgentId, spec.onchainJobId, resultHash)
    submitted = true
    await logPlatformEvent('JOB_SUBMITTED', `"${spec.title}" — worker submitted real output for review`)
  } catch (error) {
    const { isUserOpPending } = await import('@/lib/onchain/account')
    if (isUserOpPending(error)) {
      // The bundler took it; it usually lands moments later. Treat the
      // submission as done for grading purposes — the alternative is
      // recording "submit failed" for work that IS on-chain, and every
      // settlement path re-reads live status before it moves money anyway.
      submitted = true
      console.warn(`[runtime/callback] submitWork for job ${spec.onchainJobId} is pending confirmation — continuing to grade`)
    } else {
      console.error('[runtime/callback] labor market auto-submit failed:', error)
    }
  }

  // Three independent grading paths produce the same verdict shape:
  // Python asserts for code jobs, a vision LLM for image deliverables,
  // and an LLM reviewer for text jobs with acceptance criteria. Only
  // audio/video/file (binary the graders can't inspect) and text jobs
  // without criteria stay ungraded for manual requester review.
  const { resolveTestSuiteSpec } = await import('@/lib/test-suite-jobs')
  const testSuiteSpec = !spec.testCode ? resolveTestSuiteSpec(spec.title) : null
  const isRepoJob = Boolean(spec.repoFullName)
  const isImageJob = spec.deliverableKind === 'image'
  const isAudioJob = spec.deliverableKind === 'audio' && Boolean(spec.acceptanceCriteria?.trim())
  // A red-team job carries its objective on the spec, and that marker outranks
  // every other route: the objective IS the acceptance criterion, so sending
  // this submission to an LLM reviewer would replace a hash comparison with an
  // opinion — and the party writing the submission is the party being judged.
  const redteamMarker = spec.redteamObjective ?? null
  const isLlmGradableText =
    !redteamMarker &&
    !spec.testCode &&
    !testSuiteSpec &&
    !isRepoJob &&
    !isImageJob &&
    (spec.deliverableKind ?? 'text') === 'text' &&
    Boolean(spec.acceptanceCriteria?.trim())
  if (!redteamMarker && !spec.testCode && !testSuiteSpec && !isRepoJob && !isImageJob && !isAudioJob && !isLlmGradableText) {
    return null
  }
  try {
    let grade: { passed: boolean | null; output: string; gradedAt: string }
    if (redteamMarker) {
      const { gradeRedTeamSubmission } = await import('@/lib/redteam-grade')
      grade = await gradeRedTeamSubmission(redteamMarker, output)
    } else if (isRepoJob) {
      // GitHub repo job: the deliverable is a diff. Opening the PR is where
      // grading STARTS — the requester's CI writes the verdict later, via
      // /api/github/webhook. Only a bad diff fails here and now.
      const { agent } = await import('@/lib/db/schema')
      const [workerAgent] = await db.select().from(agent).where(eq(agent.id, spec.workerAgentId))
      const { openPrForSubmission } = await import('@/lib/repo-job-pipeline')
      grade = await openPrForSubmission(spec, output, { workerName: workerAgent?.name })
    } else if (testSuiteSpec) {
      // Mutation grading: the worker submitted TESTS; the platform supplies
      // the hidden reference + buggy implementations. Fully mechanical.
      const { gradeTestSuiteSubmission } = await import('@/lib/test-suite-grading')
      grade = await gradeTestSuiteSubmission(testSuiteSpec, output)
    } else if (isImageJob) {
      const { artifact, agent } = await import('@/lib/db/schema')
      const arts = await db.select().from(artifact).where(eq(artifact.taskId, agentTaskId))
      const [requesterAgent] = spec.requesterAgentId
        ? await db.select().from(agent).where(eq(agent.id, spec.requesterAgentId))
        : []
      const { gradeImageSubmission } = await import('@/lib/vision-grading')
      grade = await gradeImageSubmission(spec, arts, requesterAgent?.userId ?? null)
    } else if (isAudioJob) {
      const { artifact, agent } = await import('@/lib/db/schema')
      const arts = await db.select().from(artifact).where(eq(artifact.taskId, agentTaskId))
      const [requesterAgent] = spec.requesterAgentId
        ? await db.select().from(agent).where(eq(agent.id, spec.requesterAgentId))
        : []
      const { gradeAudioSubmission } = await import('@/lib/audio-grading')
      grade = await gradeAudioSubmission(spec, arts, requesterAgent?.userId ?? null)
    } else if (isLlmGradableText) {
      const { agent } = await import('@/lib/db/schema')
      const [requesterAgent] = spec.requesterAgentId
        ? await db.select().from(agent).where(eq(agent.id, spec.requesterAgentId))
        : []
      const { gradeTextSubmission } = await import('@/lib/text-grading')
      grade = await gradeTextSubmission(spec, output, requesterAgent?.userId ?? null)
    } else {
      const { extractPythonCode, gradeSubmission } = await import('@/lib/code-grading')
      const solutionCode = extractPythonCode(output)
      grade = solutionCode
        ? await gradeSubmission(solutionCode, spec.testCode!)
        : {
            passed: false,
            output: 'No Python code block found in the submission (the task required one).',
            gradedAt: new Date().toISOString(),
          }
    }

    await db.update(jobSpec).set({ testResult: grade }).where(eq(jobSpec.specHash, spec.specHash))

    // passed:null means grading itself was unavailable — that's an infra
    // fact about us, not behavioral data about the worker; no credit event.
    if (grade.passed !== null) {
      await db.insert(agentEvent).values({
        id: nanoid(),
        agentId: spec.workerAgentId,
        taskId: `job-${spec.onchainJobId}-tests`,
        eventType: grade.passed ? 'JOB_TESTS_PASSED' : 'JOB_TESTS_FAILED',
        success: grade.passed,
        executionTime: 0,
        tokenCost: 0,
        qualityScore: grade.passed ? '1.000' : '0.000', // graded fact, not self-opinion
        detail: {
          jobId: spec.onchainJobId,
          testOutput: grade.output.slice(0, 500),
          // Grader class + counterparty feed the collusion-resistant scoring
          // weights: an LLM review against requester-authored criteria is
          // cheaper for a colluding pair to manufacture than a mutation-
          // graded suite, and repeat counterparties earn diminishing weight.
          grader: testSuiteSpec ? 'tests' : isImageJob ? 'vision' : isAudioJob ? 'audio' : isLlmGradableText ? 'llm-review' : 'code',
          requesterAgentId: spec.requesterAgentId ?? null,
          requesterScore: await requesterScoreOf(spec.requesterAgentId),
        },
      })
      await logPlatformEvent(
        grade.passed ? 'JOB_TESTS_PASSED' : 'JOB_TESTS_FAILED',
        `"${spec.title}" — ${isRepoJob ? 'diff validation' : isImageJob ? 'vision review' : isAudioJob ? 'audio transcription review' : isLlmGradableText ? 'LLM review' : 'acceptance tests'} ${grade.passed ? 'passed' : 'FAILED'} (independent grader)`,
      )

      // Mirror the graded fact into the ERC-8004 Validation Registry — but
      // only if the submission this grade is FOR actually landed on-chain
      // via submitWork above. Otherwise this would publish an on-chain
      // validation claim referencing a submission the chain has no record
      // of (submitWork failures are caught and logged, not fatal, so
      // grading still runs on the raw output — that's fine for the DB
      // credit event below, which is genuine worker-quality signal either
      // way, but not for an on-chain attestation tied to a specific job
      // submission that never actually recorded).
      if (submitted) {
        const { publishValidation } = await import('@/lib/onchain/erc8004')
        await publishValidation(
          spec.workerAgentId,
          grade.passed ? 100 : 0,
          isRepoJob ? 'repo-diff' : isImageJob ? 'vision-review' : isAudioJob ? 'audio-review' : isLlmGradableText ? 'llm-review' : 'acceptance-tests',
          `job-${spec.onchainJobId}`,
        )
      }
    }

    if (grade.passed === false) {
      await returnFailedJobToMarket(spec)
      return { passed: false, settled: 'refunded', reason: grade.output }
    } else if (grade.passed === true) {
      await autoApprovePassedJob(spec)
      return { passed: true, settled: 'paid', reason: grade.output }
    }
    // passed:null — grading unavailable; job waits for manual requester review.
    return { passed: null, settled: 'manual', reason: grade.output }
  } catch (error) {
    console.error('[runtime/callback] acceptance-test grading failed:', error)
    return null
  }
}
