/**
 * The session loop, tick by tick, against the four product scenarios:
 *
 *   A  a local Claude Code session plans, dispatches, verifies, auto-approves, settles, completes
 *   B  the process dies mid-run; the loop times it out, keeps the checkpoint, resumes once
 *   C  a $1 / 3-file / tests-green / reviewer-approved task is paid by policy with a receipt
 *   D  a production-config change runs but cannot be paid until the owner says so
 *
 * plus retry exhaustion, deadlines, scheduled waves, worker selection and
 * budget exhaustion. Every tick's events are applied through the real
 * reducer and the invariants are checked after each, so a loop that decides
 * something the model refuses is a red test here, not a stuck session.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_WAKE_MS,
  HEARTBEAT_TIMEOUT_MS,
  PICKUP_TIMEOUT_MS,
  approvalContextFor,
  learnFromSession,
  renderLessons,
  selectWorker,
  tickSession,
  workerHistoryFrom,
  type Command,
  type Observation,
  type WorkerCandidate,
} from '@/lib/office-session-loop'
import {
  applyEvent,
  eventKey,
  initialState,
  sessionInvariants,
  type SessionEvent,
  type SessionEventType,
  type SessionState,
} from '@/lib/office-session'
import { DEFAULT_APPROVAL_POLICY } from '@/lib/approval-policy'

const T0 = Date.parse('2026-09-03T09:00:00Z')
let n = 0
const newId = (p: string) => `${p}-${++n}`
const policy = { approval: DEFAULT_APPROVAL_POLICY, newId }
/** A triage desk that pays nothing and asks no reviewer: every auto-approve condition holds vacuously. */
const lenient = { approval: { ...DEFAULT_APPROVAL_POLICY, id: 'lenient', autoApprove: [], requireReviewer: [] }, newId }

const local: WorkerCandidate = {
  agentId: 'agent-local',
  runtimeType: 'local',
  harnessId: 'claude',
  alive: true,
  successRate: null,
  kindSuccess: {},
  estCostUsd: null,
  bondReady: true,
  sameAccount: true,
  busyRuns: 0,
  capabilities: ['text', 'code'],
}

const obs = (now: number, over: Partial<Observation> = {}): Observation => ({
  now,
  dailySpentUsd: 0,
  candidates: [local],
  escrow: {},
  realMoney: false,
  allowRealMoneyFlag: undefined,
  triggersFired: [],
  tools: [],
  ...over,
})

function ev(state: SessionState, type: SessionEventType, payload: Record<string, unknown>, at: number, actorType: SessionEvent['actorType'] = 'worker'): SessionState {
  const e: SessionEvent = {
    id: newId('ev'),
    sessionId: state.session.id,
    type,
    occurredAt: at,
    actorType,
    actorId: null,
    payload,
    idempotencyKey: eventKey(state.session.id, type, `${type}:${n}`),
  }
  const next = applyEvent(state, e)
  expect(sessionInvariants(next), `after ${type}`).toEqual([])
  return next
}

function create(over: Record<string, unknown> = {}): SessionState {
  return initialState({
    id: newId('ev'),
    sessionId: `ses-${++n}`,
    type: 'SESSION_CREATED',
    occurredAt: T0,
    actorType: 'user',
    actorId: 'u1',
    payload: {
      userId: 'u1',
      officeSlot: 1,
      kind: 'local_coding',
      goal: 'Fix the auth bug',
      budgetLimitUsd: 10,
      workerAgentId: 'agent-local',
      workspace: { workdir: '/home/me/repo', write: true, shell: true, network: false, install: false, secrets: false, gitPush: false, externalPayments: false, perTaskLimitUsd: 3, dailyLimitUsd: 20 },
      ...over,
    },
    idempotencyKey: `create-${n}`,
  })
}

/** Tick and assert the invariants held after every event. */
function tick(state: SessionState, o: Observation, p = policy) {
  const r = tickSession(state, o, p)
  let check = state
  for (const e of r.events) {
    check = applyEvent(check, e)
    expect(sessionInvariants(check), `after ${e.type}`).toEqual([])
  }
  expect(check).toEqual(r.state)
  return r
}

const kinds = (cmds: Command[]) => cmds.map((c) => c.kind)

function planned(state: SessionState, tasks?: Record<string, unknown>[]): SessionState {
  return ev(
    state,
    'PLAN_CREATED',
    {
      source: 'default',
      tasks: tasks ?? [{ id: 't1', title: 'Patch refresh', brief: 'fix it', acceptanceCriteria: 'tests pass', kind: 'coding', verify: { command: 'npm test', independentReview: true } }],
    },
    T0,
    'office',
  )
}

