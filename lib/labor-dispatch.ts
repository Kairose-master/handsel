/**
 * Shared accept-and-dispatch for Labor Market jobs — one code path used by
 * BOTH the human-clicked accept (acceptJobAction) and auto-mine's
 * poll-driven accept, so prompt construction / failed-worker blocking /
 * dispatch bookkeeping can't drift between them.
 */
import { db } from '@/lib/db'
import { jobSpec, agent as agentTable } from '@/lib/db/schema'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { runAgentTask } from '@/lib/agent-tasks'
import { fenceUntrusted, untrustedNonce, workerBriefClause } from '@/lib/untrusted-input'
import { reservedAgentFor } from '@/lib/job-reservation'

type AgentRow = typeof agentTable.$inferSelect
type SpecRow = typeof jobSpec.$inferSelect

/** How long an off-chain claim holds before it's considered abandoned.
 *  Long enough to cover an on-chain accept + dispatch (~30–60s on
 *  Sepolia); short enough that a crashed claimer releases the job fast. */
export const JOB_CLAIM_TTL_MS = 90_000

/** Mining-pool-style work-unit claim: atomically take the spec for this
 *  worker BEFORE touching the chain. Exactly one concurrent claimer wins
 *  (single UPDATE ... WHERE unclaimed-or-stale RETURNING); everyone else
 *  learns in milliseconds instead of racing to an on-chain revert. */
export async function claimJobSpec(specHash: string, agentId: string): Promise<boolean> {
  // An office template's own pipeline step (lib/job-reservation.ts) is
  // reserved for one specific hired agent — every dispatch path funds a
  // claim through here, so this is the one place that reservation is real.
  const reservedFor = await reservedAgentFor(specHash)
  if (reservedFor && reservedFor !== agentId) return false

  const staleBefore = new Date(Date.now() - JOB_CLAIM_TTL_MS)
  const won = await db
    .update(jobSpec)
    .set({ claimedByAgentId: agentId, claimedAt: new Date() })
    .where(
      and(
        eq(jobSpec.specHash, specHash),
        or(
          isNull(jobSpec.claimedByAgentId),
          eq(jobSpec.claimedByAgentId, agentId), // re-entrant for the same worker
          lt(jobSpec.claimedAt, staleBefore),
        ),
      ),
    )
    .returning({ specHash: jobSpec.specHash })
  return won.length > 0
}

async function releaseJobClaim(specHash: string, agentId: string): Promise<void> {
  await db
    .update(jobSpec)
    .set({ claimedByAgentId: null, claimedAt: null })
    .where(and(eq(jobSpec.specHash, specHash), eq(jobSpec.claimedByAgentId, agentId)))
}

/** The Labor Market contract reverts SelfWork() when an agent accepts a
 *  job it posted itself — catch it API-side with an actionable message
 *  instead of burning gas on a guaranteed revert. (Delegation subtasks
 *  are posted by the prime agent, so claiming one with that same prime
 *  is the common way to hit this.) */
export function assertNotSelfClaim(worker: AgentRow, requesterAddress: string | undefined): void {
  if (
    requesterAddress &&
    worker.smartAccountAddress &&
    requesterAddress.toLowerCase() === worker.smartAccountAddress.toLowerCase()
  ) {
    throw new Error(
      `${worker.name} posted this job itself (it's the escrowing requester) — an agent can't claim its own job.`,
    )
  }
}

/**
 * Block self-DEALING, not just self-claiming: an agent claiming a job
 * posted by ANOTHER agent on the SAME account. The contract only reverts
 * on identical addresses (SelfWork), but same-owner claims are a credit-
 * farming vector — money loops A1→A2 within one owner's control (minus
 * sponsored gas) while A2 banks a JOB_COMPLETED credit event for free.
 * Allowing it would make credit scores meaningless, so we reject it
 * API-side with a clear message before any gas is spent. Cross-account
 * work (the real market, the faucet, delegation to other users) is
 * unaffected. Async because it resolves the requester's owner from the
 * on-chain address.
 */
