/**
 * The session loop — one heartbeat of an office session, as a pure function.
 *
 *   observe → interpret → plan → authorize → dispatch → execute → collect
 *           → verify → decide → settle → learn → schedule the next wake
 *
 * The server (lib/office-session-server.ts) does the observing: it folds
 * what the world said since the last tick — worker reports, chain reads,
 * review answers — into EVENTS first, then hands the resulting state and a
 * thin `Observation` to `tickSession`. Everything from interpret to
 * schedule happens here, with no I/O, and comes back as two lists:
 *
 *   events    state changes the loop decided (applied in order; the tick
 *             applies each to its own working copy as it goes, so a
 *             decision never reads a state it has already changed)
 *   commands  side effects the server performs — spawn a run on a worker,
 *             post an escrow job, ask a reviewer, release an escrow, write
 *             memory, tell the owner. Each command, when it lands, produces
 *             its own events on the NEXT append, so a crash between the
 *             two leaves a resumable record rather than a lie.
 *
 * Nothing here can make a session disappear: an exception in one stage is
 * caught by the server per session, logged with the session id, and the
 * session is re-ticked next cycle from the same persisted state. The only
 * way out of the loop is a terminal status the reducer allowed.
 *
 * Every rule that decides money is a call into lib/approval-policy.ts;
 * every state change is an event lib/office-session.ts's reducer accepts.
 * This file decides ORDER and TIMING, nothing else.
 */
import {
  RUN_TERMINAL,
  TASK_TERMINAL,
  STATUS_META,
  allTasksTerminal,
  applyEvent,
  doomedTasks,
  eventKey,
  nextScheduledAt,
  plannedCostUsd,
  retryDelayMs,
  tasksOfWave,
  unblockedTasks,
  type ApprovalOutcome,
  type Checkpoint,
  type NewEvent,
  type SessionEvent,
  type SessionRun,
  type SessionState,
  type SessionTask,
  type SessionEventType,
  type TaskKind,
} from '@/lib/office-session'
import { evaluateApproval, fileFlags, moneyGate, type ApprovalContext, type ApprovalDecision, type ApprovalPolicy } from '@/lib/approval-policy'
import { bindingsFor, notifyTargets, type SessionToolBinding } from '@/lib/session-tools'

/* ── Timing ───────────────────────────────────────────────────────────── */

/** A run that has not spoken for this long is treated as dead. Longer than
 *  the console's 150s "stalled" because a harness can legitimately think
 *  for minutes; shorter than any deadline a person would notice. */
export const HEARTBEAT_TIMEOUT_MS = 5 * 60_000
/** A dispatched run nobody picked up: the worker is not polling. */
export const PICKUP_TIMEOUT_MS = 10 * 60_000
/** Hard wall for one run, whatever it says. */
export const RUN_TIMEOUT_MS = 60 * 60_000
/** After a cancel is asked for, how long a run may keep talking before it is closed as cancelled. */
export const CANCEL_GRACE_MS = 2 * 60_000
/** How soon the loop wants to look again while something is in flight. */
export const ACTIVE_WAKE_MS = 60_000
/** …and while it is only waiting on the world (a review, a chain read). */
export const IDLE_WAKE_MS = 5 * 60_000
/** Runs a single workspace may host at once. A second harness in the same
 *  checkout writes over the first; one is the safe number and the default. */
export const MAX_LIVE_RUNS_PER_WORKSPACE = 1

/* ── Inputs ───────────────────────────────────────────────────────────── */

export type WorkerCandidate = {
  agentId: string
  runtimeType: 'local' | 'cloud' | 'mcp' | 'platform' | 'webhook'
  harnessId: string | null
  /** Heartbeat current (local) or invocable (cloud/mcp). */
  alive: boolean
  /** Paid-job success rate, null when it has none — "unknown" is not "average". */
  successRate: number | null
  /** Per-kind success, when known. */
  kindSuccess: Partial<Record<TaskKind, number | null>>
  estCostUsd: number | null
  bondReady: boolean
  sameAccount: boolean
  /** Live runs this worker already has across sessions. */
  busyRuns: number
  capabilities: string[]
}

export type EscrowObservation = {
  /** The chain's job status, null when unreadable — never treated as any status. */
  jobStatus: string | null
  paid: boolean
  txHash: string | null
  /** The platform grader's recorded verdict on the job, when any. */
  gradePassed: boolean | null
}

export type Observation = {
  now: number
  /** Spent under the office's policy in the current window, before this tick. */
  dailySpentUsd: number
  candidates: WorkerCandidate[]
  escrow: Record<string, EscrowObservation>
  realMoney: boolean
  allowRealMoneyFlag: string | undefined
  /** External events this tick was woken by (event-driven sessions). */
  triggersFired: string[]
  /** External MCP servers this office talks to (lib/session-tools.ts). */
  tools: SessionToolBinding[]
}

export type LoopPolicy = {
  approval: ApprovalPolicy
  heartbeatTimeoutMs?: number
  pickupTimeoutMs?: number
  runTimeoutMs?: number
  cancelGraceMs?: number
  maxLiveRunsPerWorkspace?: number
  /** Id factory, injected so a tick is reproducible in tests. */
  newId: (prefix: string) => string
}

/* ── Outputs ──────────────────────────────────────────────────────────── */

