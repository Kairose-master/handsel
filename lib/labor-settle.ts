/**
 * Post-grading settlement for Labor Market jobs — extracted from
 * /api/runtime/callback so it can run from TWO places:
 *
 *   1. The submission callback (the moment grading finishes) — the fast
 *      path, exactly as before.
 *   2. sweepStuckGradedJobs() — the recovery path. Settlement used to be
 *      one-shot: a transient RPC failure (Alchemy free-tier 429s under
 *      polling load, observed live) at the approve/refund step left a
 *      PASSED job sitting in Submitted forever, showing manual
 *      approve/dispute buttons for work the grader had already judged.
 *      The sweep re-drives the correct path for any Submitted job whose
 *      spec already carries a grading verdict, from the same opportunistic
 *      read-path ticks the platform already uses (no cron).
 *
 * Both paths are safe to re-run: every branch re-checks the live on-chain
 * job status ('Submitted') before moving funds, so a retry after a partial
 * failure resumes rather than double-pays.
 */
import { db } from '@/lib/db'
import { agent, agentEvent, jobSpec } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { logPlatformEvent } from '@/lib/platform-feed'

/** Retries a step that runs AFTER a prior on-chain action already
 *  succeeded and can't be undone — a transient DB/RPC failure here would
 *  otherwise permanently strand bookkeeping for money that already moved. */
/**
 * An operation the bundler accepted but hasn't confirmed. Matched by name
 * rather than `instanceof` so this stays free of the heavy on-chain module
 * (retry is used from plain unit tests too) and survives bundling
 * boundaries where identity checks can fail.
 */
export function isPendingUserOp(error: unknown): boolean {
  return error instanceof Error && error.name === 'UserOpPendingError'
}

export async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      // NEVER retry an operation that may already be on-chain. This wrapper
      // guards postJob, which locks escrow — a blind retry of a pending post
      // can put the same spec on the market twice and charge the requester
      // twice for it. Unconfirmed is not failed; hand it to the caller and
      // let the reconciliation sweeps observe what actually landed.
      if (isPendingUserOp(error)) throw error
      lastError = error
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
    }
  }
  throw lastError
}

export function isTransientRpcError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('429') || /rate limit|Too Many Requests|compute units/i.test(msg)
}

/** Retry wrapper specifically for on-chain calls that may hit RPC rate
 *  limits — longer backoff than `retry` (a 429 needs breathing room, not
 *  a 500ms hammer), and only retries the transient class. `baseDelayMs`
 *  is parameterized so tests don't sit through real backoffs. */
export async function retryRpc<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 3000): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTransientRpcError(error) || i === attempts - 1) throw error
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)))
    }
  }
  throw lastError
}

// Bounds how much a single compromised/over-lenient grader verdict can
// release with zero requester involvement. Above this, a passing job still
// waits for the requester's own "Approve & pay" — auto-approve exists to
// stop small/unwatched jobs (seed jobs, idle requesters) from stranding a
// worker unpaid, not to hand a grader unlimited fund-release authority.
export const AUTO_APPROVE_MAX_BOUNTY_USD = Number(process.env.AUTO_APPROVE_MAX_BOUNTY_USD ?? 50)

/**
 * Acceptance tests passed — an independently graded, objective fact, the
 * same authority the failure path (returnFailedJobToMarket) already acts on
 * automatically. Release the escrow instead of leaving the job "Submitted"
 * waiting on a human "Approve & pay" click that may never come.
 *
 * The actual authorization for this is `spec.autoApprove` — the requester's
 * own explicit choice, recorded on an authenticated call to postJobAction
 * at the time THEY posted the job. AUTO_APPROVE_MAX_BOUNTY_USD is the
 * second, independent layer bounding what a single grader mistake can move.
 */
