/**
 * The numbers an operator is actually buying: how often the office needed a
 * person, how long it waited, whether the work held up, what it cost.
 *
 * The tests below care as much about what these numbers REFUSE to say — a
 * null where there is no data rather than a flattering zero, "wait" rather
 * than "saved" — as about the arithmetic.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_METRICS, humanMs, metricLines, metricsSentence, officeMetrics } from '@/lib/office-metrics'
import type { SessionState } from '@/lib/office-session'

const T = Date.parse('2026-09-03T09:00:00Z')

type Ask = { decidedBy: 'owner' | 'policy' | null; requestedAt: number; decidedAt: number | null; movedUsd?: number }
type Tk = { status: 'settled' | 'failed' | 'running'; attempts: number }

function session(over: {
  status?: SessionState['session']['status']
  createdAt?: number
  startedAt?: number | null
  completedAt?: number | null
  lastHeartbeatAt?: number | null
  asks?: Ask[]
  tasks?: Tk[]
  runCosts?: Array<number | null>
}): SessionState {
  const approvals: Record<string, unknown> = {}
  ;(over.asks ?? []).forEach((a, i) => {
    approvals[`ap-${i}`] = {
      id: `ap-${i}`,
      taskId: 't0',
      requestedAt: a.requestedAt,
      decidedAt: a.decidedAt,
      decidedBy: a.decidedBy,
      moved: a.movedUsd === undefined ? null : { txHash: null, amountUsd: a.movedUsd, at: a.decidedAt ?? 0 },
    }
  })
  const tasks: Record<string, unknown> = {}
  ;(over.tasks ?? []).forEach((t, i) => (tasks[`t${i}`] = { id: `t${i}`, status: t.status, attempts: t.attempts }))
  const runs: Record<string, unknown> = {}
  ;(over.runCosts ?? []).forEach((c, i) => (runs[`r${i}`] = { id: `r${i}`, costUsd: c }))
  return {
    session: {
      status: over.status ?? 'completed',
      createdAt: over.createdAt ?? T,
      startedAt: over.startedAt === undefined ? T : over.startedAt,
      completedAt: over.completedAt === undefined ? T + 600_000 : over.completedAt,
      lastHeartbeatAt: over.lastHeartbeatAt ?? null,
    },
    tasks,
    runs,
    approvals,
    checkpoints: {},
    artifacts: {},
    toolConsults: {},
    applied: [],
    version: 1,
  } as unknown as SessionState
}

describe('an office with nothing in it', () => {
  it('reports no data rather than a flattering zero', () => {
    const m = officeMetrics([])
    expect(m).toEqual(EMPTY_METRICS)
    expect(m.unattendedRate).toBeNull()
    expect(m.passRate).toBeNull()
    expect(m.retriesPerSettled).toBeNull()
    expect(metricsSentence(m)).toBe('This office has not run a session yet.')
    const lines = metricLines(m)
    expect(lines.map((l) => l.value)).toEqual(['—', '0', '—', '—', '$0.00'])
    expect(lines[0].sub).toBe('no session has finished yet')
    expect(lines.every((l) => l.tone === 'plain')).toBe(true)
  })
})

describe('how often a person was needed', () => {
  it('counts a finished session with no owner decision as unattended', () => {
    const m = officeMetrics([
      session({ asks: [{ decidedBy: 'policy', requestedAt: T, decidedAt: T + 1000 }] }),
      session({ asks: [{ decidedBy: 'owner', requestedAt: T, decidedAt: T + 3_600_000 }] }),
      session({ asks: [] }),
    ])
    expect(m.finished).toBe(3)
    expect(m.unattendedRate).toBe(round(2 / 3))
    expect(m.ownerDecisions).toBe(1)
    expect(m.policyDecisions).toBe(1)
    expect(m.ownerWaitMs).toBe(3_600_000)
    expect(m.medianDecisionMs).toBe(3_600_000)
  })

  it('a policy decision never counts as waiting for a person', () => {
    const m = officeMetrics([session({ asks: [{ decidedBy: 'policy', requestedAt: T, decidedAt: T + 9_000_000 }] })])
    expect(m.ownerWaitMs).toBe(0)
    expect(m.medianDecisionMs).toBeNull()
  })

  it('an undecided ask is open, not answered — and a live session waiting on one is visible', () => {
    const m = officeMetrics([session({ status: 'waiting_on_approval', completedAt: null, lastHeartbeatAt: T + 60_000, asks: [{ decidedBy: null, requestedAt: T, decidedAt: null }] })])
    expect(m).toMatchObject({ openAsks: 1, ownerDecisions: 0, finished: 0, live: 1, liveWaitingOnOwner: 1 })
    expect(m.unattendedRate).toBeNull()
    expect(metricsSentence(m)).toContain('1 decision(s) are waiting for you')
  })
})

describe('whether the work held up, and what it cost', () => {
  it('pass rate is over decided tasks only, and rework is attempts past the first', () => {
    const m = officeMetrics([
      session({ tasks: [{ status: 'settled', attempts: 1 }, { status: 'settled', attempts: 3 }, { status: 'failed', attempts: 2 }, { status: 'running', attempts: 1 }] }),
    ])
    expect(m.tasksSettled).toBe(2)
    expect(m.tasksFailed).toBe(1)
    expect(m.passRate).toBe(round(2 / 3))
    expect(m.retries).toBe(3)
    expect(m.retriesPerSettled).toBe(1.5)
  })

  it('the model bill and the money that left are separate numbers', () => {
    const m = officeMetrics([session({ runCosts: [0.1, null, 0.05], asks: [{ decidedBy: 'owner', requestedAt: T, decidedAt: T + 10, movedUsd: 2.5 }] })])
    expect(m.harnessCostUsd).toBe(0.15)
    expect(m.movedUsd).toBe(2.5)
    // one glanceable total, but the split is what an operator argues about:
    // the model bill is theirs, the payout was the market's
    expect(metricLines(m).find((l) => l.key === 'realCost')).toMatchObject({ value: '$2.65', sub: '$0.15 model · $2.50 paid out' })
  })

  it('session duration ends at completedAt, or the last heartbeat, or contributes nothing', () => {
    const m = officeMetrics([
      session({ startedAt: T, completedAt: T + 120_000 }),
      session({ status: 'failed', startedAt: T, completedAt: null, lastHeartbeatAt: T + 240_000 }),
      session({ status: 'cancelled', startedAt: T, completedAt: null, lastHeartbeatAt: null }),
    ])
    expect(m.medianSessionMs).toBe(180_000)
  })

  it('a window drops sessions created before it', () => {
    const m = officeMetrics([session({ createdAt: T - 86_400_000 }), session({ createdAt: T })], { since: T })
    expect(m.finished).toBe(1)
  })
})

describe('saying it without lying', () => {
  it('the sentence claims work done and asks made, never hours saved', () => {
    const m = officeMetrics([
      session({ tasks: [{ status: 'settled', attempts: 2 }], runCosts: [0.5], asks: [{ decidedBy: 'owner', requestedAt: T, decidedAt: T + 300_000, movedUsd: 1 }] }),
      session({ tasks: [{ status: 'settled', attempts: 1 }] }),
    ])
    const sentence = metricsSentence(m)
    expect(sentence).toContain('2 of 2 finished sessions completed; 1 of them without asking you anything')
    expect(sentence).toContain('2 task(s) settled')
    expect(sentence).toContain('You were asked 1 time(s) and answered in 5m on median')
    expect(sentence).toContain('$0.50 of model time and $1.00 paid to workers')
    expect(sentence).not.toMatch(/saved|hours saved|productivity/i)
  })

  it('the blocked line says waiting, never saved', () => {
    const line = metricLines(officeMetrics([session({ asks: [{ decidedBy: 'owner', requestedAt: T, decidedAt: T + 7_200_000 }] })])).find((l) => l.key === 'blockedWaiting')!
    expect(line.value).toBe('2.0h')
    expect(line.sub).toContain('median ask answered in')
    expect(JSON.stringify(line)).not.toMatch(/saved/i)
  })

  it('tone tracks the number, and an unattended office reads good', () => {
    const good = metricLines(officeMetrics([session({ asks: [] }), session({ asks: [] }), session({ tasks: [{ status: 'settled', attempts: 1 }] })]))
    expect(good.find((l) => l.key === 'unattended')!.tone).toBe('good')
    const bad = metricLines(officeMetrics([session({ asks: [{ decidedBy: 'owner', requestedAt: T, decidedAt: T + 1 }] })]))
    expect(bad.find((l) => l.key === 'unattended')!.tone).toBe('bad')
  })

  it('humanMs is readable at every scale and null-safe', () => {
    expect([humanMs(null), humanMs(4_000), humanMs(300_000), humanMs(7_200_000), humanMs(180_000_000)]).toEqual(['—', '4s', '5m', '2.0h', '2.1d'])
  })
})

const round = (n: number) => Math.round(n * 1000) / 1000
