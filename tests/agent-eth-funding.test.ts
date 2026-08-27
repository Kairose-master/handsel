import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseEther } from 'viem'
import {
  planEthFunding,
  parseEthAmount,
  ETH_FUNDING_RESERVE_WEI,
  ETH_FUNDING_TARGET_WEI,
  ETH_FUNDING_DUST_WEI,
} from '@/lib/agent-eth-funding'
import { ETH_WITHDRAW_RESERVE_WEI } from '@/lib/agent-eth-withdraw'
import { AGENT_GAS_FLOOR } from '@/lib/onchain/account'

const EMPTY = 0n

describe('planEthFunding', () => {
  it('tops the destination up to a working balance when no amount is given', () => {
    const plan = planEthFunding({ heldWei: parseEther('0.01'), targetHeldWei: EMPTY })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.amountWei).toBe(ETH_FUNDING_TARGET_WEI)
  })

  it('sends only the shortfall when the destination is partly funded', () => {
    const half = ETH_FUNDING_TARGET_WEI / 2n
    const plan = planEthFunding({ heldWei: parseEther('0.01'), targetHeldWei: half })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.amountWei).toBe(ETH_FUNDING_TARGET_WEI - half)
  })

  it('is a no-op on an already-funded agent, so repeating the call is safe', () => {
    // Idempotence is what makes this callable from a script or a loop without
    // quietly sending a second transfer every pass.
    const plan = planEthFunding({ heldWei: parseEther('0.01'), targetHeldWei: ETH_FUNDING_TARGET_WEI })
    expect(plan).toMatchObject({ ok: false, reason: 'already-funded' })
  })

  it('still sends to a funded agent when an amount is named explicitly', () => {
    const plan = planEthFunding({
      heldWei: parseEther('0.01'),
      targetHeldWei: ETH_FUNDING_TARGET_WEI,
      requestedWei: parseEther('0.001'),
    })
    expect(plan.ok).toBe(true)
  })

  it('keeps a reserve so funding a sibling cannot strand the funder', () => {
    // The transfer is itself a UserOperation paid out of this balance. A true
    // sweep either fails outright or lands and leaves an account that cannot
    // transact and cannot fund its own rescue.
    const held = ETH_FUNDING_RESERVE_WEI + parseEther('0.0001')
    const plan = planEthFunding({ heldWei: held, targetHeldWei: EMPTY, requestedWei: held })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reason).toBe('more-than-held')
      expect(plan.maxWei).toBe(parseEther('0.0001'))
    }
  })

  it('refuses when the whole balance is the reserve', () => {
    expect(
      planEthFunding({ heldWei: ETH_FUNDING_RESERVE_WEI, targetHeldWei: EMPTY, requestedWei: 1n }),
    ).toMatchObject({ ok: false, reason: 'nothing-to-send' })
  })

  it('drain reaches past the reserve, but only when asked', () => {
    const plan = planEthFunding({
      heldWei: ETH_FUNDING_RESERVE_WEI,
      targetHeldWei: EMPTY,
      requestedWei: ETH_FUNDING_RESERVE_WEI,
      drain: true,
    })
    expect(plan).toMatchObject({ ok: true, leavesWei: 0n })
  })

  it('refuses dust', () => {
    expect(
      planEthFunding({ heldWei: parseEther('1'), targetHeldWei: EMPTY, requestedWei: 1n }),
    ).toMatchObject({ ok: false, reason: 'below-dust' })
  })
})

describe('the constants agree with the ones they mirror', () => {
  it('reuses the withdrawal reserve rather than inventing a second number', () => {
    // Both answer "how much must stay behind for this account to remain
    // usable". Two numbers for one question drift.
    expect(ETH_FUNDING_RESERVE_WEI).toBe(ETH_WITHDRAW_RESERVE_WEI)
  })

  it('targets a working balance, not the bare floor', () => {
    // Funding an agent to exactly the floor leaves it one call from stopping,
    // which is the state this tool exists to get an agent out of.
    expect(ETH_FUNDING_TARGET_WEI).toBeGreaterThan(AGENT_GAS_FLOOR)
  })

  it('keeps dust below the target, or nothing could ever be sent', () => {
    expect(ETH_FUNDING_DUST_WEI).toBeLessThan(ETH_FUNDING_TARGET_WEI)
  })
})

describe('parseEthAmount', () => {
  it('refuses everything that is not a plain positive decimal', () => {
    for (const bad of ['', '-1', '0', 'abc', '1e3', 'Infinity', '0x1', '1,5']) {
      expect(parseEthAmount(bad), bad).toBeNull()
    }
    expect(parseEthAmount('0.0002')).toBe(parseEther('0.0002'))
  })
})

describe('the transfer itself', () => {
  const src = readFileSync('lib/agent-eth-funding.ts', 'utf8')
  const body = src
    .slice(src.indexOf('export async function fundAgentEth'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('checks BOTH ends against the caller, not just the funder', () => {
    // A funder-only check makes this "send my ETH to any agent id", which is a
    // transfer to a stranger's wallet reachable from a connector.
    expect(body).toContain('from.userId !== userId')
    expect(body).toContain('to.userId !== userId')
  })

  it('never takes an owner from an argument', () => {
    expect(body).not.toMatch(/opts\.userId|args\.user_id/)
  })

  it('refuses a destination with no on-chain account', () => {
    // ETH sent to an unprovisioned agent goes to an address nothing can spend
    // from yet.
    expect(body).toContain('to.smartAccountAddress')
  })

  it('refuses a self-transfer', () => {
    expect(src).toContain('fromAgentId === toAgentId')
  })
})
