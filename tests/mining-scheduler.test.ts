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
