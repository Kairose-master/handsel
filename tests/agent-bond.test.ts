import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { bondForBounty, bondFloatFor, bondReadiness } from '@/lib/agent-bond'
import {
  planUsdcFunding,
  parseUsdcAmount,
  suggestedFloatFor,
  USDC_FUNDING_RESERVE_USD,
} from '@/lib/agent-usdc-funding'

// The deployed Base mainnet schedule, read off the contract's immutables:
// flatBond 30000 (6dp) and bondBps 500. These numbers are the reason this
// module exists, so they are the numbers it is tested against.
const LIVE = { flat: 0.03, bps: 500 }

describe('bondForBounty', () => {
  it('matches the contract on the live schedule', () => {
    // bondFor(1710000) returned 115500 on-chain. A cent of drift here is the
    // difference between a claim and a TransferFailed() revert.
    expect(bondForBounty(1.71, LIVE)).toBeCloseTo(0.1155, 6)
    expect(bondForBounty(3.43, LIVE)).toBeCloseTo(0.2015, 6)
  })

  it('charges the flat bond on a zero or absent bounty', () => {
    expect(bondForBounty(0, LIVE)).toBe(LIVE.flat)
  })

  it('does not drift on amounts that are not representable in binary', () => {
    // 0.07 * 500 / 10000 in floats is 0.0034999999999999996. In micro-units it
    // is an integer. This is the whole reason the arithmetic is in units.
    const bond = bondForBounty(0.07, LIVE)
    expect(Math.round(bond * 1e6)).toBe(30000 + Math.floor((70000 * 500) / 10_000))
  })
})

describe('bondFloatFor', () => {
  it('sums rather than maxes — bonds are held at the same time', () => {
    const float = bondFloatFor([1.71, 1.71, 3.43], LIVE)
    expect(float).toBeCloseTo(0.1155 + 0.1155 + 0.2015, 6)
  })

  it('is zero-length safe', () => {
    expect(bondFloatFor([], LIVE)).toBe(0)
  })
})

describe('bondReadiness', () => {
  it('lets an agent that holds exactly the bond through', () => {
    // The boundary is the case a float comparison gets wrong.
    expect(bondReadiness(0.1155, 1.71, LIVE)).toMatchObject({ ready: true })
  })

  it('reports the shortfall, not just a refusal', () => {
    const v = bondReadiness(0.1, 1.71, LIVE)
    expect(v.ready).toBe(false)
    if (v.ready === false) expect(v.shortUsd).toBeCloseTo(0.0155, 6)
  })

  it('answers "unknown" — never false — when the schedule could not be read', () => {
    // A probe that cannot answer must not be the thing that stops a solvent
    // worker. Same rule as the gas preflight in lib/auto-mine.ts.
    expect(bondReadiness(0, 1.71, null).ready).toBe('unknown')
  })
})

describe('planUsdcFunding', () => {
  it('keeps a reserve so funding a desk cannot disarm the funder', () => {
    const plan = planUsdcFunding({ heldUsd: 1, requestedUsd: 0.9 })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reason).toBe('more-than-held')
      expect(plan.maxUsd).toBeCloseTo(1 - USDC_FUNDING_RESERVE_USD, 6)
    }
  })

  it('sends up to the reserve exactly', () => {
    const plan = planUsdcFunding({ heldUsd: 1, requestedUsd: 0.5 })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.leavesUsd).toBeCloseTo(0.5, 6)
  })

  it('refuses when the whole balance is the reserve', () => {
    const plan = planUsdcFunding({ heldUsd: 0.4, requestedUsd: 0.1 })
    expect(plan).toMatchObject({ ok: false, reason: 'nothing-to-send' })
  })

  it('drain reaches past the reserve, but only when asked', () => {
    const plan = planUsdcFunding({ heldUsd: 0.4, requestedUsd: 0.4, drain: true })
    expect(plan).toMatchObject({ ok: true, leavesUsd: 0 })
  })

  it('refuses dust', () => {
    expect(planUsdcFunding({ heldUsd: 10, requestedUsd: 0.001 })).toMatchObject({
      ok: false,
      reason: 'below-dust',
    })
  })
})

describe('parseUsdcAmount', () => {
  it('takes a plain decimal, with or without a dollar sign', () => {
    expect(parseUsdcAmount('0.25')).toBe(0.25)
    expect(parseUsdcAmount('$1')).toBe(1)
  })

  it('refuses everything that is not one', () => {
    // These are the shapes that must never reach a transfer amount.
    for (const bad of ['', '-1', '0', 'abc', '1e3', '0.1234567', 'Infinity', '1,5']) {
      expect(parseUsdcAmount(bad), bad).toBeNull()
    }
  })
})

describe('suggestedFloatFor', () => {
  it('rounds UP to the cent, so a transfer never lands a hundredth short', () => {
    // Landing short is the failure this whole module exists to remove; a
    // round-to-nearest here would reintroduce it on exactly the amounts it
    // matters for.
    const exact = bondFloatFor([1.71, 1.71], LIVE) // 0.231
    expect(suggestedFloatFor([1.71, 1.71], LIVE)).toBe(0.24)
    expect(suggestedFloatFor([1.71, 1.71], LIVE)).toBeGreaterThanOrEqual(exact)
  })
})

describe('the "can send at most" message never names an unsendable amount', () => {
  // Live, twice in one session (2026-09-01): held $1.4870 → real max $0.9870
  // → the error said "at most $0.99" and then refused $0.99. The retry the
  // message itself suggests must succeed, so the displayed max is FLOORED to
  // the cent, not rounded.
  it('the fund path floors the displayed max instead of rounding it up', () => {
    const src = readFileSync('lib/agent-usdc-funding.ts', 'utf8')
    const block = src.slice(src.indexOf("reason === 'more-than-held'"), src.indexOf('below the dust floor'))
    expect(block).toContain('Math.floor(plan.maxUsd * 100) / 100')
    expect(block).not.toContain('plan.maxUsd.toFixed(2)')
  })

  it('a cent amount at the floored max is accepted by the plan', () => {
    const plan = planUsdcFunding({ heldUsd: 1.487, requestedUsd: 0.98 })
    expect(plan.ok).toBe(true)
    // …and the rounded-up cent the old message named is refused, which is
    // exactly why the message must not name it.
    expect(planUsdcFunding({ heldUsd: 1.487, requestedUsd: 0.99 }).ok).toBe(false)
  })
})
