/**
 * The office-session domain model: statuses, transitions, the reducer, replay
 * and the invariants.
 *
 * Two failure directions matter here. A reducer that is too permissive lets a
 * session be observed completed-and-running; one that is too strict strands
 * a real session in a state the loop cannot leave. Every scenario below runs
 * the invariant checker after every event, so a state the model can reach
 * but should not is a red test, not a page somebody has to notice.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETRY_POLICY,
  InvalidEvent,
  InvalidTransition,
  SESSION_EVENT_TYPES,
  SESSION_STATUSES,
  STATUS_META,
  TRANSITIONS,
  applyEvent,
  canTransition,
  doomedTasks,
  eventKey,
  initialState,
  narrowGrant,
  nextScheduledAt,
  plannedCostUsd,
  replay,
  retryDelayMs,
  sessionInvariants,
  sessionSentence,
  transitionTableMarkdown,
  unblockedTasks,
  type SessionEvent,
  type SessionEventType,
  type SessionState,
} from '@/lib/office-session'

const T0 = Date.parse('2026-09-03T09:00:00Z')
let seq = 0

function ev(sessionId: string, type: SessionEventType, payload: Record<string, unknown> = {}, at = T0 + seq * 1000, key?: string): SessionEvent {
  seq += 1
  return {
    id: `ev-${seq}`,
    sessionId,
    type,
    occurredAt: at,
    actorType: 'system',
    actorId: null,
    payload,
    idempotencyKey: key ?? eventKey(sessionId, type, String(seq)),
  }
}

function created(id = 'ses-1', over: Record<string, unknown> = {}): SessionEvent {
  return ev(id, 'SESSION_CREATED', {
    userId: 'u1',
    officeSlot: 1,
    kind: 'local_coding',
    goal: 'Fix the auth bug and add a test',
    budgetLimitUsd: 10,
    workerAgentId: 'agent-local',
    ...over,
  })
}

/** Apply and check invariants after every step. */
function run(state: SessionState, ...events: SessionEvent[]): SessionState {
  for (const e of events) {
    state = applyEvent(state, e)
    expect(sessionInvariants(state), `after ${e.type}`).toEqual([])
  }
  return state
}

const plan = (id: string, tasks = [{ id: 't1', title: 'Fix', brief: 'fix it', acceptanceCriteria: 'tests pass', kind: 'coding' as const }]) =>
  ev(id, 'PLAN_CREATED', { tasks, source: 'default' })

describe('status table', () => {
  it('has metadata for every status and every transition target is a status', () => {
    for (const s of SESSION_STATUSES) {
      expect(STATUS_META[s].sentence.length).toBeGreaterThan(10)
      for (const to of TRANSITIONS[s]) expect(SESSION_STATUSES).toContain(to)
      expect(TRANSITIONS[s]).not.toContain(s)
    }
  })

  it('terminal statuses have no exits and never let money move', () => {
    for (const s of SESSION_STATUSES) {
      if (STATUS_META[s].terminal) {
        expect(TRANSITIONS[s]).toEqual([])
        expect(STATUS_META[s].moneyMayMove).toBe(false)
      } else {
        expect(TRANSITIONS[s].length).toBeGreaterThan(0)
      }
    }
  })

  it('waiting_on_approval and paused are neither automatable nor money-moving', () => {
    for (const s of ['waiting_on_approval', 'paused', 'awaiting_budget'] as const) {
      expect(STATUS_META[s].automatable).toBe(false)
      expect(STATUS_META[s].moneyMayMove).toBe(false)
    }
  })

  it('every non-terminal status can be cancelled, failed or expired', () => {
    for (const s of SESSION_STATUSES) {
      if (STATUS_META[s].terminal) continue
      expect(canTransition(s, 'cancelled')).toBe(true)
      expect(canTransition(s, 'failed')).toBe(true)
      expect(canTransition(s, 'expired')).toBe(true)
    }
  })

  it('renders the transition table with a row per status', () => {
    const md = transitionTableMarkdown()
    for (const s of SESSION_STATUSES) expect(md).toContain(`| \`${s}\` |`)
  })

  it('lists every required event type', () => {
    for (const t of [
      'SESSION_CREATED', 'PLAN_CREATED', 'TASK_READY', 'TASK_DISPATCHED', 'WORKER_CONNECTED', 'RUN_STARTED', 'RUN_PROGRESS',
      'CHECKPOINT_CREATED', 'ARTIFACT_CREATED', 'TASK_SUBMITTED', 'REVIEW_REQUESTED', 'REVIEW_RECEIVED', 'APPROVAL_REQUESTED',
      'APPROVAL_GRANTED', 'APPROVAL_DENIED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SETTLED', 'RUN_FAILED', 'RUN_TIMED_OUT',
      'SESSION_PAUSED', 'SESSION_RESUMED', 'SESSION_ESCALATED', 'SESSION_COMPLETED',
    ]) expect(SESSION_EVENT_TYPES).toContain(t)
  })
})

