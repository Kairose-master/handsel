/**
 * GET /api/build/<id> — docs/build-service.md increment 3: the read side.
 *
 * The POST response was the only place a caller learned a build's outcome;
 * this is where the outcome is read BACK — the manifest, assembled fresh on
 * every read from what actually happened: the build_runs row (envelope
 * accounting), the job spec it posted, the job's CURRENT on-chain status,
 * and the signed work proof if one was issued. Nothing is stored that the
 * chain and the proof store don't already hold — a manifest that cached its
 * own verdicts could disagree with the escrow it describes.
 *
 * v1 shape: one build = one repo job = one manifest line
 * (`manifestLineForRepoJob`, pure, tested). The raw on-chain status rides
 * next to the manifest because 'Expired' must not be collapsed into an
 * ordinary refund — see lib/onchain/labor.ts on why that state exists.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { getSession } from '@/lib/get-session'
import { agent, buildRun, jobSpec } from '@/lib/db/schema'
import { buildManifest, renderManifestSummary } from '@/lib/build-manifest'
import { manifestLineForRepoJob } from '@/lib/repo-build'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session?.user) return Response.json({ error: 'Not signed in' }, { status: 401 })

  const { id } = await params
  const { ensureBuildRunTable } = await import('@/lib/db/ensure-columns')
  await ensureBuildRunTable()
  const [run] = await db.select().from(buildRun).where(eq(buildRun.id, id))
  if (!run) return Response.json({ error: 'No such build' }, { status: 404 })

  // Same ownership rule as POST: a build's money trail is visible to the
  // account whose agent spent the money, not to whoever guesses an id.
  const [owner] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, run.requesterAgentId), eq(agent.userId, session.user.id)))
  if (!owner) return Response.json({ error: 'No such build' }, { status: 404 }) // 404, not 403 — don't confirm the id exists

  // A build that never posted has no job to read — its manifest is one
  // refunded line and the run's recorded reason.
  if (run.status !== 'posted' || !run.specHash) {
    const line = manifestLineForRepoJob({
      buildId: run.id,
      goal: run.goal,
      bountyUsd: Number(run.bountyUsd ?? 0),
      jobStatus: 'Cancelled',
      proofId: null,
    })
    const manifest = buildManifest({
      buildId: run.id,
      goal: run.goal,
      budgetBaseUnits: run.budgetBaseUnits,
      closed: true, // a failed build cannot draw again — it ended at POST time
      refundedBaseUnits: run.refundedBaseUnits,
      lines: [line],
    })
    return Response.json({
      buildId: run.id,
      status: 'failed',
      reason: run.reason,
      repoFullName: run.repoFullName,
      manifest,
      summary: renderManifestSummary(manifest),
    })
  }

  const [spec] = await db
    .select({
      onchainJobId: jobSpec.onchainJobId,
      title: jobSpec.title,
      workerAgentId: jobSpec.workerAgentId,
    })
    .from(jobSpec)
    .where(eq(jobSpec.specHash, run.specHash))

  // The job's CURRENT on-chain status — the authority on where the money is.
  let jobStatus: string | null = null
  try {
    if (spec?.onchainJobId != null) {
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs()
      jobStatus = jobs.find((j) => j.id === spec.onchainJobId)?.status ?? null
    }
  } catch {
    // Unreadable chain ≠ a verdict. jobStatus stays null → the line reads
    // 'pending', which is the only honest claim available right now.
  }

  let proofId: string | null = null
  if (jobStatus === 'Completed' && spec?.onchainJobId != null) {
    const { getLatestProofForJob } = await import('@/lib/work-proof-store')
    proofId = (await getLatestProofForJob(`#${spec.onchainJobId}`))?.id ?? null
  }

  const line = manifestLineForRepoJob({
    buildId: run.id,
    goal: run.goal,
    bountyUsd: Number(run.bountyUsd ?? 0),
    jobStatus,
    proofId,
  })
  const manifest = buildManifest({
    buildId: run.id,
    goal: run.goal,
    budgetBaseUnits: run.budgetBaseUnits,
    // The build is over exactly when its one job left the in-flight states.
    closed: line.verdict !== 'pending',
    refundedBaseUnits: run.refundedBaseUnits,
    lines: [line],
  })

  return Response.json({
    buildId: run.id,
    status: manifest.status,
    repoFullName: run.repoFullName,
    job: {
      onchainJobId: spec?.onchainJobId ?? null,
      // Raw, next to the manifest, on purpose: 'Expired' (deadline settled,
      // nobody judged) must stay distinguishable from an ordinary refund.
      status: jobStatus,
      workerAgentId: spec?.workerAgentId ?? null,
    },
    ...(proofId ? { proofUrl: `/api/proof/${proofId}` } : {}),
    manifest,
    summary: renderManifestSummary(manifest),
  })
}
