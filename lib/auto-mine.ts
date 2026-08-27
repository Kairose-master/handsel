/**
 * Auto-mine: the poll loop IS the mining loop.
 *
 * When a local worker polls for work and its queue is empty, this claims
 * the next qualifying Open job on its behalf — accept on-chain, dispatch
 * the run — so a GPU owner's pipeline is: flip Auto-mine on, leave the
 * worker running, done. No daemon exists anywhere: the worker's own 3s
 * heartbeat drives acceptance, which degrades gracefully to "nothing
 * happens" when the worker is offline (exactly right — a job should never
 * be claimed by a machine that isn't there to do it).
 *
 * Rules per tick: the agent takes as many blocks as it has FREE concurrency
 * slots (ceiling = resolveMiningConcurrency(), default 3, env-overridable) —
 * where a slot is one in-flight task. maxSlots === 1 reproduces the old
 * single-slot "only when fully idle, one job per tick" behaviour. Only jobs
 * whose minScore the agent clears (avoids a guaranteed on-chain revert),
 * that it didn't post itself, and whose test lineage it hasn't already
 * failed. A crash window between accept and dispatch is self-healed on the
 * next tick by re-dispatching accepted-but-taskless jobs.
 *
 * Accepts WITHIN one agent stay serial: each acceptJob is a UserOp from the
 * agent's single smart account and they share a nonce, so firing them in
 * parallel would collide. Cross-agent parallelism lives one level up
 * (tickCloudAutoMineAgents) where each agent is a distinct account. See
 * docs/parallel-mining.md.
 */
import { db } from '@/lib/db'
import { agent, agentTask, jobSpec, type agent as agentTable } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { acceptAndDispatchJob, dispatchAcceptedJob, JOB_CLAIM_TTL_MS } from '@/lib/labor-dispatch'
import { logPlatformEvent } from '@/lib/platform-feed'
import { mapLimit } from '@/lib/concurrency'
import type { OnchainJob } from '@/lib/onchain/labor'
import {
  selectMiningBlocks,
  freeMiningSlots,
  resolveMiningConcurrency,
  resolveSweepConcurrency,
  type MiningCandidate,
} from '@/lib/mining-scheduler'

type AgentRow = typeof agentTable.$inferSelect

