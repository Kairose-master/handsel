'use server'

import { headers } from 'next/headers'
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { SAFE_JOB_SPEC_COLUMNS } from '@/lib/db/safe-select'
import { agent, agentEvent, agentTask, jobSpec, user } from '@/lib/db/schema'
import { recalculateCredit } from '@/lib/credit-engine'
import { and, eq, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { nanoid } from 'nanoid'
import { asActionError } from '@/lib/action-error'
import { gradeForDisplay } from '@/lib/job-grade'
import { logPlatformEvent } from '@/lib/platform-feed'
import { runAgentTask, reapStuckTasks } from '@/lib/agent-tasks'
import { requirePermission } from '@/lib/admin'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

async function requireOwnedAgent(agentId: string, userId: string) {
  const [found] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!found || found.userId !== userId) throw new Error('Agent not found')
  return found
}

/** Resolve the agent id that can actually sign requester-only calls for a
 *  job: the one whose smart account IS the job's on-chain requester. Falls
 *  back to the UI-passed id only if the address doesn't map to any agent
 *  (shouldn't happen for `mine` jobs). Ownership is enforced either way. */
async function requesterAgentForJob(requesterAddress: string, fallbackAgentId: string, userId: string) {
  const { sql } = await import('drizzle-orm')
  const [byAddr] = await db
    .select()
    .from(agent)
    .where(sql`lower(${agent.smartAccountAddress}) = ${requesterAddress.toLowerCase()}`)
  if (!byAddr) return fallbackAgentId
  if (byAddr.userId !== userId) throw new Error('This job belongs to another account')
  return byAddr.id
}

async function callbackUrl() {
  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host')
  return `${proto}://${host}/api/runtime/callback`
}

/** Jobs enriched with off-chain title/description/criteria, agent names, and
 *  (once submitted) the worker agent's real output. */
