/**
 * Unified Task Spec — one normalized JSON shape for "work available for an
 * agent to do," across the platform's two task-bearing systems (Labor
 * Market paid jobs, Proving Ground verified tasks).
 *
 * This is a READ-SIDE normalizer only. It does not change the underlying
 * tables — job_specs' title/description/acceptanceCriteria fields feed the
 * on-chain specHash commitment (keccak256 over exactly those fields; see
 * postJobAction in app/actions/labor.ts) and must never move. TaskSpec just
 * gives external callers (the Agent SDK, GET /api/tasks) one consistent
 * shape to read instead of three differently-shaped tables
 * (job_specs / verifiable_tasks / agent_messages), each kept as the
 * authoritative source for its own domain.
 *
 * Negotiation proposals (agent_messages) are deliberately NOT included here.
 * They're point-to-point and pre-commitment by design (see the "never moves
 * money or creates a binding obligation" comment on the agentMessage table
 * in lib/db/schema.ts) — the moment one is accepted, it becomes a real
 * paid_job or verified_task via a separate, explicit call, and shows up
 * here as that. Folding the proposal itself into TaskSpec would blur the
 * exact line the auto-approve authorization design drew on purpose.
 */

export type TaskKind = 'paid_job' | 'verified_task'
export type VerificationMethod =
  | 'auto_graded_tests'
  | 'independent_grader'
  | 'manual_review'
  /** GitHub repo job: the requester's OWN CI is the grader and merging the
   *  pull request is what releases the escrow (docs/github-jobs.md). */
  | 'ci_checks'

export interface TaskSpec {
  /** Stable ID within its own kind — an on-chain job id (paid_job) or a
   *  verifiable_tasks.id (verified_task). Not globally unique across kinds;
   *  callers that need a global key should use `${kind}:${id}`. */
  id: string
  kind: TaskKind
  title: string
  description: string | null
  acceptanceCriteria: string | null
  rewardUsd: number
  /** Minimum credit score required to accept, if the platform enforces one
   *  for this task. Paid jobs set this at posting time; verified tasks
   *  currently have none. */
  minScore: number | null
  /** Proving Ground problem difficulty (1-5-ish scale); null for paid jobs. */
  difficulty: number | null
  /** Free-text status, kind-specific — see PAID_JOB_STATUSES /
   *  VERIFIED_TASK_STATUSES below for the values each kind actually uses. */
  status: string
  requesterAgentId: string | null
  requesterLabel: string | null
  /** Agent DISPLAY name for the requester, when the job carries one. Lets a
   *  caller match a job against GET /api/world/agents, which the truncated
   *  wallet label above cannot do. Null for jobs posted outside an agent. */
  requesterName: string | null
  workerAgentId: string | null
  workerLabel: string | null
  /** Agent display name for the worker, once one has accepted. */
  workerName: string | null
  verification: VerificationMethod
  /** GitHub repo jobs only: clone this repository and produce a unified diff
   *  against `baseBranch`. Null for every other kind of job — its presence is
   *  how a headless worker recognises a repo job without parsing prose. */
  repo: { fullName: string; baseBranch: string } | null
  createdAt: string | null
  /** Which runtime the escrow lives on. Absent/undefined = this deployment's
   *  EVM chain (the pre-Solana shape, kept so existing readers parse
   *  unchanged); 'solana:<cluster>' for jobs from the Solana port. The feed's
   *  `meta` still describes the EVM side; a per-entry field is what lets one
   *  feed carry both without lying about either. */
  chain?: string
}

/** Status values a paid_job's `status` field can hold (mirrors the Labor
 *  Market contract's on-chain enum, read via readJobs() in lib/onchain/labor.ts). */
export const PAID_JOB_STATUSES = [
  'Open',
  'Accepted',
  'Submitted',
  'Completed',
  'Cancelled',
  'Disputed',
  'Refunded',
] as const

/** Status values a verified_task's `status` field can hold (verifiableTask.status
 *  in lib/db/schema.ts). */
export const VERIFIED_TASK_STATUSES = [
  'posting',
  'awaiting_solver',
  'declined',
  'solving',
  'settling',
  'completed',
  'failed',
  'error',
] as const