export async function autoApprovePassedJob(
  spec: typeof jobSpec.$inferSelect,
  opts?: {
    /**
     * What authorizes this release.
     *  - 'grader' (default): an automated verdict. Gated by the requester's
     *    autoApprove consent AND the DMN bounty ceiling.
     *  - 'merge': the requester personally merged the pull request this job
     *    produced. That IS the approve click — a stronger, first-party
     *    authorization than any grader verdict — so it bypasses both gates,
     *    which exist to bound UNATTENDED grader mistakes, not to second-guess
     *    the requester's own action.
     */
    authorization?: 'grader' | 'merge'
  },
): Promise<void> {
  if (!spec.requesterAgentId || !spec.workerAgentId || spec.onchainJobId === null) return
  const authorization = opts?.authorization ?? 'grader'
  // GitHub repo jobs: CI green is a grading signal, never a release trigger.
  // A malicious-but-CI-passing diff must not move money — only the
  // requester's merge does (docs/github-jobs.md).
  if (spec.repoFullName && authorization !== 'merge') return
  if (authorization !== 'merge' && !spec.autoApprove) return // requester opted out — stays Submitted for their own review

  let approvedTxHash: string | null = null
  try {
    const { readJobs, approveJob } = await import('@/lib/onchain/labor')
    const jobs = await retryRpc(() => readJobs())
    const job = jobs.find((j) => j.id === spec.onchainJobId)
    if (!job || job.status !== 'Submitted') return

    // Reputation-raised cap (EAS Reputation Lending pattern): a worker whose
    // oracle-attested credit score clears the four gates unlocks a HIGHER
    // auto-approve ceiling — trust extended on verified reputation, never
    // below the base cap and always bounded by the terms' maxLimitUsd.
    let effectiveCapUsd = AUTO_APPROVE_MAX_BOUNTY_USD
    try {
      const [workerAgent] = await db.select().from(agent).where(eq(agent.id, spec.workerAgentId))
      if (workerAgent) {
        const { quoteReputationLimit } = await import('@/lib/reputation-lending')
        const repLimit = await quoteReputationLimit(spec.workerAgentId, Number(workerAgent.creditScore))
        if (repLimit > effectiveCapUsd) {
          console.log(
            `[labor-settle] worker ${workerAgent.name} reputation raises auto-approve cap $${AUTO_APPROVE_MAX_BOUNTY_USD} → $${repLimit}`,
          )
          effectiveCapUsd = repLimit
        }
      }
    } catch {
      /* reputation quote is best-effort — fall back to the base cap */
    }

    // The auto-release decision is delegated to the DMN decision table, so the
    // rule that runs here is the exact one printed in the auditable policy.
    const { decideAutoRelease } = await import('@/lib/decision-table')
    const decision =
      authorization === 'merge'
        ? { action: 'auto_release' as const, reason: 'requester merged the pull request' }
        : decideAutoRelease({
            verdict: 'pass', // this path only runs on a passing grade
            autoApprove: true, // spec.autoApprove was checked at the top
            bountyUsd: job.bounty,
            capUsd: Number.isFinite(effectiveCapUsd) ? effectiveCapUsd : Number.MAX_SAFE_INTEGER,
          })
    if (decision.action !== 'auto_release') {
      console.log(
        `[labor-settle] job ${spec.onchainJobId} — ${decision.reason} (bounty $${job.bounty}, ceiling $${effectiveCapUsd})`,
      )
      return
    }

    approvedTxHash = await retryRpc(() => approveJob(spec.requesterAgentId!, spec.onchainJobId!))

    // approveJob just moved real funds on-chain and flipped the job to
    // Completed — from here there's no path back to "Submitted", so a
    // transient failure recording the credit event would otherwise strand
    // it forever. Retry the DB-only half before giving up.
    const { creditWorkerForJob } = await import('@/app/actions/labor')
    await retry(() => creditWorkerForJob(job.worker, spec.onchainJobId!, job.bounty, approvedTxHash!))

    // Stamp the paid deliverable with a Proof of Authorship & Grade (off-chain
    // EAS-style, oracle-signed, content-addressed). Best-effort: a proof
    // failure must never affect an already-settled payout.
    const { issueProofForJobSpec } = await import('@/lib/work-proof-store')
    const proof = await issueProofForJobSpec(spec)
    if (proof) console.log(`[labor-settle] issued work proof ${proof.id} (cid ${proof.cid}) for job #${spec.onchainJobId}`)

    await logPlatformEvent(
      'JOB_AUTO_APPROVED',
      authorization === 'merge'
        ? `"${spec.title}" — pull request merged by the requester, escrow released to the worker`
        : `"${spec.title}" — acceptance tests passed (independent grader), escrow released automatically`,
    )
  } catch (error) {
    console.error('[labor-settle] auto-approve failed:', error)
    if (approvedTxHash) {
      // Escrow already released on-chain — the worker was paid — but
      // recording that fact failed even after retries. Surface it so an
      // admin can backfill the credit event by hand.
      await logPlatformEvent(
        'JOB_AUTO_APPROVE_INCOMPLETE',
        `"${spec.title}" — escrow released (tx ${approvedTxHash.slice(0, 10)}…) but credit recording failed after retries — job #${spec.onchainJobId} needs a manual credit backfill`,
      ).catch(() => {})
    }
  }
}

