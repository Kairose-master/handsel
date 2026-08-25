import { describe, it, expect } from 'vitest'
import { validateVirtualOrderInput } from '@/lib/virtual-trading'

describe('validateVirtualOrderInput', () => {
  it('normalizes a bare KRX code and accepts a valid market order', () => {
    expect(validateVirtualOrderInput({ symbol: '005930', side: 'buy', quantity: 10, orderType: 'market' })).toEqual({
      symbol: '005930.KS',
      side: 'buy',
      quantity: 10,
      orderType: 'market',
      limitPriceUsd: undefined,
    })
  })

  it('accepts a valid limit order with a positive limit price', () => {
    const result = validateVirtualOrderInput({ symbol: 'AAPL', side: 'sell', quantity: 5, orderType: 'limit', limitPriceUsd: 200 })
    expect(result).toEqual({ symbol: 'AAPL', side: 'sell', quantity: 5, orderType: 'limit', limitPriceUsd: 200 })
  })

  it('rejects a non-buy/sell side', () => {
    // @ts-expect-error - deliberately invalid input
    expect(() => validateVirtualOrderInput({ symbol: 'AAPL', side: 'hold', quantity: 1, orderType: 'market' })).toThrow(/buy.*sell/)
  })

  it('rejects a non-positive quantity', () => {
    expect(() => validateVirtualOrderInput({ symbol: 'AAPL', side: 'buy', quantity: 0, orderType: 'market' })).toThrow(/positive/)
    expect(() => validateVirtualOrderInput({ symbol: 'AAPL', side: 'buy', quantity: -3, orderType: 'market' })).toThrow(/positive/)
  })

  it('requires a positive limitPriceUsd for a limit order, never for a market order', () => {
    expect(() => validateVirtualOrderInput({ symbol: 'AAPL', side: 'buy', quantity: 1, orderType: 'limit' })).toThrow(/limitPriceUsd/)
    expect(() => validateVirtualOrderInput({ symbol: 'AAPL', side: 'buy', quantity: 1, orderType: 'limit', limitPriceUsd: 0 })).toThrow(/limitPriceUsd/)
    expect(validateVirtualOrderInput({ symbol: 'AAPL', side: 'buy', quantity: 1, orderType: 'market', limitPriceUsd: 999 }).orderType).toBe('market')
  })

  it('rejects an unknown orderType', () => {
    // @ts-expect-error - deliberately invalid input
    expect(() => validateVirtualOrderInput({ symbol: 'AAPL', side: 'buy', quantity: 1, orderType: 'stop' })).toThrow(/orderType/)
  })
})
