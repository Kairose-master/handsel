/**
 * Terminal refund for jobs that ran out of retries.
 *
 * When a deliverable fails its independent grading, the settlement path
 * refunds the escrow and reposts the spec for a different worker — capped
 * at MAX_AUTO_REPOSTS so a broken test suite can't burn escrow round-trips
 * forever. At the cap it logged "leaving for manual review" and returned,
 * which sounds like a queue and is actually a dead end: the job stays
 * Submitted, the escrow stays locked, and for house-posted work the
 * "reviewer" it waits for does not exist. Five jobs were parked that way.
 *
 * This is the same disease as the abandoned-claim freeze (lib/stale-claim),
 * just entered through a different door: money held pending a human who is
 * never coming. The verdict that got here is objective and already final —
 * an independent grader failed the work N times — so the honest terminal
 * state is "refund the buyer and close it", not indefinite limbo.
 *
 * Two deliberate exemptions:
 *
 *  • Repo jobs are left alone. Their release trigger is a human merge and
 *    they already have a working human exit: closing the PR unmerged
 *    refunds via the webhook. The requester there is the repo owner, who is
 *    present by construction, and auto-refunding could yank a PR they were
 *    about to fix and merge.
 *  • A review window (default 24h from the verdict) passes first, so a
 *    requester who genuinely wants to look at failed work still can.
 */
import { db } from '@/lib/db'
import { jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { MAX_AUTO_REPOSTS } from '@/lib/labor-settle'

/** How long a cap-exhausted failure waits for a human before it refunds. */
export function reviewWindowMs(): number {
  const hours = Number(process.env.EXHAUSTED_REVIEW_HOURS)
  const h = Number.isFinite(hours) && hours > 0 ? hours : 24
  return h * 60 * 60 * 1000
}

/** At most this many terminal refunds per pass — each is two on-chain txs. */
const MAX_PER_PASS = 3

export type ExhaustedCandidate = {
  repostCount: number
  testResult: { passed: boolean | null; gradedAt: string } | null
  repoFullName: string | null
}

/**
 * Should this Submitted job be refunded and closed? Pure, so the policy is
 * testable without a chain: only a graded FAILURE, only past the retry cap,
 * only after the review window, and never a repo job (which has its own
 * human exit). An unparseable or missing verdict time means "not yet" —
 * the same never-act-on-missing-evidence rule the claim reaper uses.
 */
export function shouldRefundExhausted(now: Date, spec: ExhaustedCandidate, windowMs: number = reviewWindowMs()): boolean {
  if (spec.repoFullName) return false
  if (spec.repostCount < MAX_AUTO_REPOSTS) return false
  if (!spec.testResult || spec.testResult.passed !== false) return false
  const gradedAt = Date.parse(spec.testResult.gradedAt ?? '')
  if (!Number.isFinite(gradedAt)) return false
  return now.getTime() - gradedAt > windowMs
}

export type ExhaustedReport = { refunded: number; examined: number; skipped?: string }

export async function refundExhaustedJobs(now = new Date()): Promise<ExhaustedReport> {
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { refunded: 0, examined: 0, skipped: 'labor market not configured' }

  // Superseded on V2 by expireReview, which pays the requester 90% and the
  // worker side 10% rather than refunding in full — the forfeit exists so that
  // going silent is not free. This path would hand back the whole bounty and
  // erase that. See lib/dispute-policy.ts.
  const { offchainMayResolveDisputes, V2_HANDLES_IT } = await import('@/lib/dispute-policy')
  if (!(await offchainMayResolveDisputes())) return { refunded: 0, examined: 0, skipped: V2_HANDLES_IT }

  const { readJobs, raiseDispute, resolveDispute } = await import('@/lib/onchain/labor')
  const jobs = await readJobs({ maxAgeMs: 0 }).catch(() => [])
  const submitted = jobs.filter((j) => j.status === 'Submitted')
  if (submitted.length === 0) return { refunded: 0, examined: 0 }

  let refunded = 0
  let examined = 0

  for (const job of submitted) {
    if (refunded >= MAX_PER_PASS) break
    examined++
    try {
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
      if (!spec) continue
      if (!shouldRefundExhausted(now, spec)) continue

      // The on-chain requester is the authority — raiseDispute reverts with
      // NotRequester for anyone else (house-fronted x402 jobs differ from
      // the spec's requesterAgentId).
      // Case-insensitive: an address is the same address checksummed or
      // lowercased, and an exact match that misses here means no refund, with
      // nothing in the log to say so. See lib/agent-by-address.ts.
      const { agentByAddress } = await import('@/lib/agent-by-address')
      const requesterLookup = await agentByAddress(job.requester)
      if (!requesterLookup.found) {
        console.warn(`[exhausted-refund] job ${job.id} not refundable — unresolvable requester ${job.requester} (${requesterLookup.reason})`)
        continue
      }
      const requesterAgent = requesterLookup.agent

      let status = job.status as string
      if (status === 'Submitted') {
        await raiseDispute(requesterAgent.id, job.id)
        status = 'Disputed'
      }
      if (status === 'Disputed') {
        await resolveDispute(job.id, false)
        status = 'Refunded'
      }

      await db
        .update(jobSpec)
        .set({
          disputeNote: `Auto: failed independent grading ${spec.repostCount + 1}× and exhausted the repost cap — escrow returned to the requester`,
        })
        .where(eq(jobSpec.specHash, spec.specHash))

      const { logPlatformEvent } = await import('@/lib/platform-feed')
      await logPlatformEvent(
        'JOB_REFUNDED',
        `"${spec.title}" exhausted its retries after repeated grading failures — $${job.bounty} returned to the requester`,
      ).catch(() => {})

      refunded++
    } catch (error) {
      console.error(`[exhausted-refund] refunding job ${job.id} failed:`, error)
    }
  }

  return { refunded, examined }
}