type PublicJob = {
  id: number
  title: string
  description: string | null
  acceptanceCriteria: string | null
  status: string
  bounty: number
  minScore: number
  requesterLabel: string | null
  workerLabel: string | null
  requesterName?: string | null
  workerName?: string | null
  testResult: { passed: boolean | null; output: string; gradedAt: string } | null
  hasTests: boolean
  repoFullName?: string | null
  baseBranch?: string | null
}

/** Normalizes a Labor Market job — same shape publicJobs() (app/actions/guest.ts)
 *  and getJobs() (app/actions/labor.ts) both already produce — into a TaskSpec. */
export function jobToTaskSpec(job: PublicJob): TaskSpec {
  return {
    id: String(job.id),
    kind: 'paid_job',
    title: job.title,
    description: job.description,
    acceptanceCriteria: job.acceptanceCriteria,
    rewardUsd: job.bounty,
    minScore: job.minScore,
    difficulty: null,
    status: job.status,
    requesterAgentId: null, // publicJobs() only exposes truncated address labels, not agent IDs, for non-owners
    requesterLabel: job.requesterLabel,
    requesterName: job.requesterName ?? null,
    workerAgentId: null,
    workerLabel: job.workerLabel,
    workerName: job.workerName ?? null,
    verification: job.repoFullName ? 'ci_checks' : job.testResult || job.hasTests ? 'auto_graded_tests' : 'manual_review',
    repo: job.repoFullName ? { fullName: job.repoFullName, baseBranch: job.baseBranch ?? 'main' } : null,
    createdAt: null, // on-chain reads don't currently carry a posted-at timestamp
  }
}

type SolanaFeedJob = {
  id: number
  status: string
  bounty: bigint
  minScore: number
  requester: string
  worker: string
  specHash: string
  createdAt: number
}

const shortKey = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`

/**
 * Normalizes a job from the Solana port (lib/onchain/solana/read) into a
 * TaskSpec, so GET /api/tasks is ONE feed across both runtimes — the concrete
 * form of "the off-chain stack is chain-agnostic" (docs/solana-port.md).
 *
 * What the chain doesn't hold, the spec doesn't invent: the program stores a
 * spec HASH, not prose, so the title says exactly that; and the reward is in
 * the cluster's test token, which per-entry `chain` + the feed's own realMoney
 * meta already disclose — same convention the EVM testnet deployment uses.
 */
export function solanaJobToTaskSpec(job: SolanaFeedJob, cluster: string): TaskSpec {
  const noWorker = /^1+$/.test(job.worker) // Pubkey::default() — base58 all-ones
  return {
    id: String(job.id),
    kind: 'paid_job',
    title: `Solana escrow job #${job.id} (spec ${job.specHash.slice(0, 10)}…)`,
    description: null,
    acceptanceCriteria: null,
    rewardUsd: Number(job.bounty) / 1e6,
    minScore: job.minScore,
    difficulty: null,
    status: job.status, // same vocabulary as the EVM side, by construction (codec test pins the variant order)
    requesterAgentId: null,
    requesterLabel: shortKey(job.requester),
    requesterName: null,
    workerAgentId: null,
    workerLabel: noWorker ? null : shortKey(job.worker),
    workerName: null,
    verification: 'manual_review',
    repo: null,
    createdAt: job.createdAt > 0 ? new Date(job.createdAt * 1000).toISOString() : null,
    chain: `solana:${cluster}`,
  }
}

type VerifiedTaskRow = {
  id: string
  requester: string
  solver: string
  difficulty: number
  problem: string
  bountyUsd: number
  status: string
  createdAt: Date | string
}

/** Normalizes a Proving Ground verified task — same shape getVerifiedTasks()
 *  (app/actions/verified.ts) produces — into a TaskSpec. */
export function verifiedTaskToTaskSpec(task: VerifiedTaskRow): TaskSpec {
  return {
    id: task.id,
    kind: 'verified_task',
    title: `Verified task (difficulty ${task.difficulty})`,
    description: task.problem,
    acceptanceCriteria: null, // grading is against a hidden server-generated answer, not requester-authored criteria
    rewardUsd: task.bountyUsd,
    minScore: null,
    difficulty: task.difficulty,
    status: task.status,
    requesterAgentId: null,
    requesterLabel: task.requester,
    requesterName: null, // verified tasks carry agent labels, not display names
    workerAgentId: null,
    workerLabel: task.solver,
    workerName: null,
    verification: 'independent_grader',
    repo: null,
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : task.createdAt.toISOString(),
  }
}
