/**
 * Mining scheduler — the pure core of "which blocks does this agent take,
 * and how many at once".
 *
 * Historically auto-mine claimed exactly ONE job per tick and refused to
 * claim anything while the agent had any active task (a hard single-slot
 * idle gate). This module generalises that to N concurrent slots: given the
 * open jobs, the agent, and how many slots are free, it returns the ordered
 * subset of "blocks" (claimable work units) to attempt this tick.
 *
 * Everything here is a pure function of its inputs — no db, no chain, no
 * imports with side effects — so the eligibility rules (the part that used to
 * live inline in the tick and was untested) are unit-tested in isolation. The
 * caller injects the two predicates that DO need context (`canDeliver`,
 * `isFaucetReserved`) so this file stays dependency-free.
 *
 * See docs/parallel-mining.md for the surrounding architecture.
 */

/** The on-chain job fields the scheduler reads (structural — the real
 *  readJobs() row has more; anything with these is accepted). */
import { laneAcceptsRuntime, normalizeLane } from '@/lib/job-lane'
import { scopeAllows, type MineScope } from '@/lib/mine-scope'

export interface OnchainJobLike {
  id: number
  status: string
  requester: string
  worker: string
  minScore: number
  specHash: string
  /** USD. What the bond is a percentage of. */
  bounty: number
  /** The governing deadline, unix seconds, or null on a market that has none
   *  (V1). Read by the claim-fitness preflight, not by the scheduler itself. */
  deadline?: number | null
}

/** The off-chain spec fields the scheduler reads (structural). */
export interface JobSpecLike {
  specHash: string
  requesterAgentId: string | null
  createdAt: Date
  failedWorkerIds: string[] | null
  claimedByAgentId: string | null
  claimedAt: Date | null
  deliverableKind: string | null
  requiredCapabilities: string[] | null
  title: string
  /** Which machine this job is meant to run on (lib/job-lane.ts). Null on
   *  every job posted before the lane existed, which normalizes to `any`. */
  lane?: string | null
}

export interface MiningCandidate {
  job: OnchainJobLike
  spec: JobSpecLike
}

export interface SelectMiningInput {
  /** Open jobs already paired with their resolved off-chain specs. */
  candidates: MiningCandidate[]
  /** The worker's lowercased smart-account address (for self-deal skip). */
  myAddress: string
  /** The worker's integer credit score (for the minScore gate). */
  score: number
  /** The worker's agent id (for failed-lineage and own-claim checks). */
  agentId: string
  /** The worker's runtime (`local`, `cloud`, `mcp`, `platform`, `webhook`).
   *  Decides which lanes it may take from — a platform-driven agent taking a
   *  `local` job means the platform pays for work another machine would have
   *  done for free, and cannot touch the filesystem that job needs. */
  runtimeType?: string | null
  /** Wall-clock now, ms (for claim-staleness). */
  now: number
  /** How many blocks this agent may still take this tick (>= 0). */
  freeSlots: number
  /** How long an off-chain claim stays live before it's abandoned. */
  claimTtlMs: number
  /** Can this worker actually produce the spec's deliverable kind? */
  canDeliver: (spec: JobSpecLike) => boolean
  /** Is this spec a faucet job still reserved for lower-credit newcomers? */
  isFaucetReserved: (spec: JobSpecLike) => boolean
  /** How far from home this worker may bid (lib/mine-scope.ts). `own` keeps
   *  it on work this account posted; `market` is the whole board. Defaults to
   *  `market` when absent so an existing caller keeps its behaviour. */
  scope?: MineScope
  /** Was this job posted by an agent on the SAME account as the worker? The
   *  caller resolves it because it needs the account's own addresses; the
   *  scheduler only applies the rule. */
  isOwnAccountJob?: (c: MiningCandidate) => boolean
  /** Is this spec reserved (lib/job-reservation.ts) for a DIFFERENT agent —
   *  an office template's own pipeline step, assigned to one specific hired
   *  worker at post time? Skipping it here is a courtesy (no wasted claim
   *  attempt, no log noise); claimJobSpec enforces the real gate regardless. */
  isReservedForOther: (spec: JobSpecLike) => boolean
  /** Can the worker stake this job's bond? V2 `acceptJob` pulls USDC out of
   *  the worker's own account, so an agent holding too little reverts inside
   *  simulation with `TransferFailed()` — indistinguishable, in a log, from an
   *  RPC fault. Same category as the minScore check above: a guaranteed
   *  on-chain revert, so it is cheaper and clearer to not attempt it. */
  canPostBond: (job: OnchainJobLike) => boolean
}

/** True when a DIFFERENT worker holds a live (non-stale) claim on this spec.
 *  Mirrors isClaimedByOther in lib/labor-dispatch (kept inline here so the
 *  scheduler pulls in nothing that touches the db). */
function claimedByOther(spec: JobSpecLike, agentId: string, now: number, ttlMs: number): boolean {
  return Boolean(
    spec.claimedByAgentId &&
      spec.claimedByAgentId !== agentId &&
      spec.claimedAt &&
      now - spec.claimedAt.getTime() < ttlMs,
  )
}

