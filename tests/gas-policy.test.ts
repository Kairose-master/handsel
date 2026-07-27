import { describe, expect, it } from 'vitest'
import {
  allowanceCostUsd,
  dailyOpAllowance,
  decideSponsoredOp,
  FREE_OPS_PER_DAY,
  MAX_OPS_PER_DAY,
  OPS_PER_SETTLED_USD,
  TESTNET_ALLOWANCE_MULTIPLIER,
} from '@/lib/onchain/gas-policy'

const real = (settledVolumeUsd: number) => dailyOpAllowance({ settledVolumeUsd, isRealMoney: true })

describe('the allowance is earned', () => {
  it('gives a brand-new agent enough to get started and no more', () => {
    // It must be able to complete a few jobs, because completing jobs is how it
    // earns a bigger allowance. An agent that cannot start cannot ever qualify.
    expect(real(0)).toBe(FREE_OPS_PER_DAY)
    expect(real(0)).toBeGreaterThanOrEqual(8) // two full job cycles plus a retry
  })

  it('grows with settled volume', () => {
    expect(real(50)).toBe(FREE_OPS_PER_DAY + 50 * OPS_PER_SETTLED_USD)
    expect(real(50)).toBeGreaterThan(real(10))
  })

  it('caps regardless of history', () => {
    // A compromised well-behaved agent is likelier than a badly-behaved new
    // one, so no record buys an unlimited allowance.
    expect(real(1_000_000)).toBe(MAX_OPS_PER_DAY)
  })

  it('treats missing or nonsensical volume as none, not as infinite', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(real(bad)).toBe(FREE_OPS_PER_DAY)
    }
  })

  it('makes minting agents linear rather than free', () => {
    // N fresh agents buy N x the free tier and nothing more — and each costs an
    // account and a registration under the existing throttles. That is the
    // bound; an unmetered paymaster has none.
    const oneFarm = real(0) * 10
    expect(oneFarm).toBe(FREE_OPS_PER_DAY * 10)
    expect(oneFarm).toBeLessThan(MAX_OPS_PER_DAY * 10)
  })
})

describe('testnet uses the same code path, not a bypass', () => {
  it('is more generous but still bounded', () => {
    const t = dailyOpAllowance({ settledVolumeUsd: 0, isRealMoney: false })
    expect(t).toBe(FREE_OPS_PER_DAY * TESTNET_ALLOWANCE_MULTIPLIER)
    expect(Number.isFinite(t)).toBe(true)
  })

  it('still refuses once the larger allowance is gone', () => {
    // The point of enforcing off-mainnet is that the gate is exercised before
    // it matters. A gate that has never once refused anything is a gate nobody
    // has tested.
    const allowance = dailyOpAllowance({ settledVolumeUsd: 0, isRealMoney: false })
    expect(decideSponsoredOp(allowance, allowance).allow).toBe(false)
  })
})

describe('decideSponsoredOp', () => {
  it('allows while there is headroom and reports what is left', () => {
    const d = decideSponsoredOp(3, 12)
    expect(d.allow).toBe(true)
    expect(d.remaining).toBe(9)
  })

  it('refuses exactly at the allowance, not one past it', () => {
    expect(decideSponsoredOp(11, 12).allow).toBe(true)
    expect(decideSponsoredOp(12, 12).allow).toBe(false)
  })

  it('refuses when usage is unknown — fails closed', () => {
    // Unknown must not read as "nothing used yet": that is the reading an
    // attacker wants, and it is the one that spends the operator's money.
    const d = decideSponsoredOp(null, 12)
    expect(d.allow).toBe(false)
    expect(d.allow === false && d.reason).toContain('cannot be treated as')
  })

  it('refuses on a NaN count rather than letting arithmetic decide', () => {
    expect(decideSponsoredOp(Number.NaN, 12).allow).toBe(false)
  })

  it('tells a refused agent how to get a larger allowance', () => {
    const d = decideSponsoredOp(12, 12)
    expect(d.allow === false && d.reason).toContain('settled')
  })

  it('never reports negative headroom', () => {
    expect(decideSponsoredOp(999, 12).remaining).toBe(0)
  })
})

describe('allowanceCostUsd', () => {
  it('converts once the per-op cost has actually been measured', () => {
    expect(allowanceCostUsd(100, 0.01)).toBe(1)
  })

  it('returns null rather than a guess when it has not been', () => {
    // A made-up gas price on a diagnostics page is a number someone will quote.
    expect(allowanceCostUsd(100, null)).toBeNull()
    expect(allowanceCostUsd(100, Number.NaN)).toBeNull()
  })
})
