/**
 * POST /api/github/webhook — the grading and settlement signal for GitHub
 * repo jobs (docs/github-jobs.md, Phase 2).
 *
 * Three facts arrive here, and only these three matter:
 *   check_suite / check_run completed  → the requester's OWN CI verdict,
 *       written into `testResult` (the same field every other grader writes,
 *       so nothing downstream changes). CI green does NOT move money.
 *   pull_request merged                → the requester's approval. THIS is
 *       what releases the escrow (autoApprovePassedJob, authorization
 *       'merge').
 *   pull_request closed unmerged       → the dispute path: refund + repost
 *       for a different worker, exactly as a failed grade does.
 *
 * Every payload is HMAC-verified against the App's webhook secret before a
 * single byte of it is trusted. Unknown/unmatched deliveries are a 200 no-op:
 * GitHub retries non-2xx, and an installation on an unrelated repo is normal.
 */
import { db } from '@/lib/db'
import { jobSpec } from '@/lib/db/schema'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { origin as deploymentOrigin } from '@/lib/origin'

/**
 * Every spec ever minted from one GitHub issue, newest first.
 *
 * The two callers below both used to read the WHOLE job_specs table and take
 * the first JavaScript `.find` match, which is wrong twice over. Row order is
 * unspecified, and an issue can legitimately have several specs — label,
 * cancel, re-label, or a failed grade that auto-reposted. So `.find` could
 * return a long-dead job while a live one existed, which meant the
 * idempotency check below could pass and escrow a SECOND bounty for the same
 * issue, and the unlabel/close path could "cancel" the dead one and leave the
 * live escrow locked with no label left to release it.
 *
 * Scoped in SQL, ordered newest-first, and returning all candidates so the
 * caller decides against live chain state rather than against row order.
 */
async function specsForIssue(repoFullName: string, issueNumber: number) {
  return db
    .select({
      specHash: jobSpec.specHash,
      requesterAgentId: jobSpec.requesterAgentId,
      onchainJobId: jobSpec.onchainJobId,
    })
    .from(jobSpec)
    .where(
      and(
        eq(jobSpec.repoFullName, repoFullName),
        eq(jobSpec.issueNumber, issueNumber),
        isNotNull(jobSpec.onchainJobId),
      ),
    )
    .orderBy(desc(jobSpec.createdAt))
}

export const maxDuration = 300 // settlement runs on-chain UserOps

type Verdict = { passed: boolean | null; output: string; gradedAt: string }

export async function POST(request: Request) {
  const raw = await request.text()

  const { getGithubWebhookSecret, verifyGithubSignature } = await import('@/lib/github-app')
  const secret = await getGithubWebhookSecret()
  if (!secret) {
    console.error('[github/webhook] no webhook secret configured — rejecting delivery')
    return Response.json({ error: 'Webhook not configured' }, { status: 503 })
  }
  if (!verifyGithubSignature(raw, request.headers.get('x-hub-signature-256'), secret)) {
    return Response.json({ error: 'Bad signature' }, { status: 401 })
  }

  const event = request.headers.get('x-github-event') ?? ''
  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'Bad payload' }, { status: 400 })
  }

  try {
    if (event === 'pull_request') return await handlePullRequest(payload)
    if (event === 'check_suite' || event === 'check_run') return await handleCheck(event, payload)
    if (event === 'issues') {
      const res = await handleIssue(payload)
      // The bot's only observable output is a comment; when it stays silent we
      // need the exit path to be readable from the runtime logs.
      console.log(
        `[github/webhook] issues action=${String(payload?.action ?? '')} label=${String(payload?.label?.name ?? '')} -> ${await res.clone().text()}`,
      )
      return res
    }
    return Response.json({ status: 'ignored', event })
  } catch (error) {
    console.error(`[github/webhook] ${event} handling failed:`, error)
    // 500 so GitHub retries — settlement paths are all idempotent.
    return Response.json({ error: 'Handler failed' }, { status: 500 })
  }
}

/** Find the job this PR belongs to. Repo + PR number is the whole key. */
async function specForPr(repoFullName: string, prNumber: number) {
  const [spec] = await db
    .select()
    .from(jobSpec)
    .where(and(eq(jobSpec.repoFullName, repoFullName), eq(jobSpec.prNumber, prNumber)))
  return spec ?? null
}