export async function assertNotSelfDeal(
  worker: AgentRow,
  requesterAddress: string | undefined,
  /** The job's spec hash, when the caller has it. An office's own reserved
   *  job is the one same-owner case that is allowed through — see below. */
  specHash?: string,
): Promise<void> {
  assertNotSelfClaim(worker, requesterAddress)
  if (!requesterAddress) return
  const { sql } = await import('drizzle-orm')
  const [requesterAgent] = await db
    .select({ userId: agentTable.userId, name: agentTable.name })
    .from(agentTable)
    .where(sql`lower(${agentTable.smartAccountAddress}) = ${requesterAddress.toLowerCase()}`)
  if (!requesterAgent || requesterAgent.userId !== worker.userId) return

  // An office is same-owner by construction: you hire the roles onto your own
  // account and your own prime pays them. Enforced without an exception, this
  // guard made every office template unusable — six of them shipped and not
  // one could complete a job.
  //
  // The exception is narrow on purpose: only a job RESERVED for this exact
  // worker (lib/job-reservation.ts, set from the pipeline step's own role) is
  // let through. A same-owner agent claiming some other same-owner job is
  // still refused.
  //
  // This does not reopen credit farming, because the farm was never the work
  // — it was the free JOB_COMPLETED event at the end of it. That is closed at
  // the other end instead: creditWorkerForJob writes no credit event when
  // requester and worker share an owner, whatever route the job took. The
  // money still loops within one owner and still loses the fee, so there is
  // nothing left to farm.
  // assignedAgentFor, not reservedAgentFor: the TTL governs claim PRIORITY
  // over the open market, which must expire. Whether this job is this office's
  // own work does not expire, and gating the exception on the TTL locked a
  // desk out of its own escrowed jobs the moment a deploy or a grading pass
  // ran past thirty minutes.
  if (specHash) {
    const { assignedAgentFor } = await import('@/lib/job-reservation')
    if ((await assignedAgentFor(specHash)) === worker.id) return
  }

  throw new Error(
    `This job was posted by "${requesterAgent.name}" on your own account — you can't grade and pay yourself (it would farm credit). Use a separate account to work it, or leave it for the market.`,
  )
}

/** True when someone else holds a live (non-stale) claim on this spec. */
export function isClaimedByOther(spec: SpecRow, agentId: string): boolean {
  return Boolean(
    spec.claimedByAgentId &&
      spec.claimedByAgentId !== agentId &&
      spec.claimedAt &&
      Date.now() - spec.claimedAt.getTime() < JOB_CLAIM_TTL_MS,
  )
}

/**
 * Build the prompt a worker agent actually runs.
 *
 * Everything the requester wrote — title, description, acceptance criteria,
 * test code — is fenced with a nonce minted HERE, at dispatch, strictly after
 * they wrote it. We spent real effort fencing the worker's submission against
 * the grader and left this direction wide open, which was backwards: a grader
 * only produces a verdict, while a worker has `run_python`, `fetch_url`, a
 * wallet API, and (on the MCP path) whatever tools live in its operator's own
 * session. Posting a $1 job was write access to somebody else's agent.
 *
 * `nonce` is injectable so the shape can be asserted in tests.
 */