describe('creation and planning', () => {
  it('starts in draft with the budget and the wake set', () => {
    const s = initialState(created())
    expect(s.session.status).toBe('draft')
    expect(s.session.budgetLimitUsd).toBe(10)
    expect(s.session.nextWakeAt).toBe(T0 + 0)
    expect(s.session.officeId).toBe('u1/1')
    expect(s.session.retryPolicy).toEqual(DEFAULT_RETRY_POLICY)
    expect(sessionInvariants(s)).toEqual([])
  })

  it('refuses a session with no goal or a bad budget', () => {
    expect(() => initialState(created('x', { goal: '  ' }))).toThrow(InvalidEvent)
    expect(() => initialState(created('x', { budgetLimitUsd: -1 }))).toThrow(InvalidEvent)
    expect(() => initialState(ev('x', 'PLAN_CREATED'))).toThrow(InvalidEvent)
  })

  it('a plan moves draft → planned; a budget check moves to ready or awaiting_budget', () => {
    let s = run(initialState(created()), plan('ses-1'))
    expect(s.session.status).toBe('planned')
    expect(Object.keys(s.tasks)).toEqual(['t1'])
    s = run(s, ev('ses-1', 'BUDGET_CHECKED', { ok: false, plannedUsd: 50 }))
    expect(s.session.status).toBe('awaiting_budget')
    s = run(s, ev('ses-1', 'BUDGET_RAISED', { budgetLimitUsd: 60 }))
    expect(s.session.status).toBe('planned')
    s = run(s, ev('ses-1', 'BUDGET_CHECKED', { ok: true, plannedUsd: 50 }))
    expect(s.session.status).toBe('ready')
    expect(s.session.startedAt).not.toBeNull()
  })

  it('rejects a plan with an unknown dependency or a repeated id', () => {
    const s = initialState(created())
    expect(() =>
      applyEvent(s, plan('ses-1', [{ id: 't1', title: 'a', brief: 'b', acceptanceCriteria: 'c', kind: 'coding', dependsOn: ['nope'] } as never])),
    ).toThrow(/depends on nope/)
    const withT1 = applyEvent(s, plan('ses-1'))
    expect(() => applyEvent(withT1, plan('ses-1'))).toThrow(/repeats task id/)
  })
})

