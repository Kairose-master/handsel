import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BANKROLL, deliveryEdge, kellyExposureFraction, mayStakeBond } from '@/lib/bankroll'

/**
 * Kelly-sized bond exposure for autonomous workers. The bond is burned when
 * the work never arrives (LaborMarketV2 reclaim), so the ruin case is
 * concurrent: a worker whose runtime dies with N bonds locked loses all N —
 * observed live twice on the day this shipped. These numbers are the
 * contract: cold workers size down hard, proven deliverers earn the ceiling,
 * and the first claim is never blocked.
 */

describe('deliveryEdge — Laplace-smoothed delivery probability', () => {
  it('zero history is a 50% deliverer, not a perfect one', () => {
    expect(deliveryEdge(0, 0)).toBe(0.5)
  })
  it('converges toward the observed rate with evidence', () => {
    expect(deliveryEdge(9, 1)).toBeCloseTo(10 / 12)
    expect(deliveryEdge(1, 9)).toBeCloseTo(2 / 12)
    expect(deliveryEdge(99, 1)).toBeGreaterThan(0.95)
  })
  it('never reaches 0 or 1 — no record justifies certainty', () => {
    expect(deliveryEdge(1000, 0)).toBeLessThan(1)
    expect(deliveryEdge(0, 1000)).toBeGreaterThan(0)
  })
})

describe('kellyExposureFraction — half-Kelly with a hard ceiling', () => {
  // Market-shaped odds: bounty $1.14, bond 5% + $0.03 ≈ $0.087 → b ≈ 13.
  const WIN = 1.14
  const LOSS = 0.087

  it('a reliable deliverer is capped by the ceiling, not by Kelly', () => {
    const f = kellyExposureFraction(deliveryEdge(40, 0), WIN, LOSS)
    expect(f).toBe(BANKROLL.MAX_EXPOSURE_FRACTION)
  })
  it('a flaky worker sizes down toward the classic ~6%-at-once rule', () => {
    const f = kellyExposureFraction(deliveryEdge(1, 9), WIN, LOSS) // ~17% deliverer
    expect(f).toBeLessThan(0.09)
    expect(f).toBeGreaterThan(0.02)
  })
  it('an edge with negative expectation clamps to zero', () => {
    expect(kellyExposureFraction(0.05, 1, 1)).toBe(0)
  })
  it('degenerate odds clamp to zero rather than dividing by them', () => {
    expect(kellyExposureFraction(0.9, 0, 0.1)).toBe(0)
    expect(kellyExposureFraction(0.9, 1, 0)).toBe(0)
  })
})

describe('mayStakeBond — concurrent exposure under the cap', () => {
  const base = { heldUsd: 1.0, bondUsd: 0.087, bountyUsd: 1.14, delivered: 0, lost: 0 }

  it('the FIRST concurrent bond is always allowed — cold start must claim', () => {
    expect(mayStakeBond({ ...base, openBondsUsd: 0, heldUsd: 0.09, lost: 50 })).toEqual({ ok: true })
  })

  it('a proven deliverer stacks several bonds', () => {
    const v = mayStakeBond({ ...base, openBondsUsd: 0.26, delivered: 20, lost: 0 })
    expect(v.ok).toBe(true)
  })

  it('a worker with a lossy record is stopped at low exposure', () => {
    const v = mayStakeBond({ ...base, openBondsUsd: 0.087, delivered: 1, lost: 9 })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.capUsd).toBeLessThan(v.exposureUsd)
      expect(v.edge).toBeCloseTo(2 / 12)
    }
  })

  it('the cap is measured against held + locked (the true bankroll)', () => {
    // held $1.00 with $0.40 already in bonds: bankroll $1.40, cap ≈ $0.63,
    // exposure $0.49 → allowed. A held-only cap ($0.45-ish) would refuse
    // this — money already at work must not shrink the wallet it came from.
    const v = mayStakeBond({ ...base, heldUsd: 1.0, openBondsUsd: 0.4, delivered: 40, lost: 0 })
    expect(v).toEqual({ ok: true })
  })
})

describe('the wiring — auto-mine enforces it, office bonds pass through', () => {
  const src = readFileSync('lib/auto-mine.ts', 'utf8')
  it('the bankroll filter sits between selection and the claim loop', () => {
    const at = src.indexOf('mayStakeBond')
    expect(at).toBeGreaterThan(src.indexOf('selectMiningBlocks({'))
    expect(at).toBeLessThan(src.indexOf('acceptAndDispatchJob(agent, job.id'))
  })
  it('office-assigned jobs are not this wallet\'s exposure', () => {
    const block = src.slice(src.indexOf('let withinBankroll'), src.indexOf('Serial within the agent'))
    expect(block).toContain('isMineByAssignment(c.job.id)')
  })
  it('open exposure counts the bonds already locked on Accepted jobs', () => {
    const block = src.slice(src.indexOf('let withinBankroll'))
    expect(block).toContain("j.status === 'Accepted'")
  })
})
