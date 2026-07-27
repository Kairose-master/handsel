/**
 * Repo-job submission → pull request (docs/github-jobs.md, Phase 2).
 *
 * Runs from the same place every other grader runs (the submission callback
 * and the settle sweep), but produces a DEFERRED verdict rather than a final
 * one: opening the PR only starts the grading. The requester's CI writes
 * pass/fail into `testResult` via the webhook, and MERGE — never CI alone —
 * releases the escrow.
 *
 * Failure taxonomy, deliberately kept apart:
 *   - a bad diff (DiffRejectedError) is the WORKER's failure  → passed:false
 *   - App unconfigured / not installed / GitHub down          → passed:null
 *     (manual review — never punish a worker for our plumbing)
 */
import { db } from '@/lib/db'
import { jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { DiffRejectedError, extractUnifiedDiff } from '@/lib/repo-jobs'

export type Verdict = { passed: boolean | null; output: string; gradedAt: string }

const now = () => new Date().toISOString()

/** Is this spec a GitHub repo job? (repoFullName is the only marker.) */
export function isRepoJob(spec: Pick<typeof jobSpec.$inferSelect, 'repoFullName'>): boolean {
  return Boolean(spec.repoFullName)
}

/**
 * Open a PR from the worker's submitted diff. Idempotent: a spec that already
 * carries a prNumber returns the pending verdict without opening a second PR.
 */
export async function openPrForSubmission(
  spec: typeof jobSpec.$inferSelect,
  output: string,
  opts?: { workerName?: string; jobUrl?: string },
): Promise<Verdict> {
  if (!spec.repoFullName) return { passed: null, output: 'Not a repo job.', gradedAt: now() }
  if (spec.prNumber) {
    return {
      passed: null,
      output: `Pull request #${spec.prNumber} is already open on ${spec.repoFullName} — waiting on CI and the requester's merge.`,
      gradedAt: now(),
    }
  }

  const diff = extractUnifiedDiff(output)
  if (!diff) {
    return {
      passed: false,
      output:
        'No unified diff found in the submission. A repo job deliverable must be a ```diff fenced block ' +
        'containing a unified diff (--- / +++ / @@) generated against the base branch.',
      gradedAt: now(),
    }
  }

  try {
    const { isGithubAppConfigured, openPrFromDiff } = await import('@/lib/github-app')
    if (!(await isGithubAppConfigured())) {
      return {
        passed: null,
        output:
          'The GitHub App is not configured on this deployment, so the platform cannot open the pull request. ' +
          'The diff is recorded on the job for manual review.',
        gradedAt: now(),
      }
    }

    const body = [
      `Automated pull request from **Handsel** job #${spec.onchainJobId} — *${spec.title}*.`,
      '',
      opts?.workerName ? `Worked by agent **${opts.workerName}**.` : '',
      opts?.jobUrl ? `Job: ${opts.jobUrl}` : '',
      '',
      'The bounty is held in escrow. **Merging this pull request releases it to the worker;**',
      'closing it without merging refunds the requester. CI on this PR is the independent',
      'grading signal — the platform never executes the worker\'s code itself.',
      '',
      spec.acceptanceCriteria ? `> Acceptance criteria: ${spec.acceptanceCriteria}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const pr = await openPrFromDiff({
      repoFullName: spec.repoFullName,
      baseBranch: spec.baseBranch || '',
      diff,
      title: spec.title.replace(/^repo → [^:]+:\s*/, '') || spec.title,
      body,
      branchHint: `job-${spec.onchainJobId ?? spec.specHash.slice(2, 10)}`,
    })

    await db
      .update(jobSpec)
      .set({ prNumber: pr.prNumber, ciStatus: 'pending' })
      .where(eq(jobSpec.specHash, spec.specHash))
    spec.prNumber = pr.prNumber
    spec.ciStatus = 'pending'

    const { logPlatformEvent } = await import('@/lib/platform-feed')
    await logPlatformEvent(
      'REPO_JOB_PR_OPENED',
      `"${spec.title}" — pull request #${pr.prNumber} opened on ${spec.repoFullName}; the repo's own CI is now grading`,
    ).catch(() => {})

    return {
      passed: null,
      output:
        `Pull request opened: ${pr.prUrl}\n\n` +
        `The diff applied cleanly to ${spec.repoFullName}@${spec.baseBranch || 'default branch'}. ` +
        `The repository's CI is the grader from here; the requester merging the PR releases the escrow.`,
      gradedAt: now(),
    }
  } catch (error) {
    if (error instanceof DiffRejectedError) {
      // The worker's own diff is the problem — a real, graded failure.
      return { passed: false, output: `The submitted diff was rejected: ${error.message}`, gradedAt: now() }
    }
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[repo-job-pipeline] PR open failed:', error)
    return {
      passed: null,
      output: `Could not open the pull request (platform-side): ${msg.slice(0, 400)}`,
      gradedAt: now(),
    }
  }
}
