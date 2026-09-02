import { describe, it, expect } from 'vitest'
import { externalRevenue, originOf, renderExternalRevenue, type SettledJob } from '@/lib/external-revenue'

let n = 0
const job = (over: Partial<SettledJob> = {}): SettledJob => ({
  jobId: ++n,
  bountyUsd: 5,
  requesterAgentId: 'req-ext-a',
  requesterUserId: 'user-ext-a',
  settledAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
})
const ctx = { faucetAgentId: 'faucet-agent', internalUserIds: new Set(['operator-user']) }

describe('inside can never leak into outside', () => {
  it('excludes the faucet by agent id', () => {
    expect(originOf(job({ requesterAgentId: 'faucet-agent' }), ctx)).toBe('faucet')
  })

  it('excludes operator-owned requesters by OWNER, not by agent name', () => {
    // One operator account can run many agents; excluding by name would miss
    // every one that was not on the list.
    expect(originOf(job({ requesterAgentId: 'some-op-agent', requesterUserId: 'operator-user' }), ctx)).toBe('operator')
  })

  it('never promotes an unattributable requester to external', () => {
    // docs/product-thesis.md: the Sybil metric's first finding was the market
    // being a star centred on the operator. An unknown counted as external is
    // how that number gets manufactured back.
    expect(originOf(job({ requesterAgentId: null }), ctx)).toBe('unknown')
    expect(originOf(job({ requesterUserId: null }), ctx)).toBe('unknown')
  })

  it('reports what it excluded, so the headline can be checked against the raw count', () => {
    const r = externalRevenue(
      [job(), job({ requesterAgentId: 'faucet-agent' }), job({ requesterUserId: 'operator-user' }), job({ requesterAgentId: null })],
      ctx,
    )
    expect(r.externalJobs).toBe(1)
    expect(r.excluded).toEqual({ faucet: 1, operator: 1, unknown: 1 })
  })
})

describe('the four numbers the plan says to watch', () => {
  it('counts requesters as accounts, not agents', () => {
    const r = externalRevenue([job({ requesterAgentId: 'a1', requesterUserId: 'u1' }), job({ requesterAgentId: 'a2', requesterUserId: 'u1' })], ctx)
    expect(r.externalRequesters).toBe(1)
    expect(r.externalJobs).toBe(2)
  })

  it('sums released bounty on external jobs only', () => {
    const r = externalRevenue([job({ bountyUsd: 3 }), job({ bountyUsd: 4.5 }), job({ bountyUsd: 100, requesterAgentId: 'faucet-agent' })], ctx)
    expect(r.externalCompletedUsd).toBe(7.5)
  })

  it('distinguishes "0% repeat" from "nobody to repeat"', () => {
    expect(externalRevenue([], ctx).repeatRate).toBeNull()
    expect(externalRevenue([job({ requesterUserId: 'u1' }), job({ requesterUserId: 'u2' })], ctx).repeatRate).toBe(0)
    expect(externalRevenue([job({ requesterUserId: 'u1' }), job({ requesterUserId: 'u1' }), job({ requesterUserId: 'u2' })], ctx).repeatRate).toBe(0.5)
  })

  it('leaves cost per success null rather than standing a bounty in for it', () => {
    expect(externalRevenue([job()], ctx).costPerSuccessUsd).toBeNull()
    expect(renderExternalRevenue(externalRevenue([job()], ctx))).toMatch(/Cost per success: \*\*—\*\*/)
  })

  it('reports nothing as nothing, never as zero dollars', () => {
    const r = externalRevenue([job({ requesterAgentId: 'faucet-agent' })], ctx)
    expect(r.externalCompletedUsd).toBeNull()
    expect(renderExternalRevenue(r)).toContain('Bounty released on them: **—**')
  })
})