describe('scenario A — a local coding session end to end', () => {
  it('draft asks for a plan; planned checks the budget; ready dispatches to the bound worker', () => {
    let s = create()
    let r = tick(s, obs(T0))
    expect(kinds(r.commands)).toEqual(['plan'])
    expect(r.events).toEqual([])

    s = planned(s)
    r = tick(s, obs(T0 + 1000))
    expect(r.events.map((e) => e.type)).toEqual(['BUDGET_CHECKED', 'TASK_READY', 'TASK_DISPATCHED', 'WAKE_SCHEDULED'])
    expect(r.state.session.status).toBe('running')
    const dispatch = r.commands.find((c) => c.kind === 'dispatch_run')
    expect(dispatch).toMatchObject({ taskId: 't1', workerAgentId: 'agent-local', harnessId: 'claude', resumeFrom: null })
    expect(r.state.session.nextWakeAt).toBe(T0 + 1000 + ACTIVE_WAKE_MS)
    expect(r.notes.join('\n')).toContain('dispatched to agent-local')
  })

  it('the worker reports, submits; the loop requests review, then the policy decides, then settles and completes', () => {
    let s = planned(create())
    let r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId

    // worker side, folded by the server as events
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 5_000)
    s = ev(s, 'RUN_PROGRESS', { runId, changedFiles: ['lib/auth.ts'] }, T0 + 20_000)
    s = ev(s, 'CHECKPOINT_CREATED', { runId, checkpointId: 'cp-1', seq: 1, summary: 'edited auth', gitHead: 'abc', filesChanged: ['lib/auth.ts'] }, T0 + 20_000)
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0, changedFiles: ['lib/auth.ts', 'tests/auth.test.ts'], costUsd: 0.04 }, T0 + 60_000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', diff: '--- a\n+++ b', changedFiles: ['lib/auth.ts', 'tests/auth.test.ts'], contentHash: 'h1', costUsd: 0.04 }, T0 + 60_000)
    s = ev(s, 'TEST_REPORTED', { taskId: 't1', report: { command: 'npm test', exitCode: 0, passed: true, tail: 'ok', durationMs: 900 } }, T0 + 60_000)
    expect(s.session.status).toBe('waiting_on_review')

    // tick 2: verification → review requested
    r = tick(s, obs(T0 + 61_000))
    expect(r.events.map((e) => e.type)).toContain('REVIEW_REQUESTED')
    expect(kinds(r.commands)).toContain('run_review')
    s = r.state

    // review arrives
    s = ev(s, 'REVIEW_RECEIVED', { taskId: 't1', verdict: { reviewer: 'model', reviewerId: 'grader', approve: true, note: 'meets the criteria', at: T0 + 90_000 } }, T0 + 90_000, 'reviewer')

    // tick 3: policy decides (internal task, $0, E1 → ALLOW), settles, completes
    r = tick(s, obs(T0 + 91_000))
    const types = r.events.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'TASK_SETTLED', 'SESSION_COMPLETED']))
    expect(kinds(r.commands)).toContain('record_memory')
    expect(r.state.session.status).toBe('completed')
    const approval = Object.values(r.state.approvals)[0]
    expect(approval.policyOutcome).toBe('ALLOW')
    expect(approval.decidedBy).toBe('policy')
    expect(approval.evidence.changedFileCount).toBe(2)
    expect(approval.moved).toBeNull()
    expect(r.state.session.spentUsd).toBe(0)

    // learn
    const lessons = learnFromSession(r.state)
    expect(lessons.map((l) => l.kind)).toEqual(expect.arrayContaining(['worker', 'cost', 'approval', 'procedure']))
    expect(renderLessons(lessons)).toContain('agent-local: 1 run(s) finished')

    // a further tick is a no-op
    const again = tick(r.state, obs(T0 + 100_000))
    expect(again.events).toEqual([])
    expect(again.commands).toEqual([])
  })
})

describe('scenario B — the process dies mid-run', () => {
  function running(): { s: SessionState; runId: string } {
    let s = planned(create())
    const r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 5_000)
    s = ev(s, 'RUN_PROGRESS', { runId, changedFiles: ['lib/auth.ts'] }, T0 + 30_000)
    s = ev(s, 'CHECKPOINT_CREATED', { runId, checkpointId: 'cp-1', seq: 1, summary: 'edited auth.ts, tests not yet run', gitHead: 'abc', patch: 'diff --git a', filesChanged: ['lib/auth.ts'] }, T0 + 30_000)
    return { s, runId }
  }

  it('heartbeat timeout → waiting_on_worker, checkpoint preserved, then a resume from it — once', () => {
    const { s, runId } = running()
    // Still alive inside the timeout: nothing happens.
    let r = tick(s, obs(T0 + 30_000 + HEARTBEAT_TIMEOUT_MS - 1))
    expect(r.events.map((e) => e.type)).not.toContain('RUN_TIMED_OUT')

    // Silent past the timeout.
    r = tick(s, obs(T0 + 30_000 + HEARTBEAT_TIMEOUT_MS + 1))
    const types = r.events.map((e) => e.type)
    expect(types[0]).toBe('RUN_TIMED_OUT')
    expect(types).toContain('RETRY_SCHEDULED')
    expect(r.state.runs[runId].status).toBe('timed_out')
    expect(r.state.session.checkpointId).toBe('cp-1')
    expect(r.state.tasks.t1.attempts).toBe(1)
    expect(r.state.session.status).toBe('retrying')
    expect(r.state.session.nextWakeAt).toBe(r.state.tasks.t1.nextRetryAt)

    // Backoff not yet elapsed → no dispatch.
    const early = tick(r.state, obs(r.state.tasks.t1.nextRetryAt! - 1))
    expect(kinds(early.commands)).not.toContain('dispatch_run')

    // Backoff elapsed → one resume from the checkpoint, on the same worker.
    const resumed = tick(r.state, obs(r.state.tasks.t1.nextRetryAt!))
    const d = resumed.commands.find((c) => c.kind === 'dispatch_run') as Extract<Command, { kind: 'dispatch_run' }>
    expect(d.resumeFrom?.id).toBe('cp-1')
    expect(d.workerAgentId).toBe('agent-local')
    expect(resumed.events.map((e) => e.type)).toContain('RUN_RESUMED')
    expect(resumed.state.tasks.t1.attempts).toBe(2)
    expect(resumed.state.session.status).toBe('running')
    expect(Object.values(resumed.state.runs).filter((x) => x.status === 'dispatched')).toHaveLength(1)

    // Ticking again does not dispatch a second run for the same task.
    const twice = tick(resumed.state, obs(resumed.state.tasks.t1.nextRetryAt! + 1000))
    expect(kinds(twice.commands)).not.toContain('dispatch_run')
  })

  it('a run nobody picked up is a lost worker; another worker is chosen when there is one', () => {
    let s = planned(create())
    let r = tick(s, obs(T0))
    s = r.state
    r = tick(s, obs(T0 + PICKUP_TIMEOUT_MS + 1))
    expect(r.events.map((e) => e.type)).toContain('WORKER_LOST')
    const second: WorkerCandidate = { ...local, agentId: 'agent-2' }
    const next = tick(r.state, obs(r.state.tasks.t1.nextRetryAt!, { candidates: [{ ...local, alive: false }, second] }))
    const d = next.commands.find((c) => c.kind === 'dispatch_run') as Extract<Command, { kind: 'dispatch_run' }>
    expect(d.workerAgentId).toBe('agent-2')
  })

  it('a retry that comes due while the worker is stale waits on a worker instead of throwing', () => {
    let s = planned(create())
    let r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 5_000)
    r = tick(s, obs(T0 + 30_000 + HEARTBEAT_TIMEOUT_MS + 1))
    expect(r.state.session.status).toBe('retrying')
    const due = tick(r.state, obs(r.state.tasks.t1.nextRetryAt!, { candidates: [{ ...local, alive: false }] }))
    expect(due.state.session.status).toBe('waiting_on_worker')
    const back = tick(due.state, obs(r.state.tasks.t1.nextRetryAt! + 5000))
    expect(kinds(back.commands)).toContain('dispatch_run')
    expect(back.state.session.status).toBe('running')
  })

  it('no alive worker → waiting_on_worker and the owner is told', () => {
    const s = planned(create())
    const r = tick(s, obs(T0, { candidates: [{ ...local, alive: false }] }))
    expect(r.state.session.status).toBe('waiting_on_worker')
    expect(r.commands.find((c) => c.kind === 'notify_owner')).toBeTruthy()
  })

  it('retry exhaustion → the task fails, the session ends partially completed', () => {
    let s = planned(create({ retryPolicy: { maxAttempts: 2, backoffMs: 0 } }))
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = tick(s, obs(T0 + attempt * 1_000_000))
      const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
      s = r.state
      s = ev(s, 'RUN_FAILED', { runId, failureCode: 'DET-001', exitCode: 1 }, T0 + attempt * 1_000_000 + 5000)
    }
    const r = tick(s, obs(T0 + 3_000_000))
    expect(r.state.tasks.t1.status).toBe('failed')
    expect(r.state.session.status).toBe('partially_completed')
    expect(r.commands.some((c) => c.kind === 'notify_owner')).toBe(true)
  })

  it('a session restarted after a deployment resumes from persisted state alone', () => {
    const { s } = running()
    // "Restart": nothing but the state survives, and it is a fresh tick.
    const r = tick(structuredClone(s), obs(T0 + 31_000))
    expect(r.events.map((e) => e.type).filter((t) => t !== 'WAKE_SCHEDULED')).toEqual([]) // still alive; nothing to change
    expect(r.state.session.status).toBe('running')
  })
})

