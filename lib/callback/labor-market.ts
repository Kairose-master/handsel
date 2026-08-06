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
import { and, eq, gte, sql } from 'drizzle-orm'
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

    // A worker refusing an attack is not a worker failing a job (§24). This
    // runs before every grader because no grader can tell the difference: to
    // all of them a refusal is a submission that meets no criteria, and they
    // are right — there is nothing to grade. The mistake was recording that as
    // behavioural data about the WORKER, when the fact it establishes is about
    // the REQUESTER.
    //
    // Deliberately not applied to red-team jobs: there the objective IS to be
    // adversarial, and "I refuse" from an attacker is simply not a proof.
    //
    // Two kinds, two destinations (§25). "This brief attacked me" is evidence
    // about the REQUESTER; "I have no tool for this" is a fact about the WORKER
    // and about nobody's good faith. They arrived through one exit once and a
    // real job paid for it — a worker that lacked GitHub access wrote the attack
    // marker because it was the only vocabulary we had given it, and an innocent
    // requester got the strike.
    const refusal = !redteamMarker ? await import('@/lib/brief-refusal') : null
    const refusalKind = refusal ? refusal.classifyRefusal(output) : null

    if (refusalKind === 'incapable') {
      // Nobody did anything wrong, so nobody is recorded: no credit event about
      // the worker, no accusation logged against the requester, and none of the
      // attack-refusal bookkeeping — that counter is about a different claim.
      //
      // The job goes back to the market, which is the part that matters. Holding
      // it for manual review would strand the requester's escrow on a job that a
      // different worker could simply do, and the money moves in the safe
      // direction here — back to the party who put it in, never to the party
      // whose text triggered this. returnFailedJobToMarket also blocks this
      // worker from the repost, which is right: it still cannot do the work.
      const grade = {
        passed: null as boolean | null,
        output: refusal!.incapableGradeOutput(output),
        gradedAt: new Date().toISOString(),
      }
      await db
        .update(jobSpec)
        .set({ testResult: { ...grade, workerIncapable: true } })
        .where(eq(jobSpec.specHash, spec.specHash))
      await logPlatformEvent(
        'WORKER_INCAPABLE',
        `A worker returned job ${spec.onchainJobId} as beyond its capabilities — no verdict recorded about anyone, ` +
          'the job goes back to the market for a worker that can do it',
      ).catch(() => {})
      await returnFailedJobToMarket(spec, {
        note: 'Auto: the worker lacked a capability the job required — refunded and reposted for a worker that has it',
      })
      return {
        passed: null,
        settled: 'refunded',
        reason: 'The worker could not do this work — no verdict recorded, and the job returned to the market.',
      }
    }

    if (refusalKind === 'brief-attack') {
      const decision = await refusalCreditFor(spec.workerAgentId, spec.requesterAgentId ?? null)
      // Recorded against the requester, which is where the evidence points.
      await logPlatformEvent(
        'BRIEF_REFUSED',
        `A worker refused job ${spec.onchainJobId} as directing it outside the task` +
          (spec.requesterAgentId ? ` (requester ${spec.requesterAgentId})` : '') +
          ` — ${decision.reason}`,
      ).catch(() => {})
      if (decision.credit === 'none') {
        // passed:null is the existing "no behavioural data" path — it writes
        // the result on the job and no credit event on the worker.
        grade = {
          passed: null,
          output: refusal!.refusalGradeOutput(spec.requesterAgentId ?? null),
          gradedAt: new Date().toISOString(),
        }
        // `refusedBrief` is the marker the free-pass count reads back. It lives
        // on the job row rather than in agent_events on purpose: anything
        // written to agent_events is scoring input, and a refusal must not move
        // a score in either direction.
        await db
          .update(jobSpec)
          .set({ testResult: { ...grade, refusedBrief: true } })
          .where(eq(jobSpec.specHash, spec.specHash))
        // 'manual', not 'refunded': the escrow is left for the requester to
        // reject and reclaim. Auto-refunding on a text test would let a worker
        // move someone's money by typing a marker, and returning the job to the
        // market would just aim the same attack at the next worker.
        return {
          passed: null,
          settled: 'manual',
          reason: 'Refused as directing the worker outside the task — no verdict recorded, escrow awaits the requester.',
        }
      }
      // Over the free-pass limit: fall through and grade normally.
    }

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
        // The tag carries the forge-resistance CLASS, not just the job kind.
        // ERC-8004 stores a validation as one 0–100 number and — the spec says
        // so — cannot tell a canary-proven 100 from an LLM's opinion of 100. A
        // consumer folding those numbers can only down-weight the gameable ones
        // if the class travels with the verdict, so we put it in the tag the
        // registry already has (lib/grader-class.ts).
        const { gradeTag } = await import('@/lib/grader-class')
        // A repo job here means the PR merely OPENED — the requester's CI has
        // not graded it yet, so it is NOT a reproducible pass. Classifying it as
        // 'ci' would over-claim exactly what this file forbids; the reproducible
        // CI validation belongs on the merge path, not here. An unmapped name
        // falls to the weakest class ('declared'), which is the honest floor
        // until CI actually runs.
        const grader = testSuiteSpec ? 'tests' : isImageJob ? 'vision' : isAudioJob ? 'audio' : isLlmGradableText ? 'llm-review' : isRepoJob ? 'repo-open' : 'code'
        await publishValidation(
          spec.workerAgentId,
          grade.passed ? 100 : 0,
          gradeTag(grader),
          `job-${spec.onchainJobId}`,
        )
      }
    }

    if (grade.passed === false) {
      await returnFailedJobToMarket(spec)
      // A right the worker is not told about is not a right — §25's lesson, and
      // this is the sentence that keeps it. The reason goes back to whatever
      // submitted the work, which for most workers is the only channel there is.
      const { APPEAL_WINDOW_MS } = await import('@/lib/appeal')
      return {
        passed: false,
        settled: 'refunded',
        reason:
          `${grade.output}\n\nIf you believe this verdict is wrong you can appeal it within ` +
          `${APPEAL_WINDOW_MS / 3_600_000}h: POST /api/jobs/appeal with {agent_id, spec_hash: "${spec.specHash}"} ` +
          'and your worker secret. It costs nothing and no verdict about you changes while it is open.',
      }
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

/**
 * How many DISTINCT requesters this worker has refused recently, turned into a
 * credit decision.
 *
 * Distinct requesters, not jobs: an agent under attack sees many jobs from one
 * attacker and must not be penalised for refusing every one of them. Refusing
 * across many unrelated requesters is a different behaviour, and the only one
 * this bound is aimed at.
 *
 * A failed count is reported as unknown rather than as zero. `decideRefusalCredit`
 * treats unknown as "keep the benefit of the doubt", because the promise printed
 * in every brief has to hold when our own query is the thing that broke.
 */
async function refusalCreditFor(workerAgentId: string, requesterAgentId: string | null) {
  const { decideRefusalCredit, REFUSAL_WINDOW_DAYS } = await import('@/lib/brief-refusal')
  try {
    const since = new Date(Date.now() - REFUSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const rows = await db
      .select({ requester: jobSpec.requesterAgentId })
      .from(jobSpec)
      .where(
        and(
          eq(jobSpec.workerAgentId, workerAgentId),
          gte(jobSpec.createdAt, since),
          // Only prior REFUSALS count — not the worker's ordinary job history.
          sql`${jobSpec.testResult}->>'refusedBrief' = 'true'`,
        ),
      )
    const refusedRequesters = new Set<string>()
    for (const row of rows) {
      if (row.requester) refusedRequesters.add(row.requester)
    }
    // The row being counted is this one, which has not been written yet.
    if (requesterAgentId) refusedRequesters.add(requesterAgentId)
    return decideRefusalCredit({ distinctRequestersRefused: refusedRequesters.size })
  } catch (error) {
    console.error('[runtime/callback] refusal history unreadable:', error)
    return decideRefusalCredit({ distinctRequestersRefused: 0, countUnknown: true })
  }
}
