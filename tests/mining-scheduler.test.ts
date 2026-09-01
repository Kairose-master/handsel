import { describe, expect, it } from 'vitest'
import {
  selectMiningBlocks,
  isEligibleBlock,
  freeMiningSlots,
  type MiningCandidate,
  type SelectMiningInput,
} from '@/lib/mining-scheduler'

const NOW = 1_000_000_000
const TTL = 90_000
const ME = '0xworker'

function candidate(over: Partial<{
  id: number
  status: string
  requester: string
  worker: string
  minScore: number
  specHash: string
  requesterAgentId: string | null
  createdAt: Date
  failedWorkerIds: string[] | null
  claimedByAgentId: string | null
  claimedAt: Date | null
  deliverableKind: string | null
  requiredCapabilities: string[] | null
  title: string
  bounty: number
}> = {}): MiningCandidate {
  const specHash = over.specHash ?? `hash-${over.id ?? 1}`
  return {
    job: {
      id: over.id ?? 1,
      status: over.status ?? 'Open',
      requester: over.requester ?? '0xrequester',
      worker: over.worker ?? '0x0000000000000000000000000000000000000000',
      minScore: over.minScore ?? 0,
      specHash,
      bounty: over.bounty ?? 1,
    },
    spec: {
      specHash,
      requesterAgentId: over.requesterAgentId ?? 'req-agent',
      createdAt: over.createdAt ?? new Date(NOW - 60_000),
      failedWorkerIds: over.failedWorkerIds ?? null,
      claimedByAgentId: over.claimedByAgentId ?? null,
      claimedAt: over.claimedAt ?? null,
      deliverableKind: over.deliverableKind ?? 'text',
      requiredCapabilities: over.requiredCapabilities ?? null,
      title: over.title ?? `Job ${over.id ?? 1}`,
    },
  }
}

function input(candidates: MiningCandidate[], over: Partial<SelectMiningInput> = {}): SelectMiningInput {
  return {
    canPostBond: () => true,
    candidates,
    myAddress: ME,
    score: 500,
    agentId: 'my-agent',
    now: NOW,
    freeSlots: 10,
    claimTtlMs: TTL,
    canDeliver: () => true,
    isFaucetReserved: () => false,
    isReservedForOther: () => false,
    ...over,
  }
}

describe('freeMiningSlots', () => {
  it('is the ceiling minus in-flight, floored at zero', () => {
    expect(freeMiningSlots(0, 3)).toBe(3)
    expect(freeMiningSlots(2, 3)).toBe(1)
    expect(freeMiningSlots(3, 3)).toBe(0)
    expect(freeMiningSlots(5, 3)).toBe(0)
  })

  it('maxSlots of 1 reproduces the single-slot idle gate', () => {
    expect(freeMiningSlots(0, 1)).toBe(1)
    expect(freeMiningSlots(1, 1)).toBe(0)
  })
})