describe('scenario C and D — approval by policy vs by a person', () => {
  function submitted(over: { changedFiles?: string[]; bountyUsd?: number; settlement?: 'internal' | 'escrow'; testsPassed?: boolean | null; review?: boolean | null }) {
    let s = planned(create(), [
      {
        id: 't1',
        title: 'Small fix',
        brief: 'b',
        acceptanceCriteria: 'c',
        kind: 'coding',
        bountyUsd: over.bountyUsd ?? 1,
        settlement: over.settlement ?? 'escrow',
        riskTier: 'E2',
        verify: { command: 'npm test', independentReview: true },
      },
    ])
    let r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 1000)
    const files = over.changedFiles ?? ['lib/a.ts', 'lib/b.ts', 'tests/a.test.ts']
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0, changedFiles: files }, T0 + 2000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', diff: 'd', changedFiles: files, contentHash: 'h' }, T0 + 2000)
    if (over.testsPassed !== null) {
      s = ev(s, 'TEST_REPORTED', { taskId: 't1', report: { command: 'npm test', exitCode: over.testsPassed === false ? 1 : 0, passed: over.testsPassed ?? true, tail: '', durationMs: 1 }, ciPassed: over.testsPassed ?? true }, T0 + 2000)
    }
    if (over.review !== null) {
      s = ev(s, 'REVIEW_RECEIVED', { taskId: 't1', verdict: { reviewer: 'model', reviewerId: null, approve: over.review ?? true, note: 'ok', at: T0 + 3000 } }, T0 + 3000, 'reviewer')
    }
    r = tick(s, obs(T0 + 4000))
    return r
  }

  it('C: $1, 3 files, tests+CI green, reviewer APPROVE → ALLOW_WITH_LOG, payment authorized, escrow release commanded, then settled on observation', () => {
    const r = submitted({})
    const approval = Object.values(r.state.approvals)[0]
    expect(approval.policyOutcome).toBe('ALLOW_WITH_LOG')
    expect(approval.decidedBy).toBe('policy')
    expect(approval.reasons.some((x) => x.includes('changedFileCount <= 10'))).toBe(true)
    expect(r.events.map((e) => e.type)).toContain('PAYMENT_AUTHORIZED')
    expect(kinds(r.commands)).toContain('settle_escrow')
    expect(r.state.tasks.t1.status).toBe('approved') // money not yet observed on-chain
    // the chain says paid → settled, spent counted once
    const paid = tick(r.state, obs(T0 + 5000, { escrow: { t1: { jobStatus: 'Completed', paid: true, txHash: '0xabc', gradePassed: true } } }))
    expect(paid.state.tasks.t1.status).toBe('settled')
    expect(paid.state.session.spentUsd).toBe(1)
    expect(paid.state.session.status).toBe('completed')
    const again = tick(paid.state, obs(T0 + 6000, { escrow: { t1: { jobStatus: 'Completed', paid: true, txHash: '0xabc', gradePassed: true } } }))
    expect(again.events).toEqual([])
  })

  it('D: production config changed → REQUIRE_OWNER, session waits, nothing is authorized until the owner grants', () => {
    const r = submitted({ changedFiles: ['vercel.json', 'lib/a.ts'] })
    const approval = Object.values(r.state.approvals)[0]
    expect(approval.policyOutcome).toBe('REQUIRE_OWNER')
    expect(approval.reasons[0]).toMatch(/production/)
    expect(r.state.session.status).toBe('waiting_on_approval')
    expect(r.events.map((e) => e.type)).not.toContain('PAYMENT_AUTHORIZED')
    expect(kinds(r.commands)).toContain('notify_owner')
    // another tick does not sneak money out
    const held = tick(r.state, obs(T0 + 60_000))
    expect(held.events.map((e) => e.type)).not.toContain('PAYMENT_AUTHORIZED')
    expect(held.state.session.status).toBe('waiting_on_approval')
    // the owner grants → next tick authorizes under the owner's decision
    const granted = ev(held.state, 'APPROVAL_GRANTED', { approvalId: approval.id, decidedBy: 'owner', decidedById: 'u1' }, T0 + 120_000, 'user')
    const after = tick(granted, obs(T0 + 121_000))
    expect(after.events.map((e) => e.type)).toContain('PAYMENT_AUTHORIZED')
    expect(after.state.approvals[approval.id].decidedBy).toBe('owner')
  })

  it('failed tests: no reviewer is asked, the worker gets another attempt with the output; exhausted → failed', () => {
    const r = submitted({ testsPassed: false })
    expect(r.events.map((e) => e.type)).toContain('RETRY_SCHEDULED')
    expect(r.events.map((e) => e.type)).not.toContain('REVIEW_REQUESTED')
    const retry = r.events.find((e) => e.type === 'RETRY_SCHEDULED')!
    expect(String(retry.payload.reason)).toMatch(/tests failed/)
    // backed off, not immediate: the retry is dispatched once its time comes
    expect(kinds(r.commands)).not.toContain('dispatch_run')
    expect(r.state.session.status).toBe('retrying')
    const later = tick(r.state, obs(r.state.tasks.t1.nextRetryAt!))
    expect(kinds(later.commands)).toContain('dispatch_run')
    expect(later.state.tasks.t1.attempts).toBe(2)
  })

  it('a reviewer REVISE with attempts left is feedback, not a verdict', () => {
    const r = submitted({ review: false })
    const retry = r.events.find((e) => e.type === 'RETRY_SCHEDULED')!
    expect(String(retry.payload.reason)).toMatch(/revision/)
    expect(r.state.tasks.t1.attempts).toBe(2)
  })

  it('mainnet money guard: a policy allow on real money is held with the flag named; the owner can still release', () => {
    let s = planned(create(), [{ id: 't1', title: 'x', brief: 'b', acceptanceCriteria: 'c', kind: 'coding', bountyUsd: 1, settlement: 'escrow', verify: { command: null, independentReview: false } }])
    let r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0, changedFiles: ['a.ts'] }, T0 + 1000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', diff: 'd', changedFiles: ['a.ts'] }, T0 + 1000)
    s = ev(s, 'REVIEW_RECEIVED', { taskId: 't1', verdict: { reviewer: 'model', reviewerId: null, approve: true, note: '', at: T0 } }, T0 + 1500, 'reviewer')
    r = tick(s, obs(T0 + 2000, { realMoney: true }))
    expect(Object.values(r.state.approvals)[0].policyOutcome).toBe('ALLOW_WITH_LOG')
    expect(r.events.map((e) => e.type)).not.toContain('PAYMENT_AUTHORIZED')
    expect(r.notes.join('\n')).toContain('OFFICE_SESSION_ALLOW_REAL_MONEY')
    const withFlag = tick(s, obs(T0 + 2000, { realMoney: true, allowRealMoneyFlag: 'true' }))
    expect(withFlag.events.map((e) => e.type)).toContain('PAYMENT_AUTHORIZED')
  })

  it('budget exhaustion: a plan over the remaining budget parks the session and tells the owner', () => {
    const s = planned(create({ budgetLimitUsd: 1 }), [{ id: 't1', title: 'x', brief: 'b', acceptanceCriteria: 'c', kind: 'text', bountyUsd: 5, settlement: 'escrow' }])
    const r = tick(s, obs(T0))
    expect(r.state.session.status).toBe('awaiting_budget')
    expect(kinds(r.commands)).toEqual(['notify_owner'])
    const raised = ev(r.state, 'BUDGET_RAISED', { budgetLimitUsd: 6 }, T0 + 1000, 'user')
    const r2 = tick(raised, obs(T0 + 2000))
    expect(r2.state.session.status).not.toBe('awaiting_budget')
    expect(kinds(r2.commands)).toContain('post_escrow_job')
  })

  it('the approval context reads the state, never guesses: no tests → null, no review → null', () => {
    const s = planned(create())
    const ctx = approvalContextFor(s, s.tasks.t1, { dailySpentUsd: 0 })
    expect(ctx.testsPassed).toBeNull()
    expect(ctx.reviewerVerdict).toBeNull()
    expect(ctx.budgetRemainingUsd).toBe(10)
    expect(ctx.workspaceEscape).toBe(false)
  })
})

