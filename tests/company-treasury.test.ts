import { describe, it, expect } from 'vitest'
import { gasPoolHealth, type GasPoolStatus } from '@/lib/company-treasury'
import { LOCAL_GAS_TARGET_WEI, LOCAL_GAS_WINDOW_BUDGET_WEI } from '@/lib/local-paymaster'

const configured = (over: Partial<Extract<GasPoolStatus, { configured: true }>> = {}): GasPoolStatus => ({
  configured: true,
  enabled: true,
  sourceAgentId: 'a1',
  sourceAgentName: 'Gas Wallet',
  heldWei: (LOCAL_GAS_TARGET_WEI * 4n).toString(),
  spendableWei: (LOCAL_GAS_TARGET_WEI * 4n).toString(),
  spentTodayWei: '0',
  budgetWei: LOCAL_GAS_WINDOW_BUDGET_WEI.toString(),
  reserveWei: '200000000000000',
  ...over,
})

describe('gasPoolHealth — the states an owner chose, checked first', () => {
  it('unconfigured beats everything — no pool was ever set up', () => {
    expect(gasPoolHealth({ configured: false })).toBe('unconfigured')
  })

  it('disabled beats a healthy balance — the owner turned it off', () => {
    expect(gasPoolHealth(configured({ enabled: false, spendableWei: (LOCAL_GAS_TARGET_WEI * 10n).toString() }))).toBe('disabled')
  })
})

describe('gasPoolHealth — unknown vs zero', () => {
  it('a failed balance read is unknown, never reported as empty or ok', () => {
    expect(gasPoolHealth(configured({ spendableWei: null }))).toBe('unknown')
  })

  it('a failed spend-today read alone does not force unknown — the balance check still runs', () => {
    const v = gasPoolHealth(configured({ spentTodayWei: null, spendableWei: (LOCAL_GAS_TARGET_WEI * 4n).toString() }))
    expect(v).toBe('ok')
  })
})

describe('gasPoolHealth — balance-based verdicts', () => {
  it('a spendable balance of exactly zero is empty', () => {
    expect(gasPoolHealth(configured({ spendableWei: '0' }))).toBe('empty')
  })

  it('a healthy, unspent pool is ok', () => {
    expect(gasPoolHealth(configured())).toBe('ok')
  })

  it('spendable under half the top-up target is low even with budget untouched', () => {
    expect(gasPoolHealth(configured({ spendableWei: (LOCAL_GAS_TARGET_WEI / 4n).toString() }))).toBe('low')
  })

  it('90% of the daily budget spent is low even with plenty of balance left', () => {
    const spent = (LOCAL_GAS_WINDOW_BUDGET_WEI * 9n) / 10n
    expect(gasPoolHealth(configured({ spentTodayWei: spent.toString() }))).toBe('low')
  })

  it('89% of budget spent, healthy balance, is still ok — the threshold is a real boundary', () => {
    const spent = (LOCAL_GAS_WINDOW_BUDGET_WEI * 89n) / 100n
    expect(gasPoolHealth(configured({ spentTodayWei: spent.toString() }))).toBe('ok')
  })

  it('empty balance outranks a fine budget — insolvent beats under-spent', () => {
    expect(gasPoolHealth(configured({ spendableWei: '0', spentTodayWei: '0' }))).toBe('empty')
  })
})
