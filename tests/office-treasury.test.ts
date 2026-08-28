import { describe, it, expect } from 'vitest'
import { summarizeWalletReads } from '@/lib/office-treasury'

const ok = <T>(value: T) => ({ ok: true as const, value })
const fail = () => ({ ok: false as const })

describe('summarizeWalletReads — null vs zero vs partial', () => {
  it('zero wallets is a true zero, not an unknown', () => {
    const r = summarizeWalletReads([])
    expect(r).toEqual({ walletCount: 0, usdcTotal: 0, ethTotalWei: '0', walletReadErrors: 0 })
  })

  it('sums every successful read across multiple wallets', () => {
    const r = summarizeWalletReads([
      { usdc: ok(1.5), eth: ok(1_000_000_000_000_000_000n) },
      { usdc: ok(2.25), eth: ok(500_000_000_000_000_000n) },
    ])
    expect(r.usdcTotal).toBeCloseTo(3.75)
    expect(r.ethTotalWei).toBe('1500000000000000000')
    expect(r.walletReadErrors).toBe(0)
  })

  it('every USDC read failing yields null, not 0 — a floor of zero would read as "this office is empty"', () => {
    const r = summarizeWalletReads([{ usdc: fail(), eth: ok(1n) }, { usdc: fail(), eth: ok(1n) }])
    expect(r.usdcTotal).toBeNull()
  })

  it('every ETH read failing yields null, independently of USDC', () => {
    const r = summarizeWalletReads([{ usdc: ok(1), eth: fail() }, { usdc: ok(1), eth: fail() }])
    expect(r.ethTotalWei).toBeNull()
  })

  it('a partial failure sums what succeeded as a floor, and counts the miss', () => {
    const r = summarizeWalletReads([{ usdc: ok(10), eth: ok(1n) }, { usdc: fail(), eth: ok(1n) }])
    expect(r.usdcTotal).toBe(10) // the one that DID read, not null
    expect(r.walletReadErrors).toBe(1)
  })

  it('USDC and ETH failures are independent — one currency failing does not null the other', () => {
    const r = summarizeWalletReads([{ usdc: ok(5), eth: fail() }])
    expect(r.usdcTotal).toBe(5)
    expect(r.ethTotalWei).toBeNull()
    expect(r.walletReadErrors).toBe(1)
  })

  it('walletReadErrors counts BOTH currencies, not one row per wallet', () => {
    // Same wallet, both reads fail — that is two lost data points, not one.
    const r = summarizeWalletReads([{ usdc: fail(), eth: fail() }])
    expect(r.walletReadErrors).toBe(2)
  })

  it('never returns a negative total', () => {
    const r = summarizeWalletReads([{ usdc: ok(0), eth: ok(0n) }])
    expect(r.usdcTotal).toBeGreaterThanOrEqual(0)
  })
})
