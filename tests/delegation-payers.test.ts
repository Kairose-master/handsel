import { describe, it, expect } from 'vitest'
import {
  escrowByPayer,
  payerIdFor,
  parsePlannerOutput,
  MIN_SUBTASK_BOUNTY_USD,
  type DelegationSubtask,
} from '@/lib/delegation'
import { OFFICE_MIN_STEP_BOUNTY_USD, OFFICE_TEMPLATES, officeStepBounties } from '@/lib/office-world-data'

const st = (over: Partial<DelegationSubtask>): DelegationSubtask => ({
  title: 't',
  description: 'd',
  acceptanceCriteria: 'c',
  bountyUsd: 2,
  ...over,
})

describe('payerIdFor', () => {
  it('falls back to the prime when the subtask names no payer', () => {
    expect(payerIdFor(st({}), 'prime')).toBe('prime')
  })

  it('uses the subtask payer when it names one', () => {
    expect(payerIdFor(st({ payerAgentId: 'other' }), 'prime')).toBe('other')
  })

  it('treats a blank payer as absent rather than as an empty agent id', () => {
    expect(payerIdFor(st({ payerAgentId: '   ' }), 'prime')).toBe('prime')
  })
})

describe('escrowByPayer', () => {
  it('bills everything to the prime when no subtask names a payer', () => {
    const got = escrowByPayer([st({ bountyUsd: 2 }), st({ bountyUsd: 3 })], 'prime')
    expect([...got]).toEqual([['prime', 5]])
  })

  it('gives each payer only its own obligation', () => {
    const got = escrowByPayer(
      [st({ bountyUsd: 2 }), st({ bountyUsd: 3, payerAgentId: 'b' }), st({ bountyUsd: 4, payerAgentId: 'b' })],
      'prime',
    )
    expect(got.get('prime')).toBe(2)
    expect(got.get('b')).toBe(7)
  })

  it('skips already-posted subtasks so a retried confirm only checks the remainder', () => {
    const got = escrowByPayer([st({ bountyUsd: 2, onchainJobId: 11 }), st({ bountyUsd: 3 })], 'prime')
    expect([...got]).toEqual([['prime', 3]])
  })

  it('never counts integration subtasks — they are platform-verified, never escrowed', () => {
    const got = escrowByPayer([st({ bountyUsd: 0, isIntegration: true }), st({ bountyUsd: 3 })], 'prime')
    expect([...got]).toEqual([['prime', 3]])
  })

  it('is empty when there is nothing left to post', () => {
    expect([...escrowByPayer([st({ bountyUsd: 2, onchainJobId: 1 })], 'prime')]).toEqual([])
  })

  it('rounds to cents rather than accumulating float error', () => {
    const got = escrowByPayer([st({ bountyUsd: 0.1 }), st({ bountyUsd: 0.2 })], 'prime')
    expect(got.get('prime')).toBe(0.3)
  })
})

describe('a payer is never planner-authored', () => {
  it('drops payerAgentId from planner output the way it drops splitSpec', () => {
    const [only] = parsePlannerOutput(
      JSON.stringify([
        {
          title: 'Write the brief',
          description: 'Write it',
          acceptanceCriteria: 'A brief exists and covers the scope.',
          bountyUsd: 2,
          payerAgentId: 'someone-elses-agent',
          splitSpec: { recipients: [{ role: 'x', agentId: 'y', bps: 10000 }] },
        },
      ]),
      10,
    )
    expect(only.payerAgentId).toBeUndefined()
    expect(only.splitSpec).toBeUndefined()
  })
})

describe('officeStepBounties', () => {
  it('agrees with the delegation bounty floor it mirrors', () => {
    expect(OFFICE_MIN_STEP_BOUNTY_USD).toBe(MIN_SUBTASK_BOUNTY_USD)
  })

  it('splits equally when no step is weighted', () => {
    const t = OFFICE_TEMPLATES.find((x) => x.pipeline.every((s) => (s.bountyWeight ?? 1) === 1))!
    const got = officeStepBounties(t, t.pipeline.length * 3)
    expect([...got.values()]).toEqual(t.pipeline.map(() => 3))
  })

  it('gives a weight-2 step twice a weight-1 step out of the same budget', () => {
    const t = OFFICE_TEMPLATES.find((x) => x.pipeline.some((s) => (s.bountyWeight ?? 1) === 2))!
    // A budget that divides evenly by the weight total, so the assertion is
    // about the weighting and not about how each share rounds to cents.
    const totalWeight = t.pipeline.reduce((sum, s) => sum + (s.bountyWeight ?? 1), 0)
    const got = officeStepBounties(t, totalWeight * 10)
    const light = t.pipeline.find((s) => (s.bountyWeight ?? 1) === 1)
    const heavy = t.pipeline.find((s) => (s.bountyWeight ?? 1) === 2)!
    expect(got.get(heavy.roleId)).toBe(20)
    if (light) expect(got.get(light.roleId)).toBe(10)
  })

  it('never returns a step below the floor, however small the budget', () => {
    for (const t of OFFICE_TEMPLATES) {
      for (const v of officeStepBounties(t, 0.01).values()) {
        expect(v).toBeGreaterThanOrEqual(OFFICE_MIN_STEP_BOUNTY_USD)
      }
    }
  })

  it('totals the budget to within per-step rounding at every default budget', () => {
    // Each share is rounded to cents independently, so the total can miss the
    // budget by up to half a cent per step — a weight-6 split of $10 escrows
    // $10.01. That is inside postDelegationJobs' own one-cent tolerance and
    // is the figure the office actually stores as its budget, so the
    // invariant is the bound, not exactness.
    for (const t of OFFICE_TEMPLATES) {
      const budget = t.pipeline.length * 2
      const total = [...officeStepBounties(t, budget).values()].reduce((s, x) => s + x, 0)
      expect(Math.abs(total - budget), t.id).toBeLessThanOrEqual(t.pipeline.length * 0.005 + 1e-9)
    }
  })

  it('keys every pipeline step, so no step can silently miss a bounty', () => {
    for (const t of OFFICE_TEMPLATES) {
      const got = officeStepBounties(t, 20)
      expect(got.size).toBe(t.pipeline.length)
      for (const step of t.pipeline) expect(got.get(step.roleId)).toBeGreaterThan(0)
    }
  })
})