export type Command =
  | { kind: 'plan'; wave: number }
  | { kind: 'dispatch_run'; taskId: string; runId: string; workerAgentId: string; harnessId: string | null; resumeFrom: Checkpoint | null }
  | { kind: 'post_escrow_job'; taskId: string }
  | { kind: 'cancel_run'; runId: string; workerAgentId: string }
  | { kind: 'run_review'; taskId: string }
  | { kind: 'settle_escrow'; taskId: string; approvalId: string }
  | { kind: 'record_memory'; wave: number }
  | { kind: 'notify_owner'; reason: string; taskId: string | null }
  /** Sign a work proof over a settled internal task's artifact (escrow tasks get theirs from the market's own release path). */
  | { kind: 'issue_proof'; taskId: string }
  /** Land a settled task's diff as a pull request (the task's `deliverPr`). */
  | { kind: 'open_pr'; taskId: string }
  /** Ask an external MCP server for context before this task is worked. */
  | { kind: 'consult_tool'; taskId: string; bindingId: string }
  /** Tell an external MCP server that something happened. Never changes the session. */
  | { kind: 'notify_tool'; bindingId: string; eventType: SessionEventType; discriminator: string; taskId: string | null; amountUsd: number | null; reason: string | null }

export type TickResult = {
  events: SessionEvent[]
  commands: Command[]
  /** What the loop concluded, one line per stage, for the log. */
  notes: string[]
  state: SessionState
}

/* ── Worker selection ─────────────────────────────────────────────────── */

/**
 * Pick a worker for a task. Filters first, then a score. Filters: alive,
 * capacity, capability (a coding task needs a harness on a local worker),
 * bond readiness for escrow, and — when there is a choice — not a worker
 * whose run already failed THIS task. Score: the session's bound worker or
 * the task's assignee first; then known success (per kind when known,
 * overall otherwise), unknown ranked below known-good and above known-bad;
 * then estimated cost. Same-account workers are preferred for internal
 * tasks because that is what "the office's own worker" means.
 */
export function selectWorker(task: SessionTask, state: SessionState, candidates: readonly WorkerCandidate[], maxLive = MAX_LIVE_RUNS_PER_WORKSPACE): WorkerCandidate | null {
  const failedBy = new Set(
    Object.values(state.runs)
      .filter((r) => r.taskId === task.id && (r.status === 'failed' || r.status === 'timed_out' || r.status === 'lost'))
      .map((r) => r.workerAgentId),
  )
  const eligible = candidates.filter((c) => {
    if (!c.alive) return false
    if (c.busyRuns >= maxLive) return false
    if (task.kind === 'coding' && c.runtimeType === 'local' && !c.harnessId) return false
    // A coding task on a session with a workspace produces a diff IN that
    // workspace; a remote worker has no access to it. Without a workspace a
    // remote coder may answer in prose (its output is the deliverable).
    if (task.kind === 'coding' && state.session.workspace && c.runtimeType !== 'local') return false
    if (task.settlement === 'escrow' && !c.bondReady) return false
    if (task.settlement === 'internal' && !c.sameAccount) return false
    return true
  })
  if (eligible.length === 0) return null
  const fresh = eligible.filter((c) => !failedBy.has(c.agentId))
  const pool = fresh.length > 0 ? fresh : eligible
  const preferred = task.assignedWorkerId ?? state.session.workerAgentId
  const score = (c: WorkerCandidate): number => {
    let s = 0
    if (c.agentId === preferred) s += 10
    const rate = c.kindSuccess[task.kind] ?? c.successRate
    if (rate === null || rate === undefined) s += 0.45 // unknown: below a known 0.5+, above a known failure record
    else s += rate
    if (task.settlement === 'internal' && c.sameAccount) s += 0.5
    // A polling worker with a harness streams, checkpoints and resumes; a
    // remote one is a single call. Prefer the former for code, all else equal.
    if (task.kind === 'coding' && c.runtimeType === 'local' && c.harnessId) s += 0.25
    if (c.estCostUsd !== null) s -= Math.min(0.3, c.estCostUsd / 100)
    return s
  }
  return [...pool].sort((a, b) => score(b) - score(a) || a.agentId.localeCompare(b.agentId))[0]
}

/* ── The tick ─────────────────────────────────────────────────────────── */

export function tickSession(input: SessionState, obs: Observation, policy: LoopPolicy): TickResult {
  const result = runTick(input, obs, policy)
  return { ...result, commands: [...result.commands, ...notifyCommands(result, obs)] }
}

/**
 * The notifications this tick earned — appended by the wrapper rather than
 * inside the body, because the body returns early on a dozen paths and the
 * most important one is the last: a tick that completes a session returns
 * before anything after the dispatch stage runs. Written inline once, it
 * silently never fired for SESSION_COMPLETED, which is exactly the event an
 * owner binds a pager to.
 */
function notifyCommands(result: TickResult, obs: Observation): Command[] {
  if (obs.tools.length === 0 || result.events.length === 0) return []
  const out: Command[] = []
  for (const e of result.events) {
    for (const b of notifyTargets(obs.tools, result.state.session, e.type)) {
      const p = e.payload
      out.push({
        kind: 'notify_tool',
        bindingId: b.id,
        eventType: e.type,
        discriminator: e.idempotencyKey,
        taskId: typeof p.taskId === 'string' ? p.taskId : null,
        amountUsd: typeof p.amountUsd === 'number' ? p.amountUsd : null,
        reason: typeof p.reason === 'string' ? p.reason : null,
      })
    }
  }
  if (out.length > 0) result.notes.push(`telling ${out.length} external tool call(s) what happened`)
  return out
}