export function buildJobTaskPrompt(spec: SpecRow, nonce?: string): string {
  const n = nonce ?? untrustedNonce()
  const brief = [
    spec.title,
    spec.description,
    spec.acceptanceCriteria ? `Acceptance criteria (what "done" means):\n${spec.acceptanceCriteria}` : '',
    spec.attachmentUrl
      ? `Source material for this task is attached at: ${spec.attachmentUrl}` +
        (spec.attachmentName ? ` (original filename: ${spec.attachmentName})` : '') +
        `\nUse the fetch_url tool to read it before doing the work — it is not summarized here.`
      : '',
    spec.testCode
      ? `This job is AUTO-GRADED. Your answer MUST include your complete Python solution in a ` +
        '```python fenced code block — the LAST such block in your answer is what gets graded, ' +
        `by running it against the acceptance tests below (plain asserts appended after your code). ` +
        `CRITICAL: that code block must contain ONLY the solution — function definitions plus any ` +
        `imports they need. NO example usage, NO self-test calls, NO top-level prints or demo data: ` +
        `the grader appends the tests itself, and any crash in extra top-level code fails the job ` +
        `even if your functions are correct. ` +
        `Use the run_python tool to run your code against these exact tests BEFORE answering, and ` +
        `only submit once they pass.\n\nAcceptance tests:\n${spec.testCode}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  // The clause comes FIRST and outside the fence: it is the platform
  // speaking, and it has to be read before the customer's text, not after it.
  return [workerBriefClause(n), fenceUntrusted('customer_task', brief, n)].join('\n\n')
}

/** Start the worker's real run for an already-accepted job and link the
 *  task to the spec. Split out so a crash between accept and dispatch can
 *  be healed later (auto-mine re-dispatches accepted-but-taskless jobs). */
export async function dispatchAcceptedJob(
  worker: AgentRow,
  jobId: number,
  spec: SpecRow,
  callbackUrl: string,
): Promise<void> {
  const { taskId } = await runAgentTask({
    agent: worker,
    task: buildJobTaskPrompt(spec),
    callbackUrl,
  })
  await db
    .update(jobSpec)
    .set({ workerAgentId: worker.id, onchainJobId: jobId, agentTaskId: taskId })
    .where(eq(jobSpec.specHash, spec.specHash))
}

/** Accept a job on-chain as `worker` and dispatch its real run. Throws if
 *  the worker already failed this job lineage's tests, or if another
 *  worker holds the off-chain claim (fast, no gas wasted). A dispatch
 *  failure after a successful on-chain accept is logged, not thrown — the
 *  accept can't be undone here, and auto-mine's self-heal retries it. */
/**
 * Refuse a worker the repost of a lineage it — or its account — already
 * failed.
 *
 * Checked by controller as well as by agent id. The record holds ids, and a
 * new agent gets a new one, so an id-only gate is lifted by
 * `create_worker_agent`. See lib/failed-lineage.ts for why the block lands on
 * the controller rather than following the disqualification onto the
 * successor.
 *
 * A failed controller lookup blocks nobody: it must not become a way for an
 * RPC or database hiccup to close the board.
 */
async function assertNotFailedLineage(
  worker: Pick<AgentRow, 'id' | 'userId'>,
  failedWorkerIds: readonly string[] | null | undefined,
): Promise<void> {
  const { failedLineageVerdict, failedLineageMessage, controllersOfFailed } = await import('@/lib/failed-lineage')
  const { controllersFor, strongestControlKey } = await import('@/lib/economic-identity')
  // Both sides must be keyed the same way or the comparison silently never
  // matches — `op:u1` and `u1` are different strings, and a gate that never
  // fires looks exactly like a gate that passed.
  const [failedControllers, mine] = await Promise.all([
    controllersOfFailed(failedWorkerIds).catch(() => []),
    controllersFor([worker.id]).catch(() => new Map()),
  ])
  const workerController = (() => {
    const c = mine.get(worker.id)
    return c ? strongestControlKey(c) : null
  })()
  const verdict = failedLineageVerdict({
    workerAgentId: worker.id,
    workerController,
    failedWorkerIds,
    failedControllers,
  })
  if (verdict.blocked) throw new Error(failedLineageMessage(verdict.reason))
}

/**
 * Cover the worker's bond, when the office owns this job.
 *
 * Shared by BOTH accept paths, because it was not. It lived inline in
 * `acceptAndDispatchJob`, so a worker arriving through `claim_job` — the live
 * connector path, which is the only way a platform agent with no runtime can
 * ever work — reached `acceptJob` with an empty wallet and reverted on
 * `TransferFailed()`. The failed-lineage gate had already been through this
 * exact lesson one function earlier; the bond had not.
 *
 * Called after the off-chain claim so a worker that lost the race never moves
 * money, and before the accept it exists to enable. Never fatal: a failed
 * cover lets the chain refuse the accept exactly as it would have.
 */
async function coverBondIfAssigned(
  worker: AgentRow,
  job: { specHash: string; bounty: number } | undefined,
  jobId: number,
): Promise<void> {
  if (!job) return
  try {
    const { coverBondForAssignedJob } = await import('@/lib/office-bond-cover')
    const cover = await coverBondForAssignedJob({ worker, specHash: job.specHash, bountyUsd: job.bounty })
    if (cover.covered) {
      console.info(
        `[labor-dispatch] covered ${worker.name}'s $${cover.amountUsd.toFixed(4)} bond for job ${jobId} from ${cover.from} (tx ${cover.txHash})`,
      )
    } else if (cover.why === 'failed') {
      console.warn(`[labor-dispatch] bond cover for job ${jobId} failed, letting the accept try anyway: ${cover.error}`)
    }
  } catch (coverError) {
    console.warn(`[labor-dispatch] bond cover for job ${jobId} threw, letting the accept try anyway:`, coverError)
  }
}

