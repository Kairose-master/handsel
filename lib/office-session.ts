/**
 * Office sessions — the unit past one job.
 *
 * A job is one execution with one deliverable and one settlement. An OFFICE
 * SESSION is the long-lived goal an office is told to pursue: it plans a
 * graph of tasks, dispatches each to a worker (a local Claude Code process,
 * a cloud/MCP agent, or the open market), collects what came back, verifies
 * it, decides under a written policy whether money may move, and picks up
 * again after a crash from the last checkpoint it wrote. Jobs, runs,
 * checkpoints and approvals are all things a session HAS; the session is the
 * thing that persists across them.
 *
 *   Office (user_id, slot)
 *     └── OfficeSession            goal · status · budget · policy · clock
 *           ├── SessionTask        one node of the plan (a job-sized unit)
 *           ├── SessionRun         one harness/worker execution of a task
 *           ├── Checkpoint         a resumable point a run wrote down
 *           ├── ApprovalRecord     a policy or owner decision about one task
 *           ├── SessionArtifact    diff · file · report · log · proof
 *           └── SessionEvent       append-only: every state change, in order
 *
 * Not to be confused with `lib/session.ts`, which is a thread of escrowed
 * turns bound to one worker (a job session). That one bills per turn; this
 * one organises work over time. A job session could be one task of an
 * office session; the reverse makes no sense.
 *
 * ## Why the event log is the truth and the row is a cache
 *
 * Everything that happens to a session is an event with an idempotency key.
 * `replay(events)` rebuilds the whole state from nothing; the stored
 * "materialized" row exists only so a page can list sessions without
 * replaying each one. The reducer below is the ONLY code that changes
 * state, and it refuses transitions the table does not allow — so a
 * corrupt log fails loudly at replay instead of quietly producing a
 * session that is both completed and running. The invariants at the bottom
 * are checked in tests against every reachable state, and can be checked at
 * runtime after every append.
 *
 * ## Why status is one field and not several booleans
 *
 * `running && paused && completed` is representable with three booleans and
 * means nothing. One status, one transition table, and an invariant list
 * saying what each status implies (a running session has a live run; a
 * completed one has no open escrow) is how contradictory states become
 * unrepresentable rather than merely unlikely.
 *
 * Pure. Storage, the tick and every side effect live in
 * lib/office-session-server.ts; the loop's decisions in
 * lib/office-session-loop.ts; the money policy in lib/approval-policy.ts.
 */

/* ── Statuses ─────────────────────────────────────────────────────────── */

export const SESSION_STATUSES = [
  'draft',
  'planned',
  'awaiting_budget',
  'ready',
  'running',
  'waiting_on_dependency',
  'waiting_on_worker',
  'waiting_on_review',
  'waiting_on_approval',
  'paused',
  'retrying',
  'partially_completed',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export type StatusMeta = {
  /** Shown to the owner, one sentence, present tense. */
  sentence: string
  /** What must be true to enter — documentation, enforced by the reducer's transition guards. */
  entry: string
  /** Nothing further will ever happen to this session. */
  terminal: boolean
  /** May the loop move money while the session is here? A hard gate the
   *  settle step consults; the approval policy can only narrow it. */
  moneyMayMove: boolean
  /** May the loop act without a person? `false` means the next transition
   *  is a human's. */
  automatable: boolean
  /** What the next heartbeat does here. */
  onHeartbeat: string
  /** What a fresh process does when it finds a session here after a restart. */
  onRestart: string
}

export const STATUS_META: Record<SessionStatus, StatusMeta> = {
  draft: {
    sentence: 'Goal recorded; nothing has been planned yet.',
    entry: 'SESSION_CREATED.',
    terminal: false,
    moneyMayMove: false,
    automatable: true,
    onHeartbeat: 'Produce a plan (PLAN_CREATED) or fail if the goal is empty.',
    onRestart: 'Plan.',
  },
  planned: {
    sentence: 'The plan exists; the budget has not been checked against it.',
    entry: 'PLAN_CREATED with at least one task.',
    terminal: false,
    moneyMayMove: false,
    automatable: true,
    onHeartbeat: 'Check the budget (BUDGET_CHECKED).',
    onRestart: 'Re-check the budget.',
  },
  awaiting_budget: {
    sentence: 'The plan costs more than the session may spend; waiting for a larger budget.',
    entry: 'BUDGET_CHECKED with ok=false.',
    terminal: false,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing — wait for BUDGET_RAISED or SESSION_CANCELLED.',
    onRestart: 'Wait.',
  },
  ready: {
    sentence: 'Work is ready to dispatch.',
    entry: 'BUDGET_CHECKED ok, or a wave finished and the schedule says go again.',
    terminal: false,
    // An approved task settles from here (APPROVAL_GRANTED returns the
    // session to ready), so this is one of the two statuses money may move in.
    moneyMayMove: true,
    automatable: true,
    onHeartbeat: 'Mark ready tasks (TASK_READY) and dispatch the first (TASK_DISPATCHED → running).',
    onRestart: 'Dispatch.',
  },
  running: {
    sentence: 'A worker is executing a task right now.',
    entry: 'TASK_DISPATCHED, or a run resumed from a checkpoint.',
    terminal: false,
    moneyMayMove: true,
    automatable: true,
    onHeartbeat: 'Read heartbeats; time out silent runs; fold finished runs into TASK_SUBMITTED.',
    onRestart: 'Check the current run: alive → keep waiting; silent past the timeout → waiting_on_worker.',
  },
  waiting_on_dependency: {
    sentence: 'Every remaining task is blocked on one that has not finished.',
    entry: 'No task is ready and at least one is blocked on an unfinished dependency.',
    terminal: false,
    moneyMayMove: false,
    automatable: true,
    onHeartbeat: 'Re-evaluate the graph; a settled dependency unblocks (TASK_READY).',
    onRestart: 'Re-evaluate the graph.',
  },
  waiting_on_worker: {
    sentence: 'The worker went silent; the last checkpoint is preserved and a resume is pending.',
    entry: 'RUN_TIMED_OUT or WORKER_LOST on the current run.',
    terminal: false,
    moneyMayMove: false,
    automatable: true,
    onHeartbeat: 'Reconnect the same worker or choose another; resume from the checkpoint (RUN_RESUMED).',
    onRestart: 'Same as heartbeat — nothing is lost; the checkpoint is on disk.',
  },
  waiting_on_review: {
    sentence: 'A deliverable is in; an independent reviewer has not answered.',
    entry: 'REVIEW_REQUESTED.',
    terminal: false,
    moneyMayMove: false,
    automatable: true,
    onHeartbeat: 'Poll the review; REVIEW_RECEIVED decides the next step.',
    onRestart: 'Poll the review.',
  },
  waiting_on_approval: {
    sentence: 'The policy could not decide alone; a person has to approve or deny.',
    entry: 'APPROVAL_REQUESTED with outcome REQUIRE_OWNER.',
    terminal: false,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing moves. Remind; expire at the deadline.',
    onRestart: 'Wait for the person.',
  },
  paused: {
    sentence: 'Paused by the owner; nothing is dispatched until resumed.',
    entry: 'SESSION_PAUSED from any non-terminal status.',
    terminal: false,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing.',
    onRestart: 'Stay paused.',
  },
  retrying: {
    sentence: 'The last attempt failed; the next one is scheduled.',
    entry: 'RETRY_SCHEDULED after a failed run with attempts left.',
    terminal: false,
    moneyMayMove: false,
    automatable: true,
    onHeartbeat: 'Once nextWakeAt passes, dispatch the retry from the checkpoint.',
    onRestart: 'Same.',
  },
  partially_completed: {
    sentence: 'Finished with some tasks not done — held, failed, or handed to a person.',
    entry: 'SESSION_COMPLETED with partial=true.',
    terminal: true,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing.',
    onRestart: 'Nothing.',
  },
  completed: {
    sentence: 'Every task settled.',
    entry: 'SESSION_COMPLETED with every task settled or skipped.',
    terminal: true,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing.',
    onRestart: 'Nothing.',
  },
  failed: {
    sentence: 'The session cannot continue; the reason is on the record.',
    entry: 'SESSION_FAILED.',
    terminal: true,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing.',
    onRestart: 'Nothing.',
  },
  cancelled: {
    sentence: 'Cancelled by the owner.',
    entry: 'SESSION_CANCELLED.',
    terminal: true,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing. Running runs are told to stop.',
    onRestart: 'Nothing.',
  },
  expired: {
    sentence: 'The deadline passed with work outstanding.',
    entry: 'SESSION_EXPIRED once deadlineAt is behind now.',
    terminal: true,
    moneyMayMove: false,
    automatable: false,
    onHeartbeat: 'Nothing.',
    onRestart: 'Nothing.',
  },
}

export const TERMINAL_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter((s) => STATUS_META[s].terminal)
export const isTerminal = (s: SessionStatus): boolean => STATUS_META[s].terminal

/**
 * Allowed transitions. The reducer refuses anything else, so a status can
 * only be reached along a path the table names. Every non-terminal status
 * may pause, cancel, expire or fail; those four are listed once in
 * `ALWAYS_FROM_LIVE` rather than repeated.
 */
const ALWAYS_FROM_LIVE: readonly SessionStatus[] = ['paused', 'cancelled', 'expired', 'failed']

export const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  draft: ['planned', ...ALWAYS_FROM_LIVE],
  planned: ['awaiting_budget', 'ready', ...ALWAYS_FROM_LIVE],
  awaiting_budget: ['planned', 'ready', ...ALWAYS_FROM_LIVE],
  ready: [
    'planned',
    'running',
    'waiting_on_dependency',
    'waiting_on_worker',
    'waiting_on_review',
    'waiting_on_approval',
    'retrying',
    'completed',
    'partially_completed',
    ...ALWAYS_FROM_LIVE,
  ],
  running: [
    'ready',
    'waiting_on_worker',
    'waiting_on_review',
    'waiting_on_approval',
    'waiting_on_dependency',
    'retrying',
    'completed',
    'partially_completed',
    ...ALWAYS_FROM_LIVE,
  ],
  waiting_on_dependency: ['ready', 'running', 'completed', 'partially_completed', ...ALWAYS_FROM_LIVE],
  waiting_on_worker: ['running', 'retrying', 'ready', 'partially_completed', ...ALWAYS_FROM_LIVE],
  waiting_on_review: ['ready', 'running', 'waiting_on_approval', 'retrying', 'completed', 'partially_completed', ...ALWAYS_FROM_LIVE],
  waiting_on_approval: ['ready', 'running', 'retrying', 'completed', 'partially_completed', ...ALWAYS_FROM_LIVE],
  // Resume returns to `ready`; the loop re-derives the precise waiting
  // status on the next heartbeat from the tasks and runs, which is safer
  // than remembering the status it had (the world moved while paused).
  paused: ['ready', 'cancelled', 'expired', 'failed'],
  // A retry whose worker is gone by the time it is due waits on a worker;
  // one whose dependency failed meanwhile waits on the graph. Found by the
  // end-to-end run: the worker was restarted seconds before the backoff
  // elapsed, read as stale, and the tick threw here instead of waiting.
  retrying: ['running', 'ready', 'waiting_on_worker', 'waiting_on_dependency', 'failed', 'partially_completed', ...ALWAYS_FROM_LIVE],
  partially_completed: [],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from !== to && TRANSITIONS[from].includes(to)
}