function runTick(input: SessionState, obs: Observation, policy: LoopPolicy): TickResult {
  const heartbeatTimeoutMs = policy.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
  const pickupTimeoutMs = policy.pickupTimeoutMs ?? PICKUP_TIMEOUT_MS
  const runTimeoutMs = policy.runTimeoutMs ?? RUN_TIMEOUT_MS
  const cancelGraceMs = policy.cancelGraceMs ?? CANCEL_GRACE_MS
  const maxLive = policy.maxLiveRunsPerWorkspace ?? MAX_LIVE_RUNS_PER_WORKSPACE

  let state = input
  const events: SessionEvent[] = []
  const commands: Command[] = []
  const notes: string[] = []
  const now = obs.now
  const sid = state.session.id

  const emit = (type: NewEvent['type'], payload: Record<string, unknown>, discriminator: string, actorType: NewEvent['actorType'] = 'office'): void => {
    const event: SessionEvent = {
      id: policy.newId('ev'),
      sessionId: sid,
      type,
      occurredAt: now,
      actorType,
      actorId: null,
      payload,
      idempotencyKey: eventKey(sid, type, discriminator),
    }
    const next = applyEvent(state, event)
    if (next === state) return // duplicate within this tick — already applied
    state = next
    events.push(event)
  }
  const s = () => state.session

  /* interpret: can anything happen at all? */
  if (STATUS_META[s().status].terminal) {
    notes.push(`terminal (${s().status}); nothing to do`)
    return { events, commands, notes, state }
  }
  // A trigger is recorded the moment it fires, before anything can return
  // early (paused, budget, a wave still running). The next wave starts from
  // the recorded list, so nothing that fired is ever lost.
  if (s().kind === 'event_driven' && obs.triggersFired.length > 0) {
    emit('TRIGGER_RECEIVED', { triggers: obs.triggersFired }, `${now}:${obs.triggersFired.join(',')}`, 'system')
    notes.push(`trigger(s) received: ${obs.triggersFired.join(', ')}`)
  }
  if (s().deadlineAt !== null && now >= s().deadlineAt!) {
    for (const run of liveRuns(state)) {
      commands.push({ kind: 'cancel_run', runId: run.id, workerAgentId: run.workerAgentId })
      emit('RUN_CANCEL_REQUESTED', { runId: run.id, reason: 'deadline' }, run.id)
    }
    emit('SESSION_EXPIRED', {}, 'deadline')
    notes.push('deadline passed → expired')
    return { events, commands, notes, state }
  }
  if (s().status === 'paused' || s().status === 'awaiting_budget') {
    notes.push(`${s().status}: waiting on the owner`)
    // Still watch the clock on live runs: a paused session must not let a
    // dead run sit as "running" on the page.
    timeOutRuns({ wallClock: false })
    return { events, commands, notes, state }
  }

  /* plan */
  if (s().status === 'draft') {
    commands.push({ kind: 'plan', wave: s().wave })
    notes.push('draft → asking for a plan')
    return { events, commands, notes, state }
  }
  if (s().status === 'planned') {
    const planned = plannedCostUsd(state)
    const remaining = Math.round((s().budgetLimitUsd - s().spentUsd) * 100) / 100
    const ok = planned <= remaining + 1e-9
    emit('BUDGET_CHECKED', { ok, plannedUsd: planned, remainingUsd: remaining }, `w${s().wave}:v${state.version}`)
    notes.push(ok ? `budget ok ($${planned} of $${remaining})` : `budget short: plan $${planned}, remaining $${remaining}`)
    if (!ok) {
      commands.push({ kind: 'notify_owner', reason: `the plan costs $${planned.toFixed(2)} but only $${remaining.toFixed(2)} remains`, taskId: null })
      return { events, commands, notes, state }
    }
  }

  /* observe the clock on runs */
  // While the session is paused the harness process is stopped (SIGSTOP on
  // the worker), so the wall clock does not count against it — only a dead
  // worker (no heartbeat, never picked up, cancel grace) still times out.
  function timeOutRuns(opts: { wallClock: boolean } = { wallClock: true }): void {
    for (const run of liveRuns(state)) {
      if (run.cancelRequestedAt !== null && now - run.cancelRequestedAt > cancelGraceMs) {
        emit('RUN_CANCELLED', { runId: run.id, failureCode: 'TIM-003', reason: 'cancel grace elapsed' }, run.id)
        notes.push(`run ${run.id}: cancelled after grace`)
        continue
      }
      if (run.status === 'dispatched' && now - run.dispatchedAt > pickupTimeoutMs) {
        emit('WORKER_LOST', { runId: run.id, failureCode: 'DEP-001', reason: `worker did not pick the run up within ${Math.round(pickupTimeoutMs / 60_000)}m` }, run.id)
        notes.push(`run ${run.id}: never picked up → worker lost`)
        continue
      }
      const last = run.lastHeartbeatAt ?? run.startedAt ?? run.dispatchedAt
      if ((run.status === 'running' || run.status === 'started') && now - last > heartbeatTimeoutMs) {
        emit('RUN_TIMED_OUT', { runId: run.id, failureCode: 'TIM-002', reason: `no heartbeat for ${Math.round((now - last) / 60_000)}m` }, run.id)
        notes.push(`run ${run.id}: heartbeat timeout`)
        continue
      }
      if (opts.wallClock && run.startedAt !== null && now - run.startedAt > runTimeoutMs && run.cancelRequestedAt === null) {
        commands.push({ kind: 'cancel_run', runId: run.id, workerAgentId: run.workerAgentId })
        emit('RUN_CANCEL_REQUESTED', { runId: run.id, reason: 'run wall-clock exceeded' }, run.id)
        notes.push(`run ${run.id}: over the wall clock → cancel requested`)
      }
    }
  }
  timeOutRuns()

  /* a scheduled/event-driven session whose wave finished: start the next when due */
  if (s().kind === 'scheduled' || s().kind === 'event_driven') {
    const waveDone = tasksOfWave(state).length > 0 && allTasksTerminal(state)
    const pending = s().pendingTriggers ?? []
    const due = s().kind === 'event_driven' ? pending.length > 0 : s().nextWakeAt !== null && now >= s().nextWakeAt!
    if (waveDone && due) {
      emit('WAVE_STARTED', { wave: s().wave + 1, triggers: pending }, `w${s().wave + 1}`)
      commands.push({ kind: 'plan', wave: s().wave })
      notes.push(`wave ${s().wave} started`)
      return { events, commands, notes, state }
    }
  }

  /* retry or fail tasks whose last run ended badly */
  for (const t of tasksOfWave(state)) {
    if (t.status !== 'ready' || t.currentRunId !== null || t.nextRetryAt !== null || t.attempts === 0) continue
    const last = latestRun(state, t.id)
    if (!last || !RUN_TERMINAL.includes(last.status) || last.status === 'finished') continue
    if (t.attempts < t.maxAttempts) {
      const delay = retryDelayMs(s().retryPolicy, t.attempts + 1)
      emit('RETRY_SCHEDULED', { taskId: t.id, at: now + delay, reason: `run ${last.status}${last.failureCode ? ` (${last.failureCode})` : ''}` }, `${t.id}:a${t.attempts}`)
      notes.push(`task ${t.id}: retry ${t.attempts + 1}/${t.maxAttempts} in ${Math.round(delay / 1000)}s`)
    } else {
      emit('TASK_FAILED', { taskId: t.id, reason: `attempts exhausted (${t.attempts}/${t.maxAttempts}); last run ${last.status}`, failureCode: last.failureCode ?? 'RPL-000' }, t.id)
      commands.push({ kind: 'notify_owner', reason: `task "${t.title}" failed after ${t.attempts} attempts`, taskId: t.id })
      notes.push(`task ${t.id}: attempts exhausted → failed`)
    }
  }

  /* graph: doom, unblock, block */
  for (const t of doomedTasks(state)) {
    emit('TASK_SKIPPED', { taskId: t.id, reason: 'a dependency failed' }, t.id)
    notes.push(`task ${t.id} skipped: dependency failed`)
  }
  for (const t of unblockedTasks(state)) {
    if (t.status === 'ready') continue
    emit('TASK_READY', { taskId: t.id }, `${t.id}:a${t.attempts}`)
  }
  for (const t of tasksOfWave(state)) {
    if (t.status === 'pending' && !unblockedTasks(state).some((u) => u.id === t.id)) {
      emit('TASK_BLOCKED', { taskId: t.id, reason: `waiting on ${t.dependsOn.filter((d) => state.tasks[d]?.status !== 'settled').join(', ')}` }, t.id)
    }
  }

  /* verify + decide */
  for (const t of tasksOfWave(state)) {
    if (t.status !== 'submitted' && t.status !== 'verifying') continue
    const outcome = t.outcome
    if (!outcome) continue
    if (t.status === 'submitted') emit('VERIFICATION_STARTED', { taskId: t.id, layers: verificationLayers(t) }, `${t.id}:a${t.attempts}`)
    if (outcome.tests && outcome.tests.passed === false) {
      // Deterministic failure: no reviewer, no policy — back to the worker or fail.
      decideAfterFailedTests(t)
      continue
    }
    if (t.verify.independentReview && outcome.review === null) {
      if (!alreadyRequestedReview(state, t)) {
        emit('REVIEW_REQUESTED', { taskId: t.id }, `${t.id}:a${t.attempts}`)
        commands.push({ kind: 'run_review', taskId: t.id })
        notes.push(`task ${t.id}: review requested`)
      }
      continue
    }
    if (outcome.review && outcome.review.approve === false && t.attempts < t.maxAttempts) {
      // A REVISE with attempts left is feedback, not a verdict: the worker
      // goes again with the reviewer's note. (§64: fail is a turnstile only
      // when nothing else is possible.)
      emit('RETRY_SCHEDULED', { taskId: t.id, at: now, reason: `reviewer asked for revision: ${outcome.review.note.slice(0, 200)}` }, `${t.id}:rev${t.attempts}`)
      notes.push(`task ${t.id}: reviewer REVISE → retry with feedback`)
      continue
    }
    decide(t)
  }

  /* settle approved tasks */
  for (const t of tasksOfWave(state)) {
    if (t.status !== 'approved') continue
    const approval = Object.values(state.approvals).find((a) => a.taskId === t.id && a.granted === true)
    if (!approval) continue
    if (t.settlement === 'internal') {
      emit('TASK_SETTLED', { taskId: t.id, reason: 'internal task — nothing to pay; the artifact hash and the decision are the receipt', costUsd: t.outcome?.costUsd ?? null }, t.id)
      if (t.outcome?.contentHash) commands.push({ kind: 'issue_proof', taskId: t.id })
      // A task that asked to land as a PR does so only once it has settled:
      // verified, and past the approval policy. Nothing reaches a repository
      // that the office would not have paid for.
      if (t.deliverPr && t.outcome?.diff) commands.push({ kind: 'open_pr', taskId: t.id })
      notes.push(`task ${t.id}: settled (internal)`)
      continue
    }
    const seen = obs.escrow[t.id]
    if (seen?.paid) {
      emit('PAYMENT_SETTLED', { approvalId: approval.id, txHash: seen.txHash, amountUsd: approval.amountUsd }, approval.id)
      emit('TASK_SETTLED', { taskId: t.id, reason: `escrow released${seen.txHash ? ` (${seen.txHash})` : ''}` }, t.id)
      notes.push(`task ${t.id}: escrow paid → settled`)
      continue
    }
    const gate = moneyGate({
      sessionStatus: s().status,
      outcome: approval.policyOutcome,
      decidedBy: approval.decidedBy ?? 'policy',
      settlement: 'escrow',
      realMoney: obs.realMoney,
      allowRealMoneyFlag: obs.allowRealMoneyFlag,
    })
    if (!gate.allowed) {
      notes.push(`task ${t.id}: payment held — ${gate.why}`)
      commands.push({ kind: 'notify_owner', reason: `payment for "${t.title}" is held: ${gate.why}`, taskId: t.id })
      continue
    }
    if (!alreadyAuthorized(state, approval.id)) {
      emit('PAYMENT_AUTHORIZED', { approvalId: approval.id, amountUsd: approval.amountUsd, why: gate.why }, approval.id)
      commands.push({ kind: 'settle_escrow', taskId: t.id, approvalId: approval.id })
      notes.push(`task ${t.id}: payment authorized ($${approval.amountUsd.toFixed(2)})`)
    }
  }

  /* escrow tasks: watch the chain */
  for (const t of tasksOfWave(state)) {
    if (t.settlement !== 'escrow' || t.specHash === null || TASK_TERMINAL.includes(t.status)) continue
    const seen = obs.escrow[t.id]
    if (!seen) continue
    if ((seen.jobStatus === 'Submitted' || seen.jobStatus === 'Completed') && (t.status === 'dispatched' || t.status === 'running' || t.status === 'ready')) {
      emit('TASK_SUBMITTED', { taskId: t.id, deliverable: null, contentHash: null }, `${t.id}:chain-submitted`, 'worker')
      if (seen.gradePassed !== null) {
        emit('TEST_REPORTED', { taskId: t.id, report: { command: 'platform grader', exitCode: seen.gradePassed ? 0 : 1, passed: seen.gradePassed, tail: '', durationMs: null } }, `${t.id}:grade`)
      }
    }
    if ((seen.jobStatus === 'Refunded' || seen.jobStatus === 'Cancelled') && !TASK_TERMINAL.includes(t.status)) {
      emit('TASK_FAILED', { taskId: t.id, reason: `escrow ${seen.jobStatus.toLowerCase()} on-chain`, failureCode: 'ECO-001' }, `${t.id}:chain-${seen.jobStatus}`)
    }
  }

  /* dispatch */
  const live = liveRuns(state)
  const capacity = Math.max(0, maxLive - live.length)
  let dispatched = 0
  for (const t of tasksOfWave(state).sort((a, b) => a.createdAt - b.createdAt)) {
    if (dispatched >= capacity) break
    if (t.status !== 'ready' || t.currentRunId !== null) continue
    if (t.nextRetryAt !== null && now < t.nextRetryAt) continue
    if (t.attempts >= t.maxAttempts) continue
    if (t.settlement === 'escrow' && t.kind !== 'coding') {
      if (t.specHash === null) {
        commands.push({ kind: 'post_escrow_job', taskId: t.id })
        notes.push(`task ${t.id}: posting to the market`)
      }
      continue
    }
    // Context first: an office that has bound an external server asks it
    // once per task, before the task is worked. Once, not per attempt —
    // the record in `toolConsults` is what makes that true even when the
    // call failed.
    const consult = bindingsFor(obs.tools, s(), 'consult')[0]
    if (consult && !(state.toolConsults ?? {})[t.id]) {
      commands.push({ kind: 'consult_tool', taskId: t.id, bindingId: consult.id })
      notes.push(`task ${t.id}: consulting ${consult.label} before dispatch`)
      continue
    }
    const worker = selectWorker(t, state, obs.candidates, maxLive)
    if (!worker) {
      if (s().status !== 'waiting_on_worker') {
        emit('SESSION_WAITING', { status: 'waiting_on_worker', reason: `no worker can take "${t.title}" right now` }, `${t.id}:noworker:${Math.floor(now / IDLE_WAKE_MS)}`)
        commands.push({ kind: 'notify_owner', reason: `no connected worker can take "${t.title}" — connect one or wait`, taskId: t.id })
      }
      notes.push(`task ${t.id}: no eligible worker`)
      continue
    }
    const runId = policy.newId('run')
    const resume = latestCheckpoint(state, t.id)
    emit(
      'TASK_DISPATCHED',
      { taskId: t.id, runId, workerAgentId: worker.agentId, harnessId: worker.harnessId, resumedFromCheckpointId: resume?.id ?? null },
      runId,
    )
    if (resume) emit('RUN_RESUMED', { runId, checkpointId: resume.id }, runId)
    commands.push({ kind: 'dispatch_run', taskId: t.id, runId, workerAgentId: worker.agentId, harnessId: worker.harnessId, resumeFrom: resume })
    notes.push(`task ${t.id}: dispatched to ${worker.agentId}${resume ? ` (resume from ${resume.id})` : ''}`)
    dispatched += 1
  }

  /* session-level status */
  const wave = tasksOfWave(state)
  if (wave.length > 0 && allTasksTerminal(state)) {
    const partial = wave.some((t) => t.status !== 'settled' && t.status !== 'skipped') || wave.some((t) => t.status === 'skipped')
    commands.push({ kind: 'record_memory', wave: s().wave })
    if (s().kind === 'scheduled' && s().schedule) {
      const at = nextScheduledAt(s().schedule!, now)
      if (s().status !== 'ready') emit('SESSION_WAITING', { status: 'ready', reason: `wave ${s().wave} done; next run scheduled` }, `w${s().wave}:done`)
      emit('WAKE_SCHEDULED', { at }, `w${s().wave}:next`)
      notes.push(`wave ${s().wave} done; next at ${new Date(at).toISOString()}`)
    } else if (s().kind === 'event_driven') {
      if (s().status !== 'ready') emit('SESSION_WAITING', { status: 'ready', reason: `wave ${s().wave} done; waiting for ${s().triggers.join(', ') || 'a trigger'}` }, `w${s().wave}:done`)
      emit('WAKE_SCHEDULED', { at: null }, `w${s().wave}:idle`)
      notes.push(`wave ${s().wave} done; idle until a trigger`)
    } else {
      emit('SESSION_COMPLETED', { partial, reason: partial ? summarizePartial(wave) : `${wave.length} task(s) settled` }, `w${s().wave}`)
      notes.push(partial ? 'partially completed' : 'completed')
    }
    return { events, commands, notes, state }
  }

  /* what is the session waiting on, and when to look again */
  const openApproval = Object.values(state.approvals).some((a) => a.decidedAt === null && (a.policyOutcome === 'REQUIRE_OWNER' || a.policyOutcome === 'REQUIRE_REVIEWER'))
  const liveNow = liveRuns(state)
  const anyReady = wave.some((t) => t.status === 'ready' && t.attempts < t.maxAttempts)
  const anyVerifying = wave.some((t) => t.status === 'verifying' || t.status === 'submitted')
  const anyBlocked = wave.some((t) => t.status === 'blocked' || t.status === 'pending')
  const nextRetry = Math.min(...wave.map((t) => t.nextRetryAt ?? Infinity))
  let wakeAt: number
  if (liveNow.length > 0) {
    wakeAt = now + ACTIVE_WAKE_MS
  } else if (openApproval) {
    wakeAt = s().deadlineAt ?? now + IDLE_WAKE_MS * 6
    if (s().status !== 'waiting_on_approval' && s().status !== 'paused') {
      // Can only be reached if the approval was requested by an earlier tick
      // and the status moved since; the reducer holds the status.
    }
  } else if (anyVerifying) {
    wakeAt = now + ACTIVE_WAKE_MS
    if (s().status !== 'waiting_on_review') emit('SESSION_WAITING', { status: 'waiting_on_review', reason: 'verification in flight' }, `verify:${Math.floor(now / ACTIVE_WAKE_MS)}`)
  } else if (Number.isFinite(nextRetry)) {
    wakeAt = Math.max(now + 1000, nextRetry)
  } else if (anyReady) {
    wakeAt = now + ACTIVE_WAKE_MS
    if (s().status === 'running' || s().status === 'waiting_on_review') {
      emit('SESSION_WAITING', { status: 'ready', reason: 'work ready to dispatch' }, `ready:${Math.floor(now / ACTIVE_WAKE_MS)}`)
    }
  } else if (anyBlocked) {
    wakeAt = now + IDLE_WAKE_MS
    if (s().status !== 'waiting_on_dependency' && s().status !== 'waiting_on_worker') {
      emit('SESSION_WAITING', { status: 'waiting_on_dependency', reason: 'every remaining task is blocked' }, `blocked:${Math.floor(now / IDLE_WAKE_MS)}`)
    }
  } else {
    wakeAt = now + IDLE_WAKE_MS
  }
  if (s().deadlineAt !== null) wakeAt = Math.min(wakeAt, s().deadlineAt!)
  // Reschedule only when it changes what happens: the current wake has
  // passed, or the new one is sooner. A tick that runs early (a worker
  // report, an owner's click) must not push a pending wake later, and an
  // idle session must not write one WAKE_SCHEDULED per tick — the first
  // end-to-end run logged 76 of them while waiting for a worker.
  const current = s().nextWakeAt
  if (current === null || current <= now || wakeAt < current) emit('WAKE_SCHEDULED', { at: wakeAt }, `${Math.floor(wakeAt / 1000)}`)
  notes.push(`next wake ${new Date(wakeAt).toISOString()}`)

  return { events, commands, notes, state }

  /* ── stage helpers (closures over emit/state) ─────────────────────── */

  function decideAfterFailedTests(t: SessionTask): void {
    if (t.attempts < t.maxAttempts) {
      // With the retry policy's backoff, not immediately: a harness that
      // fails in a second would otherwise spend every attempt in seconds,
      // which is what the first end-to-end run did.
      const delay = retryDelayMs(s().retryPolicy, t.attempts + 1)
      emit('RETRY_SCHEDULED', { taskId: t.id, at: now + delay, reason: `tests failed: ${t.outcome?.tests?.tail.slice(0, 200) ?? ''}` }, `${t.id}:tests${t.attempts}`)
      notes.push(`task ${t.id}: tests failed → retry with the output in ${Math.round(delay / 1000)}s`)
    } else {
      emit('TASK_FAILED', { taskId: t.id, reason: 'tests failed and no attempts remain', failureCode: 'VER-001' }, t.id)
      commands.push({ kind: 'notify_owner', reason: `"${t.title}" failed its tests on every attempt`, taskId: t.id })
      notes.push(`task ${t.id}: tests failed, attempts spent → failed`)
    }
  }

  function decide(t: SessionTask): void {
    const ctx = approvalContextFor(state, t, obs)
    const decision = evaluateApproval(policy.approval, ctx, now)
    if (decision.outcome === 'REQUIRE_REVIEWER' && t.outcome?.review && t.outcome.review.approve === null) {
      // A review was asked for and no reviewer could answer (no model key,
      // reviewer down). Asking again is a loop; a person is the exit.
      decision.outcome = 'REQUIRE_OWNER'
      decision.reasons = [`no independent reviewer could answer (${t.outcome.review.note.slice(0, 120)}); a person decides`, ...decision.reasons]
    } else if (decision.outcome === 'REQUIRE_REVIEWER') {
      // The plan skipped independent review and the policy wants one: ask
      // for it now rather than recording an approval nobody can decide.
      if (!alreadyRequestedReview(state, t)) {
        emit('REVIEW_REQUESTED', { taskId: t.id, why: 'policy requires a reviewer' }, `${t.id}:a${t.attempts}`)
        commands.push({ kind: 'run_review', taskId: t.id })
        notes.push(`task ${t.id}: policy requires a reviewer → review requested`)
      }
      return
    }
    const approvalId = policy.newId('ap')
    emit(
      'APPROVAL_REQUESTED',
      {
        taskId: t.id,
        approvalId,
        policyOutcome: decision.outcome,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        evidence: decision.evidence,
        reasons: decision.reasons,
        amountUsd: t.bountyUsd,
      },
      `${t.id}:a${t.attempts}`,
    )
    notes.push(`task ${t.id}: policy → ${decision.outcome}`)
    switch (decision.outcome as ApprovalOutcome) {
      case 'ALLOW':
      case 'ALLOW_WITH_LOG':
        emit('APPROVAL_GRANTED', { approvalId, decidedBy: 'policy', decidedById: decision.policyId }, approvalId)
        break
      case 'DENY':
        emit('APPROVAL_DENIED', { approvalId, decidedBy: 'policy', decidedById: decision.policyId, reason: decision.reasons[0], failureCode: 'AUTH-002' }, approvalId)
        commands.push({ kind: 'notify_owner', reason: `"${t.title}" was denied by policy: ${decision.reasons[0]}`, taskId: t.id })
        break
      case 'REQUIRE_REVIEWER':
        break // handled above; unreachable here
      case 'REQUIRE_OWNER':
        commands.push({ kind: 'notify_owner', reason: `"${t.title}" needs your approval: ${decision.reasons.join('; ')}`, taskId: t.id })
        break
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

export function liveRuns(state: SessionState): SessionRun[] {
  return Object.values(state.runs).filter((r) => !RUN_TERMINAL.includes(r.status))
}

export function latestRun(state: SessionState, taskId: string): SessionRun | null {
  const runs = Object.values(state.runs).filter((r) => r.taskId === taskId)
  if (runs.length === 0) return null
  return runs.sort((a, b) => b.attempt - a.attempt)[0]
}

export function latestCheckpoint(state: SessionState, taskId: string): Checkpoint | null {
  const cps = Object.values(state.checkpoints).filter((c) => c.taskId === taskId)
  if (cps.length === 0) return null
  return cps.sort((a, b) => b.at - a.at || b.seq - a.seq)[0]
}

function alreadyRequestedReview(state: SessionState, t: SessionTask): boolean {
  return state.applied.includes(eventKey(state.session.id, 'REVIEW_REQUESTED', `${t.id}:a${t.attempts}`))
}

function alreadyAuthorized(state: SessionState, approvalId: string): boolean {
  return state.applied.includes(eventKey(state.session.id, 'PAYMENT_AUTHORIZED', approvalId))
}

export function verificationLayers(t: SessionTask): string {
  const layers: string[] = []
  if (t.verify.command) layers.push('deterministic tests')
  if (t.settlement === 'escrow') layers.push('platform grader')
  if (t.verify.independentReview) layers.push('independent review')
  layers.push('policy')
  return layers.join(', ')
}

/** The evidence a task's approval is decided on, from the state alone. */
export function approvalContextFor(state: SessionState, t: SessionTask, obs: Pick<Observation, 'dailySpentUsd'>): ApprovalContext {
  const o = t.outcome
  const changed = o?.changedFiles ?? []
  const flags = fileFlags(changed)
  const workdir = state.session.workspace?.workdir ?? null
  const escape = workdir === null ? false : changed.some((f) => f.startsWith('/') && !f.startsWith(`${workdir.replace(/\/+$/, '')}/`))
  const review = o?.review ?? null
  const disagreement = review !== null && o?.tests !== null && o?.tests !== undefined && review.approve === true && o.tests.passed === false
  return {
    officeId: state.session.officeId,
    sessionId: state.session.id,
    taskId: t.id,
    amountUsd: t.bountyUsd,
    riskTier: t.riskTier,
    changedFiles: changed,
    testsPassed: o?.tests ? o.tests.passed : null,
    ciPassed: o?.ciPassed ?? null,
    reviewerVerdict: review === null || review.approve === null ? null : review.approve ? 'APPROVE' : 'REVISE',
    workerCredit: null,
    budgetRemainingUsd: Math.round((state.session.budgetLimitUsd - state.session.spentUsd) * 100) / 100,
    dailySpentUsd: obs.dailySpentUsd,
    productionImpact: flags.productionImpact,
    secretModified: flags.secretModified,
    newDependency: flags.newDependency,
    reviewerDisagreement: disagreement,
    workspaceEscape: escape,
    settlement: t.settlement,
  }
}

function summarizePartial(tasks: readonly SessionTask[]): string {
  const counts: Record<string, number> = {}
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
  return Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
}

/* ── learn ────────────────────────────────────────────────────────────── */

export type SessionLesson = {
  kind: 'worker' | 'cost' | 'retry' | 'approval' | 'intervention' | 'procedure' | 'conflict'
  text: string
}

/**
 * What a finished wave teaches the office. Pure and honest: every line is
 * derived from the record, and a session with nothing to teach returns
 * nothing rather than a platitude.
 */
export function learnFromSession(state: SessionState, wave = state.session.wave): SessionLesson[] {
  const out: SessionLesson[] = []
  const tasks = tasksOfWave(state, wave)
  const runs = Object.values(state.runs).filter((r) => tasks.some((t) => t.id === r.taskId))
  const byWorker = new Map<string, { ok: number; bad: number }>()
  for (const r of runs) {
    const e = byWorker.get(r.workerAgentId) ?? { ok: 0, bad: 0 }
    if (r.status === 'finished') e.ok += 1
    else if (r.status === 'failed' || r.status === 'timed_out' || r.status === 'lost') e.bad += 1
    byWorker.set(r.workerAgentId, e)
  }
  for (const [w, e] of byWorker) {
    if (e.ok + e.bad === 0) continue
    out.push({ kind: 'worker', text: `${w}: ${e.ok} run(s) finished, ${e.bad} failed or lost` })
  }
  const estimated = tasks.reduce((s, t) => s + t.bountyUsd, 0)
  const actual = tasks.reduce((s, t) => s + (t.outcome?.costUsd ?? 0), 0)
  const costKnown = tasks.some((t) => typeof t.outcome?.costUsd === 'number')
  if (costKnown) out.push({ kind: 'cost', text: `budgeted $${estimated.toFixed(2)}, measured harness cost $${actual.toFixed(4)}` })
  const retried = tasks.filter((t) => t.attempts > 1)
  if (retried.length) out.push({ kind: 'retry', text: `${retried.length} task(s) needed more than one attempt: ${retried.map((t) => `${t.title} ×${t.attempts}`).join(', ')}` })
  const approvals = Object.values(state.approvals).filter((a) => tasks.some((t) => t.id === a.taskId))
  const byPerson = approvals.filter((a) => a.decidedBy === 'owner' || a.decidedBy === 'reviewer')
  const denied = approvals.filter((a) => a.granted === false)
  if (approvals.length) {
    out.push({
      kind: 'approval',
      text: `${approvals.length} decision(s): ${approvals.length - byPerson.length} by policy, ${byPerson.length} by a person, ${denied.length} denied`,
    })
  }
  if (byPerson.length) {
    out.push({ kind: 'intervention', text: `a person decided: ${byPerson.map((a) => `${state.tasks[a.taskId]?.title ?? a.taskId} (${a.policyOutcome} → ${a.granted ? 'granted' : 'denied'})`).join('; ')}` })
  }
  const failed = tasks.filter((t) => t.status === 'failed')
  if (failed.length) out.push({ kind: 'procedure', text: `failed: ${failed.map((t) => `${t.title} — ${t.statusReason ?? 'no reason recorded'}`).join('; ')}` })
  const touched = new Map<string, number>()
  for (const t of tasks) for (const f of t.outcome?.changedFiles ?? []) touched.set(f, (touched.get(f) ?? 0) + 1)
  const contested = [...touched.entries()].filter(([, n]) => n > 1).map(([f]) => f)
  if (contested.length) out.push({ kind: 'conflict', text: `files changed by more than one task: ${contested.slice(0, 10).join(', ')}` })
  const settled = tasks.filter((t) => t.status === 'settled')
  if (settled.length && tasks.length === settled.length) {
    out.push({ kind: 'procedure', text: `reusable: ${tasks.map((t) => t.title).join(' → ')}${tasks.some((t) => t.verify.command) ? ` (verified with ${[...new Set(tasks.map((t) => t.verify.command).filter(Boolean))].join(', ')})` : ''}` })
  }
  return out
}

/** The lessons as brief text for the next session's planner and workers. */
export function renderLessons(lessons: readonly SessionLesson[]): string {
  if (lessons.length === 0) return ''
  return `## What previous sessions taught this office\n\n${lessons.map((l) => `- [${l.kind}] ${l.text}`).join('\n')}`
}

/** A first-class type re-export so the server can type its decision path without importing the policy module. */
export type { ApprovalDecision }

/* ── Worker history ───────────────────────────────────────────────────── */

export type WorkerHistory = {
  /** Finished runs / (finished + failed + timed out + lost), null with no terminal run. */
  successRate: number | null
  kindSuccess: Partial<Record<TaskKind, number | null>>
  /** Mean reported cost of a finished run, null when none reported one. */
  estCostUsd: number | null
  runs: number
}

/**
 * What each worker actually did on this account's sessions — the real
 * numbers `selectWorker` scores on, from the session states themselves.
 * A cancelled run is neither success nor failure (the owner stopped it), so
 * it counts toward `runs` and nothing else. "No history" stays null: an
 * untried worker is unknown, not average.
 */
export function workerHistoryFrom(states: readonly SessionState[]): Map<string, WorkerHistory> {
  type Acc = { ok: number; bad: number; runs: number; cost: number[]; kinds: Map<TaskKind, { ok: number; bad: number }> }
  const acc = new Map<string, Acc>()
  for (const st of states) {
    for (const run of Object.values(st.runs ?? {})) {
      const a: Acc = acc.get(run.workerAgentId) ?? { ok: 0, bad: 0, runs: 0, cost: [], kinds: new Map() }
      const kind = st.tasks[run.taskId]?.kind
      const k = kind ? (a.kinds.get(kind) ?? { ok: 0, bad: 0 }) : null
      if (run.status === 'finished') {
        a.ok += 1
        if (k) k.ok += 1
        if (typeof run.costUsd === 'number' && Number.isFinite(run.costUsd)) a.cost.push(run.costUsd)
      } else if (run.status === 'failed' || run.status === 'timed_out' || run.status === 'lost') {
        a.bad += 1
        if (k) k.bad += 1
      } else if (run.status !== 'cancelled') {
        continue // live: not history yet
      }
      a.runs += 1
      if (kind && k) a.kinds.set(kind, k)
      acc.set(run.workerAgentId, a)
    }
  }
  const out = new Map<string, WorkerHistory>()
  for (const [agentId, a] of acc) {
    const total = a.ok + a.bad
    const kindSuccess: Partial<Record<TaskKind, number | null>> = {}
    for (const [kind, k] of a.kinds) kindSuccess[kind] = k.ok + k.bad > 0 ? k.ok / (k.ok + k.bad) : null
    out.set(agentId, {
      successRate: total > 0 ? a.ok / total : null,
      kindSuccess,
      estCostUsd: a.cost.length > 0 ? Math.round((a.cost.reduce((x, y) => x + y, 0) / a.cost.length) * 10000) / 10000 : null,
      runs: a.runs,
    })
  }
  return out
}
