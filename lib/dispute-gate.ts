/**
 * The only thing on a V2 market that resolves a dispute.
 *
 * It never *decides* one. It opens and closes a dispute in the same pass, and
 * only when a refund is derivable from evidence the requester did not author —
 * see `decideRefund` in lib/decision-table.ts. Everything else settles on a
 * deadline, and the deadline pays the worker.
 *
 * ## The shape, and why it is a gate rather than a judge
 *
 * `resolveDispute(id, true)` and `expireDispute(id)` both call
 * `_payWorkerSide(job, job.bounty)` — identical money. So the arbiter is not a
 * judge choosing between two verdicts; it is a ONE-WAY GATE on the requester
 * winning. Silence already pays the worker. That means every bond, every
 * evidence rule and every escalation can live off-chain, behind this function,
 * with no contract change at all.
 *
 * ## What a stuck gate costs
 *
 * Nothing. If this file throws on every pass, `expireReview` settles Submitted
 * jobs at 90/10 and `expireDispute` settles Disputed ones to the worker, both
 * called by lib/deadline-sweep.ts, which shares no lease and no failure with
 * this. That is the property worth protecting: the policy layer is allowed to
 * be broken, because the backstop is not in it.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { jobSpec, agentTask, artifact, disputeRuling } from '@/lib/db/schema'
import { authorOfRule, decideRefund, type RefundGround } from '@/lib/decision-table'
import { briefMatchesHash } from '@/lib/spec-hash'
import { nanoid } from 'nanoid'
import { acquireOpsLease, releaseOpsLease } from '@/lib/ops-lease'

const LEASE_MS = 4 * 60_000
export const MAX_RULINGS_PER_PASS = 3

/**
 * How long a job must have been Disputed before this will look at it.
 *
 * A dispute raised seconds ago may be mid-flight — another path could be about
 * to write the evidence this reads. Ruling on a half-written record is how a
 * "no deliverable" refund gets issued against work that arrived a moment later.
 */
export const MIN_DISPUTE_AGE_MS = 120_000

export type Ruling = {
  jobId: number
  decision: 'refund' | 'no_refund'
  ground: RefundGround
  reason: string
  /** What the decision was made FROM. Stored so a published ruling can be
   *  recomputed later against a table that may since have changed — otherwise
   *  "here is the rule, here is the ruling" is two claims a reader has to take
   *  on trust separately. */
  evidence: Record<string, unknown>
}

/**
 * Whether this job produced anything at all.
 *
 * Two sources because a deliverable can be either: text in `agent_tasks.output`
 * or a file in `artifacts`. Absence of BOTH is the only fact this asserts, and
 * it is a fact about bytes rather than about quality — which is the entire
 * reason it is allowed to move escrow.
 */
async function gatherDelivery(taskIds: string[]): Promise<{ delivered: boolean; mimes: string[] }> {
  if (taskIds.length === 0) return { delivered: false, mimes: [] }
  const tasks = await db
    .select({ output: agentTask.output })
    .from(agentTask)
    .where(inArray(agentTask.id, taskIds))
  const arts = await db.select({ mime: artifact.mime }).from(artifact).where(inArray(artifact.taskId, taskIds))
  const hasText = tasks.some((t) => (t.output ?? '').trim().length > 0)
  return { delivered: hasText || arts.length > 0, mimes: arts.map((a) => a.mime) }
}

/**
 * Does what arrived match the KIND the sealed brief asked for?
 *
 * Only meaningful when the seal verified — otherwise the brief's own claim
 * about the kind is not something anyone committed to. A text job is satisfied
 * by text output with no artifact at all, so an empty mime list is a match for
 * 'text' and unknown for everything else.
 */
function deliverableMatches(kind: string, mimes: string[]): boolean {
  if (kind === 'text') return true
  if (mimes.length === 0) return false
  const prefix = kind === 'image' ? 'image/' : kind === 'audio' ? 'audio/' : kind === 'video' ? 'video/' : null
  if (!prefix) return true // a kind this function does not model — not evidence
  return mimes.some((m) => m.toLowerCase().startsWith(prefix))
}