describe('isEligibleBlock', () => {
  it('accepts a plain open, deliverable, unclaimed job', () => {
    expect(isEligibleBlock(candidate(), input([]))).toBe(true)
  })

  it('rejects non-Open jobs', () => {
    expect(isEligibleBlock(candidate({ status: 'Accepted' }), input([]))).toBe(false)
  })

  it('rejects jobs whose minScore exceeds the agent score', () => {
    expect(isEligibleBlock(candidate({ minScore: 600 }), input([], { score: 500 }))).toBe(false)
    expect(isEligibleBlock(candidate({ minScore: 500 }), input([], { score: 500 }))).toBe(true)
  })

  it('rejects self-posted jobs (case-insensitive address match)', () => {
    expect(isEligibleBlock(candidate({ requester: '0xWORKER' }), input([]))).toBe(false)
  })

  it('rejects a lineage this agent already failed', () => {
    expect(
      isEligibleBlock(candidate({ failedWorkerIds: ['other', 'my-agent'] }), input([])),
    ).toBe(false)
  })

  it('rejects a job a DIFFERENT worker holds a live claim on', () => {
    expect(
      isEligibleBlock(
        candidate({ claimedByAgentId: 'rival', claimedAt: new Date(NOW - 1000) }),
        input([]),
      ),
    ).toBe(false)
  })

  it('allows a job whose claim has gone stale', () => {
    expect(
      isEligibleBlock(
        candidate({ claimedByAgentId: 'rival', claimedAt: new Date(NOW - TTL - 1) }),
        input([]),
      ),
    ).toBe(true)
  })

  it('allows a job THIS agent already holds the claim on (re-entrant)', () => {
    expect(
      isEligibleBlock(
        candidate({ claimedByAgentId: 'my-agent', claimedAt: new Date(NOW - 1000) }),
        input([]),
      ),
    ).toBe(true)
  })

  it('rejects a job it cannot deliver', () => {
    expect(
      isEligibleBlock(candidate({ deliverableKind: 'image' }), input([], { canDeliver: () => false })),
    ).toBe(false)
  })

  it('rejects a faucet job still reserved for newcomers', () => {
    expect(isEligibleBlock(candidate(), input([], { isFaucetReserved: () => true }))).toBe(false)
  })

  it('rejects a job reserved (lib/job-reservation.ts) for a different agent', () => {
    expect(isEligibleBlock(candidate(), input([], { isReservedForOther: () => true }))).toBe(false)
  })

  it('allows a job reserved for THIS agent (isReservedForOther only flags others)', () => {
    expect(isEligibleBlock(candidate(), input([], { isReservedForOther: () => false }))).toBe(true)
  })
})

describe('selectMiningBlocks', () => {
  it('returns nothing when there are no free slots', () => {
    const cs = [candidate({ id: 1 }), candidate({ id: 2 })]
    expect(selectMiningBlocks(input(cs, { freeSlots: 0 }))).toEqual([])
  })

  it('takes up to freeSlots eligible blocks, in input (FIFO) order', () => {
    const cs = [candidate({ id: 1 }), candidate({ id: 2 }), candidate({ id: 3 })]
    const picked = selectMiningBlocks(input(cs, { freeSlots: 2 }))
    expect(picked.map((c) => c.job.id)).toEqual([1, 2])
  })

  it('skips ineligible blocks but keeps filling remaining slots', () => {
    const cs = [
      candidate({ id: 1, status: 'Accepted' }), // ineligible
      candidate({ id: 2 }),
      candidate({ id: 3, minScore: 9999 }), // ineligible
      candidate({ id: 4 }),
    ]
    const picked = selectMiningBlocks(input(cs, { freeSlots: 2 }))
    expect(picked.map((c) => c.job.id)).toEqual([2, 4])
  })

  it('returns fewer than freeSlots when not enough are eligible', () => {
    const cs = [candidate({ id: 1 }), candidate({ id: 2, status: 'Accepted' })]
    const picked = selectMiningBlocks(input(cs, { freeSlots: 5 }))
    expect(picked.map((c) => c.job.id)).toEqual([1])
  })
})

describe('the bond gate', () => {
  // Accepting stakes USDC out of the worker's own account, so affordability
  // decides eligibility exactly the way minScore does — both are guaranteed
  // on-chain reverts, and attempting either costs a built UserOperation and a
  // log line that reads like an RPC fault.
  it('skips a job whose bond the worker cannot stake', () => {
    const jobs = [candidate({ id: 1, bounty: 1.71 }), candidate({ id: 2, bounty: 0.1 })]
    const picked = selectMiningBlocks(
      input(jobs, { canPostBond: (job) => job.bounty < 1 }),
    )
    expect(picked.map((c) => c.job.id)).toEqual([2])
  })

  it('takes everything when the balance covers it', () => {
    const jobs = [candidate({ id: 1, bounty: 1.71 }), candidate({ id: 2, bounty: 0.1 })]
    expect(selectMiningBlocks(input(jobs)).map((c) => c.job.id)).toEqual([1, 2])
  })
})