/** The happy path: plan → dispatch → run → submit → verify → approve → settle → complete. */
function happyPath(): { state: SessionState; events: SessionEvent[] } {
  const id = 'ses-h'
  const events = [
    created(id),
    plan(id),
    ev(id, 'BUDGET_CHECKED', { ok: true, plannedUsd: 0 }),
    ev(id, 'TASK_READY', { taskId: 't1' }),
    ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'agent-local', harnessId: 'claude' }),
    ev(id, 'RUN_STARTED', { runId: 'run-1' }),
    ev(id, 'RUN_PROGRESS', { runId: 'run-1', changedFiles: ['lib/auth.ts'] }),
    ev(id, 'CHECKPOINT_CREATED', { runId: 'run-1', checkpointId: 'cp-1', seq: 1, summary: 'edited auth', gitHead: 'abc', filesChanged: ['lib/auth.ts'] }),
    ev(id, 'RUN_FINISHED', { runId: 'run-1', exitCode: 0, changedFiles: ['lib/auth.ts', 'tests/auth.test.ts'], diffStat: { files: 2, additions: 10, deletions: 2 } }),
    ev(id, 'ARTIFACT_CREATED', { artifactId: 'art-1', taskId: 't1', runId: 'run-1', kind: 'diff', name: 'diff.patch', sha256: 'deadbeef', bytes: 120, inline: '--- a\n+++ b' }),
    ev(id, 'TASK_SUBMITTED', { taskId: 't1', diff: '--- a\n+++ b', changedFiles: ['lib/auth.ts', 'tests/auth.test.ts'], contentHash: 'deadbeef' }),
    ev(id, 'VERIFICATION_STARTED', { taskId: 't1', layers: 'tests,review' }),
    ev(id, 'TEST_REPORTED', { taskId: 't1', report: { command: 'npm test', exitCode: 0, passed: true, tail: 'ok', durationMs: 900 } }),
    ev(id, 'REVIEW_REQUESTED', { taskId: 't1' }),
    ev(id, 'REVIEW_RECEIVED', { taskId: 't1', verdict: { reviewer: 'model', reviewerId: null, approve: true, note: 'fine', at: T0 } }),
    ev(id, 'APPROVAL_REQUESTED', { taskId: 't1', approvalId: 'ap-1', policyOutcome: 'ALLOW_WITH_LOG', policyId: 'default', policyVersion: 1, evidence: { testsPassed: true }, reasons: ['ci passed'], amountUsd: 0 }),
    ev(id, 'APPROVAL_GRANTED', { approvalId: 'ap-1', decidedBy: 'policy' }),
    ev(id, 'TASK_SETTLED', { taskId: 't1', reason: 'internal — no escrow' }),
    ev(id, 'SESSION_COMPLETED', { partial: false }),
  ]
  let state = initialState(events[0])
  for (const e of events.slice(1)) {
    state = applyEvent(state, e)
    expect(sessionInvariants(state), `after ${e.type}`).toEqual([])
  }
  return { state, events }
}

