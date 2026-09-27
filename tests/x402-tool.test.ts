import { describe, expect, it } from 'vitest'
import {
  USDC_BY_NETWORK,
  X402_TOOL_PRESETS,
  X402_TOOL_PRICE_CAP_MAX_USD,
  parseX402ToolBinding,
  pickRequirement,
  requestFor,
  usdToUnits,
  type PaymentRequirement,
} from '@/lib/x402-tool'

/**
 * A 402 challenge is adversarial input. These pin the refusals: wrong
 * network, wrong asset, wrong payee, too expensive, and the shapes of a
 * binding an operator may set.
 */
const good: PaymentRequirement = {
  scheme: 'exact',
  network: 'base-sepolia',
  asset: USDC_BY_NETWORK['base-sepolia'],
  payTo: '0x' + 'ab'.repeat(20),
  maxAmountRequired: '10000', // $0.01
}
const pins = { network: 'base-sepolia' as const, priceCapUsd: 0.01 }

describe('pickRequirement', () => {
  it('pays exactly the pinned network + USDC at or under the cap', () => {
    const r = pickRequirement([good], pins)
    expect(r.ok && r.priceUsd).toBe(0.01)
  })
  it('refuses another network even when cheaper', () => {
    const r = pickRequirement([{ ...good, network: 'base', asset: USDC_BY_NETWORK.base, maxAmountRequired: '1' }], pins)
    expect(r.ok).toBe(false)
  })
  it('refuses another asset on the right network', () => {
    expect(pickRequirement([{ ...good, asset: '0x' + '11'.repeat(20) }], pins).ok).toBe(false)
  })
  it('refuses a price one unit over the cap', () => {
    expect(pickRequirement([{ ...good, maxAmountRequired: '10001' }], pins).ok).toBe(false)
  })
  it('refuses a changed payee when the binding pins one', () => {
    expect(pickRequirement([good], { ...pins, payTo: '0x' + 'cd'.repeat(20) }).ok).toBe(false)
    expect(pickRequirement([good], { ...pins, payTo: '0x' + 'AB'.repeat(20).toLowerCase() }).ok).toBe(true)
  })
  it('refuses a non-exact scheme, zero and garbage amounts, and an empty challenge', () => {
    expect(pickRequirement([{ ...good, scheme: 'upto' }], pins).ok).toBe(false)
    expect(pickRequirement([{ ...good, maxAmountRequired: '0' }], pins).ok).toBe(false)
    expect(pickRequirement([{ ...good, maxAmountRequired: 'lots' }], pins).ok).toBe(false)
    expect(pickRequirement([], pins).ok).toBe(false)
  })
  it('takes the first acceptable option among several', () => {
    const r = pickRequirement([{ ...good, network: 'base' }, good, { ...good, maxAmountRequired: '5000' }], pins)
    expect(r.ok && r.chosen.maxAmountRequired).toBe('10000')
  })
})

describe('parseX402ToolBinding', () => {
  it('defaults to POST/query and lowercases payTo', () => {
    const r = parseX402ToolBinding({ url: 'https://x.example/api', priceCapUsd: 0.05, payTo: '0x' + 'AB'.repeat(20) })
    expect(r.ok && r.binding).toEqual({ url: 'https://x.example/api', method: 'POST', priceCapUsd: 0.05, bodyKey: 'query', payTo: '0x' + 'ab'.repeat(20) })
  })
  it('refuses http, a missing cap, a cap over the tool ceiling, and a bad payee', () => {
    expect(parseX402ToolBinding({ url: 'http://x.example', priceCapUsd: 0.01 }).ok).toBe(false)
    expect(parseX402ToolBinding({ url: 'https://x.example' }).ok).toBe(false)
    expect(parseX402ToolBinding({ url: 'https://x.example', priceCapUsd: X402_TOOL_PRICE_CAP_MAX_USD + 0.01 }).ok).toBe(false)
    expect(parseX402ToolBinding({ url: 'https://x.example', priceCapUsd: 0.01, payTo: 'nope' }).ok).toBe(false)
  })
  it('every preset parses', () => {
    for (const p of X402_TOOL_PRESETS) expect(parseX402ToolBinding(p.binding).ok).toBe(true)
  })
})

describe('requestFor + usdToUnits', () => {
  it('GET puts the task in the query, POST in the JSON body', () => {
    const b = { url: 'https://x.example/api', method: 'GET' as const, priceCapUsd: 0.01, bodyKey: 'q' }
    expect(requestFor(b, 'hello world').url).toBe('https://x.example/api?q=hello+world')
    const p = requestFor({ ...b, method: 'POST' }, 'hi')
    expect(p.url).toBe('https://x.example/api')
    expect(JSON.parse(String(p.init.body))).toEqual({ q: 'hi' })
  })
  it('one cent is 10000 base units', () => {
    expect(usdToUnits(0.01)).toBe(10000n)
  })
})