export async function getJobs() {
  await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()

  const userId = await requireUser()
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) {
    return { configured: false, jobs: [], myAgents: [] as { id: string; name: string; provisioned: boolean }[] }
  }

  const { readJobs } = await import('@/lib/onchain/labor')
  const onchainJobs = await readJobs().catch(() => [])

  await reapStuckTasks()
  const { tickCloudAutoMineAgents } = await import('@/lib/auto-mine')
  await tickCloudAutoMineAgents(await callbackUrl())
  // Re-drive any settlement that died mid-flight on a transient RPC
  // failure — AFTER the response: a re-driven settlement is multiple
  // on-chain txs and must never hold the jobs list hostage.
  {
    const { after } = await import('next/server')
    after(async () => {
      const { sweepStuckGradedJobs } = await import('@/lib/labor-settle')
      await sweepStuckGradedJobs().catch((e) => console.error('[jobs] settle sweep failed:', e))
      const { sweepPriceRaises } = await import('@/lib/price-raise')
      await sweepPriceRaises().catch((e) => console.error('[jobs] price-raise sweep failed:', e))
      // Refill starter jobs while someone is actually looking at the
      // market — an empty jobs page is exactly what the faucet prevents.
      // Internally throttled to one real tick per 10 minutes.
      const { tickJobFaucet } = await import('@/lib/job-faucet')
      await tickJobFaucet().catch((e) => console.error('[jobs] faucet tick failed:', e))
    })
  }

  const specs = await db.select(SAFE_JOB_SPEC_COLUMNS).from(jobSpec)
  const specByHash = new Map(specs.map((s) => [s.specHash, s]))

  // The `taskIds.length > 0 ?` guard read like a scoped lookup, but the query
  // behind it had no WHERE clause: every agent_tasks row, every column, on
  // every load of this page — including the prompt and output text of every
  // run the platform has ever done. Ask for the three fields the cards render,
  // for the tasks actually referenced.
  const taskIds = [...new Set(specs.map((s) => s.agentTaskId).filter((id): id is string => Boolean(id)))]
  const tasks = taskIds.length > 0
    ? await db
        .select({ id: agentTask.id, status: agentTask.status, output: agentTask.output, error: agentTask.error })
        .from(agentTask)
        .where(inArray(agentTask.id, taskIds))
    : []
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  const agents = await db.select().from(agent).where(eq(agent.userId, userId))
  const byAddress = new Map(
    agents
      .filter((a) => a.smartAccountAddress)
      .map((a) => [a.smartAccountAddress!.toLowerCase(), a]),
  )
  const label = (addr: string) => {
    if (!addr || /^0x0+$/.test(addr)) return null
    const a = byAddress.get(addr.toLowerCase())
    return a ? a.name : `${addr.slice(0, 6)}…${addr.slice(-4)}`
  }

  // Binary deliverables attached to submissions — id/name/mime only (the
  // bytes stream from /api/artifacts/:id on demand).
  const { artifact } = await import('@/lib/db/schema')
  let artifactRows: { id: string; taskId: string; name: string; mime: string }[] = []
  try {
    if (taskIds.length > 0) {
      artifactRows = await db
        .select({ id: artifact.id, taskId: artifact.taskId, name: artifact.name, mime: artifact.mime })
        .from(artifact)
        .where(inArray(artifact.taskId, taskIds))
    }
  } catch { /* table missing until migration runs */ }
  const artifactsByTask = new Map<string, { id: string; name: string; mime: string }[]>()
  for (const a of artifactRows) {
    const list = artifactsByTask.get(a.taskId) ?? []
    list.push({ id: a.id, name: a.name, mime: a.mime })
    artifactsByTask.set(a.taskId, list)
  }

  const jobs = onchainJobs.map((j) => {
    const spec = specByHash.get(j.specHash)
    const task = spec?.agentTaskId ? taskById.get(spec.agentTaskId) : undefined
    return {
      ...j,
      title: spec?.title ?? 'Untitled job',
      description: spec?.description ?? null,
      acceptanceCriteria: spec?.acceptanceCriteria ?? null,
      requesterName: label(j.requester),
      workerName: label(j.worker),
      mine: byAddress.has(j.requester.toLowerCase()),
      workerRunStatus: task?.status ?? null, // running | processing | completed | failed
      workerRunError: task?.status === 'failed' ? task.error : null,
      agentTaskId: spec?.agentTaskId ?? null,
      output: task?.status === 'completed' ? task.output : null,
      disputeNote: spec?.disputeNote ?? null,
      attachmentUrl: spec?.attachmentUrl ?? null,
      attachmentName: spec?.attachmentName ?? null,
      hasTests: Boolean(spec?.testCode),
      // A grade describes a SUBMISSION. Grading runs even when `submitWork`
      // failed to land (see lib/job-grade.ts), so the stored verdict can be
      // about an output the chain never received — which is how mainnet job #3
      // showed a red FAILED while sitting Accepted with resultHash zero.
      testResult: gradeForDisplay(j.resultHash, spec?.testResult),
      deliverableKind: spec?.deliverableKind ?? 'text',
      requiredCapabilities: spec?.requiredCapabilities ?? [],
      artifacts: spec?.agentTaskId ? (artifactsByTask.get(spec.agentTaskId) ?? []) : [],
    }
  })

  return {
    configured: true,
    jobs,
    myAgents: agents.map((a) => ({ id: a.id, name: a.name, provisioned: Boolean(a.smartAccountAddress) })),
  }
}