describe('the happy path', () => {
  it('walks every status the loop needs and ends completed', () => {
    const { state } = happyPath()
    expect(state.session.status).toBe('completed')
    expect(state.tasks.t1.status).toBe('settled')
    expect(state.tasks.t1.attempts).toBe(1)
    expect(state.runs['run-1'].status).toBe('finished')
    expect(state.runs['run-1'].changedFiles).toEqual(['lib/auth.ts', 'tests/auth.test.ts'])
    expect(state.checkpoints['cp-1'].gitHead).toBe('abc')
    expect(state.session.checkpointId).toBe('cp-1')
    expect(state.artifacts['art-1'].kind).toBe('diff')
    expect(state.approvals['ap-1'].decidedBy).toBe('policy')
    expect(state.session.completedAt).not.toBeNull()
    expect(state.session.nextWakeAt).toBeNull()
  })

  it('replay of the log reproduces the materialized state exactly', () => {
    const { state, events } = happyPath()
    expect(replay(events)).toEqual(state)
  })

  it('is idempotent: a duplicated event changes nothing', () => {
    const { state, events } = happyPath()
    const twice = [...events.slice(0, 6), events[5], ...events.slice(6)]
    expect(replay(twice)).toEqual(state)
    const again = applyEvent(state, events[10])
    expect(again).toBe(state)
  })

  it('a shuffled log that breaks the transition table is refused loudly', () => {
    const { events } = happyPath()
    const bad = [events[0], events[1], events[4]] // dispatch without a budget check or TASK_READY
    expect(() => replay(bad)).toThrow(InvalidEvent)
    const bad2 = [events[0], events[1], events[2], events[3], events[18]] // SESSION_COMPLETED from ready is allowed by the table…
    expect(() => replay(bad2)).not.toThrow()
    // …but a completed session with an open task is an invariant violation the store would refuse.
    expect(sessionInvariants(replay(bad2))).toContain('completed session has a task that is not terminal')
    // A terminal session cannot be dispatched into, whatever the task says.
    const bad3 = [
      ...events.slice(0, 5),
      events[18],
      ev('ses-h', 'TASK_READY', { taskId: 't1' }),
      ev('ses-h', 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-9', workerAgentId: 'w' }),
    ]
    expect(() => replay(bad3)).toThrow(InvalidTransition)
  })
})

describe('worker crash and resume', () => {
  it('a timed-out run moves the session to waiting_on_worker and keeps the checkpoint', () => {
    const id = 'ses-c'
    let s = run(
      initialState(created(id)),
      plan(id),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
      ev(id, 'TASK_READY', { taskId: 't1' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'agent-local' }),
      ev(id, 'RUN_STARTED', { runId: 'run-1' }),
      ev(id, 'CHECKPOINT_CREATED', { runId: 'run-1', checkpointId: 'cp-1', seq: 1, summary: 'half done', patch: 'diff', filesChanged: ['a.ts'] }),
      ev(id, 'RUN_TIMED_OUT', { runId: 'run-1', failureCode: 'TIM-002', reason: 'no heartbeat for 5m' }),
    )
    expect(s.session.status).toBe('waiting_on_worker')
    expect(s.session.currentRunId).toBeNull()
    expect(s.session.checkpointId).toBe('cp-1')
    expect(s.runs['run-1'].status).toBe('timed_out')
    expect(s.tasks.t1.attempts).toBe(1)

    // Resume: a new run on the same task from the checkpoint. No duplicate work: the task is still t1, attempt 2.
    s = run(
      s,
      ev(id, 'RETRY_SCHEDULED', { taskId: 't1', at: T0 + 60_000 }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-2', workerAgentId: 'agent-local', resumedFromCheckpointId: 'cp-1' }),
      ev(id, 'RUN_STARTED', { runId: 'run-2' }),
    )
    expect(s.session.status).toBe('running')
    expect(s.runs['run-2'].resumedFromCheckpointId).toBe('cp-1')
    expect(s.tasks.t1.attempts).toBe(2)
  })

  it('late telemetry from a closed run is ignored, not an error', () => {
    const id = 'ses-l'
    let s = run(
      initialState(created(id)),
      plan(id),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
      ev(id, 'TASK_READY', { taskId: 't1' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'w' }),
      ev(id, 'RUN_FAILED', { runId: 'run-1', failureCode: 'DET-001' }),
    )
    const before = s.runs['run-1']
    s = run(s, ev(id, 'RUN_PROGRESS', { runId: 'run-1', changedFiles: ['late.ts'] }))
    expect(s.runs['run-1'].changedFiles).toEqual(before.changedFiles)
    expect(s.runs['run-1'].status).toBe('failed')
  })

  it('retry exhaustion: no RETRY_SCHEDULED past maxAttempts', () => {
    const id = 'ses-r'
    let s = run(
      initialState(created(id, { retryPolicy: { maxAttempts: 1 } })),
      plan(id),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
      ev(id, 'TASK_READY', { taskId: 't1' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'w' }),
      ev(id, 'RUN_FAILED', { runId: 'run-1' }),
    )
    expect(() => applyEvent(s, ev(id, 'RETRY_SCHEDULED', { taskId: 't1' }))).toThrow(/no attempts left/)
    s = run(s, ev(id, 'TASK_FAILED', { taskId: 't1', reason: 'attempts spent' }), ev(id, 'SESSION_COMPLETED', { partial: true }))
    expect(s.session.status).toBe('partially_completed')
  })

  it('two workers cannot both run the same task: a second dispatch on a running task is refused', () => {
    const id = 'ses-2w'
    const s = run(
      initialState(created(id)),
      plan(id),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
      ev(id, 'TASK_READY', { taskId: 't1' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'w1' }),
      ev(id, 'RUN_STARTED', { runId: 'run-1' }),
    )
    expect(() => applyEvent(s, ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-2', workerAgentId: 'w2' }))).toThrow(/only a ready task/)
  })
})

describe('approval and money', () => {
  const base = (id: string, settlement: 'internal' | 'escrow' = 'internal', bountyUsd = 2) => {
    const s = run(
      initialState(created(id)),
      plan(id, [{ id: 't1', title: 'Fix', brief: 'b', acceptanceCriteria: 'c', kind: 'coding', settlement, bountyUsd } as never]),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
      ev(id, 'TASK_READY', { taskId: 't1' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'w' }),
      ev(id, 'RUN_STARTED', { runId: 'run-1' }),
      ev(id, 'RUN_FINISHED', { runId: 'run-1', exitCode: 0 }),
      ev(id, 'TASK_SUBMITTED', { taskId: 't1', deliverable: 'done' }),
    )
    return s
  }

  it('REQUIRE_OWNER parks the session in waiting_on_approval, where the policy cannot decide', () => {
    const id = 'ses-o'
    let s = run(base(id), ev(id, 'APPROVAL_REQUESTED', { taskId: 't1', approvalId: 'ap-1', policyOutcome: 'REQUIRE_OWNER', amountUsd: 2 }))
    expect(s.session.status).toBe('waiting_on_approval')
    expect(s.tasks.t1.status).toBe('awaiting_approval')
    expect(() => applyEvent(s, ev(id, 'APPROVAL_GRANTED', { approvalId: 'ap-1', decidedBy: 'policy' }))).toThrow(/required a owner/)
    expect(() => applyEvent(s, ev(id, 'PAYMENT_AUTHORIZED', { approvalId: 'ap-1' }))).toThrow(/not granted/)
    s = run(s, ev(id, 'APPROVAL_GRANTED', { approvalId: 'ap-1', decidedBy: 'owner', decidedById: 'u1' }))
    expect(s.session.status).toBe('ready')
    expect(s.tasks.t1.status).toBe('approved')
    expect(s.approvals['ap-1'].decidedBy).toBe('owner')
  })

  it('a denial fails the task and records who denied it', () => {
    const id = 'ses-d'
    const s = run(
      base(id),
      ev(id, 'APPROVAL_REQUESTED', { taskId: 't1', approvalId: 'ap-1', policyOutcome: 'REQUIRE_OWNER' }),
      ev(id, 'APPROVAL_DENIED', { approvalId: 'ap-1', decidedBy: 'owner', decidedById: 'u1', reason: 'touches prod config' }),
    )
    expect(s.tasks.t1.status).toBe('failed')
    expect(s.tasks.t1.outcome?.failureCode).toBe('APPROVAL_DENIED')
    expect(s.approvals['ap-1'].granted).toBe(false)
  })

  it('an approval is decided once; a second answer does not flip it', () => {
    const id = 'ses-once'
    const s = run(
      base(id),
      ev(id, 'APPROVAL_REQUESTED', { taskId: 't1', approvalId: 'ap-1', policyOutcome: 'REQUIRE_OWNER' }),
      ev(id, 'APPROVAL_GRANTED', { approvalId: 'ap-1', decidedBy: 'owner' }),
      ev(id, 'APPROVAL_DENIED', { approvalId: 'ap-1', decidedBy: 'owner' }),
    )
    expect(s.approvals['ap-1'].granted).toBe(true)
    expect(s.tasks.t1.status).toBe('approved')
  })

  it('an escrow task cannot settle before its payment settled, and a payment settles once', () => {
    const id = 'ses-e'
    let s = run(
      base(id, 'escrow', 2),
      ev(id, 'APPROVAL_REQUESTED', { taskId: 't1', approvalId: 'ap-1', policyOutcome: 'ALLOW', amountUsd: 2 }),
      ev(id, 'APPROVAL_GRANTED', { approvalId: 'ap-1', decidedBy: 'policy' }),
    )
    expect(() => applyEvent(s, ev(id, 'TASK_SETTLED', { taskId: 't1' }))).toThrow(/before PAYMENT_SETTLED/)
    s = run(
      s,
      ev(id, 'PAYMENT_AUTHORIZED', { approvalId: 'ap-1' }),
      ev(id, 'PAYMENT_SETTLED', { approvalId: 'ap-1', txHash: '0xabc', amountUsd: 2 }),
      ev(id, 'PAYMENT_SETTLED', { approvalId: 'ap-1', txHash: '0xabc', amountUsd: 2 }, undefined, 'dup-key-but-different'),
      ev(id, 'TASK_SETTLED', { taskId: 't1' }),
    )
    expect(s.session.spentUsd).toBe(2)
    expect(s.tasks.t1.status).toBe('settled')
  })

  it('spend cannot exceed the budget without the invariant naming it', () => {
    const id = 'ses-b'
    const s = run(
      base(id, 'escrow', 2),
      ev(id, 'APPROVAL_REQUESTED', { taskId: 't1', approvalId: 'ap-1', policyOutcome: 'ALLOW', amountUsd: 2 }),
      ev(id, 'APPROVAL_GRANTED', { approvalId: 'ap-1', decidedBy: 'policy' }),
    )
    const over = applyEvent(s, ev(id, 'PAYMENT_SETTLED', { approvalId: 'ap-1', amountUsd: 999 }))
    expect(sessionInvariants(over).join(' ')).toMatch(/exceeds budget/)
  })

  it('a task cannot settle without a granted approval', () => {
    const id = 'ses-na'
    const s = base(id)
    expect(() => applyEvent(s, ev(id, 'TASK_SETTLED', { taskId: 't1' }))).toThrow(/only an approved task settles/)
  })
})

describe('pause, cancel, expire, dependencies', () => {
  it('pause stops everything; resume returns to ready and the loop re-derives the rest', () => {
    const id = 'ses-p'
    let s = run(initialState(created(id)), plan(id), ev(id, 'BUDGET_CHECKED', { ok: true }), ev(id, 'TASK_READY', { taskId: 't1' }), ev(id, 'SESSION_PAUSED', { reason: 'lunch' }))
    expect(s.session.status).toBe('paused')
    expect(s.session.pausedAt).not.toBeNull()
    expect(() => applyEvent(s, ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'r', workerAgentId: 'w' }))).toThrow(InvalidTransition)
    s = run(s, ev(id, 'SESSION_RESUMED'))
    expect(s.session.status).toBe('ready')
    expect(s.session.pausedAt).toBeNull()
  })

  it('cancel marks live runs for stopping and open tasks cancelled; nothing dispatches afterwards', () => {
    const id = 'ses-x'
    const s = run(
      initialState(created(id)),
      plan(id),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
      ev(id, 'TASK_READY', { taskId: 't1' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-1', workerAgentId: 'w' }),
      ev(id, 'SESSION_CANCELLED', { reason: 'owner' }),
    )
    expect(s.session.status).toBe('cancelled')
    expect(s.runs['run-1'].cancelRequestedAt).not.toBeNull()
    expect(s.tasks.t1.status).toBe('cancelled')
    expect(() => applyEvent(s, ev(id, 'TASK_DISPATCHED', { taskId: 't1', runId: 'run-2', workerAgentId: 'w' }))).toThrow()
  })

  it('a session can expire from any live status', () => {
    const id = 'ses-t'
    const s = run(initialState(created(id)), plan(id), ev(id, 'SESSION_EXPIRED'))
    expect(s.session.status).toBe('expired')
  })

  it('dependency unblock and doom', () => {
    const id = 'ses-dep'
    let s = run(
      initialState(created(id)),
      plan(id, [
        { id: 'a', title: 'A', brief: 'a', acceptanceCriteria: 'a', kind: 'coding' },
        { id: 'b', title: 'B', brief: 'b', acceptanceCriteria: 'b', kind: 'coding', dependsOn: ['a'] } as never,
      ]),
      ev(id, 'BUDGET_CHECKED', { ok: true }),
    )
    expect(unblockedTasks(s).map((t) => t.id)).toEqual(['a'])
    s = run(
      s,
      ev(id, 'TASK_READY', { taskId: 'a' }),
      ev(id, 'TASK_BLOCKED', { taskId: 'b', reason: 'waiting on a' }),
      ev(id, 'TASK_DISPATCHED', { taskId: 'a', runId: 'r1', workerAgentId: 'w' }),
      ev(id, 'RUN_FAILED', { runId: 'r1' }),
      ev(id, 'TASK_FAILED', { taskId: 'a', reason: 'gave up' }),
    )
    expect(doomedTasks(s).map((t) => t.id)).toEqual(['b'])
    s = run(s, ev(id, 'TASK_SKIPPED', { taskId: 'b' }), ev(id, 'SESSION_COMPLETED', { partial: true }))
    expect(s.tasks.b.status).toBe('skipped')
    expect(s.session.status).toBe('partially_completed')
  })

  it('planned cost sums unsettled bounties', () => {
    const id = 'ses-cost'
    const s = run(
      initialState(created(id)),
      plan(id, [
        { id: 'a', title: 'A', brief: 'a', acceptanceCriteria: 'a', kind: 'coding', bountyUsd: 1.5, settlement: 'escrow' } as never,
        { id: 'b', title: 'B', brief: 'b', acceptanceCriteria: 'b', kind: 'text', bountyUsd: 2.25, settlement: 'escrow' } as never,
      ]),
    )
    expect(plannedCostUsd(s)).toBe(3.75)
  })

  it('a scheduled session starts a new wave from a terminal-looking ready state', () => {
    const id = 'ses-w'
    let s = run(initialState(created(id, { kind: 'scheduled', schedule: { kind: 'interval', everyMs: 3_600_000 } })), plan(id), ev(id, 'BUDGET_CHECKED', { ok: true }))
    s = run(s, ev(id, 'WAVE_STARTED', { wave: 2 }))
    expect(s.session.wave).toBe(2)
    expect(s.session.status).toBe('ready')
    s = run(s, plan(id, [{ id: 'w2-t1', title: 'again', brief: 'b', acceptanceCriteria: 'c', kind: 'coding' }]))
    expect(unblockedTasks(s, 2).map((t) => t.id)).toEqual(['w2-t1'])
    expect(unblockedTasks(s, 1).map((t) => t.id)).toEqual(['t1'])
  })
})

describe('time helpers', () => {
  it('retry backoff grows and caps', () => {
    const p = { maxAttempts: 5, backoffMs: 1000, backoffMultiplier: 3, maxBackoffMs: 5000 }
    expect(retryDelayMs(p, 1)).toBe(1000)
    expect(retryDelayMs(p, 2)).toBe(1000)
    expect(retryDelayMs(p, 3)).toBe(3000)
    expect(retryDelayMs(p, 4)).toBe(5000)
  })

  it('daily schedule fires later today or tomorrow, never now', () => {
    const now = Date.parse('2026-09-03T08:00:00Z')
    expect(nextScheduledAt({ kind: 'daily', atUtcMinutes: 9 * 60 }, now)).toBe(Date.parse('2026-09-03T09:00:00Z'))
    expect(nextScheduledAt({ kind: 'daily', atUtcMinutes: 7 * 60 }, now)).toBe(Date.parse('2026-09-04T07:00:00Z'))
    expect(nextScheduledAt({ kind: 'interval', everyMs: 1 }, now)).toBe(now + 60_000)
  })

  it('sentence carries the reason', () => {
    const s = initialState(created())
    expect(sessionSentence(s.session)).toBe(STATUS_META.draft.sentence)
    expect(sessionSentence({ ...s.session, statusReason: 'x' })).toContain('(x)')
  })
})

describe('narrowGrant — permission layering', () => {
  const base = { workdir: '/home/me/repo', write: true, shell: true, network: true, install: true, secrets: false, gitPush: true, externalPayments: false, perTaskLimitUsd: 5, dailyLimitUsd: 50 }
  it('a layer can only take away or lower; never widen', () => {
    const g = narrowGrant(base, { network: false, perTaskLimitUsd: 2 }, { gitPush: false, dailyLimitUsd: 100, secrets: true, externalPayments: true })
    expect(g).toEqual({ ...base, network: false, gitPush: false, perTaskLimitUsd: 2, dailyLimitUsd: 50 })
  })
  it('an absent field keeps the base; a null layer is a no-op', () => {
    expect(narrowGrant(base, null, undefined, {})).toEqual(base)
  })
  it('a workdir moves only inward', () => {
    expect(narrowGrant(base, { workdir: '/home/me/repo/packages/api' }).workdir).toBe('/home/me/repo/packages/api')
    expect(narrowGrant(base, { workdir: '/home/me/other' }).workdir).toBe('/home/me/repo')
    expect(narrowGrant(base, { workdir: '/home/me/repo2' }).workdir).toBe('/home/me/repo')
    expect(narrowGrant(base, { workdir: '' }).workdir).toBe('/home/me/repo')
    expect(narrowGrant({ ...base, workdir: '' }, { workdir: '/anything' }).workdir).toBe('')
  })
  it('a limit never goes negative or non-finite', () => {
    expect(narrowGrant(base, { perTaskLimitUsd: -1 }).perTaskLimitUsd).toBe(0)
    expect(narrowGrant(base, { perTaskLimitUsd: Number.NaN }).perTaskLimitUsd).toBe(5)
  })
})