async function writeVerdict(specHash: string, verdict: Verdict, ciStatus: string | null) {
  await db
    .update(jobSpec)
    .set(ciStatus === null ? { testResult: verdict } : { testResult: verdict, ciStatus })
    .where(eq(jobSpec.specHash, specHash))
}


/**
 * The label-to-bounty bot: `bounty:$15` on a GitHub issue IS the job posting.
 *
 * labeled   → resolve the labeler through github_identities to a platform
 *             account (the GitHub sign-in is the identity bridge), escrow
 *             from their funded agent, post the repo job, comment back.
 *             Not linked → the comment carries the link instructions, so a
 *             failed label is an onboarding surface, not a silent no-op.
 * unlabeled / closed → cancel-and-refund, but ONLY while the job is still
 *             Open on-chain — a claimed job is a worker's committed work and
 *             a label cannot destroy it.
 *
 * Requires the App to hold Issues: Read & write and subscribe to Issue
 * events (docs/github-jobs.md). Idempotent per (repo, issue): re-delivered
 * webhooks find the existing open job and stop.
 */
async function handleIssue(payload: any): Promise<Response> {
  const action = String(payload?.action ?? '')
  const repoFullName = String(payload?.repository?.full_name ?? '')
  const { issueNumberOf, parseBountyLabel, bountyLabelOn } = await import('@/lib/bounty-label')
  const issueNumber = issueNumberOf(payload)
  if (!repoFullName || issueNumber === null) return Response.json({ status: 'ignored' })

  const origin = deploymentOrigin()
  const { commentOnPr } = await import('@/lib/github-app') // issues share the comments API with PRs

  if (action === 'labeled') {
    const bountyUsd = parseBountyLabel(String(payload?.label?.name ?? ''))
    if (bountyUsd === null) return Response.json({ status: 'ignored', reason: 'not a bounty label' })

    const { validateLabelBounty, briefFromIssue, bountyPostedComment, notLinkedComment } = await import('@/lib/bounty-label')
    const check = validateLabelBounty(bountyUsd)
    if (!check.ok) {
      await commentOnPr(repoFullName, issueNumber, `⚠️ ${check.reason}`)
      return Response.json({ status: 'rejected', reason: check.reason })
    }

    // Idempotency: one open job per (repo, issue) — and the check has to hold
    // for as long as the ESCROW takes, not just for the instant it runs.
    //
    // Posting a repo job is a ~30s ERC-4337 round trip. GitHub gives a webhook
    // ten seconds and redelivers when it doesn't hear back, so the natural
    // sequence is: delivery 1 checks (nothing live) → starts posting → GitHub
    // times out → delivery 2 arrives while the post is still in flight →
    // checks (still nothing live, because it hasn't landed) → posts a second
    // bounty. Neither check is wrong; they just both ran inside one gap. The
    // chain read being fresh would not have helped — nothing was there to
    // read yet.
    //
    // So hold a cross-instance lock on the issue across the whole post. Two
    // minutes covers the on-chain round trip with room to spare, and expires
    // on its own if this invocation dies mid-flight.
    const { acquireOpsLease, releaseOpsLease } = await import('@/lib/ops-lease')
    const issueLock = `bounty-issue:${repoFullName}#${issueNumber}`
    if (!(await acquireOpsLease(issueLock, 120_000))) {
      return Response.json({ status: 'ignored', reason: 'a bounty for this issue is already being escrowed' })
    }
    // Hand the lock back on every path that does NOT escrow. Most of them end
    // in "here is how to fix this" — and a user who fixes it re-labels within
    // seconds, which a two-minute lock would silently swallow.
    const unlock = async () => releaseOpsLease(issueLock)

    await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()
    const existing = await specsForIssue(repoFullName, issueNumber)
    if (existing.length > 0) {
      const { readJobsOrUnknown } = await import('@/lib/onchain/labor-read')
      const jobs = await readJobsOrUnknown({ maxAgeMs: 0 })
      // An RPC hiccup here used to read as "nothing live for this issue" and
      // escrow a SECOND bounty. Unknown chain state is not permission to spend.
      if (jobs === null) {
        await unlock()
        await commentOnPr(repoFullName, issueNumber, `⚠️ Could not read the chain to check for an existing bounty — nothing was escrowed. Re-add the label to retry.`)
        return Response.json({ status: 'deferred', reason: 'chain state unknown' })
      }
      const statusById = new Map(jobs.map((j) => [j.id, j.status]))
      // ANY live job for this issue blocks a second escrow — not merely the
      // newest one, and not whichever row the database returned first.
      const { pickIssueJob } = await import('@/lib/bounty-label')
      const live = pickIssueJob(existing, (id) => statusById.get(id))
      if (live) {
        await unlock()
        return Response.json({ status: 'ignored', reason: `job #${live.jobId} already live for this issue` })
      }
    }

    // Identity bridge: the LABELER pays, resolved via their linked GitHub.
    const senderGithubId = String(payload?.sender?.id ?? '')
    const { userIdForGithubUser } = await import('@/lib/github-identity')
    const userId = senderGithubId ? await userIdForGithubUser(senderGithubId) : null
    if (!userId) {
      await unlock()
      await commentOnPr(repoFullName, issueNumber, notLinkedComment(origin))
      return Response.json({ status: 'rejected', reason: 'labeler not linked' })
    }
    const { agent } = await import('@/lib/db/schema')
    const agents = await db.select().from(agent).where(eq(agent.userId, userId))
    const requester = agents.find((a) => a.smartAccountAddress)
    if (!requester) {
      await unlock()
      await commentOnPr(repoFullName, issueNumber, `Your Handsel account has no provisioned agent to escrow from — create one at ${origin}/agents and re-add the label.`)
      return Response.json({ status: 'rejected', reason: 'no funded agent' })
    }

    try {
      const { postRepoJob } = await import('@/lib/repo-job-post')
      const issueTitle = String(payload?.issue?.title ?? `Issue #${issueNumber}`)
      const res = await postRepoJob({
        requesterAgentId: requester.id,
        repoFullName,
        title: issueTitle,
        brief: briefFromIssue({
          title: issueTitle,
          body: payload?.issue?.body ?? null,
          url: String(payload?.issue?.html_url ?? `https://github.com/${repoFullName}/issues/${issueNumber}`),
        }),
        issueUrl: String(payload?.issue?.html_url ?? ''),
        bountyUsd,
        issueNumber,
      })
      const [posted] = await db
        .select({ onchainJobId: jobSpec.onchainJobId })
        .from(jobSpec)
        .where(eq(jobSpec.specHash, res.specHash))
      await commentOnPr(repoFullName, issueNumber, bountyPostedComment({ bountyUsd, jobId: posted?.onchainJobId ?? null, origin }))
      const { logPlatformEvent } = await import('@/lib/platform-feed')
      await logPlatformEvent('BOUNTY_LABELED', `A bounty label minted a $${bountyUsd} job from ${repoFullName}#${issueNumber}`).catch(() => {})
      return Response.json({ status: 'ok', posted: res.specHash })
    } catch (error) {
      // A PENDING post keeps the lock: the escrow was accepted by the bundler
      // and probably lands, so releasing here is how one label becomes two
      // bounties. A genuine failure releases, because the user will read the
      // comment and re-label within seconds.
      const { isUserOpPending } = await import('@/lib/onchain/account')
      if (isUserOpPending(error)) {
        console.warn(`[github/webhook] bounty post for ${repoFullName}#${issueNumber} is pending confirmation — holding the issue lock`)
        await commentOnPr(repoFullName, issueNumber, `⏳ Bounty escrow submitted — confirming on-chain. The job will appear on the board shortly.`)
        return Response.json({ status: 'pending' }, { status: 200 })
      }
      await unlock()
      const reason = error instanceof Error ? error.message : String(error)
      await commentOnPr(repoFullName, issueNumber, `⚠️ Could not escrow the bounty: ${reason.slice(0, 300)}`)
      return Response.json({ status: 'error', reason }, { status: 200 }) // 200: GitHub should not retry a semantic failure
    }
  }

  if (action === 'unlabeled' || action === 'closed') {
    // Only act when the bounty label is genuinely gone (unlabeled fires per
    // label; closed ends the intent regardless).
    if (action === 'unlabeled') {
      const removed = parseBountyLabel(String(payload?.label?.name ?? ''))
      if (removed === null) return Response.json({ status: 'ignored' })
      if (bountyLabelOn(payload?.issue?.labels) !== null) {
        return Response.json({ status: 'ignored', reason: 'another bounty label remains' })
      }
    }
    const candidates = await specsForIssue(repoFullName, issueNumber)
    if (candidates.length === 0) return Response.json({ status: 'ignored' })

    const { cancelJob } = await import('@/lib/onchain/labor')
    const { readJobsOrUnknown } = await import('@/lib/onchain/labor-read')
    const jobs = await readJobsOrUnknown({ maxAgeMs: 0 })
    // Swallowing the read here answered "no Open job for this issue", which
    // is a confident wrong answer to a question we could not see. `closed`
    // fires once and the label is already gone, so nothing would retry —
    // say what actually happened and leave it to the escrow sweeps.
    if (jobs === null) {
      return Response.json({ status: 'deferred', reason: 'chain state unknown — no refund attempted' })
    }
    const statusById = new Map(jobs.map((j) => [j.id, j.status]))
    // Refund the job that is ACTUALLY Open, whichever spec row it belongs to.
    // A claimed job is a worker's committed work — a label cannot destroy it.
    const { pickIssueJob } = await import('@/lib/bounty-label')
    const match = pickIssueJob(candidates, (id) => statusById.get(id), ['Open'])
    if (!match) {
      return Response.json({ status: 'ignored', reason: 'no Open job for this issue — a claimed job outlives its label' })
    }
    const { spec } = match
    if (!spec.requesterAgentId) return Response.json({ status: 'ignored', reason: 'no requester on record' })
    try {
      await cancelJob(spec.requesterAgentId, match.jobId)
      await commentOnPr(repoFullName, issueNumber, `↩️ Bounty cancelled and the escrow refunded (job was still unclaimed).`)
      const { logPlatformEvent } = await import('@/lib/platform-feed')
      await logPlatformEvent('BOUNTY_UNLABELED', `Bounty on ${repoFullName}#${issueNumber} cancelled while unclaimed — escrow refunded`).catch(() => {})
      return Response.json({ status: 'ok', cancelled: spec.onchainJobId })
    } catch (error) {
      // A cancel whose receipt never arrived was still accepted by the
      // bundler and usually lands, so do not tell the issue it failed —
      // that reads as "your money is stuck" for a refund that is in flight.
      const { isUserOpPending } = await import('@/lib/onchain/account')
      if (isUserOpPending(error)) {
        console.warn(`[github/webhook] cancel of job ${spec.onchainJobId} is pending confirmation`)
        await commentOnPr(repoFullName, issueNumber, `↩️ Bounty cancelled — the refund is confirming on-chain.`)
        return Response.json({ status: 'pending', cancelled: spec.onchainJobId })
      }
      console.error('[github/webhook] bounty cancel failed:', error)
      return Response.json({ status: 'error' }, { status: 200 })
    }
  }

  return Response.json({ status: 'ignored' })
}