export async function acceptAndDispatchJob(
  worker: AgentRow,
  jobId: number,
  callbackUrl: string,
): Promise<{ txHash: string }> {
  const { acceptJob, readJobs } = await import('@/lib/onchain/labor')

  const jobs = await readJobs()
  const job = jobs.find((j) => j.id === jobId)
  const [spec] = job ? await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash)) : []

  await assertNotSelfDeal(worker, job?.requester, job?.specHash)

  await assertNotFailedLineage(worker, spec?.failedWorkerIds)

  // Capability gate — covers BOTH manual accepts and auto-mine (which
  // also pre-filters, but this is the single chokepoint before gas is
  // spent on an accept the worker can't deliver on).
  if (spec) {
    const { workerCanDeliver } = await import('@/lib/artifacts')
    const kind = spec.deliverableKind ?? 'text'
    if (!workerCanDeliver(worker.capabilities, kind, spec.requiredCapabilities)) {
      throw new Error(
        `This job requires a ${kind} deliverable${(spec.requiredCapabilities ?? []).length ? ` plus [${spec.requiredCapabilities.join(', ')}]` : ''} — ${worker.name} hasn't declared the needed capabilities.`,
      )
    }
  }

  // Take the off-chain work-unit claim before spending gas. Losing here is
  // the normal contention path — cheap and instant, like a mining pool
  // handing each work unit to exactly one rig.
  if (spec && !(await claimJobSpec(spec.specHash, worker.id))) {
    const reservedFor = await reservedAgentFor(spec.specHash)
    throw new Error(
      reservedFor
        ? 'This job is reserved for a different hired worker (an office pipeline step) — it is not open to anyone else.'
        : 'Another worker is already claiming this job — try a different one.',
    )
  }

  await coverBondIfAssigned(worker, job, jobId)

  let txHash: string
  try {
    txHash = await acceptJob(worker.id, jobId)
  } catch (error) {
    // An unconfirmed accept is the likeliest way a job becomes a zombie:
    // if it DID land, releasing the claim frees a job the chain already
    // says is Accepted, the next worker's accept reverts, and this worker
    // never gets dispatched — nobody is working a job whose escrow is
    // locked. So on pending, keep the claim and go do the work; if it
    // truly never landed, the claim TTL expires and the job returns to
    // the market on its own.
    const { isUserOpPending } = await import('@/lib/onchain/account')
    if (!isUserOpPending(error)) {
      if (spec) await releaseJobClaim(spec.specHash, worker.id) // free it for the next rig
      throw error
    }
    console.warn(`[labor-dispatch] accept of job ${jobId} is pending confirmation — keeping the claim and dispatching`)
    txHash = '0x'
  }

  if (spec) {
    try {
      await dispatchAcceptedJob(worker, jobId, spec, callbackUrl)
    } catch (dispatchError) {
      console.error('[labor-dispatch] accepted on-chain but failed to start the real run:', dispatchError)
    }
  }

  return { txHash }
}