describe('deadlines, pause, schedules, event triggers', () => {
  it('a deadline expires the session and asks live runs to stop', () => {
    let s = planned(create({ deadlineAt: T0 + 100_000 }))
    let r = tick(s, obs(T0))
    s = r.state
    r = tick(s, obs(T0 + 100_000))
    expect(r.state.session.status).toBe('expired')
    expect(kinds(r.commands)).toContain('cancel_run')
    expect(Object.values(r.state.runs)[0].cancelRequestedAt).not.toBeNull()
  })

  it('a paused session dispatches nothing but still times out a dead run', () => {
    let s = planned(create())
    let r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 1000)
    s = ev(s, 'SESSION_PAUSED', { reason: 'lunch' }, T0 + 2000, 'user')
    r = tick(s, obs(T0 + 2000 + HEARTBEAT_TIMEOUT_MS + 1))
    expect(r.events.map((e) => e.type)).toEqual(['RUN_TIMED_OUT'])
    expect(r.state.session.status).toBe('paused')
    expect(kinds(r.commands)).toEqual([])
  })

  it('a scheduled session finishes a wave, schedules the next, and re-plans when due', () => {
    let s = create({ kind: 'scheduled', schedule: { kind: 'interval', everyMs: 3_600_000 } })
    s = planned(s, [{ id: 'w1', title: 'triage', brief: 'b', acceptanceCriteria: 'c', kind: 'text', settlement: 'internal', verify: { command: null, independentReview: false } }])
    let r = tick(s, obs(T0), lenient)
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0 }, T0 + 1000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 'w1', deliverable: 'triaged' }, T0 + 1000)
    r = tick(s, obs(T0 + 2000), lenient)
    expect(r.state.tasks.w1.status).toBe('settled')
    expect(r.state.session.status).toBe('ready')
    expect(r.state.session.nextWakeAt).toBe(T0 + 2000 + 3_600_000)
    expect(kinds(r.commands)).toContain('record_memory')
    // not due yet
    const early = tick(r.state, obs(T0 + 3000), lenient)
    expect(early.events.map((e) => e.type)).not.toContain('WAVE_STARTED')
    // due → wave 2 and a new plan is asked for
    const due = tick(r.state, obs(T0 + 2000 + 3_600_000), lenient)
    expect(due.events.map((e) => e.type)).toContain('WAVE_STARTED')
    expect(due.state.session.wave).toBe(2)
    expect(kinds(due.commands)).toContain('plan')
  })

  it('an event-driven session idles until a trigger fires', () => {
    let s = create({ kind: 'event_driven', triggers: ['github.ci_failed'] })
    s = planned(s, [{ id: 'w1', title: 'triage', brief: 'b', acceptanceCriteria: 'c', kind: 'text', settlement: 'internal', verify: { command: null, independentReview: false } }])
    let r = tick(s, obs(T0), lenient)
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0 }, T0 + 1000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 'w1', deliverable: 'x' }, T0 + 1000)
    r = tick(s, obs(T0 + 2000), lenient)
    expect(r.state.session.status).toBe('ready')
    expect(r.state.session.nextWakeAt).toBeNull()
    const idle = tick(r.state, obs(T0 + 3000), lenient)
    expect(idle.events).toEqual([])
    const fired = tick(r.state, obs(T0 + 4000, { triggersFired: ['github.ci_failed'] }), lenient)
    expect(fired.events.map((e) => e.type)).toContain('WAVE_STARTED')
  })

  it('dependencies: a settled task unblocks the next; a failed one dooms it', () => {
    let s = planned(create({ retryPolicy: { maxAttempts: 1 } }), [
      { id: 'a', title: 'A', brief: 'b', acceptanceCriteria: 'c', kind: 'coding', verify: { command: null, independentReview: false } },
      { id: 'b', title: 'B', brief: 'b', acceptanceCriteria: 'c', kind: 'coding', dependsOn: ['a'], verify: { command: null, independentReview: false } },
    ])
    let r = tick(s, obs(T0))
    expect(r.state.tasks.a.status).toBe('dispatched')
    expect(r.state.tasks.b.status).toBe('blocked')
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_FAILED', { runId, failureCode: 'DET-001' }, T0 + 1000)
    r = tick(s, obs(T0 + 2000))
    expect(r.state.tasks.a.status).toBe('failed')
    expect(r.state.tasks.b.status).toBe('skipped')
    expect(r.state.session.status).toBe('partially_completed')
  })
})