/**
 * Record the CI verdict on the WORKER'S credit ledger.
 *
 * `logPlatformEvent` only writes the cosmetic activity feed. The score comes
 * from `agent_events`, and every other grader — pytest, vision, transcription,
 * LLM review — inserts one there. Repo jobs did not, which meant the strongest
 * grader we have (the buyer's own CI, run on GitHub's infrastructure, where the
 * worker cannot reach it) contributed nothing to the credit score the whole
 * platform is built on. A worker could pass CI forever and stay "no graded work
 * yet".
 *
 * Idempotent: webhooks are re-delivered, and check_suite and check_run can both
 * fire for one result, so the event id is derived from the job and skipped if
 * already present.
 */
async function recordCiCreditEvent(
  spec: typeof jobSpec.$inferSelect,
  passed: boolean,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!spec.workerAgentId || spec.onchainJobId === null) return
  try {
    // Stamp the requester's current score for credibility weighting.
    if (spec.requesterAgentId && detail.requesterScore === undefined) {
      const { agent } = await import('@/lib/db/schema')
      const [req] = await db.select({ creditScore: agent.creditScore }).from(agent).where(eq(agent.id, spec.requesterAgentId))
      detail.requesterScore = req ? Number(req.creditScore) : null
    }
    const { agentEvent } = await import('@/lib/db/schema')
    const taskId = `job-${spec.onchainJobId}-ci`
    const existing = await db.select({ id: agentEvent.id }).from(agentEvent).where(eq(agentEvent.taskId, taskId))
    if (existing.length > 0) return

    const { nanoid } = await import('nanoid')
    await db.insert(agentEvent).values({
      id: nanoid(),
      agentId: spec.workerAgentId,
      taskId,
      eventType: passed ? 'JOB_TESTS_PASSED' : 'JOB_TESTS_FAILED',
      success: passed,
      executionTime: 0,
      tokenCost: 0,
      qualityScore: passed ? '1.000' : '0.000', // a graded fact, not self-assessment
      detail,
    })
    const { recalculateCredit } = await import('@/lib/credit-engine')
    await recalculateCredit(spec.workerAgentId)
  } catch (error) {
    console.error('[github/webhook] recording the CI credit event failed (non-fatal):', error)
  }
}