/** Is this a block the given agent may accept right now? Encodes exactly the
 *  per-job filters auto-mine applied inline, made testable. */
export function isEligibleBlock(c: MiningCandidate, input: SelectMiningInput): boolean {
  const { job, spec } = c
  if (job.status !== 'Open') return false
  if (job.minScore > input.score) return false // guaranteed on-chain revert otherwise
  if (!input.canPostBond(job)) return false // cannot stake the bond — also a guaranteed revert
  if (job.requester.toLowerCase() === input.myAddress) return false // no self-dealing
  if (input.isFaucetReserved(spec)) return false // newcomer grace window
  if (!laneAcceptsRuntime(normalizeLane(spec.lane), input.runtimeType)) return false // wrong machine
  // Scope before reservation: a worker kept to its own account's work should
  // not even be considering a stranger's job, whoever it is reserved for.
  if (!scopeAllows(input.scope ?? 'market', input.isOwnAccountJob?.(c) ?? true)) return false
  if (input.isReservedForOther(spec)) return false // an office's job, assigned elsewhere
  if (spec.failedWorkerIds?.includes(input.agentId)) return false // already failed this lineage
  if (claimedByOther(spec, input.agentId, input.now, input.claimTtlMs)) return false // another rig has it
  if (!input.canDeliver(spec)) return false // capability mismatch (would burn an accept)
  return true
}

/**
 * Pick up to `freeSlots` eligible blocks for this agent.
 *
 * Order is preserved from the caller's input (readJobs() returns jobs in
 * on-chain id order, i.e. oldest first), so this is FIFO/fair — no rig can
 * cherry-pick the fattest bounty ahead of older work. Ranking policy can be
 * layered on later without changing the eligibility contract.
 */
export function selectMiningBlocks(input: SelectMiningInput): MiningCandidate[] {
  if (input.freeSlots <= 0) return []
  const out: MiningCandidate[] = []
  for (const c of input.candidates) {
    if (out.length >= input.freeSlots) break
    if (isEligibleBlock(c, input)) out.push(c)
  }
  return out
}

/** Free concurrency slots = ceiling minus what's already in flight (never
 *  negative). maxSlots === 1 reproduces the old single-slot idle gate. */
export function freeMiningSlots(inFlight: number, maxSlots: number): number {
  return Math.max(0, maxSlots - inFlight)
}

/** Platform-wide default concurrency ceiling per agent, env-overridable.
 *  Bounded to [1, 8] so a fat-fingered env var can't unleash unbounded
 *  parallel on-chain accepts against a free-tier bundler. */
export function resolveMiningConcurrency(): number {
  const raw = Number(process.env.MINING_CONCURRENCY ?? 3)
  if (!Number.isFinite(raw) || raw < 1) return 3
  return Math.min(Math.floor(raw), 8)
}

/** Ceiling on how many agents a single sweep processes concurrently
 *  (cross-agent parallelism is nonce-safe — different smart accounts).
 *  Bounded to [1, 8] for the same free-tier-RPC reason. */
export function resolveSweepConcurrency(): number {
  const raw = Number(process.env.MINING_SWEEP_CONCURRENCY ?? 4)
  if (!Number.isFinite(raw) || raw < 1) return 4
  return Math.min(Math.floor(raw), 8)
}

/** How long a FAILED dispatch must have sat before the self-heal tries the
 *  job again. The bound on retries is the pair (this cooldown, the job's
 *  own claim deadline): spaced attempts until the chain itself closes the
 *  window, rather than a counter nothing persists. */
export const REDISPATCH_COOLDOWN_MS = 10 * 60_000

/**
 * Should auto-mine's self-heal (re-)dispatch an on-chain Accepted job this
 * agent already holds?
 *
 * Two heals, found months apart:
 *  - no task at all — a crash between accept and dispatch (the original);
 *  - a task that FAILED — dispatch ran and died off-chain, e.g. every
 *    assisted write 400ing while the platform model key was out of credits
 *    (live, 2026-08-31). The escrow sat Accepted-but-doomed until the
 *    deadline refunded it, because the heal saw an agentTaskId and moved on.
 *    A failed task is not a dispatched job; it is a dispatch that needs
 *    doing again, once the cooldown says the world may have changed.
 *
 * A task still queued/running/processing is genuinely in flight — never
 * double-dispatch over it (reapStuckTasks owns hung ones, marking them
 * failed, which routes them back here next sweep).
 */
export function shouldHealAcceptedJob(input: {
  hasTask: boolean
  /** The linked task's status, when hasTask. */
  taskStatus?: string | null
  /** ms since the linked task last changed, when hasTask. */
  taskAgeMs?: number | null
}): boolean {
  if (!input.hasTask) return true
  if (input.taskStatus !== 'failed') return false
  return (input.taskAgeMs ?? 0) > REDISPATCH_COOLDOWN_MS
}