describe('the auto-mine scope gate', () => {
  // The reported harm: an office's hired specialist, auto-mined on by
  // hire_office, claimed a third party's job — staking a USDC bond and its
  // credit score on work the owner never approved.
  it("keeps an own-scope worker off another account's job", () => {
    const jobs = [candidate({ id: 1, requester: '0xstranger' }), candidate({ id: 2, requester: '0xmine' })]
    const picked = selectMiningBlocks(
      input(jobs, { scope: 'own', isOwnAccountJob: (c) => c.job.requester === '0xmine' }),
    )
    expect(picked.map((c) => c.job.id)).toEqual([2])
  })

  it('leaves market scope taking everything, exactly as before scope existed', () => {
    const jobs = [candidate({ id: 1, requester: '0xstranger' }), candidate({ id: 2, requester: '0xmine' })]
    const picked = selectMiningBlocks(
      input(jobs, { scope: 'market', isOwnAccountJob: (c) => c.job.requester === '0xmine' }),
    )
    expect(picked.map((c) => c.job.id)).toEqual([1, 2])
  })

  it('defaults to market for a caller that never heard of scope', () => {
    // Every existing call site omits both fields; none of them may start
    // refusing work because a new option was added.
    expect(isEligibleBlock(candidate({ requester: '0xstranger' }), input([]))).toBe(true)
  })
})

describe('shouldHealAcceptedJob', () => {
  it('heals a taskless accepted job — the original crash-between-accept-and-dispatch case', async () => {
    const { shouldHealAcceptedJob } = await import('@/lib/mining-scheduler')
    expect(shouldHealAcceptedJob({ hasTask: false })).toBe(true)
  })

  it('re-dispatches a FAILED dispatch after the cooldown — the dead-model-key incident', async () => {
    const { shouldHealAcceptedJob, REDISPATCH_COOLDOWN_MS } = await import('@/lib/mining-scheduler')
    expect(
      shouldHealAcceptedJob({ hasTask: true, taskStatus: 'failed', taskAgeMs: REDISPATCH_COOLDOWN_MS + 1 }),
    ).toBe(true)
    // Inside the cooldown: the world probably has not changed yet.
    expect(
      shouldHealAcceptedJob({ hasTask: true, taskStatus: 'failed', taskAgeMs: REDISPATCH_COOLDOWN_MS - 1 }),
    ).toBe(false)
  })

  it('never double-dispatches over a task that is genuinely in flight', async () => {
    const { shouldHealAcceptedJob } = await import('@/lib/mining-scheduler')
    for (const status of ['queued', 'running', 'processing', 'completed']) {
      expect(shouldHealAcceptedJob({ hasTask: true, taskStatus: status, taskAgeMs: 10 ** 9 })).toBe(false)
    }
  })
})

describe('shouldHealAcceptedJob — completed-but-worker-reported-failure', () => {
  it('heals a completed task whose worker said success:false — the callback never marks these failed', async () => {
    const { shouldHealAcceptedJob, REDISPATCH_COOLDOWN_MS } = await import('@/lib/mining-scheduler')
    expect(
      shouldHealAcceptedJob({
        hasTask: true,
        taskStatus: 'completed',
        taskReportedSuccess: false,
        taskAgeMs: REDISPATCH_COOLDOWN_MS + 1,
      }),
    ).toBe(true)
  })

  it('never touches a completed task whose worker reported success, or one with unknown success', async () => {
    const { shouldHealAcceptedJob } = await import('@/lib/mining-scheduler')
    expect(
      shouldHealAcceptedJob({ hasTask: true, taskStatus: 'completed', taskReportedSuccess: true, taskAgeMs: 10 ** 9 }),
    ).toBe(false)
    expect(
      shouldHealAcceptedJob({ hasTask: true, taskStatus: 'completed', taskReportedSuccess: null, taskAgeMs: 10 ** 9 }),
    ).toBe(false)
  })
})