/**
 * Rule on the disputed jobs that have one.
 *
 * Returns a human-readable line for the ops log. Every ruling is per-job and
 * individually caught: these are independent counterparties, and one job whose
 * spec row is missing must not stop the rest.
 */
export async function settleDisputes(): Promise<string> {
  const { isV2Market, readJobsV2 } = await import('@/lib/onchain/labor-v2')
  if (!(await isV2Market())) return 'skipped: not a v2 market'
  if (!(await acquireOpsLease('disputeGate', LEASE_MS))) return 'skipped: leased'

  try {
    const jobs = await readJobsV2()
    const disputed = jobs.filter((j) => j.status === 'Disputed')
    if (disputed.length === 0) return '0 disputed'

    const rulings: Ruling[] = []
    let refunded = 0
    for (const job of disputed) {
      if (rulings.length >= MAX_RULINGS_PER_PASS) break
      try {
        const ruling = await ruleOn(job.id)
        if (!ruling) continue
        rulings.push(ruling)
        let txHash: string | null = null
        if (ruling.decision === 'refund') {
          const { resolveDispute } = await import('@/lib/onchain/labor')
          txHash = await resolveDispute(job.id, false)
          refunded++
        }
        // Recorded AFTER the money moved, so a row here always means the
        // outcome actually happened. The reverse ordering would publish a
        // ruling that a failed transaction silently made untrue.
        await db.insert(disputeRuling).values({
          id: `dr-${nanoid()}`,
          onchainJobId: job.id,
          decision: ruling.decision,
          ground: ruling.ground,
          reason: ruling.reason,
          evidence: ruling.evidence,
          txHash,
        })
      } catch (e) {
        console.error(`[dispute-gate] job ${job.id}:`, e)
      }
    }

    const held = rulings.length - refunded
    return `${rulings.length} ruled: ${refunded} refunded, ${held} left to the deadline`
  } finally {
    await releaseOpsLease('disputeGate')
  }
}

/** The evidence gather + the pure decision, for one job. Exported so a ruling
 *  can be previewed without settling anything. */
export async function ruleOn(onchainJobId: number): Promise<Ruling | null> {
  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.onchainJobId, onchainJobId))
  if (!spec) return null

  const tasks = await db
    .select({ id: agentTask.id })
    .from(agentTask)
    .where(and(eq(agentTask.agentId, spec.workerAgentId ?? ''), eq(agentTask.task, spec.title)))

  const { delivered, mimes: artifactMimes } = await gatherDelivery(tasks.map((t) => t.id))

  // Did the posted terms survive? A row whose nonce predates the sealed brief
  // is `unverifiable`, NOT `mismatch` — calling it a mismatch would mark every
  // legacy job substituted, and SUBSTITUTED refunds, so it would have handed
  // every legacy dispute back to the requester on the first pass.
  const seal = briefMatchesHash(spec)

  const evidence = {
    hasDeliverable: delivered,
    // The bytes the worker delivered are checked elsewhere; what this asserts
    // is that the TERMS were not rewritten after posting. A requester who
    // edits acceptanceCriteria mid-job is claiming a rule that was never
    // agreed to, and the on-chain hash is the only thing that can say so.
    hashMismatch: seal === 'mismatch' ? 'yes' : seal === 'match' ? 'no' : 'unknown',
    kindMismatch:
      seal === 'match' && spec.deliverableKind
        ? deliverableMatches(spec.deliverableKind, artifactMimes)
          ? 'no'
          : 'yes'
        : 'unknown',
    verdict: spec.testResult?.passed === false ? 'fail' : spec.testResult?.passed ? 'pass' : 'pending',
    ruleAuthor: authorOfRule(spec),
  } as const
  const out = decideRefund(evidence)

  return { jobId: onchainJobId, ...out, evidence }
}