/* ── Kinds, policies, grants ──────────────────────────────────────────── */

export const SESSION_KINDS = ['one_shot', 'long_running', 'scheduled', 'event_driven', 'local_coding'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

export type RetryPolicy = {
  maxAttempts: number
  backoffMs: number
  backoffMultiplier: number
  maxBackoffMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 60_000,
  backoffMultiplier: 2,
  maxBackoffMs: 30 * 60_000,
}

/** Delay before attempt `attempt` (1-based) may start, after a failure. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const n = Math.max(1, attempt - 1)
  const raw = policy.backoffMs * Math.pow(policy.backoffMultiplier, n - 1)
  return Math.min(policy.maxBackoffMs, Math.max(0, Math.round(raw)))
}

export type SessionSchedule = { kind: 'interval'; everyMs: number } | { kind: 'daily'; atUtcMinutes: number }

/** The next firing strictly after `now`. */
export function nextScheduledAt(schedule: SessionSchedule, now: number): number {
  if (schedule.kind === 'interval') return now + Math.max(60_000, schedule.everyMs)
  const dayMs = 86_400_000
  const startOfDay = now - (now % dayMs)
  const today = startOfDay + Math.max(0, Math.min(1439, schedule.atUtcMinutes)) * 60_000
  return today > now ? today : today + dayMs
}

/**
 * What a local worker may do on the owner's machine. Set on the platform by
 * the owner, delivered to the worker with every run, and turned into harness
 * flags by lib/coding-harness.ts. The worker enforces what it can (cwd,
 * tool allow-lists); the platform records what was granted so a run that
 * exceeded it is a policy fact, not an opinion.
 */
export type WorkspaceGrant = {
  workdir: string
  write: boolean
  shell: boolean
  network: boolean
  install: boolean
  secrets: boolean
  gitPush: boolean
  externalPayments: boolean
  perTaskLimitUsd: number
  dailyLimitUsd: number
}

export const DEFAULT_WORKSPACE_GRANT: Omit<WorkspaceGrant, 'workdir'> = {
  write: true,
  shell: true,
  network: false,
  install: false,
  secrets: false,
  gitPush: false,
  externalPayments: false,
  perTaskLimitUsd: 3,
  dailyLimitUsd: 20,
}

/* ── The session ──────────────────────────────────────────────────────── */

export type OfficeSession = {
  id: string
  /** The office is (userId, officeSlot); `officeId` is the readable join. */
  userId: string
  officeSlot: number
  officeId: string
  kind: SessionKind
  goal: string
  status: SessionStatus
  /** Why it is in this status, one line, for the page. */
  statusReason: string | null
  priority: number
  createdAt: number
  startedAt: number | null
  lastHeartbeatAt: number | null
  nextWakeAt: number | null
  deadlineAt: number | null
  pausedAt: number | null
  completedAt: number | null
  /** The task the loop is on, or null between tasks. */
  currentNodeId: string | null
  currentRunId: string | null
  budgetLimitUsd: number
  spentUsd: number
  retryPolicy: RetryPolicy
  approvalPolicyId: string
  /** The latest checkpoint any run of this session wrote. */
  checkpointId: string | null
  schedule: SessionSchedule | null
  /** Event kinds that wake an event-driven session (e.g. 'github.ci_failed'). */
  triggers: string[]
  /** The worker a local coding session is bound to. */
  workerAgentId: string | null
  /** The office agent whose wallet escrows any `escrow` task of this session. */
  payerAgentId: string | null
  workspace: WorkspaceGrant | null
  /** The deterministic check a coding task runs after the harness (e.g. `npm test`). */
  verifyCommand: string | null
  /** Repeated runs of a scheduled/event-driven session count up from 1. */
  wave: number
  /** Which office-memory rules were folded into the briefs of this session. */
  memoryRulesUsed: string[]
}

export const officeIdOf = (userId: string, slot: number): string => `${userId}/${slot}`

/* ── Tasks ────────────────────────────────────────────────────────────── */

export const TASK_STATUSES = [
  'pending', // in the plan, dependencies not yet checked
  'blocked', // a dependency is unfinished
  'ready', // may be dispatched
  'dispatched', // handed to a worker; not yet started
  'running', // the worker said it started
  'submitted', // a deliverable is in; verification not started
  'verifying', // deterministic tests / independent review in flight
  'awaiting_approval', // policy said a person decides
  'approved', // may settle
  'settled', // done; money (if any) moved
  'failed', // no attempts left, or unrecoverable
  'cancelled',
  'skipped', // a dependency failed; never attempted
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_TERMINAL: readonly TaskStatus[] = ['settled', 'failed', 'cancelled', 'skipped']

export const TASK_KINDS = ['coding', 'text', 'review', 'verify'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/**
 * How a task's pay is handled.
 *
 *   internal  the office's own worker on the owner's own machine — no
 *             escrow, no bounty, no credit event. Settling records the
 *             decision and the artifact hash and moves nothing.
 *   escrow    posted as an ordinary job (lib/job-post.ts), graded and paid
 *             by the paths every other job uses. The session only decides
 *             WHEN autoApprove may flip on; the release site stays where it is.
 */
export type TaskSettlement = 'internal' | 'escrow'

export type RiskTier = 'E0' | 'E1' | 'E2' | 'E3' | 'E4'

export type VerificationPlan = {
  /** A command the worker runs after the harness, inside the workdir, when
   *  the grant allows shell. Exit 0 is the deterministic layer's PASS. */
  command: string | null
  /** Ask an independent (model) reviewer before deciding. */
  independentReview: boolean
}

export type TestReport = {
  command: string
  exitCode: number | null
  passed: boolean | null
  tail: string
  durationMs: number | null
}

export type ReviewVerdict = {
  reviewer: 'model' | 'agent' | 'owner'
  reviewerId: string | null
  approve: boolean | null
  note: string
  at: number
}

export type TaskOutcome = {
  deliverable: string | null
  diff: string | null
  changedFiles: string[]
  tests: TestReport | null
  review: ReviewVerdict | null
  ciPassed: boolean | null
  costUsd: number | null
  failureCode: string | null
  /** sha256 of the deliverable (or diff) — the artifact this task was decided on. */
  contentHash: string | null
}

export type SessionTask = {
  id: string
  sessionId: string
  wave: number
  title: string
  brief: string
  acceptanceCriteria: string
  kind: TaskKind
  dependsOn: string[]
  status: TaskStatus
  statusReason: string | null
  attempts: number
  maxAttempts: number
  bountyUsd: number
  riskTier: RiskTier
  settlement: TaskSettlement
  /** The posted job's spec hash, when settlement is escrow. */
  specHash: string | null
  onchainJobId: number | null
  assignedWorkerId: string | null
  currentRunId: string | null
  verify: VerificationPlan
  outcome: TaskOutcome | null
  nextRetryAt: number | null
  createdAt: number
  updatedAt: number
}

export const EMPTY_OUTCOME: TaskOutcome = {
  deliverable: null,
  diff: null,
  changedFiles: [],
  tests: null,
  review: null,
  ciPassed: null,
  costUsd: null,
  failureCode: null,
  contentHash: null,
}

/* ── Runs ─────────────────────────────────────────────────────────────── */

export const RUN_STATUSES = [
  'dispatched',
  'started',
  'running',
  'finished',
  'failed',
  'timed_out',
  'cancelled',
  'lost', // the worker never came back and never said why
] as const
export type SessionRunStatus = (typeof RUN_STATUSES)[number]
export const RUN_TERMINAL: readonly SessionRunStatus[] = ['finished', 'failed', 'timed_out', 'cancelled', 'lost']

export type DiffStat = { files: number; additions: number; deletions: number }

export type SessionRun = {
  id: string
  sessionId: string
  taskId: string
  attempt: number
  workerAgentId: string
  harnessId: string | null
  status: SessionRunStatus
  dispatchedAt: number
  startedAt: number | null
  lastHeartbeatAt: number | null
  finishedAt: number | null
  exitCode: number | null
  failureCode: string | null
  /** Latest checkpoint this run wrote. */
  checkpointId: string | null
  /** The checkpoint this run began from, when it is a resume. */
  resumedFromCheckpointId: string | null
  changedFiles: string[]
  diffStat: DiffStat | null
  costUsd: number | null
  tokensUsed: number | null
  /** Set when the platform asked the worker to stop. */
  cancelRequestedAt: number | null
}

/* ── Checkpoints ──────────────────────────────────────────────────────── */

export type Checkpoint = {
  id: string
  sessionId: string
  taskId: string
  runId: string
  seq: number
  at: number
  summary: string
  /** `git rev-parse HEAD` in the workdir, when it is a repository. */
  gitHead: string | null
  /** A bounded unified diff of the workspace at this point — what a
   *  different worker needs to continue. Null when nothing changed. */
  patch: string | null
  filesChanged: string[]
}

export const CHECKPOINT_PATCH_MAX_CHARS = 200_000

/* ── Approvals & artifacts ────────────────────────────────────────────── */

export type ApprovalOutcome = 'ALLOW' | 'ALLOW_WITH_LOG' | 'REQUIRE_OWNER' | 'REQUIRE_REVIEWER' | 'DENY'

export type ApprovalRecord = {
  id: string
  sessionId: string
  taskId: string
  requestedAt: number
  /** The policy engine's verdict — always recorded, even when a person overrode it. */
  policyOutcome: ApprovalOutcome
  policyId: string
  policyVersion: number
  /** The evidence the engine read, verbatim, so the decision is auditable. */
  evidence: Record<string, unknown>
  reasons: string[]
  /** Who made the final call. `policy` for ALLOW/ALLOW_WITH_LOG. */
  decidedBy: 'policy' | 'owner' | 'reviewer' | null
  decidedById: string | null
  decidedAt: number | null
  granted: boolean | null
  amountUsd: number
  /** What actually moved, if anything. Null for internal tasks. */
  moved: { txHash: string | null; amountUsd: number; at: number } | null
}

export const ARTIFACT_KINDS = ['diff', 'file', 'report', 'log', 'proof', 'test_report', 'deliverable'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export type SessionArtifact = {
  id: string
  sessionId: string
  taskId: string
  runId: string | null
  kind: ArtifactKind
  name: string
  sha256: string
  bytes: number
  /** Stored inline when small; otherwise `ref` points at the store. */
  inline: string | null
  ref: string | null
  createdAt: number
}

/* ── Events ───────────────────────────────────────────────────────────── */

export const SESSION_EVENT_TYPES = [
  'SESSION_CREATED',
  'PLAN_CREATED',
  'BUDGET_CHECKED',
  'BUDGET_RAISED',
  'TASK_READY',
  'TASK_BLOCKED',
  'TASK_SKIPPED',
  'TASK_DISPATCHED',
  'TASK_POSTED',
  'WORKER_CONNECTED',
  'RUN_STARTED',
  'RUN_PROGRESS',
  'RUN_HEARTBEAT',
  'CHECKPOINT_CREATED',
  'ARTIFACT_CREATED',
  'RUN_FINISHED',
  'RUN_FAILED',
  'RUN_TIMED_OUT',
  'RUN_CANCEL_REQUESTED',
  'RUN_CANCELLED',
  'RUN_RESUMED',
  'WORKER_LOST',
  'TASK_SUBMITTED',
  'VERIFICATION_STARTED',
  'TEST_REPORTED',
  'REVIEW_REQUESTED',
  'REVIEW_RECEIVED',
  'APPROVAL_REQUESTED',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_SETTLED',
  'TASK_SETTLED',
  'TASK_FAILED',
  'RETRY_SCHEDULED',
  'SESSION_PAUSED',
  'SESSION_RESUMED',
  'SESSION_ESCALATED',
  'SESSION_WAITING',
  'WAVE_STARTED',
  'WAKE_SCHEDULED',
  'SESSION_COMPLETED',
  'SESSION_FAILED',
  'SESSION_CANCELLED',
  'SESSION_EXPIRED',
  'MEMORY_RECORDED',
] as const
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

export type ActorType = 'user' | 'office' | 'worker' | 'reviewer' | 'system'

export type SessionEvent = {
  id: string
  sessionId: string
  type: SessionEventType
  occurredAt: number
  actorType: ActorType
  actorId: string | null
  payload: Record<string, unknown>
  /** Two events with the same key are one event. */
  idempotencyKey: string
}

/** What a producer hands to the store; id and key can be derived. */
export type NewEvent = Omit<SessionEvent, 'id' | 'sessionId'> & { idempotencyKey?: string }

/** `sessionId:TYPE:discriminator` — stable across retries of the same act. */
export function eventKey(sessionId: string, type: SessionEventType, discriminator: string): string {
  return `${sessionId}:${type}:${discriminator}`
}

/* ── State ────────────────────────────────────────────────────────────── */

export type SessionState = {
  session: OfficeSession
  tasks: Record<string, SessionTask>
  runs: Record<string, SessionRun>
  checkpoints: Record<string, Checkpoint>
  approvals: Record<string, ApprovalRecord>
  artifacts: Record<string, SessionArtifact>
  /** Idempotency keys already applied — replay drops duplicates. */
  applied: string[]
  /** Count of events folded in, so a stale materialized row is detectable. */
  version: number
}

export class InvalidTransition extends Error {
  constructor(
    public readonly from: SessionStatus,
    public readonly to: SessionStatus,
    public readonly event: SessionEventType,
  ) {
    super(`office-session: ${event} cannot move a session from ${from} to ${to}`)
  }
}

export class InvalidEvent extends Error {
  constructor(message: string) {
    super(`office-session: ${message}`)
  }
}

/* ── Payload shapes (the reducer reads these; producers write them) ─── */

export type SessionCreatedPayload = {
  userId: string
  officeSlot: number
  kind: SessionKind
  goal: string
  priority?: number
  budgetLimitUsd: number
  deadlineAt?: number | null
  retryPolicy?: Partial<RetryPolicy>
  approvalPolicyId?: string
  schedule?: SessionSchedule | null
  triggers?: string[]
  workerAgentId?: string | null
  payerAgentId?: string | null
  workspace?: WorkspaceGrant | null
  verifyCommand?: string | null
  memoryRulesUsed?: string[]
}

export type PlannedTask = Pick<SessionTask, 'id' | 'title' | 'brief' | 'acceptanceCriteria' | 'kind'> &
  Partial<Pick<SessionTask, 'dependsOn' | 'maxAttempts' | 'bountyUsd' | 'riskTier' | 'settlement' | 'verify' | 'assignedWorkerId'>>

export type PlanCreatedPayload = { tasks: PlannedTask[]; wave?: number; source: 'default' | 'llm' | 'owner' }

/* ── The reducer ──────────────────────────────────────────────────────── */

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function requireTask(state: SessionState, id: unknown, event: SessionEventType): SessionTask {
  const task = typeof id === 'string' ? state.tasks[id] : undefined
  if (!task) throw new InvalidEvent(`${event} names task ${String(id)} which is not in the plan`)
  return task
}
function requireRun(state: SessionState, id: unknown, event: SessionEventType): SessionRun {
  const run = typeof id === 'string' ? state.runs[id] : undefined
  if (!run) throw new InvalidEvent(`${event} names run ${String(id)} which does not exist`)
  return run
}

function move(state: SessionState, to: SessionStatus, event: SessionEventType, reason: string | null, at: number): void {
  const from = state.session.status
  if (from === to) {
    state.session.statusReason = reason ?? state.session.statusReason
    return
  }
  if (!canTransition(from, to)) throw new InvalidTransition(from, to, event)
  state.session.status = to
  state.session.statusReason = reason
  if (to === 'paused') state.session.pausedAt = at
  if (from === 'paused') state.session.pausedAt = null
  if (STATUS_META[to].terminal) {
    state.session.completedAt = at
    state.session.nextWakeAt = null
    state.session.currentRunId = null
  }
}

function setTask(state: SessionState, task: SessionTask, status: TaskStatus, reason: string | null, at: number): void {
  task.status = status
  task.statusReason = reason
  task.updatedAt = at
}

function setRun(run: SessionRun, status: SessionRunStatus, at: number): void {
  run.status = status
  if (RUN_TERMINAL.includes(status)) run.finishedAt = run.finishedAt ?? at
}

/** Every task done in a way that needs no further action. */
export function allTasksTerminal(state: SessionState): boolean {
  return Object.values(state.tasks).every((t) => TASK_TERMINAL.includes(t.status))
}

export function tasksOfWave(state: SessionState, wave = state.session.wave): SessionTask[] {
  return Object.values(state.tasks).filter((t) => t.wave === wave)
}

/**
 * Fold one event in. Mutates a COPY of the state so callers can keep the
 * previous one (a tick that fails halfway must not have half-applied).
 * Duplicate idempotency keys are a no-op — the store may deliver the same
 * event twice on a retried write, and replay must not double-count.
 */
export function applyEvent(prev: SessionState, event: SessionEvent): SessionState {
  if (prev.applied.includes(event.idempotencyKey)) return prev
  const state: SessionState = structuredClone(prev)
  state.applied.push(event.idempotencyKey)
  state.version += 1
  const at = event.occurredAt
  const p = event.payload
  const s = state.session
  s.lastHeartbeatAt = Math.max(s.lastHeartbeatAt ?? 0, at)

  switch (event.type) {
    case 'SESSION_CREATED':
      throw new InvalidEvent('SESSION_CREATED can only be the first event (use initialState)')

    case 'PLAN_CREATED': {
      const payload = p as unknown as PlanCreatedPayload
      if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) throw new InvalidEvent('PLAN_CREATED with no tasks')
      const wave = num(payload.wave, s.wave)
      for (const t of payload.tasks) {
        if (state.tasks[t.id]) throw new InvalidEvent(`PLAN_CREATED repeats task id ${t.id}`)
        const verify: VerificationPlan = t.verify ?? { command: null, independentReview: true }
        state.tasks[t.id] = {
          id: t.id,
          sessionId: s.id,
          wave,
          title: t.title,
          brief: t.brief,
          acceptanceCriteria: t.acceptanceCriteria,
          kind: t.kind,
          dependsOn: t.dependsOn ?? [],
          status: 'pending',
          statusReason: null,
          attempts: 0,
          maxAttempts: t.maxAttempts ?? s.retryPolicy.maxAttempts,
          bountyUsd: t.bountyUsd ?? 0,
          riskTier: t.riskTier ?? 'E1',
          settlement: t.settlement ?? 'internal',
          specHash: null,
          onchainJobId: null,
          assignedWorkerId: t.assignedWorkerId ?? s.workerAgentId,
          currentRunId: null,
          verify,
          outcome: null,
          nextRetryAt: null,
          createdAt: at,
          updatedAt: at,
        }
      }
      for (const t of payload.tasks) {
        for (const dep of t.dependsOn ?? []) {
          if (!state.tasks[dep]) throw new InvalidEvent(`task ${t.id} depends on ${dep}, which is not in the plan`)
        }
      }
      if (s.status === 'draft' || s.status === 'ready') move(state, 'planned', event.type, `plan of ${payload.tasks.length} task(s) from ${payload.source}`, at)
      break
    }

    case 'BUDGET_CHECKED': {
      const ok = p.ok === true
      const planned = num(p.plannedUsd, 0)
      if (ok) move(state, 'ready', event.type, `plan costs $${planned.toFixed(2)} of $${s.budgetLimitUsd.toFixed(2)}`, at)
      else move(state, 'awaiting_budget', event.type, `plan costs $${planned.toFixed(2)}; budget is $${s.budgetLimitUsd.toFixed(2)}`, at)
      if (s.startedAt === null && ok) s.startedAt = at
      break
    }

    case 'BUDGET_RAISED': {
      const to = num(p.budgetLimitUsd, s.budgetLimitUsd)
      if (to < s.spentUsd) throw new InvalidEvent('budget cannot be lowered below what was already spent')
      s.budgetLimitUsd = to
      if (s.status === 'awaiting_budget') move(state, 'planned', event.type, 'budget raised — re-checking', at)
      break
    }

    case 'TASK_READY': {
      const task = requireTask(state, p.taskId, event.type)
      if (TASK_TERMINAL.includes(task.status)) throw new InvalidEvent(`task ${task.id} is ${task.status}; cannot become ready`)
      setTask(state, task, 'ready', null, at)
      break
    }

    case 'TASK_BLOCKED': {
      const task = requireTask(state, p.taskId, event.type)
      if (task.status === 'pending' || task.status === 'ready' || task.status === 'blocked') {
        setTask(state, task, 'blocked', str(p.reason), at)
      }
      break
    }

    case 'TASK_SKIPPED': {
      const task = requireTask(state, p.taskId, event.type)
      if (!TASK_TERMINAL.includes(task.status)) setTask(state, task, 'skipped', str(p.reason) ?? 'dependency failed', at)
      break
    }

    case 'TASK_DISPATCHED': {
      const task = requireTask(state, p.taskId, event.type)
      const runId = str(p.runId)
      const workerAgentId = str(p.workerAgentId)
      if (!runId || !workerAgentId) throw new InvalidEvent('TASK_DISPATCHED needs runId and workerAgentId')
      if (state.runs[runId]) throw new InvalidEvent(`run ${runId} already exists`)
      if (task.status !== 'ready') throw new InvalidEvent(`task ${task.id} is ${task.status}; only a ready task can be dispatched`)
      if (task.attempts >= task.maxAttempts) throw new InvalidEvent(`task ${task.id} has no attempts left (${task.attempts}/${task.maxAttempts})`)
      task.attempts += 1
      task.assignedWorkerId = workerAgentId
      task.currentRunId = runId
      task.nextRetryAt = null
      setTask(state, task, 'dispatched', null, at)
      state.runs[runId] = {
        id: runId,
        sessionId: s.id,
        taskId: task.id,
        attempt: task.attempts,
        workerAgentId,
        harnessId: str(p.harnessId),
        status: 'dispatched',
        dispatchedAt: at,
        startedAt: null,
        lastHeartbeatAt: null,
        finishedAt: null,
        exitCode: null,
        failureCode: null,
        checkpointId: null,
        resumedFromCheckpointId: str(p.resumedFromCheckpointId),
        changedFiles: [],
        diffStat: null,
        costUsd: null,
        tokensUsed: null,
        cancelRequestedAt: null,
      }
      s.currentNodeId = task.id
      s.currentRunId = runId
      if (s.startedAt === null) s.startedAt = at
      move(state, 'running', event.type, `${task.title} → ${workerAgentId}`, at)
      break
    }

    case 'TASK_POSTED': {
      // An escrow task handed to the market: no run of ours, the chain and
      // the job's own grading path carry it from here; the loop observes.
      const task = requireTask(state, p.taskId, event.type)
      const specHash = str(p.specHash)
      if (!specHash) throw new InvalidEvent('TASK_POSTED needs specHash')
      if (task.status !== 'ready') throw new InvalidEvent(`task ${task.id} is ${task.status}; only a ready task can be posted`)
      task.specHash = specHash
      task.onchainJobId = typeof p.onchainJobId === 'number' ? p.onchainJobId : null
      task.attempts += 1
      setTask(state, task, 'dispatched', 'posted to the market', at)
      break
    }

    case 'WORKER_CONNECTED': {
      const workerAgentId = str(p.workerAgentId)
      if (workerAgentId) s.workerAgentId = workerAgentId
      if (p.workspace && typeof p.workspace === 'object') s.workspace = p.workspace as WorkspaceGrant
      break
    }

    case 'RUN_STARTED': {
      const run = requireRun(state, p.runId, event.type)
      if (RUN_TERMINAL.includes(run.status)) throw new InvalidEvent(`run ${run.id} is ${run.status}; cannot start`)
      run.startedAt = run.startedAt ?? at
      run.lastHeartbeatAt = at
      setRun(run, 'running', at)
      const task = state.tasks[run.taskId]
      if (task) setTask(state, task, 'running', null, at)
      if (s.status === 'waiting_on_worker' || s.status === 'retrying') move(state, 'running', event.type, null, at)
      break
    }

    case 'RUN_HEARTBEAT':
    case 'RUN_PROGRESS': {
      const run = requireRun(state, p.runId, event.type)
      if (RUN_TERMINAL.includes(run.status)) break // late telemetry from a run already closed — keep, ignore
      run.lastHeartbeatAt = at
      if (run.status === 'dispatched') {
        run.startedAt = run.startedAt ?? at
        setRun(run, 'running', at)
        const task = state.tasks[run.taskId]
        if (task) setTask(state, task, 'running', null, at)
      }
      const files = strList(p.changedFiles)
      if (files.length) run.changedFiles = [...new Set([...run.changedFiles, ...files])]
      if (typeof p.tokensUsed === 'number') run.tokensUsed = p.tokensUsed
      if (typeof p.costUsd === 'number') run.costUsd = p.costUsd
      break
    }

    case 'CHECKPOINT_CREATED': {
      const run = requireRun(state, p.runId, event.type)
      const id = str(p.checkpointId)
      if (!id) throw new InvalidEvent('CHECKPOINT_CREATED needs checkpointId')
      const patch = str(p.patch)
      const cp: Checkpoint = {
        id,
        sessionId: s.id,
        taskId: run.taskId,
        runId: run.id,
        seq: num(p.seq, 0),
        at,
        summary: str(p.summary) ?? '',
        gitHead: str(p.gitHead),
        patch: patch && patch.length > CHECKPOINT_PATCH_MAX_CHARS ? null : patch,
        filesChanged: strList(p.filesChanged),
      }
      state.checkpoints[id] = cp
      run.checkpointId = id
      s.checkpointId = id
      if (cp.filesChanged.length) run.changedFiles = [...new Set([...run.changedFiles, ...cp.filesChanged])]
      break
    }

    case 'ARTIFACT_CREATED': {
      const id = str(p.artifactId)
      const taskId = str(p.taskId)
      if (!id || !taskId) throw new InvalidEvent('ARTIFACT_CREATED needs artifactId and taskId')
      requireTask(state, taskId, event.type)
      const kind = ARTIFACT_KINDS.includes(p.kind as ArtifactKind) ? (p.kind as ArtifactKind) : 'file'
      state.artifacts[id] = {
        id,
        sessionId: s.id,
        taskId,
        runId: str(p.runId),
        kind,
        name: str(p.name) ?? id,
        sha256: str(p.sha256) ?? '',
        bytes: num(p.bytes, 0),
        inline: str(p.inline),
        ref: str(p.ref),
        createdAt: at,
      }
      break
    }

    case 'RUN_FINISHED': {
      const run = requireRun(state, p.runId, event.type)
      if (RUN_TERMINAL.includes(run.status)) break
      run.exitCode = typeof p.exitCode === 'number' ? p.exitCode : null
      run.lastHeartbeatAt = at
      const files = strList(p.changedFiles)
      if (files.length) run.changedFiles = [...new Set([...run.changedFiles, ...files])]
      if (p.diffStat && typeof p.diffStat === 'object') run.diffStat = p.diffStat as DiffStat
      if (typeof p.costUsd === 'number') run.costUsd = p.costUsd
      if (typeof p.tokensUsed === 'number') run.tokensUsed = p.tokensUsed
      setRun(run, 'finished', at)
      break
    }

    case 'RUN_FAILED':
    case 'RUN_TIMED_OUT':
    case 'WORKER_LOST':
    case 'RUN_CANCELLED': {
      const run = requireRun(state, p.runId, event.type)
      if (RUN_TERMINAL.includes(run.status)) break
      run.failureCode = str(p.failureCode)
      run.exitCode = typeof p.exitCode === 'number' ? p.exitCode : run.exitCode
      const status: SessionRunStatus =
        event.type === 'RUN_FAILED' ? 'failed' : event.type === 'RUN_TIMED_OUT' ? 'timed_out' : event.type === 'WORKER_LOST' ? 'lost' : 'cancelled'
      setRun(run, status, at)
      const task = state.tasks[run.taskId]
      if (task && task.currentRunId === run.id) {
        task.currentRunId = null
        // Back to `ready`, not straight to a retry: whether this task is
        // retried, resumed or failed is the loop's decision on the next
        // heartbeat, and until then the task must not read as dispatched.
        if (task.status === 'dispatched' || task.status === 'running') {
          setTask(state, task, 'ready', `run ${status}${run.failureCode ? ` (${run.failureCode})` : ''}`, at)
        }
      }
      if (s.currentRunId === run.id) s.currentRunId = null
      if (!STATUS_META[s.status].terminal && s.status !== 'paused') {
        if (event.type === 'RUN_TIMED_OUT' || event.type === 'WORKER_LOST') {
          move(state, 'waiting_on_worker', event.type, str(p.reason) ?? `run ${run.id} ${status}`, at)
        } else if (s.status === 'running' && s.currentRunId === null) {
          move(state, 'ready', event.type, str(p.reason) ?? `run ${run.id} ${status}`, at)
        }
      }
      break
    }

    case 'RUN_CANCEL_REQUESTED': {
      const run = requireRun(state, p.runId, event.type)
      if (!RUN_TERMINAL.includes(run.status)) run.cancelRequestedAt = at
      break
    }

    case 'RUN_RESUMED': {
      // A resume is a new dispatch that names the checkpoint; the producer
      // emits TASK_DISPATCHED with resumedFromCheckpointId. This event only
      // records the intent on the timeline.
      break
    }

    case 'TASK_SUBMITTED': {
      const task = requireTask(state, p.taskId, event.type)
      if (TASK_TERMINAL.includes(task.status)) throw new InvalidEvent(`task ${task.id} is ${task.status}; cannot accept a submission`)
      const outcome: TaskOutcome = { ...(task.outcome ?? EMPTY_OUTCOME) }
      if (typeof p.deliverable === 'string') outcome.deliverable = p.deliverable
      if (typeof p.diff === 'string') outcome.diff = p.diff
      const files = strList(p.changedFiles)
      if (files.length) outcome.changedFiles = files
      if (typeof p.contentHash === 'string') outcome.contentHash = p.contentHash
      if (typeof p.costUsd === 'number') outcome.costUsd = p.costUsd
      task.outcome = outcome
      task.currentRunId = null
      setTask(state, task, 'submitted', null, at)
      if (s.currentNodeId === task.id) s.currentRunId = null
      // The deliverable is in; what happens next (tests, review, policy) is
      // verification, and the session waits on it rather than on a worker.
      if (s.status === 'running') move(state, 'waiting_on_review', event.type, `${task.title}: deliverable in, verifying`, at)
      break
    }

    case 'VERIFICATION_STARTED': {
      const task = requireTask(state, p.taskId, event.type)
      if (task.status === 'submitted') setTask(state, task, 'verifying', str(p.layers), at)
      break
    }

    case 'TEST_REPORTED': {
      const task = requireTask(state, p.taskId, event.type)
      const report = p.report as TestReport | undefined
      if (!report || typeof report !== 'object') throw new InvalidEvent('TEST_REPORTED needs report')
      task.outcome = { ...(task.outcome ?? EMPTY_OUTCOME), tests: report }
      if (typeof p.ciPassed === 'boolean') task.outcome.ciPassed = p.ciPassed
      task.updatedAt = at
      break
    }

    case 'REVIEW_REQUESTED': {
      const task = requireTask(state, p.taskId, event.type)
      if (task.status === 'submitted' || task.status === 'verifying') setTask(state, task, 'verifying', 'independent review', at)
      if (!STATUS_META[s.status].terminal && s.status !== 'paused') move(state, 'waiting_on_review', event.type, `${task.title}: review requested`, at)
      break
    }

    case 'REVIEW_RECEIVED': {
      const task = requireTask(state, p.taskId, event.type)
      const verdict = p.verdict as ReviewVerdict | undefined
      if (!verdict || typeof verdict !== 'object') throw new InvalidEvent('REVIEW_RECEIVED needs verdict')
      task.outcome = { ...(task.outcome ?? EMPTY_OUTCOME), review: verdict }
      task.updatedAt = at
      break
    }

    case 'APPROVAL_REQUESTED': {
      const task = requireTask(state, p.taskId, event.type)
      const id = str(p.approvalId)
      if (!id) throw new InvalidEvent('APPROVAL_REQUESTED needs approvalId')
      const outcome = p.policyOutcome as ApprovalOutcome
      state.approvals[id] = {
        id,
        sessionId: s.id,
        taskId: task.id,
        requestedAt: at,
        policyOutcome: outcome,
        policyId: str(p.policyId) ?? s.approvalPolicyId,
        policyVersion: num(p.policyVersion, 0),
        evidence: (p.evidence as Record<string, unknown>) ?? {},
        reasons: strList(p.reasons),
        decidedBy: null,
        decidedById: null,
        decidedAt: null,
        granted: null,
        amountUsd: num(p.amountUsd, task.bountyUsd),
        moved: null,
      }
      if (outcome === 'REQUIRE_OWNER' || outcome === 'REQUIRE_REVIEWER') {
        setTask(state, task, 'awaiting_approval', outcome === 'REQUIRE_OWNER' ? 'owner must approve' : 'reviewer must approve', at)
        if (!STATUS_META[s.status].terminal && s.status !== 'paused') {
          move(state, 'waiting_on_approval', event.type, `${task.title}: ${outcome === 'REQUIRE_OWNER' ? 'your approval needed' : 'reviewer approval needed'}`, at)
        }
      }
      break
    }

    case 'APPROVAL_GRANTED':
    case 'APPROVAL_DENIED': {
      const id = str(p.approvalId)
      const approval = id ? state.approvals[id] : undefined
      if (!approval) throw new InvalidEvent(`${event.type} names approval ${String(id)} which was never requested`)
      if (approval.decidedAt !== null) break // decided once; a second answer is not a second decision
      const task = requireTask(state, approval.taskId, event.type)
      const decidedBy = p.decidedBy === 'owner' || p.decidedBy === 'reviewer' ? p.decidedBy : 'policy'
      if (decidedBy === 'policy' && (approval.policyOutcome === 'REQUIRE_OWNER' || approval.policyOutcome === 'REQUIRE_REVIEWER')) {
        throw new InvalidEvent(`approval ${id} required a ${approval.policyOutcome === 'REQUIRE_OWNER' ? 'owner' : 'reviewer'}; the policy cannot decide it`)
      }
      approval.decidedBy = decidedBy
      approval.decidedById = str(p.decidedById)
      approval.decidedAt = at
      approval.granted = event.type === 'APPROVAL_GRANTED'
      if (approval.granted) {
        setTask(state, task, 'approved', `approved by ${decidedBy}`, at)
      } else {
        setTask(state, task, 'failed', str(p.reason) ?? `denied by ${decidedBy}`, at)
        task.outcome = { ...(task.outcome ?? EMPTY_OUTCOME), failureCode: str(p.failureCode) ?? 'APPROVAL_DENIED' }
      }
      if (s.status === 'waiting_on_approval' || s.status === 'waiting_on_review') move(state, 'ready', event.type, null, at)
      break
    }

    case 'PAYMENT_AUTHORIZED': {
      const id = str(p.approvalId)
      const approval = id ? state.approvals[id] : undefined
      if (!approval) throw new InvalidEvent('PAYMENT_AUTHORIZED names an unknown approval')
      if (approval.granted !== true) throw new InvalidEvent('PAYMENT_AUTHORIZED on an approval that was not granted')
      if (!STATUS_META[s.status].moneyMayMove) throw new InvalidEvent(`money may not be authorized while the session is ${s.status}`)
      break
    }

    case 'PAYMENT_SETTLED': {
      const id = str(p.approvalId)
      const approval = id ? state.approvals[id] : undefined
      if (!approval) throw new InvalidEvent('PAYMENT_SETTLED names an unknown approval')
      if (approval.moved) break // settled once
      const amount = num(p.amountUsd, approval.amountUsd)
      approval.moved = { txHash: str(p.txHash), amountUsd: amount, at }
      s.spentUsd = Math.round((s.spentUsd + amount) * 100) / 100
      break
    }

    case 'TASK_SETTLED': {
      const task = requireTask(state, p.taskId, event.type)
      if (task.status === 'settled') break
      if (task.status !== 'approved') throw new InvalidEvent(`task ${task.id} is ${task.status}; only an approved task settles`)
      if (task.settlement === 'escrow') {
        const paid = Object.values(state.approvals).some((a) => a.taskId === task.id && a.moved)
        if (!paid) throw new InvalidEvent(`escrow task ${task.id} cannot settle before PAYMENT_SETTLED`)
      }
      setTask(state, task, 'settled', str(p.reason), at)
      if (typeof p.costUsd === 'number') task.outcome = { ...(task.outcome ?? EMPTY_OUTCOME), costUsd: p.costUsd }
      if (s.currentNodeId === task.id) s.currentNodeId = null
      break
    }

    case 'TASK_FAILED': {
      const task = requireTask(state, p.taskId, event.type)
      if (TASK_TERMINAL.includes(task.status)) break
      setTask(state, task, 'failed', str(p.reason), at)
      task.outcome = { ...(task.outcome ?? EMPTY_OUTCOME), failureCode: str(p.failureCode) ?? 'TASK_FAILED' }
      task.currentRunId = null
      if (s.currentNodeId === task.id) {
        s.currentNodeId = null
        s.currentRunId = null
      }
      break
    }

    case 'RETRY_SCHEDULED': {
      const task = requireTask(state, p.taskId, event.type)
      if (TASK_TERMINAL.includes(task.status)) throw new InvalidEvent(`task ${task.id} is ${task.status}; nothing to retry`)
      if (task.attempts >= task.maxAttempts) throw new InvalidEvent(`task ${task.id} has no attempts left (${task.attempts}/${task.maxAttempts})`)
      task.nextRetryAt = num(p.at, at)
      task.currentRunId = null
      setTask(state, task, 'ready', str(p.reason) ?? 'retry scheduled', at)
      s.nextWakeAt = task.nextRetryAt
      if (!STATUS_META[s.status].terminal && s.status !== 'paused') move(state, 'retrying', event.type, `${task.title}: attempt ${task.attempts + 1} of ${task.maxAttempts}`, at)
      break
    }

    case 'SESSION_PAUSED':
      move(state, 'paused', event.type, str(p.reason) ?? 'paused by owner', at)
      break

    case 'SESSION_RESUMED':
      if (s.status !== 'paused') throw new InvalidEvent('only a paused session resumes')
      move(state, 'ready', event.type, 'resumed', at)
      break

    case 'SESSION_ESCALATED': {
      // A person is named; the session waits on them. Recorded on the
      // timeline; the status is whatever waiting state the escalation came from.
      s.statusReason = str(p.reason) ?? s.statusReason
      break
    }

    case 'SESSION_WAITING': {
      const to = p.status as SessionStatus
      if (to !== 'waiting_on_dependency' && to !== 'waiting_on_review' && to !== 'waiting_on_worker' && to !== 'ready') {
        throw new InvalidEvent(`SESSION_WAITING cannot target ${String(to)}`)
      }
      move(state, to, event.type, str(p.reason), at)
      break
    }

    case 'WAVE_STARTED': {
      s.wave = num(p.wave, s.wave + 1)
      s.currentNodeId = null
      s.currentRunId = null
      // A new wave re-plans; the previous wave's tasks stay on the record.
      if (s.status !== 'draft') move(state, 'ready', event.type, `wave ${s.wave}`, at)
      break
    }

    case 'WAKE_SCHEDULED': {
      s.nextWakeAt = typeof p.at === 'number' ? p.at : null
      break
    }

    case 'SESSION_COMPLETED': {
      const partial = p.partial === true
      move(state, partial ? 'partially_completed' : 'completed', event.type, str(p.reason), at)
      break
    }

    case 'SESSION_FAILED':
      move(state, 'failed', event.type, str(p.reason) ?? 'failed', at)
      break

    case 'SESSION_CANCELLED':
      move(state, 'cancelled', event.type, str(p.reason) ?? 'cancelled by owner', at)
      for (const run of Object.values(state.runs)) {
        if (!RUN_TERMINAL.includes(run.status)) run.cancelRequestedAt = run.cancelRequestedAt ?? at
      }
      for (const task of Object.values(state.tasks)) {
        if (!TASK_TERMINAL.includes(task.status)) setTask(state, task, 'cancelled', 'session cancelled', at)
      }
      break

    case 'SESSION_EXPIRED':
      move(state, 'expired', event.type, 'deadline passed', at)
      break

    case 'MEMORY_RECORDED':
      break

    default: {
      const never: never = event.type
      throw new InvalidEvent(`unknown event type ${String(never)}`)
    }
  }
  return state
}

/** The state a SESSION_CREATED event produces. */
export function initialState(event: SessionEvent): SessionState {
  if (event.type !== 'SESSION_CREATED') throw new InvalidEvent('the first event must be SESSION_CREATED')
  const p = event.payload as unknown as SessionCreatedPayload
  if (!p.goal || typeof p.goal !== 'string' || !p.goal.trim()) throw new InvalidEvent('a session needs a goal')
  if (!SESSION_KINDS.includes(p.kind)) throw new InvalidEvent(`unknown session kind ${String(p.kind)}`)
  const budget = num(p.budgetLimitUsd, NaN)
  if (!Number.isFinite(budget) || budget < 0) throw new InvalidEvent('budgetLimitUsd must be a non-negative number')
  const session: OfficeSession = {
    id: event.sessionId,
    userId: p.userId,
    officeSlot: p.officeSlot,
    officeId: officeIdOf(p.userId, p.officeSlot),
    kind: p.kind,
    goal: p.goal.trim(),
    status: 'draft',
    statusReason: null,
    priority: num(p.priority, 0),
    createdAt: event.occurredAt,
    startedAt: null,
    lastHeartbeatAt: event.occurredAt,
    nextWakeAt: event.occurredAt,
    deadlineAt: typeof p.deadlineAt === 'number' ? p.deadlineAt : null,
    pausedAt: null,
    completedAt: null,
    currentNodeId: null,
    currentRunId: null,
    budgetLimitUsd: budget,
    spentUsd: 0,
    retryPolicy: { ...DEFAULT_RETRY_POLICY, ...(p.retryPolicy ?? {}) },
    approvalPolicyId: p.approvalPolicyId ?? 'default',
    checkpointId: null,
    schedule: p.schedule ?? null,
    triggers: p.triggers ?? [],
    workerAgentId: p.workerAgentId ?? null,
    payerAgentId: p.payerAgentId ?? null,
    workspace: p.workspace ?? null,
    verifyCommand: typeof p.verifyCommand === 'string' && p.verifyCommand.trim() ? p.verifyCommand.trim() : null,
    wave: 1,
    memoryRulesUsed: p.memoryRulesUsed ?? [],
  }
  return {
    session,
    tasks: {},
    runs: {},
    checkpoints: {},
    approvals: {},
    artifacts: {},
    applied: [event.idempotencyKey],
    version: 1,
  }
}

/** Rebuild the state from the log alone. Events must be in occurrence order. */
export function replay(events: readonly SessionEvent[]): SessionState {
  if (events.length === 0) throw new InvalidEvent('cannot replay an empty log')
  let state = initialState(events[0])
  for (let i = 1; i < events.length; i++) state = applyEvent(state, events[i])
  return state
}

/* ── Invariants ───────────────────────────────────────────────────────── */

/**
 * What must hold in every reachable state. Returns the violations; an empty
 * list is the healthy answer. Tests run this after every event in every
 * scenario, and the store may run it after every append and refuse the
 * write on a violation — a session that can be observed in a contradictory
 * state is worse than a session that refuses to move.
 */
export function sessionInvariants(state: SessionState): string[] {
  const out: string[] = []
  const s = state.session
  const tasks = Object.values(state.tasks)
  const runs = Object.values(state.runs)
  const liveRuns = runs.filter((r) => !RUN_TERMINAL.includes(r.status))
  const openEscrow = tasks.filter((t) => t.settlement === 'escrow' && !TASK_TERMINAL.includes(t.status))

  if (!SESSION_STATUSES.includes(s.status)) out.push(`unknown status ${s.status}`)

  if (s.status === 'completed') {
    if (openEscrow.length) out.push(`completed session has ${openEscrow.length} open escrow task(s)`)
    if (!allTasksTerminal(state)) out.push('completed session has a task that is not terminal')
    if (tasks.some((t) => t.status === 'failed')) out.push('completed session has a failed task (should be partially_completed)')
  }
  if (s.status === 'partially_completed' && !allTasksTerminal(state)) out.push('partially completed session has a task still open')
  if (s.status === 'cancelled' && liveRuns.some((r) => r.cancelRequestedAt === null)) {
    out.push('cancelled session has a live run that was not told to stop')
  }
  if (STATUS_META[s.status].terminal) {
    if (s.currentRunId !== null) out.push(`terminal session (${s.status}) still names a current run`)
    if (s.nextWakeAt !== null) out.push(`terminal session (${s.status}) still has a wake scheduled`)
  }
  if (s.status === 'running') {
    if (!s.currentRunId) out.push('running session has no current run')
    else {
      const run = state.runs[s.currentRunId]
      if (!run) out.push('running session names a run that does not exist')
      // A `finished` run is allowed: its deliverable is folded in by the
      // TASK_SUBMITTED that follows in the same append.
      else if (RUN_TERMINAL.includes(run.status) && run.status !== 'finished') out.push(`running session's current run is ${run.status}`)
      else {
        // Resumable: the run wrote a checkpoint, or began from one, or no
        // checkpoint exists for its task at all — in which case the brief
        // itself is the level-0 checkpoint and a restart re-dispatches it.
        // The violation is a run that IGNORED a checkpoint its task has.
        const hasCheckpoint = Object.values(state.checkpoints).some((c) => c.taskId === run.taskId)
        const resumable = run.checkpointId !== null || run.resumedFromCheckpointId !== null || !hasCheckpoint
        if (!resumable) out.push('running session has no resumable checkpoint')
      }
    }
  }
  if (s.status === 'waiting_on_approval') {
    if (STATUS_META[s.status].moneyMayMove) out.push('waiting_on_approval must not allow money to move')
    if (!Object.values(state.approvals).some((a) => a.decidedAt === null)) out.push('waiting_on_approval with no undecided approval')
  }
  if (s.spentUsd > s.budgetLimitUsd + 0.005) out.push(`spent $${s.spentUsd} exceeds budget $${s.budgetLimitUsd}`)
  if (s.spentUsd < 0) out.push('negative spend')

  for (const t of tasks) {
    if (t.attempts > t.maxAttempts) out.push(`task ${t.id} has ${t.attempts} attempts, max ${t.maxAttempts}`)
    if ((t.status === 'dispatched' || t.status === 'running') && !t.currentRunId && !(t.settlement === 'escrow' && t.specHash)) {
      out.push(`task ${t.id} is ${t.status} with no run`)
    }
    if (t.status === 'settled' && t.settlement === 'escrow' && !Object.values(state.approvals).some((a) => a.taskId === t.id && a.moved)) {
      out.push(`escrow task ${t.id} settled without a payment`)
    }
    if (t.status === 'settled' && !Object.values(state.approvals).some((a) => a.taskId === t.id && a.granted === true)) {
      out.push(`task ${t.id} settled without a granted approval`)
    }
    for (const dep of t.dependsOn) if (!state.tasks[dep]) out.push(`task ${t.id} depends on missing ${dep}`)
  }
  for (const r of runs) {
    if (r.status === 'running' && r.startedAt === null) out.push(`run ${r.id} running without a start time`)
  }
  const liveByTask = new Map<string, number>()
  for (const r of liveRuns) liveByTask.set(r.taskId, (liveByTask.get(r.taskId) ?? 0) + 1)
  for (const [taskId, n] of liveByTask) if (n > 1) out.push(`task ${taskId} has ${n} live runs at once`)

  for (const a of Object.values(state.approvals)) {
    if (a.moved && a.granted !== true) out.push(`approval ${a.id} moved money without being granted`)
    if (a.moved && a.policyOutcome === 'DENY') out.push(`approval ${a.id} moved money under a DENY`)
    if (a.decidedBy === 'policy' && (a.policyOutcome === 'REQUIRE_OWNER' || a.policyOutcome === 'REQUIRE_REVIEWER')) {
      out.push(`approval ${a.id} was decided by the policy although it required a person`)
    }
  }
  return out
}

/* ── Projections for people ───────────────────────────────────────────── */

/** The one sentence a page shows for a session. */
export function sessionSentence(s: OfficeSession): string {
  const base = STATUS_META[s.status].sentence
  return s.statusReason ? `${base} (${s.statusReason})` : base
}

/** The transition table as Markdown — the doc is generated from the code so it cannot drift. */
export function transitionTableMarkdown(): string {
  const rows = SESSION_STATUSES.map((st) => {
    const m = STATUS_META[st]
    const to = TRANSITIONS[st].length ? TRANSITIONS[st].join(', ') : '—'
    return `| \`${st}\` | ${m.sentence} | ${m.entry} | ${to} | ${m.moneyMayMove ? 'yes' : 'no'} | ${m.automatable ? 'yes' : 'no'} | ${m.onHeartbeat} | ${m.onRestart} |`
  })
  return [
    '| status | shown to the owner | entered by | may go to | money may move | automatable | next heartbeat | after a restart |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/** Tasks whose dependencies are all settled or skipped and which have not started. */
export function unblockedTasks(state: SessionState, wave = state.session.wave): SessionTask[] {
  return tasksOfWave(state, wave).filter((t) => {
    if (t.status !== 'pending' && t.status !== 'blocked' && t.status !== 'ready') return false
    return t.dependsOn.every((d) => state.tasks[d]?.status === 'settled')
  })
}

/** Tasks that can never run because a dependency failed or was cancelled. */
export function doomedTasks(state: SessionState, wave = state.session.wave): SessionTask[] {
  return tasksOfWave(state, wave).filter((t) => {
    if (TASK_TERMINAL.includes(t.status)) return false
    return t.dependsOn.some((d) => {
      const dep = state.tasks[d]
      return dep !== undefined && (dep.status === 'failed' || dep.status === 'cancelled' || dep.status === 'skipped')
    })
  })
}

/** Sum of bounties the plan still needs to escrow, plus what internal tasks are budgeted at. */
export function plannedCostUsd(state: SessionState, wave = state.session.wave): number {
  return Math.round(tasksOfWave(state, wave).reduce((sum, t) => sum + (t.status === 'settled' ? 0 : t.bountyUsd), 0) * 100) / 100
}

export const sha256Hex = async (text: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
}