describe('selectWorker', () => {
  const task = (over: Record<string, unknown> = {}) => ({ ...planned(create()).tasks.t1, ...over })

  it('prefers the bound worker, then known success, ranks unknown between good and bad, and never a busy or dead one', () => {
    const s = planned(create())
    const good: WorkerCandidate = { ...local, agentId: 'good', successRate: 0.9 }
    const bad: WorkerCandidate = { ...local, agentId: 'bad', successRate: 0.1 }
    const unknown: WorkerCandidate = { ...local, agentId: 'unknown', successRate: null }
    expect(selectWorker(task(), s, [bad, good, local])?.agentId).toBe('agent-local')
    expect(selectWorker(task({ assignedWorkerId: null }), { ...s, session: { ...s.session, workerAgentId: null } }, [bad, unknown, good])?.agentId).toBe('good')
    expect(selectWorker(task({ assignedWorkerId: null }), { ...s, session: { ...s.session, workerAgentId: null } }, [bad, unknown])?.agentId).toBe('unknown')
    expect(selectWorker(task(), s, [{ ...local, busyRuns: 1 }])).toBeNull()
    expect(selectWorker(task(), s, [{ ...local, alive: false }])).toBeNull()
  })

  it('a coding task needs a harness on a local worker; an escrow task needs a bond; an internal task needs the same account', () => {
    const s = planned(create())
    expect(selectWorker(task(), s, [{ ...local, harnessId: null }])).toBeNull()
    expect(selectWorker(task({ settlement: 'escrow' }), s, [{ ...local, bondReady: false }])).toBeNull()
    expect(selectWorker(task({ settlement: 'escrow' }), s, [local])?.agentId).toBe('agent-local')
    expect(selectWorker(task(), s, [{ ...local, sameAccount: false }])).toBeNull()
  })

  it('a worker whose run already failed this task is passed over when there is a choice', () => {
    let s = planned(create())
    const r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_FAILED', { runId }, T0 + 1000)
    const other: WorkerCandidate = { ...local, agentId: 'other' }
    expect(selectWorker(s.tasks.t1, s, [local, other])?.agentId).toBe('other')
    expect(selectWorker(s.tasks.t1, s, [local])?.agentId).toBe('agent-local')
  })
})