async function handleCheck(event: string, payload: any) {
  const repoFullName: string | undefined = payload?.repository?.full_name
  const node = event === 'check_suite' ? payload?.check_suite : payload?.check_run
  if (!repoFullName || payload?.action !== 'completed' || !node) return Response.json({ status: 'ignored' })

  // check_run carries its PRs on the run; check_suite on the suite.
  const prs: Array<{ number: number }> = node.pull_requests ?? node.check_suite?.pull_requests ?? []
  const conclusion: string = node.conclusion ?? ''

  // A failing check on a commit that is not a Handsel job is not a verdict —
  // it is a NEW defect, and (if the repo opted in) a bounty to fix it. This
  // runs even with no PR: a red default branch is the purest case. It has to
  // know whether any PR here is a Handsel job first, because a failing check on
  // a worker's fix attempt is grading, not origination — so it goes after the
  // grading loop, which sets `gradedAHandselJob`.
  let gradedAHandselJob = false

  let handled = 0
  for (const pr of prs) {
    const spec = await specForPr(repoFullName, pr.number)
    if (!spec) continue
    gradedAHandselJob = true

    if (conclusion === 'success') {
      // Green CI is the independent verdict — recorded, and announced on the
      // PR — but the money waits for the merge.
      await writeVerdict(
        spec.specHash,
        {
          passed: true,
          output: `CI passed on ${repoFullName}#${pr.number} (${event} conclusion: success). The escrow releases when the requester merges.`,
          gradedAt: new Date().toISOString(),
        },
        'success',
      )
      const { commentOnPr } = await import('@/lib/github-app')
      await commentOnPr(
        repoFullName,
        pr.number,
        `✅ CI is green. Merging this pull request releases the escrowed bounty to the worker; closing it unmerged refunds it. ` +
          `— [Handsel](${deploymentOrigin()}) job #${spec.onchainJobId}`,
      )
      await recordCiCreditEvent(spec, true, {
        jobId: spec.onchainJobId,
        repo: repoFullName,
        prNumber: pr.number,
        grader: 'repo-ci',
        requesterAgentId: spec.requesterAgentId ?? null,
        conclusion,
      })
      const { logPlatformEvent } = await import('@/lib/platform-feed')
      await logPlatformEvent(
        'JOB_TESTS_PASSED',
        `"${spec.title}" — the repository's own CI passed on PR #${pr.number}; awaiting the requester's merge to release escrow`,
      ).catch(() => {})
      handled++
    } else if (conclusion === 'failure' || conclusion === 'timed_out') {
      // The requester's own grader failed the work: an objective verdict, so
      // the standard failure path runs — close the PR, refund, repost for a
      // different worker.
      await writeVerdict(
        spec.specHash,
        {
          passed: false,
          output: `CI failed on ${repoFullName}#${pr.number} (${event} conclusion: ${conclusion}). The repository's own checks are the grader for repo jobs.`,
          gradedAt: new Date().toISOString(),
        },
        'failure',
      )
      await recordCiCreditEvent(spec, false, {
        jobId: spec.onchainJobId,
        repo: repoFullName,
        prNumber: pr.number,
        grader: 'repo-ci',
        requesterAgentId: spec.requesterAgentId ?? null,
        conclusion,
      })
      const { commentOnPr } = await import('@/lib/github-app')
      await commentOnPr(
        repoFullName,
        pr.number,
        `❌ CI failed, so this attempt did not earn the bounty. The escrow is being refunded and the job reposted for a different worker.`,
      )
      const fresh = await specForPr(repoFullName, pr.number)
      const { returnFailedJobToMarket } = await import('@/lib/labor-settle')
      if (fresh) await returnFailedJobToMarket(fresh)
      handled++
    }
    // neutral / skipped / cancelled / action_required: not a verdict — ignore.
  }

  // Origination: a red check → a bounty to fix it, if the repo authorised it.
  // Only check_run carries a single check name; check_suite aggregates many, so
  // there is no one signature to dedup on and origination is a no-op there.
  const originated =
    event === 'check_run'
      ? await maybeOriginateCiBounty({
          repoFullName,
          checkName: String(node?.name ?? ''),
          conclusion,
          headSha: String(node?.head_sha ?? ''),
          runUrl: String(node?.html_url ?? ''),
          gradedAHandselJob,
        })
      : { status: 'skipped', reason: 'not a check_run' }

  return Response.json({ status: 'ok', handled, originated })
}

