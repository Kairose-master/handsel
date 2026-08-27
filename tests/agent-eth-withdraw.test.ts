import { describe, it, expect } from 'vitest'
import {
  planEthWithdrawal,
  parseEthAmount,
  ETH_WITHDRAW_RESERVE_WEI,
  ETH_WITHDRAW_DUST_WEI,
} from '@/lib/agent-eth-withdraw'

const eth = (n: string) => BigInt(Math.round(Number(n) * 1e18))

describe('planEthWithdrawal', () => {
  it('keeps the reserve behind so the account can still transact', () => {
    const plan = planEthWithdrawal({ heldWei: eth('0.001') })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.amountWei).toBe(eth('0.001') - ETH_WITHDRAW_RESERVE_WEI)
    expect(plan.leavesWei).toBe(ETH_WITHDRAW_RESERVE_WEI)
  })

  it('never plans a withdrawal that would empty the account', () => {
    // The withdrawal is itself paid for out of this balance. Emptying it
    // either fails outright or lands and strands the account below the floor.
    for (const held of ['0.0002', '0.0005', '0.01', '1']) {
      const plan = planEthWithdrawal({ heldWei: eth(held) })
      if (plan.ok) expect(plan.leavesWei).toBeGreaterThanOrEqual(ETH_WITHDRAW_RESERVE_WEI)
    }
  })

  it('refuses when the balance is at or under the reserve', () => {
    for (const held of ['0', '0.0001', '0.0002']) {
      const plan = planEthWithdrawal({ heldWei: eth(held) })
      expect(plan.ok, held).toBe(false)
      if (!plan.ok) expect(plan.reason).toBe('nothing-to-withdraw')
    }
  })

  it('lets an explicit drain take the reserve, for an agent being retired', () => {
    const plan = planEthWithdrawal({ heldWei: eth('0.0003'), drain: true })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.amountWei).toBe(eth('0.0003'))
      expect(plan.leavesWei).toBe(0n)
    }
  })

  it('honours a smaller explicit amount', () => {
    const plan = planEthWithdrawal({ heldWei: eth('0.01'), requestedWei: eth('0.001') })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.amountWei).toBe(eth('0.001'))
  })

  it('refuses an amount above what is safely available, and says the max', () => {
    const plan = planEthWithdrawal({ heldWei: eth('0.001'), requestedWei: eth('0.001') })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reason).toBe('more-than-held')
      expect(plan.maxWei).toBe(eth('0.001') - ETH_WITHDRAW_RESERVE_WEI)
    }
  })

  it('refuses dust — a transfer that costs more than it moves', () => {
    const plan = planEthWithdrawal({
      heldWei: eth('1'),
      requestedWei: ETH_WITHDRAW_DUST_WEI - 1n,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toBe('below-dust')
  })

  it('is exact in wei — no float rounds someone’s money', () => {
    const held = 1_234_567_890_123_456_789n
    const plan = planEthWithdrawal({ heldWei: held })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.amountWei + plan.leavesWei).toBe(held)
  })
})

describe('parseEthAmount', () => {
  it('accepts a plain decimal', () => {
    expect(parseEthAmount('0.001')).toBe(1_000_000_000_000_000n)
    expect(parseEthAmount('  1  ')).toBe(1_000_000_000_000_000_000n)
  })

  it('refuses anything that is not a positive plain decimal', () => {
    // parseEther tolerates some of these; a transfer amount must not.
    for (const bad of ['', '-1', '1e18', '0x10', 'abc', '1.2.3', 'Infinity', 'NaN', '0', '0.0', '+1', '1,5']) {
      expect(parseEthAmount(bad), bad).toBeNull()
    }
  })
})