describe('a trigger that lands mid-wave is queued, not lost', () => {
  it('is recorded at once and starts the next wave when the current one is done', () => {
    let s = create({ kind: 'event_driven', triggers: ['github:acme/api:ci.failed', 'http:nightly'] })
    s = planned(s, [{ id: 't1', title: 'Note', brief: 'write', acceptanceCriteria: 'one paragraph', kind: 'research', verify: { command: null, independentReview: false } }])
    let r = tick(s, obs(T0), lenient)
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(r.state, 'RUN_STARTED', { runId }, T0 + 1000)
    // the trigger fires while the run is still going
    r = tick(s, obs(T0 + 5000, { triggersFired: ['http:nightly'] }), lenient)
    expect(r.events.map((e) => e.type)).toContain('TRIGGER_RECEIVED')
    expect(r.events.map((e) => e.type)).not.toContain('WAVE_STARTED')
    expect(r.state.session.pendingTriggers).toEqual(['http:nightly'])
    expect(r.state.session.wave).toBe(1)
    // the same name again is not queued twice; a second name is
    r = tick(r.state, obs(T0 + 6000, { triggersFired: ['http:nightly', 'github:acme/api:ci.failed'] }), lenient)
    expect(r.state.session.pendingTriggers).toEqual(['http:nightly', 'github:acme/api:ci.failed'])
    // the wave finishes and settles
    s = ev(r.state, 'RUN_FINISHED', { runId, exitCode: null, changedFiles: [] }, T0 + 10_000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', deliverable: 'A note.', changedFiles: [], contentHash: 'h' }, T0 + 10_000)
    r = tick(s, obs(T0 + 11_000), lenient)
    expect(r.state.tasks.t1.status).toBe('settled')
    // next tick, no new trigger: wave 2 starts from what was queued, and the queue is cleared
    r = tick(r.state, obs(T0 + 12_000), lenient)
    const wave = r.events.find((e) => e.type === 'WAVE_STARTED')
    expect(wave?.payload.triggers).toEqual(['http:nightly', 'github:acme/api:ci.failed'])
    expect(r.state.session.wave).toBe(2)
    expect(r.state.session.pendingTriggers).toEqual([])
    expect(kinds(r.commands)).toContain('plan')
  })

  it('a paused session still records the trigger and does not start a wave', () => {
    let s = create({ kind: 'event_driven', triggers: ['http:nightly'] })
    s = planned(s, [{ id: 't1', title: 'Note', brief: 'write', acceptanceCriteria: 'one paragraph', kind: 'research', verify: { command: null, independentReview: false } }])
    s = ev(s, 'SESSION_PAUSED', { reason: 'owner' }, T0 + 500, 'user')
    const r = tick(s, obs(T0 + 1000, { triggersFired: ['http:nightly'] }), lenient)
    expect(r.events.map((e) => e.type)).toEqual(['TRIGGER_RECEIVED'])
    expect(r.state.session.pendingTriggers).toEqual(['http:nightly'])
    expect(r.state.session.status).toBe('paused')
  })
})

describe('remote workers (cloud / MCP / webhook) on a session task', () => {
  const remote: WorkerCandidate = { ...local, agentId: 'agent-mcp', runtimeType: 'mcp', harnessId: null }

  it('a coding task on a session WITH a workspace never goes to a remote worker', () => {
    const s = planned(create({ workerAgentId: null }))
    const t = Object.values(s.tasks)[0]
    expect(selectWorker(t, s, [remote], 1)).toBeNull()
    expect(selectWorker(t, s, [remote, local], 1)?.agentId).toBe('agent-local')
  })

  it('without a workspace a remote worker may take it; a local harness is still preferred for code', () => {
    const s = planned(create({ workerAgentId: null, workspace: null, kind: 'long_running' }))
    const t = Object.values(s.tasks)[0]
    expect(selectWorker(t, s, [remote], 1)?.agentId).toBe('agent-mcp')
    expect(selectWorker(t, s, [remote, local], 1)?.agentId).toBe('agent-local')
    const research = planned(create({ workerAgentId: null, workspace: null, kind: 'long_running' }), [
      { id: 't1', title: 'Survey', brief: 'read', acceptanceCriteria: 'cites', kind: 'research', verify: { command: null, independentReview: true } },
    ])
    const rt = Object.values(research.tasks)[0]
    // equal footing on non-code: the better record wins, not the runtime
    expect(selectWorker(rt, research, [{ ...remote, successRate: 0.9 }, { ...local, successRate: 0.5 }], 1)?.agentId).toBe('agent-mcp')
  })

  it('the loop dispatches to it and the folded callback settles like any run', () => {
    let s = planned(create({ workerAgentId: null, workspace: null, kind: 'long_running' }), [
      { id: 't1', title: 'Survey', brief: 'read', acceptanceCriteria: 'cites', kind: 'research', verify: { command: null, independentReview: false } },
    ])
    let r = tick(s, obs(T0, { candidates: [remote] }), lenient)
    const dispatch = r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string; workerAgentId: string; harnessId: string | null }
    expect(dispatch).toMatchObject({ workerAgentId: 'agent-mcp', harnessId: null })
    s = r.state
    // the server folds RUN_STARTED at dispatch time and the callback's output as the deliverable
    s = ev(s, 'RUN_STARTED', { runId: dispatch.runId, agentTaskId: 'task-x' }, T0 + 1000)
    s = ev(s, 'RUN_FINISHED', { runId: dispatch.runId, exitCode: null, changedFiles: [] }, T0 + 30_000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', deliverable: 'The survey.', changedFiles: [], contentHash: 'h' }, T0 + 30_000)
    r = tick(s, obs(T0 + 31_000, { candidates: [remote] }), lenient)
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'TASK_SETTLED', 'SESSION_COMPLETED']))
    expect(r.state.session.status).toBe('completed')
  })
})