export const MAX_AUTO_REPOSTS = 2

/**
 * Failed acceptance tests are an objective verdict — return the job to the
 * market automatically: dispute → arbiter refunds the requester → repost
 * the same spec as a fresh job for a DIFFERENT worker (failed workers are
 * blocked off-chain; parent_spec_hash records the lineage so anything
 * tracking the original — a delegation — follows the replacement). Capped
 * at MAX_AUTO_REPOSTS per lineage so a broken test suite can't burn escrow
 * round-trips forever.
 */
export async function returnFailedJobToMarket(spec: typeof jobSpec.$inferSelect): Promise<void> {
  if (!spec.requesterAgentId || !spec.workerAgentId || spec.onchainJobId === null) return
  if (spec.repostCount >= MAX_AUTO_REPOSTS) {
    console.warn(`[labor-settle] job ${spec.onchainJobId} failed tests but hit the auto-repost cap — leaving for manual review`)
    return
  }

  let refunded = false
  try {
    const { readJobs, raiseDispute, resolveDispute, postJob } = await import('@/lib/onchain/labor')
    const jobs = await retryRpc(() => readJobs())
    const job = jobs.find((j) => j.id === spec.onchainJobId)
    if (!job || job.status !== 'Submitted') return

    // 1. Requester's agent disputes; the arbiter refunds — both platform-
    //    signed, justified by the objective test verdict.
    await retryRpc(() => raiseDispute(spec.requesterAgentId!, spec.onchainJobId!))
    await db
      .update(jobSpec)
      .set({ disputeNote: 'Auto: acceptance tests failed (independent grader) — refunded and reposted' })
      .where(eq(jobSpec.specHash, spec.specHash))
    await retryRpc(() => resolveDispute(spec.onchainJobId!, false))
    refunded = true // irreversible from here — resolveDispute already paid out

    // 2. Repost the same spec as a fresh on-chain job, blocking every worker
    //    that already failed this lineage.
    const { keccak256, toHex } = await import('viem')
    const newSpecHash = keccak256(
      toHex(JSON.stringify({ title: spec.title, agent: spec.requesterAgentId, nonce: nanoid() })),
    )
    const failedWorkers = [...new Set([...(spec.failedWorkerIds ?? []), spec.workerAgentId])]
    await db.insert(jobSpec).values({
      specHash: newSpecHash,
      title: spec.title,
      description: spec.description,
      acceptanceCriteria: spec.acceptanceCriteria,
      requesterAgentId: spec.requesterAgentId,
      attachmentUrl: spec.attachmentUrl,
      attachmentName: spec.attachmentName,
      testCode: spec.testCode,
      // Preserve what the deliverable actually IS — dropping these silently
      // reset a reposted image/audio job to plain text, so it matched the
      // wrong workers and skipped vision/transcription grading.
      deliverableKind: spec.deliverableKind,
      requiredCapabilities: spec.requiredCapabilities,
      repostCount: spec.repostCount + 1,
      failedWorkerIds: failedWorkers,
      autoApprove: spec.autoApprove, // carry the requester's original consent choice forward, don't silently reset it
      // Repo identity must survive a repost, or the replacement job silently
      // stops being a GitHub job (no PR, no CI grader). prNumber/ciStatus are
      // deliberately NOT carried — the replacement gets its own PR.
      repoFullName: spec.repoFullName,
      baseBranch: spec.baseBranch,
      // issueNumber belongs to that identity too, and leaving it out stranded
      // real escrow. It is the CANCEL KEY: `specsForIssue` in the webhook
      // matches on (repoFullName, issueNumber), so a reposted bounty answered
      // an issue-closed event with "no job for this issue" and silently
      // returned. Job #327 sat Open with its issue closed and its label gone.
      // The stale-claim deadline warning reads it too, so that went quiet as
      // well. Two lines above named repo identity and counted two of its three
      // fields.
      issueNumber: spec.issueNumber,
      parentSpecHash: spec.specHash, // explicit lineage — lets delegations follow the work to its replacement
    })
    const txHash = await retry(() => postJob(spec.requesterAgentId!, job.bounty, job.minScore, newSpecHash))

    // Backfill the new spec's onchainJobId so the sweep and diagnostics can
    // find it by job id (the reverse link was silently missing before).
    try {
      const fresh = await retryRpc(() => readJobs())
      const posted = fresh.find((j) => j.specHash.toLowerCase() === newSpecHash.toLowerCase())
      if (posted) await db.update(jobSpec).set({ onchainJobId: posted.id }).where(eq(jobSpec.specHash, newSpecHash))
    } catch (e) {
      console.error('[labor-settle] repost onchainJobId backfill failed (non-fatal):', e)
    }

    await logPlatformEvent(
      'JOB_AUTO_REPOSTED',
      `"${spec.title}" — tests failed, escrow auto-refunded, reposted for a different worker (attempt ${spec.repostCount + 2})`,
    )
    console.log(`[labor-settle] job ${spec.onchainJobId} auto-returned to market (repost tx ${txHash})`)
  } catch (error) {
    console.error('[labor-settle] auto-return to market failed:', error)
    if (refunded) {
      // The refund already completed on-chain and is irreversible, but the
      // replacement job failed to post even after retries — surfaced so an
      // admin can manually repost the spec.
      await logPlatformEvent(
        'JOB_REPOST_FAILED',
        `"${spec.title}" — refund completed but repost failed after retries — job #${spec.onchainJobId} needs a manual repost`,
      ).catch(() => {})
    }
  }
}