/** Post a job: store the spec off-chain, escrow the bounty on-chain. */
export async function postJobAction(input: {
  requesterAgentId: string
  title: string
  description: string
  acceptanceCriteria: string
  bountyUsd: number
  minScore: number
  attachmentUrl?: string
  attachmentName?: string
  /** Optional Python asserts — makes this an auto-graded code job: the
   *  worker's submitted code block is run against these on the platform
   *  runtime (grader ≠ solver) and the result recorded as evidence. */
  testCode?: string
  /** What the worker must deliver: text (default) | image | audio |
   *  video | file. Non-text jobs only match workers declaring the
   *  capability; image is vision-graded, audio/video/file are manual
   *  review (plus Python tests when provided). */
  deliverableKind?: string
  /** Tool capabilities the worker must declare: 'web' | 'code' | 'gpu'. */
  requiredCapabilities?: string[]
  /** How long the worker has to deliver, in seconds. The contract bounds it to
   *  [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW] and the server clamps into that
   *  range, so an out-of-range value is corrected rather than rejected. Omitted
   *  → the 4h default (DEFAULT_DELIVERY_WINDOW_S), deliberately near the floor so
   *  a normal job does not strand escrow for weeks. A long window is a real
   *  requester choice (a big deliverable — or a deliberately long-lived escrow). */
  deliveryWindowSec?: number
  /** Only meaningful alongside testCode: release escrow the instant the
   *  platform grader reports a pass, with no separate "Approve & pay"
   *  click. This is the requester's own explicit choice, made right now
   *  in this authenticated call — NOT inferred later from testCode's mere
   *  presence — because it's the actual authorization the automatic
   *  release in autoApprovePassedJob checks before moving funds. Defaults
   *  true (matches a bot/house requester that never comes back to click
   *  approve); a real human posting a job can opt out and keep manual
   *  review even on a passing verdict. */
  autoApprove?: boolean
}) {
  // The WRITE path needs this as much as the reads do, and it did not have it.
  // Six read paths called ensureJobSpecColumns and no write path did, which is
  // backwards: drizzle names every declared column in the INSERT it builds, so
  // one column missing from the database fails the insert outright rather than
  // degrading a feature. And in serverless each invocation is its own process
  // with its own memoized ensure, so rendering the page never covered posting
  // from it.
  await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()

  // The mainnet guard, on the first path that locks escrow.
  //
  // `lib/onchain/mainnet-guard.ts` implements eight blockers, is unit-tested, and
  // docs/mainnet-deploy.md describes it as something that REFUSES — and it had no
  // caller. On a real chain it would have blocked none of them. This is the
  // wiring, and posting is the right place: it is where money first becomes hard
  // to recover, and it runs before the DB insert so a refusal leaves nothing
  // behind.
  //
  // A no-op on a testnet — realMoneyBlockers returns [] when isRealMoney is false.
  await (await import('@/lib/onchain/real-money')).assertRealMoneyReady('Posting a job')

  const userId = await requireUser()
  const ag = await requireOwnedAgent(input.requesterAgentId, userId)
  if (!ag.smartAccountAddress) throw new Error('Provision the requester agent first')
  if (!input.title.trim()) throw new Error('Title required')
  if (input.acceptanceCriteria.trim().length < 10) {
    throw new Error('Acceptance criteria must be specific enough to grade (10+ characters)')
  }
  if (!Number.isFinite(input.bountyUsd) || input.bountyUsd <= 0) throw new Error('Bounty must be positive')

  try {
    const { keccak256, toHex } = await import('viem')
    const payload = JSON.stringify({
      title: input.title,
      description: input.description,
      agent: input.requesterAgentId,
      nonce: nanoid(),
    })
    const specHash = keccak256(toHex(payload))

    await db.insert(jobSpec).values({
      specHash,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      requesterAgentId: input.requesterAgentId,
      attachmentUrl: input.attachmentUrl || null,
      attachmentName: input.attachmentName || null,
      testCode: input.testCode?.trim() || null,
      autoApprove: input.autoApprove ?? true,
      deliverableKind: (await import('@/lib/artifacts')).normalizeDeliverableKind(input.deliverableKind),
      requiredCapabilities: Array.isArray(input.requiredCapabilities)
        ? input.requiredCapabilities.filter((c) => ['web', 'code', 'gpu'].includes(c))
        : [],
    })

    // Posting fee before escrow (lib/platform-fee.ts): wash trading must
    // cost something, and "can't afford bounty + fee" should surface here.
    const { collectPostingFee } = await import('@/lib/platform-fee')
    await collectPostingFee(input.requesterAgentId, input.bountyUsd, `"${input.title}"`)

    const { postJob } = await import('@/lib/onchain/labor')
    const txHash = await postJob(
      input.requesterAgentId,
      input.bountyUsd,
      Math.round(input.minScore),
      specHash,
      input.deliveryWindowSec,
    )

    await logPlatformEvent('JOB_POSTED', `${ag.name} posted "${input.title}" — $${input.bountyUsd.toLocaleString()} bounty`)
    revalidatePath('/jobs')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'postJobAction')
  }
}

