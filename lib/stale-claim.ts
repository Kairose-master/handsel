/**
 * Abandoned-claim recovery — the way money gets un-stuck.
 *
 * The LaborMarket contract has no exit from `Accepted`: `cancelJob` requires
 * Open and `raiseDispute` requires Submitted, so a worker that claims a job
 * and never delivers freezes the requester's escrow FOREVER. That is the
 * worst failure a market can have — worse than a bad deliverable, because
 * the buyer loses the money and the work — and it is also a griefing attack:
 * claim every open job, deliver nothing, and the whole market's liquidity
 * stops. Nothing on-chain times out.
 *
 * The escape uses authority the platform already holds. Every agent's
 * smart account is operated by the platform (sendAgentCall), so for an
 * abandoned claim it can walk the state machine the contract does allow:
 *
 *   submitWork(worker, ABANDONED_RESULT)  Accepted  → Submitted
 *   raiseDispute(requester)               Submitted → Disputed
 *   resolveDispute(jobId, false)          Disputed  → Refunded ✔ money back
 *
 * Each step re-reads the live status first, so a pass that dies halfway
 * resumes on the next run instead of double-spending a transition. The
 * worker takes a real graded failure for it: abandonment has to cost
 * reputation, or claiming everything and delivering nothing stays free.
 *
 * Deliberately NOT a contract migration. A `reclaimJob(jobId)` with an
 * on-chain deadline is the right long-term shape, but it needs a redeploy
 * and a migration of every live job; this recovers the funds already stuck
 * today with the contract as deployed.
 */
