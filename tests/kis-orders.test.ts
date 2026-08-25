/**
 * lib/kis-orders.ts — validateOrderInput is pure (no network/DB), covered
 * directly. The structural-invariant tests below mirror
 * securities-mcp/test_kis_client.py's: this file must never contain the
 * real-account (non-paper) TR IDs or the real KIS host, checked against the
 * source text itself so a future edit can't quietly reintroduce either.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateOrderInput } from '@/lib/kis-orders'

describe('validateOrderInput', () => {
  it('accepts a valid limit buy', () => {
    expect(validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 10, orderType: 'limit', priceKrw: 70000 })).toEqual({
      krxCode: '005930',
      side: 'buy',
      quantity: 10,
      ordDvsn: '00',
      priceKrw: 70000,
    })
  })

  it('accepts a valid market sell with price 0', () => {
    expect(validateOrderInput({ krxCode: '000660', side: 'sell', quantity: 3, orderType: 'market' })).toEqual({
      krxCode: '000660',
      side: 'sell',
      quantity: 3,
      ordDvsn: '01',
      priceKrw: 0,
    })
  })

  it('trims and requires an exactly-6-digit KRX code', () => {
    expect(validateOrderInput({ krxCode: ' 005930 ', side: 'buy', quantity: 1, orderType: 'market' }).krxCode).toBe('005930')
    expect(() => validateOrderInput({ krxCode: '5930', side: 'buy', quantity: 1, orderType: 'market' })).toThrow(/6 digits/)
    expect(() => validateOrderInput({ krxCode: 'AAPL', side: 'buy', quantity: 1, orderType: 'market' })).toThrow(/6 digits/)
  })

  it('rejects a non-buy/sell side', () => {
    // @ts-expect-error - deliberately invalid input
    expect(() => validateOrderInput({ krxCode: '005930', side: 'hold', quantity: 1, orderType: 'market' })).toThrow(/buy.*sell/)
  })

  it('rejects a non-positive or non-integer quantity', () => {
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 0, orderType: 'market' })).toThrow(/positive integer/)
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: -5, orderType: 'market' })).toThrow(/positive integer/)
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 1.5, orderType: 'market' })).toThrow(/positive integer/)
  })

  it('requires a positive priceKrw for a limit order, but never for a market order', () => {
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 1, orderType: 'limit' })).toThrow(/priceKrw/)
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 1, orderType: 'limit', priceKrw: 0 })).toThrow(/priceKrw/)
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 1, orderType: 'limit', priceKrw: -1 })).toThrow(/priceKrw/)
    expect(validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 1, orderType: 'market', priceKrw: 999 }).priceKrw).toBe(0)
  })

  it('rejects an unknown orderType', () => {
    // @ts-expect-error - deliberately invalid input
    expect(() => validateOrderInput({ krxCode: '005930', side: 'buy', quantity: 1, orderType: 'stop' })).toThrow(/orderType/)
  })
})

describe('lib/kis-orders.ts — real-money structural invariants', () => {
  const source = readFileSync(join(process.cwd(), 'lib/kis-orders.ts'), 'utf8')

  it('never references the real-account (non-paper) order TR ids', () => {
    expect(source).not.toContain('TTTC0012U') // real-account buy
    expect(source).not.toContain('TTTC0011U') // real-account sell
  })

  it('never references the real (non-paper) KIS host', () => {
    expect(source).not.toContain('openapi.koreainvestment.com:9443')
  })

  it('defines exactly one base URL constant', () => {
    expect(source.match(/const PAPER_BASE_URL = /g)?.length).toBe(1)
  })
})