/**
 * Accept a job AND actually do it: the worker agent's real runtime (platform
 * Claude runtime or the owner's BYO webhook) is dispatched with the job's
 * title/description/acceptance criteria as its task. The real output is
 * submitted on-chain automatically when the run completes (see
 * settleLaborMarketJob in /api/runtime/callback) — no placeholder text.
 */
export async function acceptJobAction(workerAgentId: string, jobId: number) {
  const userId = await requireUser()
  const worker = await requireOwnedAgent(workerAgentId, userId)
  if (!worker.smartAccountAddress) throw new Error('Provision the worker agent first')

  try {
    const { acceptAndDispatchJob } = await import('@/lib/labor-dispatch')
    const { txHash } = await acceptAndDispatchJob(worker, jobId, await callbackUrl())

    revalidatePath('/jobs')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'acceptJobAction')
  }
}

/**
 * Approve delivered work: release the escrow on-chain, then record a
 * JOB_COMPLETED reputation event for the worker and recalculate its credit —
 * closing the loop from paid labor back into creditworthiness.
 */
export async function approveJobAction(requesterAgentId: string, jobId: number) {
  const userId = await requireUser()
  await requireOwnedAgent(requesterAgentId, userId)

  try {
    const { readJobs, approveJob } = await import('@/lib/onchain/labor')
    const jobs = await readJobs()
    const job = jobs.find((j) => j.id === jobId)
    if (!job) throw new Error('Job not found on-chain')

    // The contract only accepts approveJob from the job's own requester
    // account. Resolve that agent by ADDRESS — the passed id came from a
    // name-based UI lookup once, and duplicate agent names made it sign
    // with the wrong wallet (NotRequester revert, seen in production).
    const signer = await requesterAgentForJob(job.requester, requesterAgentId, userId)

    const txHash = await approveJob(signer, jobId)
    await creditWorkerForJob(job.worker, jobId, job.bounty, txHash)

    // Multi-party split (docs/physical-operatorship.md inc. 3) — same
    // best-effort application as the auto-approve path, so a manually
    // approved job honors its split table too.
    try {
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
      if (spec) {
        const { applySettlementSplit } = await import('@/lib/settlement-split-apply')
        await applySettlementSplit(spec, job.bounty)
      }
    } catch (e) {
      console.error('[approveJobAction] split application failed:', e instanceof Error ? e.message : e)
    }

    revalidatePath('/jobs')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'approveJobAction')
  }
}

/** Requester disputes a submission instead of approving it — locks the
 *  escrow until an independent admin reviews and resolves it. */
export async function raiseDisputeAction(requesterAgentId: string, jobId: number, note: string) {
  const userId = await requireUser()
  await requireOwnedAgent(requesterAgentId, userId)
  if (!note.trim()) throw new Error('Explain what is wrong with the submission')

  try {
    const { raiseDispute, readJobs } = await import('@/lib/onchain/labor')
    const jobs = await readJobs()
    const job = jobs.find((j) => j.id === jobId)
    if (!job) throw new Error('Job not found on-chain')
    const signer = await requesterAgentForJob(job.requester, requesterAgentId, userId)

    const txHash = await raiseDispute(signer, jobId)

    if (job) {
      await db.update(jobSpec).set({ disputeNote: note.trim() }).where(eq(jobSpec.specHash, job.specHash))
    }

    await logPlatformEvent('JOB_DISPUTED', `Job #${jobId} disputed — awaiting independent review`)
    revalidatePath('/jobs')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'raiseDisputeAction')
  }
}

/** Admin-only: every Disputed job, with the original requirements and the
 *  worker's actual submitted output side by side. */