import { db } from '@/lib/db'
import { agent, agentEvent, agentTask, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { absoluteUrl } from '@/lib/origin'

/** How long a claim may sit without delivery before it is abandoned. */
export function claimDeadlineMs(): number {
  const hours = Number(process.env.CLAIM_DEADLINE_HOURS)
  const h = Number.isFinite(hours) && hours > 0 ? hours : 6
  return h * 60 * 60 * 1000
}

/** At most this many jobs recovered per pass — each costs three UserOps. */
const MAX_PER_PASS = 3

/** And at most this many warnings, so a backlog of stuck claims doesn't
 *  arrive as a burst of identical emails. */
const MAX_WARNINGS_PER_PASS = 5

/**
 * Warn before taking the claim away.
 *
 * This sweep does two things at once: it unfreezes the requester's escrow, and
 * it writes a permanent graded failure onto the worker's record. The first is
 * urgent. The second is a punishment, and it was landing with **no notice at
 * all** — a desktop miner whose laptop slept, or an MCP session that dropped,
 * came back six hours later to a `VERIFIED_TASK_FAILED` it was never told was
 * coming. For a platform whose entire claim is that reputation means
 * something, handing out a permanent mark unannounced is the wrong way round.
 *
 * So: warn at 70% of the deadline, then leave a grace window, then reclaim.
 * A worker that comes back inside the window finishes the job and nothing
 * happens; one that does not has at least been told.
 *
 * `reclaimDecision` below deliberately refuses to reclaim a job that has
 * never been warned — but it warns it *on that pass* and recovers it on the
 * next, so no job stays frozen because a notice was missed. The guarantee is
 * "nobody is marked without notice", not "nothing is ever recovered".
 */
export const CLAIM_WARN_AT = 0.7

/** Grace between the warning and the reclaim, as a fraction of the deadline.
 *  With the 6h default that is ~54 minutes to finish or say something. */
export const CLAIM_WARN_GRACE = 0.15

/**
 * `unknown` is the phase this file was missing, and its absence hid seven
 * frozen jobs in plain sight.
 *
 * `claimPhase` treated "no claim timestamp and no task activity" as `working`,
 * because of the rule that protects a genuinely-running job from being
 * reclaimed out from under it (invariant 5: never act on missing evidence).
 * The rule is right. Reporting it as `working` is not: for a job that has been
 * `Accepted` on-chain for days with no off-chain claim record — the exact
 * situation §1 warns about, where the claim lock has been TTL'd away — "still
 * working" is a false statement, and it made the sweep look like it had
 * nothing to do while escrow stayed locked.
 *
 * So: still never reclaimed, but named and counted. Recovering these needs the
 * accept timestamp from the chain (the AcceptedJob event's block), which
 * `readJobs` does not expose today — a separate change, tracked in
 * docs/failure-modes.md §18 rather than guessed at here.
 */
export type ClaimPhase = 'working' | 'unknown' | 'warn' | 'expired'

/**
 * Where this claim sits against its deadline. Pure.
 *
 * Same evidence rule as `isClaimAbandoned`: `lastActivityAt` is the worker's
 * most recent sign of life, and no evidence at all means `working` — never
 * escalate against a claim we cannot see.
 */
export function claimPhase(
  now: Date,
  claimedAt: Date | null,
  lastActivityAt: Date | null,
  deadlineMs: number = claimDeadlineMs(),
): ClaimPhase {
  const last = Math.max(claimedAt?.getTime() ?? 0, lastActivityAt?.getTime() ?? 0)
  if (last === 0) return 'unknown'
  const elapsed = now.getTime() - last
  if (elapsed > deadlineMs) return 'expired'
  if (elapsed > deadlineMs * CLAIM_WARN_AT) return 'warn'
  return 'working'
}

export type ClaimAction = 'wait' | 'warn' | 'reclaim'

/**
 * What to do about one claim this pass. Pure, because this is the rule that
 * decides whether a worker takes a permanent mark.
 *
 * `warnedAt` is when this job's warning was recorded (null if never). Note
 * that an already-expired, never-warned claim returns `warn`, not `reclaim`:
 * that is the whole point, and it costs one ops cycle.
 */
export function reclaimDecision(
  now: Date,
  phase: ClaimPhase,
  warnedAt: Date | null,
  deadlineMs: number = claimDeadlineMs(),
): ClaimAction {
  // `unknown` never escalates — that is invariant 5 and it stays. The caller
  // is responsible for counting it as blocked rather than as "nothing to do".
  if (phase === 'working' || phase === 'unknown') return 'wait'
  if (!warnedAt) return 'warn'
  if (phase === 'warn') return 'wait' // already warned, still inside the deadline
  return now.getTime() - warnedAt.getTime() >= deadlineMs * CLAIM_WARN_GRACE ? 'reclaim' : 'wait'
}

/**
 * Is this claim past its deadline? A view over `claimPhase`, not a second
 * implementation — the boundary rule ("deadline measured from the last sign
 * of life; no evidence means not abandoned") now exists in exactly one place,
 * and the tests written against this signature keep guarding it.
 *
 * Note that past the deadline is no longer sufficient to reclaim: see
 * `reclaimDecision`.
 */
export function isClaimAbandoned(
  now: Date,
  claimedAt: Date | null,
  lastActivityAt: Date | null,
  deadlineMs: number = claimDeadlineMs(),
): boolean {
  return claimPhase(now, claimedAt, lastActivityAt, deadlineMs) === 'expired'
}

/** Marker result hash recorded on-chain for a reclaimed job, so the chain
 *  itself distinguishes "abandoned, refunded" from a real submission.
 *  keccak of a fixed sentence — a hand-written hex literal is one typo away
 *  from being invalid bytes32, and this one only ever meets a real chain. */
export async function abandonedResultHash(): Promise<`0x${string}`> {
  const { keccak256, toHex } = await import('viem')
  return keccak256(toHex('handsel:claim-abandoned'))
}

/**
 * Why a frozen job could not be processed. Every one of these was a bare
 * `continue` at some point, and every one of them means escrow stays locked.
 *
 * The first version of this instrumentation only covered the address lookups
 * and left `no-spec` silent — the same defect one line earlier, which is why
 * the counter read 0 while seven jobs were being skipped. Reasons are tagged
 * now so the ops line says *which* wall the sweep hit, not just that it hit one.
 */
export type BlockedReason =
  | 'no-spec' // no job_specs row for this on-chain specHash
  | 'no-requester-on-spec' // spec exists but carries no requesterAgentId
  | 'no-claim-record' // Accepted on-chain, but no claimedAt and no task activity
  | 'unresolvable-worker'
  | 'unresolvable-requester'

export type ReclaimReport = {
  reclaimed: number
  warned: number
  /** Accepted jobs this sweep cannot free, counted by reason. Frozen escrow
   *  that is invisible is the failure mode; a number with a name is the fix. */
  blocked: Partial<Record<BlockedReason, number>>
  examined: number
  skipped?: string
}

/** Compact, greppable rendering for the ops-cycle line. Pure. */
export function formatBlocked(blocked: Partial<Record<BlockedReason, number>>): string {
  const parts = Object.entries(blocked)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${reason}=${n}`)
  return parts.length === 0 ? '' : `, BLOCKED ${parts.join(' ')}`
}

/** The event row that records a warning was issued. Durable and idempotent
 *  on the job, the same shape as the `abandoned-${id}` failure marker — no
 *  new table, and a warning survives the lambda that sent it. */
const warnTaskId = (jobId: number) => `claim-warn-${jobId}`

export async function reclaimAbandonedJobs(now = new Date()): Promise<ReclaimReport> {
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { reclaimed: 0, warned: 0, blocked: {}, examined: 0, skipped: 'labor market not configured' }

  const { readJobs, submitWork, raiseDispute, resolveDispute } = await import('@/lib/onchain/labor')
  const jobs = await readJobs({ maxAgeMs: 0 }).catch(() => [])
  const accepted = jobs.filter((j) => j.status === 'Accepted')
  if (accepted.length === 0) return { reclaimed: 0, warned: 0, blocked: {}, examined: 0 }

  let reclaimed = 0
  let warned = 0
  let examined = 0
  const blocked: Partial<Record<BlockedReason, number>> = {}
  const block = (jobId: number, reason: BlockedReason, detail: string) => {
    blocked[reason] = (blocked[reason] ?? 0) + 1
    console.warn(`[stale-claim] job ${jobId} is frozen and unrecoverable by this sweep — ${reason}: ${detail}`)
  }

  for (const job of accepted) {
    if (reclaimed >= MAX_PER_PASS && warned >= MAX_WARNINGS_PER_PASS) break
    examined++
    try {
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
      if (!spec) {
        block(job.id, 'no-spec', `specHash ${job.specHash} has no job_specs row`)
        continue
      }
      if (!spec.requesterAgentId) {
        block(job.id, 'no-requester-on-spec', `spec ${job.specHash} carries no requesterAgentId`)
        continue
      }

      // Last sign of life: the claim itself, or the worker's task row if a
      // long-running job has been reporting progress.
      let lastActivityAt: Date | null = null
      if (spec.agentTaskId) {
        const [task] = await db.select({ updatedAt: agentTask.updatedAt }).from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
        lastActivityAt = task?.updatedAt ?? null
      }
      const phase = claimPhase(now, spec.claimedAt, lastActivityAt)
      if (phase === 'working') continue
      if (phase === 'unknown') {
        // Deliberately not reclaimed — but it is frozen escrow, not idle work,
        // so it gets counted and named instead of silently reading as healthy.
        block(job.id, 'no-claim-record', `claimedAt is null and no task activity for spec ${job.specHash}`)
        continue
      }

      // Has this claim already been warned, and when?
      const [warnRow] = await db
        .select({ createdAt: agentEvent.createdAt })
        .from(agentEvent)
        .where(eq(agentEvent.taskId, warnTaskId(job.id)))
      const action = reclaimDecision(now, phase, warnRow?.createdAt ?? null)
      if (action === 'wait') continue

      // Addresses on the chain are the authority for BOTH sides: the
      // off-chain claim lock may already have been TTL'd away, and
      // `raiseDispute` reverts with NotRequester unless the caller is
      // literally job.requester (which differs from spec.requesterAgentId
      // for house-fronted x402 postings).
      const { agentByAddress } = await import('@/lib/agent-by-address')
      const workerLookup = await agentByAddress(job.worker)
      const requesterLookup = await agentByAddress(job.requester)
      if (!workerLookup.found) {
        block(job.id, 'unresolvable-worker', `${job.worker} (${workerLookup.reason})`)
        continue
      }
      if (!requesterLookup.found) {
        block(job.id, 'unresolvable-requester', `${job.requester} (${requesterLookup.reason})`)
        continue
      }
      const workerAgent = workerLookup.agent
      const requesterAgent = requesterLookup.agent

      if (action === 'warn') {
        if (warned >= MAX_WARNINGS_PER_PASS) continue
        // The row is what makes the warning real, so it is written FIRST and
        // unconditionally: delivery is best-effort (email may be unconfigured,
        // the provider may be down), but a notice that isn't recorded would
        // either warn forever or reclaim as if it never warned.
        await db.insert(agentEvent).values({
          id: nanoid(),
          agentId: workerAgent.id,
          taskId: warnTaskId(job.id),
          eventType: 'CLAIM_DEADLINE_WARNED',
          success: true,
          executionTime: 0,
          tokenCost: 0,
          qualityScore: null,
          detail: { jobId: job.id, bounty: job.bounty, deadlineHours: claimDeadlineMs() / 3_600_000 },
        })

        const { logPlatformEvent } = await import('@/lib/platform-feed')
        await logPlatformEvent(
          'CLAIM_DEADLINE_WARNED',
          `${workerAgent.name} is close to the delivery deadline on job #${job.id} — deliver or the claim is released`,
        ).catch(() => {})

        try {
          const { user } = await import('@/lib/db/schema')
          const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, workerAgent.userId))
          if (owner?.email) {
            const { sendEmail } = await import('@/lib/email')
            await sendEmail({
              to: owner.email,
              subject: `Deliver job #${job.id} soon — ${workerAgent.name}'s claim is about to be released`,
              title: 'A claimed job is close to its deadline',
              bodyLines: [
                `<strong>${workerAgent.name}</strong> claimed job #${job.id} ($${job.bounty}) and has not delivered yet.`,
                'If nothing is submitted shortly, the claim is released, the escrow returns to the requester, and the job is recorded as a failed delivery on this agent&rsquo;s record.',
                'A job that is still running only needs to report progress — the deadline measures from the last sign of life, not from the claim.',
              ],
              ctaLabel: 'Open the worker console',
              ctaUrl: absoluteUrl('/worker'),
            })
          }
        } catch (error) {
          console.error(`[stale-claim] deadline warning email for job ${job.id} failed (non-fatal):`, error)
        }

        warned++
        continue
      }

      if (reclaimed >= MAX_PER_PASS) continue

      // Walk the state machine, re-reading status before each transition so a
      // half-finished previous pass resumes rather than repeating a step.
      let status = job.status as string
      if (status === 'Accepted') {
        await submitWork(workerAgent.id, job.id, await abandonedResultHash())
        status = 'Submitted'
      }
      if (status === 'Submitted') {
        await raiseDispute(requesterAgent.id, job.id)
        status = 'Disputed'
      }
      if (status === 'Disputed') {
        await resolveDispute(job.id, false) // refund the requester
        status = 'Refunded'
      }

      // Abandonment is a real, platform-verified failure to deliver — not a
      // self-report — so it lands as a graded negative on the worker's
      // record. Idempotent per job.
      const eventTaskId = `abandoned-${job.id}`
      const existing = await db.select({ id: agentEvent.id }).from(agentEvent).where(eq(agentEvent.taskId, eventTaskId))
      if (existing.length === 0) {
        await db.insert(agentEvent).values({
          id: nanoid(),
          agentId: workerAgent.id,
          taskId: eventTaskId,
          eventType: 'VERIFIED_TASK_FAILED',
          success: false,
          executionTime: 0,
          tokenCost: 0,
          qualityScore: '0.000',
          detail: {
            jobId: job.id,
            reason: 'claim abandoned — no delivery before the deadline',
            bounty: job.bounty,
            requesterAgentId: spec.requesterAgentId,
          },
        })
        const { recalculateCredit } = await import('@/lib/credit-engine')
        await recalculateCredit(workerAgent.id).catch(() => {})
      }

      const { logPlatformEvent } = await import('@/lib/platform-feed')
      await logPlatformEvent(
        'CLAIM_ABANDONED',
        `Job #${job.id} was claimed but never delivered — $${job.bounty} refunded to the requester and the claim recorded as a failed delivery`,
      ).catch(() => {})

      // A refund the requester never hears about is barely better than the
      // freeze: for a bounty that came from a GitHub issue, say so where it
      // was posted, and name the one gesture that retries it.
      if (spec.repoFullName && spec.issueNumber) {
        try {
          const { commentOnPr } = await import('@/lib/github-app')
          await commentOnPr(
            spec.repoFullName,
            spec.issueNumber,
            `↩️ The worker that claimed this bounty never delivered, so the escrow was released back to you — **$${job.bounty} refunded**, nothing was charged for the abandoned attempt.\n\n` +
              `Re-add the \`bounty:$${job.bounty}\` label to put it back on the market for a different worker.`,
          )
        } catch (error) {
          console.error(`[stale-claim] issue comment for job ${job.id} failed (non-fatal):`, error)
        }
      }

      reclaimed++
    } catch (error) {
      console.error(`[stale-claim] reclaiming job ${job.id} failed:`, error)
    }
  }

  return { reclaimed, warned, blocked, examined }
}