describe('shouldHealAcceptedJob — deadline runway', () => {
  it('declines any heal into a deadline that cannot be met — the wasted re-dispatch of the same incident', async () => {
    const { shouldHealAcceptedJob, HEAL_MIN_RUNWAY_MS, REDISPATCH_COOLDOWN_MS } = await import('@/lib/mining-scheduler')
    // Otherwise-perfect heal candidates, both kinds, refused on runway alone.
    expect(shouldHealAcceptedJob({ hasTask: false, deadlineRunwayMs: HEAL_MIN_RUNWAY_MS - 1 })).toBe(false)
    expect(
      shouldHealAcceptedJob({
        hasTask: true,
        taskStatus: 'failed',
        taskAgeMs: REDISPATCH_COOLDOWN_MS + 1,
        deadlineRunwayMs: HEAL_MIN_RUNWAY_MS - 1,
      }),
    ).toBe(false)
    // A lapsed deadline is negative runway — same refusal, not an exception.
    expect(shouldHealAcceptedJob({ hasTask: false, deadlineRunwayMs: -60_000 })).toBe(false)
  })

  it('heals when the runway is generous, and when it is unknown (V1 market, RPC gap) — unknown never blocks', async () => {
    const { shouldHealAcceptedJob, HEAL_MIN_RUNWAY_MS } = await import('@/lib/mining-scheduler')
    expect(shouldHealAcceptedJob({ hasTask: false, deadlineRunwayMs: HEAL_MIN_RUNWAY_MS + 1 })).toBe(true)
    expect(shouldHealAcceptedJob({ hasTask: false, deadlineRunwayMs: null })).toBe(true)
    expect(shouldHealAcceptedJob({ hasTask: false })).toBe(true)
  })

  it('gives a floor a dispatch can actually live inside — the 4-minute cloud call plus grading', async () => {
    const { HEAL_MIN_RUNWAY_MS } = await import('@/lib/mining-scheduler')
    expect(HEAL_MIN_RUNWAY_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })
})

describe('shouldResubmitAcceptedJob — finished work whose on-chain submission was eaten', () => {
  it('resubmits a completed task that reported success while the job sits Accepted', async () => {
    const { shouldResubmitAcceptedJob } = await import('@/lib/mining-scheduler')
    expect(shouldResubmitAcceptedJob({ hasTask: true, taskStatus: 'completed', taskReportedSuccess: true })).toBe(true)
  })

  it('never resubmits anything else — failed, unknown, in flight, or taskless', async () => {
    const { shouldResubmitAcceptedJob } = await import('@/lib/mining-scheduler')
    expect(shouldResubmitAcceptedJob({ hasTask: false })).toBe(false)
    expect(shouldResubmitAcceptedJob({ hasTask: true, taskStatus: 'completed', taskReportedSuccess: false })).toBe(false)
    expect(shouldResubmitAcceptedJob({ hasTask: true, taskStatus: 'completed', taskReportedSuccess: null })).toBe(false)
    expect(shouldResubmitAcceptedJob({ hasTask: true, taskStatus: 'running', taskReportedSuccess: true })).toBe(false)
    expect(shouldResubmitAcceptedJob({ hasTask: true, taskStatus: 'failed', taskReportedSuccess: true })).toBe(false)
  })

  it('the heal loop asks resubmit BEFORE re-dispatch — the work exists, never redo it', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/auto-mine.ts', 'utf8')
    const resubmitAt = src.indexOf('shouldResubmitAcceptedJob({')
    const healAt = src.indexOf('shouldHealAcceptedJob({')
    expect(resubmitAt).toBeGreaterThan(-1)
    expect(resubmitAt).toBeLessThan(healAt)
    // Same bytes the callback would have hashed — a late landing and this
    // retry must describe the same submission.
    expect(src).toContain("keccak256(toHex(taskOutput || '(empty output)'))")
  })
})