export async function autoMineTick(
  agent: AgentRow,
  callbackUrl: string,
  // opts.jobs lets a cross-agent sweep pass ONE shared on-chain snapshot so N
  // agents don't each call readJobs() (RPC amplification). Selection tolerates
  // a slightly stale snapshot — the atomic claim + on-chain accept re-check
  // catch anything taken since (the loser just tries the next block).
  opts?: { maxSlots?: number; jobs?: OnchainJob[] },
): Promise<boolean> {
  if (!agent.autoMine || !agent.smartAccountAddress) return false

  const active = await db
    .select({ id: agentTask.id })
    .from(agentTask)
    .where(and(eq(agentTask.agentId, agent.id), inArray(agentTask.status, ['queued', 'running', 'processing'])))
  const maxSlots = opts?.maxSlots ?? resolveMiningConcurrency()
  let free = freeMiningSlots(active.length, maxSlots)
  if (free <= 0) return false

  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return false

  // An agent that cannot pay for gas cannot claim anything, so let it find out
  // once here instead of once per candidate job.
  //
  // Measured on a real sweep: six unfunded agents on one account each tried
  // every open job, each attempt building a UserOperation and simulating it
  // before hitting `holds 0 wei` — which drove base-mainnet.infura.io to 429
  // and knocked out the reads the four agents that COULD work depended on.
  // The unfunded ones cost nothing to satisfy and everything to ignore.
  //
  // One eth_getBalance, and only when nothing is sponsoring the gas. Failing
  // the probe does NOT skip the agent: an RPC hiccup must not silently stop a
  // funded worker from mining, and the real check still runs at send time.
  const { agentGasReadiness } = await import('@/lib/agent-provision')
  const readiness = await agentGasReadiness(agent.smartAccountAddress)
  if (!readiness.ready && readiness.weiHeld !== 'unknown') {
    console.info(
      `[auto-mine] ${agent.name} holds ${readiness.weiHeld} wei and nothing is sponsoring gas — skipping its sweep`,
    )
    return false
  }

  let jobs: OnchainJob[]
  if (opts?.jobs) {
    jobs = opts.jobs // shared snapshot from the sweep — one read for all agents
  } else {
    const { readJobs } = await import('@/lib/onchain/labor')
    jobs = await readJobs().catch(() => [])
  }
  const myAddress = agent.smartAccountAddress.toLowerCase()
  let didWork = false

  // Self-heal first: jobs this agent already accepted on-chain whose dispatch
  // never happened (e.g. a timeout between accept and runAgentTask). Dispatch
  // is off-chain, so healing several is nonce-safe; each consumes a slot.
  for (const j of jobs) {
    if (free <= 0) break
    if (j.status !== 'Accepted' || j.worker.toLowerCase() !== myAddress) continue
    const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, j.specHash))
    if (spec && !spec.agentTaskId) {
      await dispatchAcceptedJob(agent, j.id, spec, callbackUrl)
      free -= 1
      didWork = true
    }
  }
  if (free <= 0) return didWork

  // Resolve every Open job's spec in ONE query (was N+1 inside the loop).
  const openJobs = jobs.filter((j) => j.status === 'Open')
  const specHashes = openJobs.map((j) => j.specHash)
  const specs = specHashes.length
    ? await db.select().from(jobSpec).where(inArray(jobSpec.specHash, specHashes))
    : []
  const specByHash = new Map(specs.map((s) => [s.specHash, s]))
  const candidates: MiningCandidate[] = []
  for (const j of openJobs) {
    const spec = specByHash.get(j.specHash)
    if (spec) candidates.push({ job: j, spec }) // structurally satisfies MiningCandidate
  }

  const score = Math.round(parseFloat(agent.creditScore))
  const { faucetAgentId, faucetReservedFor } = await import('@/lib/job-faucet')
  const faucetId = await faucetAgentId().catch(() => null)
  const now = Date.now()
  const { workerCanDeliver } = await import('@/lib/artifacts')
  const { reservationsByHash, assignmentsByHash } = await import('@/lib/job-reservation')
  const [reservedBy, assignedBy] = await Promise.all([
    reservationsByHash(specHashes).catch(() => new Map<string, string>()),
    assignmentsByHash(specHashes).catch(() => new Map<string, string>()),
  ])
  const specHashByJobId = new Map(openJobs.map((j) => [j.id, j.specHash]))
  /** Work this office posted and assigned to this exact agent. The owner
   *  covers the bond on it (lib/office-bond-cover.ts), so an empty balance is
   *  not a reason to skip — it is a reason to top up on the way in. */
  const isMineByAssignment = (jobId: number) => {
    const hash = specHashByJobId.get(jobId)
    return Boolean(hash && assignedBy.get(hash) === agent.id)
  }

  // Accepting stakes a bond in USDC out of the worker's own account, so an
  // agent's balance decides which bounties it can even attempt. One balance
  // read and one schedule read (immutable, cached) answer that for every
  // candidate; without them the miner builds a UserOperation per job and
  // learns the same thing from a `TransferFailed()` revert in simulation.
  //
  // Unreadable => allow, exactly as the gas preflight does. A probe that
  // cannot answer must not be the thing that stops a solvent worker; the
  // contract still refuses what it should.
  const { bondReadiness } = await import('@/lib/agent-bond')
  const { bondScheduleOf } = await import('@/lib/onchain/labor-v2')
  const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
  const [bondSchedule, heldUsd] = await Promise.all([
    bondScheduleOf().catch(() => null),
    usdcBalanceOf(agent.smartAccountAddress as `0x${string}`).catch(() => null),
  ])
  let bondShortfall: { bounty: number; shortUsd: number } | null = null

  const selected = selectMiningBlocks({
    candidates,
    myAddress,
    score,
    agentId: agent.id,
    now,
    freeSlots: free,
    claimTtlMs: JOB_CLAIM_TTL_MS,
    canDeliver: (spec) =>
      workerCanDeliver(agent.capabilities, spec.deliverableKind ?? 'text', spec.requiredCapabilities),
    // New-miner priority: freshly-posted faucet jobs stay reserved for
    // low-credit newcomers during the grace window; a high-credit rig skips
    // them and takes non-faucet (or post-grace) work instead.
    isFaucetReserved: (spec) =>
      Boolean(faucetId && spec.requesterAgentId === faucetId && faucetReservedFor(score, spec.createdAt, now)),
    isReservedForOther: (spec) => {
      const reservedFor = reservedBy.get(spec.specHash)
      return Boolean(reservedFor && reservedFor !== agent.id)
    },
    canPostBond: (job) => {
      if (heldUsd === null) return true // unreadable — let the contract decide
      if (isMineByAssignment(job.id)) return true // the office pays this one's bond
      const verdict = bondReadiness(heldUsd, job.bounty, bondSchedule)
      if (verdict.ready === true || verdict.ready === 'unknown') return true
      // Remember the cheapest miss, so the tick can say what is actually
      // wrong instead of going quiet. A worker skipping every job for want of
      // eleven cents is the single least guessable state this system has.
      if (!bondShortfall || verdict.shortUsd < bondShortfall.shortUsd) {
        bondShortfall = { bounty: job.bounty, shortUsd: verdict.shortUsd }
      }
      return false
    },
  })

  if (selected.length === 0 && bondShortfall) {
    const { bounty, shortUsd } = bondShortfall as { bounty: number; shortUsd: number }
    console.info(
      `[auto-mine] ${agent.name} holds $${(heldUsd ?? 0).toFixed(4)} USDC — $${shortUsd.toFixed(4)} short of the bond on a $${bounty.toFixed(2)} job. Fund it from another of your agents to let it work.`,
    )
  }

  // Serial within the agent (shared account nonce). The off-chain claim
  // inside acceptAndDispatchJob still guards each block against other rigs.
  for (const { job, spec } of selected) {
    try {
      await acceptAndDispatchJob(agent, job.id, callbackUrl)
      await logPlatformEvent(
        'JOB_AUTO_ACCEPTED',
        `${agent.name} auto-claimed job #${job.id} "${spec.title}" (auto-mine)`,
      )
      didWork = true
    } catch (error) {
      // Lost the race (someone else accepted) or a transient revert — try the
      // next block rather than giving up the tick.
      console.error(`[auto-mine] claim of job ${job.id} failed:`, error)
    }
  }

  return didWork
}