/**
 * A job left sitting in on-chain 'Disputed' status is a dispute-refund-repost
 * flow that died mid-flight (or a dispute nobody resolved) — the worker and
 * any delegation waiting on it hang forever. FINISH the interrupted flow:
 * resolve the dispute in the requester's favour (refund) and repost the spec
 * as a fresh job for a DIFFERENT worker. No raiseDispute (already disputed).
 * Same cap, lineage, and capability-preserving repost as the failed-grading
 * path; the live status re-check keeps it safe to run from the heartbeat
 * alongside that path. Capped by MAX_AUTO_REPOSTS per lineage.
 */
export async function returnDisputedJobToMarket(spec: typeof jobSpec.$inferSelect): Promise<void> {
  if (!spec.requesterAgentId || spec.onchainJobId === null) return
  if (spec.repostCount >= MAX_AUTO_REPOSTS) {
    console.warn(`[labor-settle] disputed job ${spec.onchainJobId} hit the auto-repost cap — leaving for manual review`)
    return
  }
  let refunded = false
  try {
    const { readJobs, resolveDispute, postJob } = await import('@/lib/onchain/labor')
    const jobs = await retryRpc(() => readJobs())
    const job = jobs.find((j) => j.id === spec.onchainJobId)
    if (!job || job.status !== 'Disputed') return // already moved by the other path

    await db
      .update(jobSpec)
      .set({ disputeNote: spec.disputeNote ?? 'Auto: job stuck in dispute — refunded and reposted for a different worker' })
      .where(eq(jobSpec.specHash, spec.specHash))
    await retryRpc(() => resolveDispute(spec.onchainJobId!, false)) // false = refund the requester
    refunded = true

    const { keccak256, toHex } = await import('viem')
    const newSpecHash = keccak256(
      toHex(JSON.stringify({ title: spec.title, agent: spec.requesterAgentId, nonce: nanoid() })),
    )
    const failedWorkers = [
      ...new Set([...(spec.failedWorkerIds ?? []), spec.workerAgentId].filter(Boolean) as string[]),
    ]
    await db.insert(jobSpec).values({
      specHash: newSpecHash,
      title: spec.title,
      description: spec.description,
      acceptanceCriteria: spec.acceptanceCriteria,
      requesterAgentId: spec.requesterAgentId,
      attachmentUrl: spec.attachmentUrl,
      attachmentName: spec.attachmentName,
      testCode: spec.testCode,
      deliverableKind: spec.deliverableKind, // preserve what the deliverable actually IS
      requiredCapabilities: spec.requiredCapabilities,
      repostCount: spec.repostCount + 1,
      failedWorkerIds: failedWorkers,
      autoApprove: spec.autoApprove,
      repoFullName: spec.repoFullName, // keep GitHub jobs GitHub jobs across a repost
      baseBranch: spec.baseBranch,
      issueNumber: spec.issueNumber, // the cancel key — see the note on the grading-failure repost above
      parentSpecHash: spec.specHash, // lineage — delegations follow the replacement
    })
    const txHash = await retry(() => postJob(spec.requesterAgentId!, job.bounty, job.minScore, newSpecHash))
    try {
      const fresh = await retryRpc(() => readJobs())
      const posted = fresh.find((j) => j.specHash.toLowerCase() === newSpecHash.toLowerCase())
      if (posted) await db.update(jobSpec).set({ onchainJobId: posted.id }).where(eq(jobSpec.specHash, newSpecHash))
    } catch (e) {
      console.error('[labor-settle] disputed repost onchainJobId backfill failed (non-fatal):', e)
    }
    await logPlatformEvent(
      'JOB_DISPUTE_REPOSTED',
      `"${spec.title}" — stuck in dispute, escrow refunded and reposted for a different worker (attempt ${spec.repostCount + 2})`,
    )
    console.log(`[labor-settle] disputed job ${spec.onchainJobId} returned to market (repost tx ${txHash})`)
  } catch (error) {
    console.error('[labor-settle] disputed return-to-market failed:', error)
    if (refunded) {
      await logPlatformEvent(
        'JOB_REPOST_FAILED',
        `"${spec.title}" — dispute refund completed but repost failed — job #${spec.onchainJobId} needs a manual repost`,
      ).catch(() => {})
    }
  }
}

