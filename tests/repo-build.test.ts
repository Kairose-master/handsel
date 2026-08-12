import { describe, expect, it } from 'vitest'
import { baseUnitsToUsd, bountyFromBudget, manifestLineForRepoJob, usdToBaseUnits } from '@/lib/repo-build'

describe('base-unit conversion round-trips', () => {
  it('goes USD -> base units -> USD without drift', () => {
    expect(usdToBaseUnits(9.8)).toBe('9800000')
    expect(baseUnitsToUsd('9800000')).toBe(9.8)
  })

  it('rounds a float artifact to the cent before converting', () => {
    expect(usdToBaseUnits(9.799999999999999)).toBe('9800000')
  })
})

describe('bountyFromBudget — the increment 2 v1 decision (one build = one repo job)', () => {
  it('splits a budget into a bounty that leaves room for the fee', () => {
    const split = bountyFromBudget(10, 200) // 2%
    expect(split).not.toBeNull()
    if (!split) return
    expect(split.bountyUsd).toBe(9.8)
    expect(split.feeUsd).toBe(0.2)
    expect(Math.round((split.bountyUsd + split.feeUsd) * 100)).toBeLessThanOrEqual(1000)
  })

  it('never returns a pair whose sum exceeds the budget, across a sweep of budgets and rates', () => {
    for (const budgetUsd of [0.5, 1, 2.37, 5, 9.99, 50, 123.45, 1000]) {
      for (const bps of [0, 1, 50, 200, 999, 2000]) {
        const split = bountyFromBudget(budgetUsd, bps)
        if (!split) continue
        const sumCents = Math.round((split.bountyUsd + split.feeUsd) * 100)
        expect(sumCents).toBeLessThanOrEqual(Math.round(budgetUsd * 100))
        expect(split.bountyUsd).toBeGreaterThanOrEqual(0.01)
      }
    }
  })

  it('the full budget becomes the bounty when the fee is disabled', () => {
    const split = bountyFromBudget(25, 0)
    expect(split).toEqual({ bountyUsd: 25, feeUsd: 0 })
  })

  it('refuses a budget too small to fund even a 1-cent bounty', () => {
    expect(bountyFromBudget(0.001, 200)).toBeNull()
    expect(bountyFromBudget(0, 200)).toBeNull()
    expect(bountyFromBudget(-5, 200)).toBeNull()
    expect(bountyFromBudget(NaN, 200)).toBeNull()
  })

  it('a high fee rate still leaves a positive bounty for a modest budget', () => {
    const split = bountyFromBudget(1, 2000) // 20%, the platform's cap
    expect(split).not.toBeNull()
    if (!split) return
    expect(split.bountyUsd).toBeGreaterThan(0)
    expect(Math.round((split.bountyUsd + split.feeUsd) * 100)).toBeLessThanOrEqual(100)
  })
})

describe('manifestLineForRepoJob — increment 3, the one line a v1 build has', () => {
  const base = { buildId: 'b1', goal: 'Fix the flaky retry logic in the sync worker', bountyUsd: 9.8, proofId: null }

  it('in-flight statuses stay pending — a manifest must never settle a build early', () => {
    for (const status of ['Open', 'Accepted', 'Submitted', 'Disputed', null]) {
      const line = manifestLineForRepoJob({ ...base, jobStatus: status })
      expect(line.verdict, String(status)).toBe('pending')
      expect(line.amountBaseUnits).toBe('0')
      expect(line.graderClass).toBeNull()
    }
  })

  it('Completed pays the bounty as a mechanical-class pass with its proof', () => {
    const line = manifestLineForRepoJob({ ...base, jobStatus: 'Completed', proofId: 'proof-7' })
    expect(line.verdict).toBe('pass')
    expect(line.amountBaseUnits).toBe('9800000')
    expect(line.graderClass).toBe('mechanical') // CI-graded — never 'reproducible', runner state isn't pinned
    expect(line.proofId).toBe('proof-7')
  })

  it('Refunded, Cancelled and Expired read as refunded with nothing paid', () => {
    for (const status of ['Refunded', 'Cancelled', 'Expired']) {
      const line = manifestLineForRepoJob({ ...base, jobStatus: status })
      expect(line.verdict, status).toBe('refunded')
      expect(line.amountBaseUnits).toBe('0')
      expect(line.proofId).toBeNull()
    }
  })

  it('a proof id on a non-pass line is dropped, not reported', () => {
    const line = manifestLineForRepoJob({ ...base, jobStatus: 'Refunded', proofId: 'proof-9' })
    expect(line.proofId).toBeNull()
  })
})
