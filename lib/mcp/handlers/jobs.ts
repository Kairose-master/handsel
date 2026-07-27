/**
 * MCP tools — jobs.
 *
 * The labour market itself: browsing, claiming, delivering, and the proofs that come out of it.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */
import { agent } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { toolText, type McpToolContext } from '../rpc'

export async function handleJobs(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth, origin } = ctx
  switch (name) {
    case 'browse_open_jobs': {
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = (await readJobs().catch(() => [])).filter((j) => j.status === 'Open')
      if (jobs.length === 0) return toolText(id, 'No open jobs right now.')
      const { jobSpec } = await import('@/lib/db/schema')
      const specs = await db.select().from(jobSpec)
      const byHash = new Map(specs.map((s) => [s.specHash, s]))
      const lines = jobs.map((j) => {
        const spec = byHash.get(j.specHash)
        const kind = spec?.deliverableKind && spec.deliverableKind !== 'text' ? ` [${spec.deliverableKind}]` : ''
        return `#${j.id} · $${j.bounty} · ${spec?.title ?? 'Untitled'}${kind} (min score ${j.minScore})`
      })
      return toolText(id, lines.join('\n'))
    }
    case 'get_job': {
      const jobNo = Number(args.job)
      if (!Number.isInteger(jobNo) || jobNo < 0) return toolText(id, 'job must be a job number, e.g. 144.', true)
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs().catch(() => [])
      const job = jobs.find((j) => j.id === jobNo)
      if (!job) return toolText(id, `No job #${jobNo} on the market. Use browse_open_jobs to see what's currently open.`)
      const { jobSpec } = await import('@/lib/db/schema')
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
      const ZERO = '0x0000000000000000000000000000000000000000'
      const kind = spec?.deliverableKind ?? 'text'
      const reqCaps = (spec?.requiredCapabilities ?? []) as string[]
      const trunc = (s: string | null | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? ''))
      const statusHint: Record<string, string> = {
        Open: 'claimable now — claim_job to take it',
        Accepted: 'a worker has accepted it and is working',
        Submitted: 'submitted — awaiting independent grading / settlement',
        Completed: 'done and paid — see get_work_proof for the signed proof',
        Disputed: 'in dispute — being returned to the market for a different worker',
        Refunded: 'refunded to the requester',
        Cancelled: 'cancelled by the requester',
      }
      const lines = [
        `📋 Job #${job.id} — ${spec?.title ?? 'Untitled'}`,
        `status: ${job.status} (${statusHint[job.status] ?? '—'})`,
        `bounty: $${job.bounty} · min credit score: ${job.minScore}`,
        `deliverable: ${kind}${reqCaps.length ? ` · requires [${reqCaps.join(', ')}]` : ''}`,
        `requester: ${job.requester}`,
        job.worker && job.worker.toLowerCase() !== ZERO ? `worker: ${job.worker}` : 'worker: (unclaimed)',
        spec?.testCode ? 'grading: automated acceptance tests (objective)' : 'grading: independent grader',
        spec?.description ? `\ntask:\n${trunc(spec.description, 700)}` : '',
        spec?.acceptanceCriteria ? `\nacceptance criteria:\n${trunc(spec.acceptanceCriteria, 400)}` : '',
        job.status === 'Open' ? '\n→ claim_job to take this for one of your agents.' : '',
      ].filter(Boolean)
      return toolText(id, lines.join('\n'))
    }
    case 'claim_job': {
      const jobId = Number(args.job_id)
      if (!Number.isInteger(jobId) || jobId < 0) return toolText(id, 'job_id must be a job number.', true)
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wanted = args.agent_name ? String(args.agent_name) : null
      // When defaulting, skip the agent that POSTED this job — the
      // contract rejects self-claims (SelfWork), and delegation subtasks
      // are posted by the account's own prime agent.
      let requesterAddr: string | null = null
      if (!wantedId && !wanted) {
        const { readJobs } = await import('@/lib/onchain/labor')
        const jobs = await readJobs().catch(() => [])
        requesterAddr = jobs.find((j) => j.id === jobId)?.requester?.toLowerCase() ?? null
      }
      const worker = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress && a.smartAccountAddress.toLowerCase() !== requesterAddr)
      if (!worker) return toolText(id, wantedId ? `No agent with id "${wantedId}".` : wanted ? `No agent named "${wanted}".` : 'No claimable agent — every provisioned agent either posted this job itself or is missing; create_worker_agent adds one.', true)
      if (!worker.smartAccountAddress) return toolText(id, `Agent ${worker.name} has no wallet yet.`, true)

      const { acceptJobForExternalWorker } = await import('@/lib/labor-dispatch')
      const { taskId, prompt, bounty } = await acceptJobForExternalWorker(worker, jobId)
      return toolText(
        id,
        `Claimed job #${jobId} ($${bounty}) as ${worker.name}. task_id: ${taskId}\n\n` +
          `Now DO this work yourself, in this conversation, then call submit_work with the task_id and your complete result:\n\n${prompt}`,
      )
    }
    case 'submit_work': {
      const taskId = String(args.task_id ?? '')
      const output = String(args.output ?? '')
      if (!taskId || !output.trim()) return toolText(id, 'task_id and a non-empty output are required.', true)

      const { agentTask } = await import('@/lib/db/schema')
      const [task] = await db.select().from(agentTask).where(eq(agentTask.id, taskId))
      if (!task || task.userId !== auth.userId) return toolText(id, 'Task not found on this account.', true)
      if (task.status !== 'running') return toolText(id, `Task is already ${task.status}.`, true)

      // Route through the real callback endpoint — grading, credit events
      // and settlement stay on the single battle-tested path.
      const { resolveCallbackAuth } = await import('@/lib/webhook')
      const cbAuth = await resolveCallbackAuth(task.agentId)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (cbAuth.required) headers['X-Runtime-Secret'] = cbAuth.secret
      const res = await fetch(`${origin}/api/runtime/callback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          task_id: taskId,
          agent_id: task.agentId,
          success: true,
          output,
          artifacts: Array.isArray(args.artifacts) ? args.artifacts : [],
          quality_score: null,
          execution_time: 0,
          token_cost: 0,
          events: [],
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return toolText(id, `Submission failed (${res.status}): ${body.slice(0, 300)}`, true)
      }

      // Read back what grading + settlement decided.
      const { jobSpec } = await import('@/lib/db/schema')
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.agentTaskId, taskId))
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs({ maxAgeMs: 0 }).catch(() => [])
      const job = spec?.onchainJobId != null ? jobs.find((j) => j.id === spec.onchainJobId) : undefined
      const verdict = spec?.testResult
        ? spec.testResult.passed === true
          ? 'Independent grading PASSED.'
          : spec.testResult.passed === false
            ? `Independent grading FAILED: ${spec.testResult.output.slice(0, 300)}`
            : `Grading unavailable — awaiting manual review (${spec.testResult.output.slice(0, 200)})`
        : 'No automatic grading on this job — the requester reviews manually.'
      const settle =
        job?.status === 'Completed'
          ? `Escrow released — $${job.bounty} paid to your agent's wallet. 🎉`
          : job?.status === 'Refunded'
            ? 'Escrow refunded to the requester; the job was reposted for another worker.'
            : `Job status: ${job?.status ?? 'unknown'}.`
      return toolText(id, `Submitted. ${verdict}\n${settle}`)
    }
    case 'my_work': {
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const mine = new Map(agents.map((a) => [a.id, a]))
      const { jobSpec } = await import('@/lib/db/schema')
      const specs = (await db.select().from(jobSpec)).filter((s) => s.workerAgentId && mine.has(s.workerAgentId))
      if (specs.length === 0) return toolText(id, 'No claimed jobs yet — browse_open_jobs → claim_job to start earning.')
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs().catch(() => [])
      const lines = specs.slice(-10).map((s) => {
        const job = s.onchainJobId != null ? jobs.find((j) => j.id === s.onchainJobId) : undefined
        const grade = s.testResult ? (s.testResult.passed === true ? 'passed' : s.testResult.passed === false ? 'FAILED' : 'ungraded') : '—'
        return `#${s.onchainJobId ?? '?'} · ${s.title.slice(0, 50)} · ${job?.status ?? '?'} · grading: ${grade} · agent: ${mine.get(s.workerAgentId!)?.name}`
      })
      return toolText(id, lines.join('\n'))
    }
    case 'market_price': {
      const { observedPrices } = await import('@/lib/market-price-read')
      const { priceHint } = await import('@/lib/market-price')
      const stats = await observedPrices()
      if (stats.length === 0) {
        return toolText(id, 'No jobs have settled on this market yet, so there is no going rate to quote. You would be setting the first price.')
      }
      const lines = stats.map((st) => `• ${st.jobClass} — ${priceHint(st)}`)
      return toolText(
        id,
        `Observed clearing prices (real completed jobs only — unclaimed postings are asking prices, not trades):\n\n${lines.join('\n')}\n\n` +
          'Pricing a job below the median means waiting longer for a worker; a rising-price plan (price_ceiling_usd on post_repo_job) ' +
          'lets the market find the number instead of you guessing it.',
      )
    }
    case 'get_work_proof': {
      const jobNo = Number(args.job_id)
      if (!Number.isInteger(jobNo) || jobNo < 0) return toolText(id, 'job_id must be a job number.', true)
      const { getLatestProofForJob } = await import('@/lib/work-proof-store')
      const stored = await getLatestProofForJob(`#${jobNo}`)
      if (!stored) return toolText(id, `No proof recorded for job #${jobNo} — proofs are issued when a job passes grading and auto-settles.`)
      const { verifyWorkProof } = await import('@/lib/attestation')
      const v = await verifyWorkProof(stored.proof, stored.signature as `0x${string}`, stored.attester as `0x${string}`)
      return toolText(
        id,
        `📜 Proof of Authorship & Grade — job #${jobNo}\n` +
          `kind: ${stored.proof.kind} · grader: ${stored.proof.grader} · verdict: ${stored.proof.verdict}\n` +
          `deliverable fingerprint (keccak256): ${stored.proof.contentHash}\n` +
          `attested by: ${stored.attester} → signature ${v.valid ? 'VALID ✅ (trusted oracle)' : 'INVALID ⚠️'}\n` +
          (stored.cid ? `content id: ipfs://${stored.cid}\n` : '') +
          `certificate: ${origin}/proof/${stored.id}`,
      )
    }
    case 'browse_capabilities': {
      const limit = Math.max(1, Math.min(Number(args.limit ?? 15) || 15, 40))
      const { listClawhubSkills } = await import('@/lib/clawhub')
      const skills = await listClawhubSkills({ limit }).catch(() => [])
      if (skills.length === 0) return toolText(id, 'No capabilities listed right now (directory unavailable or empty).')
      const lines = skills.map((s) => {
        const topics = s.topics?.length ? ` [${s.topics.slice(0, 4).join(', ')}]` : ''
        const stats = s.installs || s.stars ? ` (${s.installs} installs · ${s.stars}★)` : ''
        return `• ${s.name}${topics}${s.summary ? ` — ${s.summary.slice(0, 120)}` : ''}${stats}\n  ${s.url}`
      })
      return toolText(id, `Hireable capabilities (ClawHub):\n${lines.join('\n')}\n\nWire one in as a worker with connect_mcp_worker.`)
    }
    default:
      return null
  }
}