/**
 * Sweep on-chain Disputed jobs and return each (with a spec under the repost
 * cap) to the market so a different worker can pick it up. Best-effort,
 * heartbeat-safe: every mutation re-checks live status first.
 */
export async function sweepDisputedJobs(): Promise<number> {
  let reposted = 0
  try {
    const { readJobs } = await import('@/lib/onchain/labor')
    const jobs = await readJobs().catch(() => [])
    for (const job of jobs.filter((j) => j.status === 'Disputed')) {
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
      if (!spec || spec.repostCount >= MAX_AUTO_REPOSTS) continue
      await returnDisputedJobToMarket(spec)
      reposted++
    }
  } catch (error) {
    console.error('[labor-settle] disputed sweep failed:', error)
  }
  return reposted
}

const STUCK_SWEEP_COOLDOWN_MS = 20_000

/**
 * Recovery sweep: any Submitted job whose spec already holds a grading
 * verdict is settlement that started and died mid-flight (the callback's
 * attempt hit a transient failure). Re-drive the correct path. Throttled,
 * best-effort, and safe to call from any hot read path — both settle
 * functions re-check live on-chain status before moving anything.
 */
export async function sweepStuckGradedJobs(): Promise<void> {
  await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()

  // Cross-instance: this sweep re-drives settlement, and it is called from
  // the jobs page's after() block on every warm lambda.
  const { acquireOpsLease } = await import('@/lib/ops-lease')
  if (!(await acquireOpsLease('stuck-graded-sweep', STUCK_SWEEP_COOLDOWN_MS))) return

  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) return

    // Drive from the ON-CHAIN jobs, matched to specs by specHash — NOT from
    // specs filtered by a populated onchainJobId column. That reverse link was
    // sometimes never written (delegation subtasks, reposts), so the old
    // query silently skipped those jobs forever. specHash is always present on
    // both sides, so nothing Submitted escapes the sweep now; we backfill the
    // missing onchainJobId so downstream settlement (which keys off it) works.
    // Read the chain FIRST so the spec query can be narrowed to the jobs that
    // could possibly need work. This used to load every spec row in the table
    // to build a lookup and then use only the Submitted handful — fine at a
    // few hundred jobs, and quietly worse every week, on a sweep that runs
    // from traffic. (Column-level fragility is already handled here by the
    // ensureJobSpecColumns call above; settlement genuinely reads most of the
    // row, so the projection stays wide and only the row count narrows.)
    const { readJobs } = await import('@/lib/onchain/labor')
    const jobs = await readJobs()

    const submittedHashes = jobs.filter((j) => j.status === 'Submitted').map((j) => j.specHash)
    if (submittedHashes.length === 0) return
    // Match tolerantly on case, exactly as the lowercased map below did: the
    // chain and keccak256 both hand back lowercase hex today, but a single
    // mismatched byte-case would silently skip a job's settlement forever.
    const hashVariants = [...new Set(submittedHashes.flatMap((h) => [h, h.toLowerCase()]))]
    const allSpecs = await db.select().from(jobSpec).where(inArray(jobSpec.specHash, hashVariants))
    const specByHash = new Map(allSpecs.map((s) => [s.specHash.toLowerCase(), s]))

    for (const job of jobs) {
      if (job.status !== 'Submitted') continue
      const spec = specByHash.get(job.specHash.toLowerCase())
      if (!spec) continue

      if (spec.onchainJobId !== job.id) {
        await db.update(jobSpec).set({ onchainJobId: job.id }).where(eq(jobSpec.specHash, spec.specHash))
        spec.onchainJobId = job.id // settlement/regrade key off this
      }

      let verdict = spec.testResult && spec.testResult.passed !== null ? spec.testResult.passed : null
      if (verdict === null) {
        console.log(`[labor-settle] re-grading ungraded Submitted job #${job.id} (${spec.deliverableKind ?? 'text'})`)
        verdict = await regradeSubmittedSpec(spec).catch((e) => {
          console.error(`[labor-settle] re-grade of job #${job.id} failed:`, e)
          return null
        })
        if (verdict === null) continue // still no verdict → manual review
      } else {
        console.log(`[labor-settle] re-driving stuck settlement for job #${job.id} (passed=${verdict})`)
      }

      if (verdict) {
        await autoApprovePassedJob(spec)
      } else {
        await returnFailedJobToMarket(spec)
      }
    }
  } catch (error) {
    console.error('[labor-settle] stuck sweep failed:', error)
  }
}