export async function getDisputedJobs() {
  await requirePermission('disputes')

  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs()
  const disputed = jobs.filter((j) => j.status === 'Disputed')

  if (disputed.length === 0) return []

  // Disputes are a handful; read a handful. (Was: the whole job_specs table
  // and the whole agent_tasks table, to render two or three rows.)
  const disputedHashes = [...new Set(disputed.flatMap((j) => [j.specHash, j.specHash.toLowerCase()]))]
  const specs = await db.select(SAFE_JOB_SPEC_COLUMNS).from(jobSpec).where(inArray(jobSpec.specHash, disputedHashes))
  const specByHash = new Map(specs.map((s) => [s.specHash.toLowerCase(), s]))
  const taskIds = [...new Set(specs.map((s) => s.agentTaskId).filter((id): id is string => Boolean(id)))]
  const tasks = taskIds.length > 0
    ? await db.select({ id: agentTask.id, output: agentTask.output }).from(agentTask).where(inArray(agentTask.id, taskIds))
    : []
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  return disputed.map((j) => {
    const spec = specByHash.get(j.specHash.toLowerCase())
    const task = spec?.agentTaskId ? taskById.get(spec.agentTaskId) : undefined
    return {
      id: j.id,
      title: spec?.title ?? 'Untitled job',
      description: spec?.description ?? null,
      acceptanceCriteria: spec?.acceptanceCriteria ?? null,
      disputeNote: spec?.disputeNote ?? null,
      attachmentUrl: spec?.attachmentUrl ?? null,
      attachmentName: spec?.attachmentName ?? null,
      testCode: spec?.testCode ?? null,
      testResult: spec?.testResult ?? null,
      bounty: j.bounty,
      requester: j.requester,
      worker: j.worker,
      output: task?.output ?? null,
    }
  })
}

/** Admin-only: force-settle a disputed job — releaseToWorker=true pays the
 *  worker (and credits its reputation same as a normal approval); false
 *  refunds the requester. */
export async function resolveDisputeAction(jobId: number, releaseToWorker: boolean) {
  await requirePermission('disputes')

  try {
    const { resolveDispute, readJobs } = await import('@/lib/onchain/labor')
    const txHash = await resolveDispute(jobId, releaseToWorker)

    if (releaseToWorker) {
      const jobs = await readJobs()
      const job = jobs.find((j) => j.id === jobId)
      if (job) await creditWorkerForJob(job.worker, jobId, job.bounty, txHash)
    }

    await logPlatformEvent(
      'JOB_DISPUTE_RESOLVED',
      `Job #${jobId} dispute resolved — ${releaseToWorker ? 'paid to worker' : 'refunded to requester'}`,
    )
    revalidatePath('/jobs')
    return { txHash }
  } catch (error) {
    throw asActionError(error, 'resolveDisputeAction')
  }
}

/**
 * Shared by approveJobAction, a worker-favoring dispute resolution, and the
 * auto-approve path for auto-graded jobs (see settleLaborMarketJob in
 * /api/runtime/callback): map the worker's on-chain address back to our
 * agent row, record the reputation event, and recalculate credit.
 *
 * Exported only so /api/runtime/callback can reach it via a server-side
 * dynamic import — it has no internal auth check of its own (every current
 * caller gates ownership/permission before calling it), and it is not
 * referenced by any client component. Do not import this from a
 * 'use client' file or a form action; if a future caller needs to, add an
 * explicit authorization check here first.
 */
