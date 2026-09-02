/**
 * Owner release of a Submitted job — the requester's own on-chain judgment,
 * callable from any authenticated surface.
 *
 * Until this existed the only lever was the button on /jobs, behind the
 * session cookie. The MCP connector — which posts, escrows, plans and
 * confirms whole delegations for the same account — could not release a
 * single job, so a pipeline that ended in a failed peer review left its
 * owner with no way to overrule the reviewer from the surface they ran the
 * office from. That overrule is the exact trigger the verdict stake
 * (lib/review-stake.ts) waits on: a release of refused work forfeits the
 * reviewer's stake, a refund returns it. A judgment nobody can deliver is
 * not a judgment.
 *
 * Same shape as lib/office-hire.ts: the core takes a userId, the server
 * action supplies it from the session, the MCP handler from the verified
 * token. Ownership is enforced from the chain's requester ADDRESS, never
 * from a passed agent id — duplicate agent names once signed with the wrong
 * wallet (NotRequester revert, in production).
 */
import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

export type ReleaseResult = {
  txHash: string
  jobId: number
  bounty: number
  worker: string
  title: string | null
}

/** Why a release is refused, as text the caller can show verbatim. */
export function releaseRefusal(job: { status: string } | undefined, requesterOwned: boolean): string | null {
  if (!job) return 'Job not found on-chain.'
  if (!requesterOwned) return 'This job was posted by another account — only its requester can release it.'
  if (job.status !== 'Submitted') {
    return job.status === 'Completed'
      ? 'Already released — the escrow has been paid out.'
      : `Job is ${job.status}, not Submitted — there is no delivered work to release.`
  }
  return null
}

export async function releaseJobForUser(userId: string, jobId: number): Promise<ReleaseResult> {
  const { readJobs, approveJob } = await import('@/lib/onchain/labor')
  const jobs = await readJobs({ maxAgeMs: 0 })
  const job = jobs.find((j) => j.id === jobId)

  const [requester] = job
    ? await db
        .select()
        .from(agent)
        .where(sql`lower(${agent.smartAccountAddress}) = ${job.requester.toLowerCase()}`)
    : []
  const owned = Boolean(requester && requester.userId === userId)
  const refusal = releaseRefusal(job, owned)
  if (refusal || !job || !requester) throw new Error(refusal ?? 'Job not found on-chain.')

  const txHash = await approveJob(requester.id, jobId)

  // Bookkeeping on the one path every release shares (credit event unless
  // self-dealt, portfolio mirror, office memory). The action does not read
  // the session — see tests/mcp-handlers-no-server-actions.test.ts.
  const { creditWorkerForJob } = await import('@/app/actions/labor')
  await creditWorkerForJob(job.worker, jobId, job.bounty, txHash)

  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
  if (spec) {
    try {
      const { applySettlementSplit } = await import('@/lib/settlement-split-apply')
      await applySettlementSplit(spec, job.bounty)
    } catch (e) {
      console.error('[job-release] split application failed:', e instanceof Error ? e.message : e)
    }
  }

  return { txHash, jobId, bounty: job.bounty, worker: job.worker, title: spec?.title ?? null }
}