/**
 * Accept a job for an EXTERNAL live worker — an MCP session (Claude /
 * ChatGPT connected via the connector) that will do the work itself,
 * inside its own conversation, and submit via the normal callback path.
 *
 * Same gates as acceptAndDispatchJob (failed-lineage block, capability
 * match, off-chain claim, on-chain accept); the difference is dispatch:
 * there is no runtime to send the task TO — the caller IS the runtime —
 * so the agent task is created directly in 'running' and the composed
 * prompt is handed back for the session to execute. Submission then flows
 * through /api/runtime/callback exactly like every other worker, so
 * grading, credit, and settlement cannot drift.
 */
export async function acceptJobForExternalWorker(
  worker: AgentRow,
  jobId: number,
): Promise<{ taskId: string; prompt: string; bounty: number }> {
  const { acceptJob, readJobs } = await import('@/lib/onchain/labor')

  const jobs = await readJobs({ maxAgeMs: 0 })
  const job = jobs.find((j) => j.id === jobId)
  if (!job) throw new Error('Job not found on-chain')
  if (job.status !== 'Open') throw new Error(`Job #${jobId} is ${job.status}, not Open`)
  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
  if (!spec) throw new Error('Job has no off-chain spec — nothing to actually do')

  await assertNotSelfDeal(worker, job.requester, job.specHash)

  await assertNotFailedLineage(worker, spec.failedWorkerIds)
  {
    const { workerCanDeliver } = await import('@/lib/artifacts')
    const kind = spec.deliverableKind ?? 'text'
    if (!workerCanDeliver(worker.capabilities, kind, spec.requiredCapabilities)) {
      throw new Error(
        `This job requires a ${kind} deliverable${(spec.requiredCapabilities ?? []).length ? ` plus [${spec.requiredCapabilities.join(', ')}]` : ''} — agent ${worker.name} hasn't declared the needed capabilities.`,
      )
    }
  }
  if (Math.round(parseFloat(worker.creditScore)) < job.minScore) {
    throw new Error(`Job requires credit score ≥ ${job.minScore}; ${worker.name} has ${Math.round(parseFloat(worker.creditScore))}.`)
  }
  if (!(await claimJobSpec(spec.specHash, worker.id))) {
    const reservedFor = await reservedAgentFor(spec.specHash)
    throw new Error(
      reservedFor
        ? 'This job is reserved for a different hired worker (an office pipeline step) — it is not open to anyone else.'
        : 'Another worker is already claiming this job — try a different one.',
    )
  }

  await coverBondIfAssigned(worker, job, jobId)

  try {
    await acceptJob(worker.id, jobId)
  } catch (error) {
    // Same reasoning as the dispatched path above: a pending accept may
    // already be on-chain, so releasing the claim is what manufactures a
    // zombie. Hold it and let the worker proceed.
    const { isUserOpPending } = await import('@/lib/onchain/account')
    if (!isUserOpPending(error)) {
      await releaseJobClaim(spec.specHash, worker.id)
      throw error
    }
    console.warn(`[labor-dispatch] external accept of job ${jobId} is pending confirmation — keeping the claim`)
  }

  const { nanoid } = await import('nanoid')
  const { agentTask } = await import('@/lib/db/schema')
  const taskId = `task-${nanoid(10)}`
  const prompt = buildJobTaskPrompt(spec)
  await db.insert(agentTask).values({
    id: taskId,
    userId: worker.userId,
    agentId: worker.id,
    task: prompt,
    status: 'running',
  })
  await db
    .update(jobSpec)
    .set({ workerAgentId: worker.id, onchainJobId: jobId, agentTaskId: taskId })
    .where(eq(jobSpec.specHash, spec.specHash))

  return { taskId, prompt, bounty: job.bounty }
}
