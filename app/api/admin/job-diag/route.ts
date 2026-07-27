import { db } from '@/lib/db'
import { jobSpec, agentTask, artifact, agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Read-only diagnostic: why is a Submitted job not settling? Dumps the spec's
 * grading-relevant fields, its agent task, and its artifact rows (without the
 * base64 payload) so we can see whether the image/audio deliverable is even
 * linked and gradable. Guarded by CRON_SECRET.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" ".../api/admin/job-diag?job_id=129"
 */
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request, { mutating: false })
  if (!auth.ok) return auth.response
  const url = new URL(request.url)

  // List mode: recent specs (title/kind/onchainJobId/verdict) + open on-chain
  // jobs, to spot linkage gaps (a subtask posted but jobSpec.onchainJobId null).
  if (url.searchParams.get('list')) {
    const { desc } = await import('drizzle-orm')
    const specs = await db
      .select({
        title: jobSpec.title,
        deliverableKind: jobSpec.deliverableKind,
        onchainJobId: jobSpec.onchainJobId,
        agentTaskId: jobSpec.agentTaskId,
        specHash: jobSpec.specHash,
        testResult: jobSpec.testResult,
      })
      .from(jobSpec)
      .orderBy(desc(jobSpec.createdAt))
      .limit(25)
    let openJobs: { id: number; status: string; bounty: number; specHash: string }[] = []
    try {
      const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
      if (isLaborMarketConfigured()) {
        const { readJobs } = await import('@/lib/onchain/labor')
        openJobs = (await readJobs())
          .filter((j) => j.status === 'Open' || j.status === 'Submitted')
          .map((j) => ({ id: j.id, status: j.status, bounty: j.bounty, specHash: j.specHash }))
      }
    } catch { /* ignore */ }
    return Response.json({
      specs: specs.map((s) => ({
        title: s.title,
        kind: s.deliverableKind,
        onchainJobId: s.onchainJobId,
        hasTask: Boolean(s.agentTaskId),
        specHash: s.specHash.slice(0, 12),
        verdict: s.testResult?.passed ?? null,
      })),
      openOrSubmittedJobs: openJobs.map((j) => ({ ...j, specHash: j.specHash.slice(0, 12) })),
    })
  }

  const jobId = Number(url.searchParams.get('job_id'))
  if (!Number.isInteger(jobId)) return Response.json({ error: 'job_id or list required' }, { status: 400 })

  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.onchainJobId, jobId))
  if (!spec) return Response.json({ error: `no spec for onchainJobId ${jobId}` }, { status: 404 })

  const [reqAgent] = spec.requesterAgentId
    ? await db.select().from(agent).where(eq(agent.id, spec.requesterAgentId))
    : []
  const [task] = spec.agentTaskId
    ? await db.select().from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
    : []
  const arts = spec.agentTaskId
    ? await db.select().from(artifact).where(eq(artifact.taskId, spec.agentTaskId))
    : []

  // On-chain status too.
  let onchainStatus: string | null = null
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (isLaborMarketConfigured()) {
      const { readJobs } = await import('@/lib/onchain/labor')
      onchainStatus = (await readJobs()).find((j) => j.id === jobId)?.status ?? null
    }
  } catch { /* ignore */ }

  return Response.json({
    jobId,
    onchainStatus,
    spec: {
      title: spec.title,
      deliverableKind: spec.deliverableKind,
      hasTestCode: Boolean(spec.testCode),
      hasAcceptanceCriteria: Boolean(spec.acceptanceCriteria?.trim()),
      agentTaskId: spec.agentTaskId,
      requesterAgentId: spec.requesterAgentId,
      workerAgentId: spec.workerAgentId,
      autoApprove: spec.autoApprove,
      testResult: spec.testResult, // { passed, output, gradedAt } or null
    },
    requesterOwner: reqAgent ? { agentName: reqAgent.name, userId: reqAgent.userId } : null,
    task: task
      ? { id: task.id, status: task.status, hasOutput: Boolean(task.output), outputLen: (task.output ?? '').length }
      : null,
    artifacts: arts.map((a) => ({
      id: a.id,
      mime: a.mime,
      name: a.name,
      hasBase64: Boolean(a.dataBase64),
      url: a.url,
      urlHost: a.url ? (() => { try { return new URL(a.url!).host } catch { return 'invalid' } })() : null,
      size: a.size,
    })),
  })
}

export const GET = handle
export const POST = handle