describe('a paused session stops the clock on its live run', () => {
  function running(): { s: SessionState; runId: string } {
    let s = planned(create())
    const r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 5_000)
    return { s, runId }
  }

  it('the wall clock is not charged while paused, but a dead worker still times out', () => {
    const { s, runId } = running()
    const paused = ev(s, 'SESSION_PAUSED', { reason: 'owner stepped away' }, T0 + 10_000, 'user')
    const short = { ...policy, runTimeoutMs: 60_000 }
    // The worker keeps reporting while the process is SIGSTOPped, so the
    // heartbeat stays fresh — nothing should happen at 5x the wall clock.
    let cur = paused
    for (let i = 1; i <= 5; i++) cur = ev(cur, 'RUN_HEARTBEAT', { runId }, T0 + 10_000 + i * 55_000)
    const r = tick(cur, obs(T0 + 10_000 + 5 * 55_000 + 1000), short)
    expect(r.events.map((e) => e.type)).toEqual([])
    expect(kinds(r.commands)).toEqual([])
    expect(r.state.runs[runId].status).toBe('running')
    // Same elapsed time on a running session: the wall clock cancels it.
    let live = s
    for (let i = 1; i <= 5; i++) live = ev(live, 'RUN_HEARTBEAT', { runId }, T0 + 10_000 + i * 55_000)
    const r2 = tick(live, obs(T0 + 10_000 + 5 * 55_000 + 1000), short)
    expect(r2.events.map((e) => e.type)).toContain('RUN_CANCEL_REQUESTED')
    // And a paused session whose worker went silent still loses the run.
    const r3 = tick(paused, obs(T0 + 10_000 + HEARTBEAT_TIMEOUT_MS + 1000), short)
    expect(r3.events.map((e) => e.type)).toContain('RUN_TIMED_OUT')
  })
})

describe('a settled internal task asks for a signed proof', () => {
  it('issue_proof follows TASK_SETTLED when there is a content hash, and only then', () => {
    let s = planned(create())
    let r = tick(s, obs(T0))
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 5_000)
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0, changedFiles: ['lib/auth.ts'], costUsd: 0.01 }, T0 + 60_000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', diff: '--- a\n+++ b', changedFiles: ['lib/auth.ts'], contentHash: 'h1', costUsd: 0.01 }, T0 + 60_000)
    s = ev(s, 'TEST_REPORTED', { taskId: 't1', report: { command: 'npm test', exitCode: 0, passed: true, tail: 'ok', durationMs: 900 } }, T0 + 60_000)
    r = tick(s, obs(T0 + 61_000))
    s = ev(r.state, 'REVIEW_RECEIVED', { taskId: 't1', verdict: { reviewer: 'model', reviewerId: 'grader', approve: true, note: 'ok', at: T0 + 90_000 } }, T0 + 90_000, 'reviewer')
    r = tick(s, obs(T0 + 91_000))
    expect(r.events.map((e) => e.type)).toContain('TASK_SETTLED')
    expect(r.commands).toContainEqual({ kind: 'issue_proof', taskId: 't1' })
    // The proof is a command, never money: the session's spend is untouched.
    expect(r.state.session.spentUsd).toBe(0)
  })
})

describe('workerHistoryFrom — real numbers for selectWorker', () => {
  function withRuns(runs: Array<{ agent: string; status: string; kind?: string; cost?: number | null }>): SessionState {
    const s = planned(
      create(),
      runs.map((r, i) => ({ id: `t${i}`, title: `t${i}`, brief: 'b', acceptanceCriteria: 'c', kind: r.kind ?? 'coding', verify: { command: null, independentReview: false } })),
    )
    // Build the runs by hand: the shape is what the reducer would leave.
    const out = structuredClone(s) as SessionState
    runs.forEach((r, i) => {
      out.runs[`run-${i}`] = {
        id: `run-${i}`,
        sessionId: s.session.id,
        taskId: `t${i}`,
        attempt: 1,
        workerAgentId: r.agent,
        harnessId: 'claude',
        status: r.status,
        dispatchedAt: T0,
        startedAt: T0,
        finishedAt: T0 + 1000,
        lastHeartbeatAt: T0,
        cancelRequestedAt: null,
        exitCode: null,
        failureCode: null,
        changedFiles: [],
        diffStat: null,
        costUsd: r.cost ?? null,
        tokensUsed: null,
        harnessSessionId: null,
        resumedFromCheckpointId: null,
      } as unknown as SessionState['runs'][string]
    })
    return out
  }

  it('finished over terminal, per kind, mean cost; cancelled counts as neither; live is not history', () => {
    const h = workerHistoryFrom([
      withRuns([
        { agent: 'a', status: 'finished', kind: 'coding', cost: 0.2 },
        { agent: 'a', status: 'failed', kind: 'coding' },
        { agent: 'a', status: 'finished', kind: 'research', cost: 0.4 },
        { agent: 'a', status: 'cancelled', kind: 'research' },
        { agent: 'a', status: 'running', kind: 'research' },
        { agent: 'b', status: 'lost' },
      ]),
    ])
    expect(h.get('a')).toEqual({ successRate: 2 / 3, kindSuccess: { coding: 0.5, research: 1 }, estCostUsd: 0.3, runs: 4 })
    expect(h.get('b')).toEqual({ successRate: 0, kindSuccess: { coding: 0 }, estCostUsd: null, runs: 1 })
    expect(h.get('c')).toBeUndefined()
    expect(workerHistoryFrom([])).toEqual(new Map())
  })

  it('feeds selectWorker: the worker with the better record on this kind wins', () => {
    const h = workerHistoryFrom([withRuns([{ agent: 'good', status: 'finished' }, { agent: 'good', status: 'finished' }, { agent: 'bad', status: 'failed' }, { agent: 'bad', status: 'timed_out' }])])
    const cands: WorkerCandidate[] = ['bad', 'good'].map((id) => ({ ...local, agentId: id, successRate: h.get(id)!.successRate, kindSuccess: h.get(id)!.kindSuccess }))
    const s = planned(create({ workerAgentId: null }))
    const picked = selectWorker(Object.values(s.tasks)[0], s, cands, 1)
    expect(picked?.agentId).toBe('good')
  })
})