/** Re-run grading for a Submitted job whose spec has no usable verdict yet
 *  (grading never ran, threw, or returned no verdict — a provider overload or
 *  a grading key that was missing at submission time). Writes testResult and
 *  returns the fresh verdict, or null if the job isn't auto-gradable or the
 *  submission isn't recorded yet. */
export async function regradeSubmittedSpec(spec: typeof jobSpec.$inferSelect): Promise<boolean | null> {
  if (spec.onchainJobId === null || !spec.agentTaskId) return null
  const { agentTask, artifact, agent } = await import('@/lib/db/schema')

  const { resolveTestSuiteSpec } = await import('@/lib/test-suite-jobs')
  const testSuiteSpec = !spec.testCode ? resolveTestSuiteSpec(spec.title) : null
  // A repo job's deliverable is a diff, and its grader is the repository's own
  // CI — never the text reviewer. Re-driving it means (re-)opening the PR;
  // openPrForSubmission is idempotent once prNumber is set.
  const isRepo = Boolean(spec.repoFullName)
  const isImage = spec.deliverableKind === 'image'
  const isAudio = spec.deliverableKind === 'audio' && Boolean(spec.acceptanceCriteria?.trim())
  const isLlmText =
    !spec.testCode &&
    !testSuiteSpec &&
    !isRepo &&
    !isImage &&
    (spec.deliverableKind ?? 'text') === 'text' &&
    Boolean(spec.acceptanceCriteria?.trim())
  if (!spec.testCode && !testSuiteSpec && !isRepo && !isImage && !isAudio && !isLlmText) return null

  const [task] = await db.select().from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
  const output = task?.output ?? ''
  const [reqAgent] = spec.requesterAgentId
    ? await db.select().from(agent).where(eq(agent.id, spec.requesterAgentId))
    : []
  const ownerId = reqAgent?.userId ?? null
  const gspec = { title: spec.title, description: spec.description, acceptanceCriteria: spec.acceptanceCriteria }

  let grade: { passed: boolean | null; output: string; gradedAt: string }
  if (isRepo) {
    if (!output) return null
    const [workerAg] = spec.workerAgentId ? await db.select().from(agent).where(eq(agent.id, spec.workerAgentId)) : []
    const { openPrForSubmission } = await import('@/lib/repo-job-pipeline')
    grade = await openPrForSubmission(spec, output, { workerName: workerAg?.name })
  } else if (testSuiteSpec) {
    if (!output) return null
    const { gradeTestSuiteSubmission } = await import('@/lib/test-suite-grading')
    grade = await gradeTestSuiteSubmission(testSuiteSpec, output)
  } else if (isImage || isAudio) {
    const arts = await db.select().from(artifact).where(eq(artifact.taskId, spec.agentTaskId))
    if (!arts.length) return null // submitted on-chain but artifact not recorded yet
    if (isImage) {
      const { gradeImageSubmission } = await import('@/lib/vision-grading')
      grade = await gradeImageSubmission(gspec, arts, ownerId)
    } else {
      const { gradeAudioSubmission } = await import('@/lib/audio-grading')
      grade = await gradeAudioSubmission(gspec, arts, ownerId)
    }
  } else if (isLlmText) {
    if (!output) return null
    const { gradeTextSubmission } = await import('@/lib/text-grading')
    grade = await gradeTextSubmission(gspec, output, ownerId)
  } else {
    if (!output) return null
    const { extractPythonCode, gradeSubmission } = await import('@/lib/code-grading')
    const code = extractPythonCode(output)
    grade = code
      ? await gradeSubmission(code, spec.testCode!)
      : { passed: false, output: 'No Python code block found in the submission.', gradedAt: new Date().toISOString() }
  }

  await db.update(jobSpec).set({ testResult: grade }).where(eq(jobSpec.specHash, spec.specHash))
  if (grade.passed !== null) {
    await logPlatformEvent(
      grade.passed ? 'JOB_TESTS_PASSED' : 'JOB_TESTS_FAILED',
      `"${spec.title}" — re-graded on the settle heartbeat: ${grade.passed ? 'passed' : 'FAILED'}`,
    )
  }
  return grade.passed
}