/**
 * A failing check becomes a funded fix-job — or, far more often, does not.
 *
 * The default is no spend: without a `ci_bounty_policies` row for the repo this
 * returns before touching a wallet. `decideAutoBounty` (lib/ci-bounty.ts) is the
 * authority; everything here is the plumbing that gives it honest inputs — the
 * live open-bounty check and the day's spend — and the lease that stops one red
 * check, redelivered, from escrowing twice (the exact race the label bot hit).
 */
async function maybeOriginateCiBounty(input: {
  repoFullName: string
  checkName: string
  conclusion: string
  headSha: string
  runUrl: string
  gradedAHandselJob: boolean
}): Promise<{ status: string; reason?: string; jobSpec?: string }> {
  const { repoFullName, checkName, conclusion, headSha, runUrl, gradedAHandselJob } = input
  const { isFailingConclusion, ciFailureSignature, decideAutoBounty, ciBountyBrief } = await import('@/lib/ci-bounty')

  // Cheapest rejections first, before any DB or chain read.
  if (!checkName || !isFailingConclusion(conclusion)) {
    return { status: 'skipped', reason: 'not a failing named check' }
  }

  const { ensureCiBountyTable } = await import('@/lib/db/ensure-columns')
  await ensureCiBountyTable()
  const { ciBountyPolicy, jobSpec: jobSpecTable } = await import('@/lib/db/schema')
  const [policyRow] = await db.select().from(ciBountyPolicy).where(eq(ciBountyPolicy.repoFullName, repoFullName))
  const policy = policyRow
    ? {
        repoFullName: policyRow.repoFullName,
        funderAgentId: policyRow.funderAgentId,
        bountyUsd: parseFloat(policyRow.bountyUsd),
        dailyCapUsd: parseFloat(policyRow.dailyCapUsd),
        enabled: policyRow.enabled,
      }
    : null

  const signature = ciFailureSignature(repoFullName, checkName)

  // Open-bounty dedup and today's spend, both read live rather than assumed.
  // An unreadable chain here must NOT read as "nothing open" — that is how a
  // second escrow lands (§the label bot's own lesson). Treat unknown as "an
  // open bounty might exist" and skip: refusing to spend on doubt is the safe
  // direction.
  let openBountyExists = true
  let spentTodayUsd = 0
  try {
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    const rows = await db
      .select({ id: jobSpecTable.onchainJobId, sig: jobSpecTable.ciCheckSignature, created: jobSpecTable.createdAt })
      .from(jobSpecTable)
      .where(and(eq(jobSpecTable.repoFullName, repoFullName), isNotNull(jobSpecTable.ciCheckSignature)))
    const { readJobsOrUnknown } = await import('@/lib/onchain/labor-read')
    const jobs = await readJobsOrUnknown({ maxAgeMs: 0 })
    if (jobs === null) return { status: 'deferred', reason: 'chain state unknown — no bounty originated' }
    // The amount lives on-chain, not in the spec row — the spec never stores a
    // price because the live bounty can rise (Dutch auction). So spend is
    // summed from the chain's own bounty, matched by onchain job id.
    const statusById = new Map(jobs.map((j) => [j.id, j.status]))
    const bountyById = new Map(jobs.map((j) => [j.id, j.bounty]))

    openBountyExists = rows.some(
      (r) => r.sig === signature && r.id !== null && statusById.get(r.id) === 'Open',
    )
    spentTodayUsd = rows
      .filter((r) => r.created && r.created >= dayStart && r.id !== null)
      .reduce((sum, r) => sum + (bountyById.get(r.id!) ?? 0), 0)
  } catch (error) {
    console.error('[ci-bounty] pre-post read failed — not originating:', error)
    return { status: 'error', reason: 'pre-post read failed' }
  }

  const decision = decideAutoBounty({ policy, conclusion, isHandselJobPr: gradedAHandselJob, openBountyExists, spentTodayUsd })
  if (!decision.post) return { status: 'skipped', reason: decision.reason }

  // One in-flight origination per signature, mirroring the issue lock: a
  // redelivered webhook must not escrow twice while the first post is landing.
  const { acquireOpsLease, releaseOpsLease } = await import('@/lib/ops-lease')
  const lock = `ci-bounty:${signature}`
  if (!(await acquireOpsLease(lock, 120_000))) {
    return { status: 'ignored', reason: 'a bounty for this check is already being escrowed' }
  }

  try {
    const { postRepoJob } = await import('@/lib/repo-job-post')
    const res = await postRepoJob({
      requesterAgentId: policy!.funderAgentId,
      repoFullName,
      title: `Fix failing check: ${checkName}`,
      brief: ciBountyBrief({ repoFullName, checkName, runUrl, headSha }),
      bountyUsd: decision.bountyUsd,
      ciCheckSignature: signature,
    })
    const { logPlatformEvent } = await import('@/lib/platform-feed')
    await logPlatformEvent(
      'CI_BOUNTY_POSTED',
      `A red check "${checkName}" on ${repoFullName} minted a $${decision.bountyUsd} fix bounty`,
    ).catch(() => {})
    return { status: 'ok', jobSpec: res.specHash }
  } catch (error) {
    // A pending post KEEPS the lock — the escrow probably landed, and releasing
    // is how one red check becomes two bounties. A real failure releases.
    const { isUserOpPending } = await import('@/lib/onchain/account')
    if (isUserOpPending(error)) {
      console.warn(`[ci-bounty] post for ${signature} is pending — holding the lock`)
      return { status: 'pending' }
    }
    await releaseOpsLease(lock)
    console.error('[ci-bounty] origination post failed:', error)
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function handlePullRequest(payload: any) {
  const repoFullName: string | undefined = payload?.repository?.full_name
  const prNumber: number | undefined = payload?.pull_request?.number
  if (!repoFullName || !prNumber || payload?.action !== 'closed') return Response.json({ status: 'ignored' })

  const spec = await specForPr(repoFullName, prNumber)
  if (!spec) return Response.json({ status: 'ignored', reason: 'no job for this PR' })

  const merged = Boolean(payload?.pull_request?.merged)
  const { logPlatformEvent } = await import('@/lib/platform-feed')

  if (merged) {
    // The requester merged: their own, first-party approval of this work.
    // Record it as the verdict (a merge outranks any grader) and release.
    await writeVerdict(
      spec.specHash,
      {
        passed: true,
        output: `The requester merged ${repoFullName}#${prNumber} — the work was accepted into the repository.`,
        gradedAt: new Date().toISOString(),
      },
      // Deliberately null: the merge is already recorded in testResult and in
      // the on-chain status. Writing 'merged' into ciStatus overwrote what CI
      // actually said, so a merged job reported "no CI result yet" — the audit
      // trail lost the verdict at the exact moment it mattered most.
      null,
    )
    const fresh = await specForPr(repoFullName, prNumber)
    const { autoApprovePassedJob } = await import('@/lib/labor-settle')
    if (fresh) await autoApprovePassedJob(fresh, { authorization: 'merge' })
    await logPlatformEvent(
      'REPO_JOB_MERGED',
      `"${spec.title}" — PR #${prNumber} merged on ${repoFullName}; escrow released to the worker`,
    ).catch(() => {})
    return Response.json({ status: 'ok', settled: 'merged' })
  }

  // Closed without merging = rejected. Same semantics as a failed grade.
  await writeVerdict(
    spec.specHash,
    {
      passed: false,
      output: `The requester closed ${repoFullName}#${prNumber} without merging — the work was not accepted.`,
      gradedAt: new Date().toISOString(),
    },
    'closed',
  )
  const fresh = await specForPr(repoFullName, prNumber)
  const { returnFailedJobToMarket } = await import('@/lib/labor-settle')
  if (fresh) await returnFailedJobToMarket(fresh)
  await logPlatformEvent(
    'REPO_JOB_REJECTED',
    `"${spec.title}" — PR #${prNumber} closed unmerged on ${repoFullName}; escrow refunded and the job reposted`,
  ).catch(() => {})
  return Response.json({ status: 'ok', settled: 'closed' })
}