export async function creditWorkerForJob(workerAddress: string, jobId: number, bounty: number, txHash: string) {
  // Case-insensitive, and it matters more here than anywhere: the payout has
  // ALREADY happened by the time this runs, so a lookup that misses means a
  // worker was paid with no credit event — docs/failure-modes.md §8, from the
  // other direction. The error below used to read like a deleted agent; it may
  // only ever have been a checksummed address compared exactly.
  const { agentByAddress } = await import('@/lib/agent-by-address')
  const workerLookup = await agentByAddress(workerAddress)
  if (!workerLookup.found) {
    console.error(
      `[labor] creditWorkerForJob: no agent for worker address ${workerAddress} (job ${jobId}, reason: ${workerLookup.reason}) — ` +
        'payout succeeded on-chain but no credit event was recorded',
    )
    return
  }
  const workerAgent = workerLookup.agent

  // Idempotent on the job. Five call sites can observe the same completed
  // job — the settlement sweep, a delegation tick, the two approve paths —
  // and one of them is wrapped in retry(), so a partial failure (event
  // written, recalculateCredit throws) used to re-enter here and write a
  // SECOND completion. That inflates the worker's public earnings and job
  // count and lifts their score for work done once, which is precisely the
  // kind of unearned number this platform exists to not have.
  //
  // The SELECT closes the SEQUENTIAL case (a retry, a later reconciliation).
  // It cannot close the concurrent one: check-then-insert is two statements,
  // and two lambdas can both find nothing. The partial unique index below is
  // what actually decides that race; see lib/db/completion-index.ts.
  const { ensureCompletionUniqueIndex } = await import('@/lib/db/completion-index')
  const indexed = await ensureCompletionUniqueIndex()

  const eventTaskId = `job-${jobId}`
  const already = await db
    .select({ id: agentEvent.id })
    .from(agentEvent)
    .where(and(eq(agentEvent.taskId, eventTaskId), eq(agentEvent.eventType, 'JOB_COMPLETED')))
  if (already.length > 0) return

  // Counterparty identity rides on the event so the scoring engine can
  // apply the collusion discount (repeat requester → diminishing weight)
  // without a join at score time.
  const [specRow] = await db.select({ requesterAgentId: jobSpec.requesterAgentId }).from(jobSpec).where(eq(jobSpec.onchainJobId, jobId))
  const [requesterRow] = specRow?.requesterAgentId
    ? await db.select({ creditScore: agent.creditScore }).from(agent).where(eq(agent.id, specRow.requesterAgentId))
    : []
  const written = await db.insert(agentEvent).values({
    id: nanoid(),
    agentId: workerAgent.id,
    taskId: eventTaskId,
    eventType: 'JOB_COMPLETED',
    success: true,
    executionTime: 0,
    tokenCost: 0,
    qualityScore: '1.000',
    detail: {
      jobId,
      bounty,
      txHash,
      onchain: true,
      requesterAgentId: specRow?.requesterAgentId ?? null,
      // Stamped at event time so later score changes can't rewrite history:
      // reputation earned from a fresh score-300 account keeps its floor
      // weight even if that account later climbs.
      requesterScore: requesterRow ? Number(requesterRow.creditScore) : null,
    },
  })
    .onConflictDoNothing()
    .returning({ id: agentEvent.id })

  // Lost the race: the other caller is crediting this job right now, and
  // everything after this point (score recalculation, feed entry, payout
  // email) is theirs to do exactly once.
  if (indexed && written.length === 0) {
    console.warn(`[labor] job ${jobId} was credited concurrently — this caller stands down`)
    return
  }

  await recalculateCredit(workerAgent.id)
  await logPlatformEvent('JOB_COMPLETED', `${workerAgent.name} completed job #${jobId} — $${bounty.toLocaleString()}`)

  // "You got paid" — the one moment a worker's owner always wants to hear
  // about. Best-effort: mail must never touch settlement.
  try {
    const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, workerAgent.userId))
    if (owner?.email) {
      const { sendPayoutEmail } = await import('@/lib/email')
      await sendPayoutEmail({ to: owner.email, agentId: workerAgent.id, agentName: workerAgent.name, bountyUsd: bounty, jobId })
    }
  } catch (error) {
    console.error('[labor] payout email failed (non-fatal):', error)
  }

  // Governance: reward the worker's owner with $LEDGER — voting weight is
  // earned from real completed work, never bought. Best-effort.
  const { earnLedger, LEDGER_PER_COMPLETED_JOB } = await import('@/lib/governance')
  await earnLedger(workerAgent.userId, LEDGER_PER_COMPLETED_JOB)
}