describe('talking to servers outside the session', () => {
  const consultTool = {
    id: 'tool-c',
    officeSlot: 1,
    sessionId: null,
    label: 'Docs',
    serverUrl: 'https://docs.example/mcp',
    toolName: 'search',
    purpose: 'consult' as const,
    events: [],
    createdAt: T0,
  }
  const notifyTool = { ...consultTool, id: 'tool-n', label: 'Pager', purpose: 'notify' as const, events: ['APPROVAL_REQUESTED' as const, 'SESSION_COMPLETED' as const] }

  it('consults once before the first dispatch, then dispatches with it — and never asks twice', () => {
    const s0 = planned(create())
    // tick 1: the consult comes first; nothing is dispatched yet
    let r = tick(s0, obs(T0, { tools: [consultTool] }))
    expect(kinds(r.commands)).toEqual(['consult_tool'])
    expect(r.commands[0]).toMatchObject({ taskId: 't1', bindingId: 'tool-c' })
    expect(r.events.map((e) => e.type)).not.toContain('TASK_DISPATCHED')

    // the server records what came back, and now the task dispatches
    const consulted = ev(r.state, 'TOOL_CONSULTED', { taskId: 't1', bindingId: 'tool-c', label: 'Docs', host: 'docs.example', ok: true, sha256: 'abc', bytes: 120 }, T0 + 500, 'system')
    expect(consulted.toolConsults.t1).toMatchObject({ ok: true, host: 'docs.example' })
    r = tick(consulted, obs(T0 + 1000, { tools: [consultTool] }))
    expect(kinds(r.commands)).toContain('dispatch_run')
    expect(kinds(r.commands)).not.toContain('consult_tool')

    // a consult that FAILED is still a consult: the office does not ask a dead server every tick
    const failed = ev(planned(create()), 'TOOL_CONSULTED', { taskId: 't1', bindingId: 'tool-c', label: 'Docs', host: 'docs.example', ok: false, error: 'timeout', bytes: 0 }, T0, 'system')
    expect(kinds(tick(failed, obs(T0 + 1000, { tools: [consultTool] })).commands)).toEqual(['dispatch_run'])
  })

  it('with no binding nothing changes', () => {
    expect(kinds(tick(planned(create()), obs(T0)).commands)).toEqual(['dispatch_run'])
  })

  it('notifies only on the events it subscribed to, once per event, and never on its own notification', () => {
    let s = planned(create())
    let r = tick(s, obs(T0, { tools: [notifyTool] }))
    // TASK_READY / TASK_DISPATCHED / WAKE_SCHEDULED are not subscribed
    expect(kinds(r.commands)).not.toContain('notify_tool')
    s = r.state
    const runId = (r.commands.find((c) => c.kind === 'dispatch_run') as { runId: string }).runId
    s = ev(s, 'RUN_STARTED', { runId }, T0 + 1000)
    s = ev(s, 'RUN_FINISHED', { runId, exitCode: 0, changedFiles: ['a.ts'] }, T0 + 2000)
    s = ev(s, 'TASK_SUBMITTED', { taskId: 't1', diff: 'd', changedFiles: ['a.ts'], contentHash: 'h' }, T0 + 2000)
    s = ev(s, 'TEST_REPORTED', { taskId: 't1', report: { command: 'npm test', exitCode: 0, passed: true, tail: '', durationMs: 10 } }, T0 + 2000)
    r = tick(s, obs(T0 + 3000, { tools: [notifyTool] }))
    s = ev(r.state, 'REVIEW_RECEIVED', { taskId: 't1', verdict: { reviewer: 'model', reviewerId: 'g', approve: true, note: 'ok', at: T0 + 4000 } }, T0 + 4000, 'reviewer')
    r = tick(s, obs(T0 + 5000, { tools: [notifyTool] }))

    const notifies = r.commands.filter((c) => c.kind === 'notify_tool') as Array<{ eventType: string; discriminator: string; amountUsd: number | null }>
    const types = r.events.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['APPROVAL_REQUESTED', 'SESSION_COMPLETED']))
    expect(notifies.map((n) => n.eventType).sort()).toEqual(['APPROVAL_REQUESTED', 'SESSION_COMPLETED'])
    // the discriminator is the event's own key, so re-running the command cannot double-notify
    for (const n of notifies) expect(n.discriminator.length).toBeGreaterThan(0)
    expect(new Set(notifies.map((n) => n.discriminator)).size).toBe(notifies.length)
    // TASK_SETTLED was emitted but not subscribed to
    expect(types).toContain('TASK_SETTLED')
    expect(notifies.map((n) => n.eventType)).not.toContain('TASK_SETTLED')
  })
})
