import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { fundsEscrow, x402NetworkFor } from '@/lib/x402-network'

describe('the buyer pays in the money the platform is about to spend', () => {
  it('settles real money on Base and everything else on Base Sepolia', () => {
    expect(x402NetworkFor('base')).toBe('base')
    for (const chain of ['base-sepolia', 'sepolia', 'giwa-sepolia']) {
      expect(x402NetworkFor(chain), chain).toBe('base-sepolia')
    }
  })

  it('defaults an unset or unknown chain to test money, never to real', () => {
    // Unset means no on-chain layer, which is a supported way to run this app.
    // Guessing wrong toward `base` would quote a real-USDC price on a
    // deployment with no escrow behind it.
    expect(x402NetworkFor(undefined)).toBe('base-sepolia')
    expect(x402NetworkFor(null)).toBe('base-sepolia')
    expect(x402NetworkFor('mainnet')).toBe('base-sepolia')
    expect(x402NetworkFor('')).toBe('base-sepolia')
  })

  it('covers every chain the app can actually be pointed at', () => {
    // Copy-plus-pin: this module is a deliberate copy of one fact from
    // lib/onchain/config.ts, because middleware runs on the edge and importing
    // that module pulls viem's chain definitions. The pin is what stops the
    // copy from going stale — a new chain in CHAINS must be classified here.
    const config = readFileSync('lib/onchain/config.ts', 'utf8')
    const line = config.split('\n').find((l) => l.includes('const CHAINS ='))!
    const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
    const names = body
      .split(',')
      .map((entry) => entry.split(':')[0].trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    expect(names).toContain('base')
    expect(names).toContain('base-sepolia')
    for (const n of names) {
      const network = x402NetworkFor(n)
      // Exactly one chain in the list is real money, and it is the only one
      // that may map to the real-money rail.
      expect(network === 'base', n).toBe(n === 'base')
    }
  })
})

describe('which routes make the mismatch a drain', () => {
  it('marks the two routes whose price funds escrow the platform then spends', () => {
    expect(fundsEscrow('POST /api/jobs/external')).toBe(true)
    expect(fundsEscrow('POST /api/storefront/venture-lab/commission')).toBe(true)
  })

  it('does not mark a data sale, where the payer chain genuinely does not matter', () => {
    expect(fundsEscrow('GET /api/agents/*/report')).toBe(false)
    expect(fundsEscrow('GET /api/market/index')).toBe(false)
  })
})

describe('the middleware actually uses it', () => {
  const mw = readFileSync('middleware.ts', 'utf8')

  it('has no hardcoded network left', () => {
    // The whole defect was four copies of a literal. A fifth added later would
    // reintroduce it on exactly one route, which is the hardest kind to spot.
    const inMap = mw.split('\n').filter((l) => l.includes('network:'))
    expect(inMap.length).toBeGreaterThan(0)
    for (const line of inMap) expect(line).toContain('X402_NETWORK')
  })

  it('derives it from ONCHAIN_CHAIN', () => {
    expect(mw).toMatch(/x402NetworkFor\(process\.env\.ONCHAIN_CHAIN\)/)
  })
})

describe('the fixed-price subsidy does not follow the deployment onto real money', () => {
  const route = readFileSync('app/api/jobs/external/route.ts', 'utf8')

  it('refuses when the chain is real, because pass-through pricing was never built', () => {
    // $0.10 buying a $25 escrowed bounty is 250x out for 1x in. On mUSDC that
    // is a subsidy bought with nothing; on Circle USDC it is the house agent's
    // wallet with a faucet handle on it, and the daily cap only sets the rate.
    expect(route).toContain('isRealMoney()')
    const guard = route.indexOf('isRealMoney()')
    const spend = route.indexOf('recordX402Payment')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(spend)
  })
})
