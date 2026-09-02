import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  BOUNTY_ENV,
  PRICE_ENV,
  TESTNET_BOUNTY_USD,
  TESTNET_PRICE_USD,
  externalJobPricing,
} from '@/lib/external-job-pricing'

const real = (price?: string, bounty?: string) => externalJobPricing({ isRealMoney: true, price, bounty })

describe('the testnet subsidy stays on testnet', () => {
  it('keeps the practice pricing where the token is free', () => {
    const p = externalJobPricing({ isRealMoney: false })
    expect(p).toMatchObject({ open: true, priceUsd: TESTNET_PRICE_USD, bountyUsd: TESTNET_BOUNTY_USD })
  })

  it('is closed by default on real money, even though testnet numbers exist', () => {
    // 250x out for 1x in is a faucet handle on the house agent's wallet, and
    // inferring a real price from the testnet one would be the platform
    // deciding to spend its owner's money for them.
    const p = real()
    expect(p.open).toBe(false)
    expect(p.open === false && p.reason).toContain(PRICE_ENV)
    expect(p.open === false && p.reason).toContain(BOUNTY_ENV)
  })
})

describe('the price has to exceed the bounty', () => {
  it('opens when it does, and reports the margin', () => {
    expect(real('30', '25')).toEqual({ open: true, priceUsd: 30, bountyUsd: 25, marginUsd: 5 })
  })

  it('refuses at or below, rather than clamping either number', () => {
    // Silently charging more than configured overrules the operator about
    // money; silently escrowing less sells a bounty the buyer did not get.
    // Both are worse than saying no.
    for (const [price, bounty] of [['25', '25'], ['10', '25'], ['0.10', '25']]) {
      const p = real(price, bounty)
      expect(p.open, `${price}/${bounty}`).toBe(false)
      expect(p.open === false && p.reason).toMatch(/must exceed/)
    }
  })

  it('treats a blank, zero or non-numeric setting as unset rather than as free', () => {
    for (const bad of ['', '   ', '0', '-5', 'free', 'NaN']) {
      expect(real(bad, '25').open, bad).toBe(false)
      expect(real('30', bad).open, bad).toBe(false)
    }
  })

  it('never returns an open pricing that loses money', () => {
    for (const price of ['0.01', '1', '25', '26', '1000']) {
      const p = real(price, '25')
      if (p.open) expect(p.priceUsd).toBeGreaterThan(p.bountyUsd)
    }
  })
})

describe('the route actually uses it', () => {
  const src = readFileSync('app/api/jobs/external/route.ts', 'utf8')

  it('escrows the configured bounty, not the hardcoded one', () => {
    expect(src).toContain('postJob(houseAgentId, pricing.bountyUsd')
    expect(src).not.toMatch(/postJob\(houseAgentId, FIXED_BOUNTY_USD/)
  })

  it('bills what it charges', () => {
    expect(src).toContain('amountUsd: pricing.priceUsd')
  })

  it('refuses before taking the money, not after', () => {
    // Refusing after settlement would be the same defect with better manners.
    expect(src.indexOf('if (!pricing.open)')).toBeLessThan(src.indexOf('recordX402Payment'))
  })
})