// Cheap in-memory cooldown, per serverless instance — good enough for a
// best-effort sweep (over-ticking across cold instances is harmless;
// autoMineTick() is self-limiting via its own busy/status checks).
let lastCloudSweepAt = 0
const CLOUD_SWEEP_COOLDOWN_MS = 15_000

/**
 * A local worker's own 3s poll heartbeat IS its mining loop (see the
 * module doc comment) — but a 'cloud' agent never polls at all; the
 * platform dispatches TO it, not the other way around (see
 * dispatchToCloudApi in lib/agent-tasks.ts). Nothing would ever call
 * autoMineTick() for one on its own. This is the substitute: swept
 * opportunistically from the same already-frequent read paths that already
 * call reapStuckTasks() (the Jobs page, the guest page), throttled so an
 * on-chain read doesn't run on every single request. Best-effort, same
 * spirit as everything else here — a quiet period with zero site traffic
 * means no sweep, the same way an offline local worker means no claims.
 */
export async function tickCloudAutoMineAgents(callbackUrl: string): Promise<void> {
  const now = Date.now()
  if (now - lastCloudSweepAt < CLOUD_SWEEP_COOLDOWN_MS) return
  lastCloudSweepAt = now

  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return

  // Both 'cloud' and 'mcp' agents are push-based — the platform dispatches TO
  // them (they never poll), so they need this sweep to ever auto-mine.
  const candidates = await db
    .select()
    .from(agent)
    .where(and(inArray(agent.runtimeType, ['cloud', 'mcp']), eq(agent.autoMine, true)))
  if (candidates.length === 0) return

  // ONE on-chain read shared across the whole sweep (phase 3b) — otherwise N
  // agents each call readJobs(), multiplying RPC load exactly when many agents
  // mine at once. Each tick still re-reads freshly inside acceptAndDispatchJob
  // before spending gas, so a stale snapshot can't cause a bad accept.
  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs().catch(() => [])

  // Fan out across agents — each is a distinct smart account, so their
  // on-chain accepts don't share a nonce and are safe to run concurrently.
  // Bounded so a big roster can't stampede a free-tier bundler/RPC.
  await mapLimit(candidates, resolveSweepConcurrency(), (a) =>
    autoMineTick(a, callbackUrl, { jobs }).catch((error) => {
      console.error(`[auto-mine] cloud sweep tick failed for ${a.id}:`, error)
      return false
    }),
  )
}
