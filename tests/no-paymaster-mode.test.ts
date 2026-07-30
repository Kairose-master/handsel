import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideSponsorship } from '@/lib/gas-budget'

/**
 * Running with no paymaster, which is not the same as running out of one.
 *
 * The distinction is the whole reason this is an explicit switch. An exhausted
 * budget means the operator's pool ran dry and the market should degrade. No
 * paymaster means there was never a pool — and the sponsored path is then not a
 * fallback but a dead end, because an operation naming a paymaster with no
 * EntryPoint deposit fails with `AA21 didn't pay prefund` however much budget
 * this codebase believes remains.
 *
 * Read off Base mainnet at block 49319334: this deployment's paymaster,
 * 0xEB49a384…24e4d3, holds a deposit of 0 and is not staked, and a sponsorship
 * request for a 700k-gas operation returned exactly that AA21. A dashboard
 * balance is an accounting entry; `getDepositInfo(pm).deposit` is whether
 * anything can be paid.
 */

const base = {
  lane: 'user' as const,
  agentSpentUsd: 0,
  laneSpentUsd: 0,
  canSelfPay: true,
  paymasterAvailable: false,
}

describe('with no paymaster', () => {
  it('sends the user lane straight to self-pay', () => {
    const v = decideSponsorship(base)
    expect(v.decision).toBe('self_pay')
    expect(v.reason).toMatch(/no paymaster/)
  })

  it('lets the keeper self-pay too, which it may not do on an exhausted reserve', () => {
    // The reserve rule exists so a DRAINED user lane cannot stop expireOpen,
    // reclaimJob, expireReview and expireDispute from freeing other people's
    // escrow. With no paymaster there is no reserve to drain and nothing hidden
    // from the operator — refusing here would simply stop the permissionless
    // exits, which is the failure the two lanes were built to prevent.
    expect(decideSponsorship({ ...base, lane: 'keeper' }).decision).toBe('self_pay')
  })

  it('still refuses a caller that cannot pay, and says what would fix it', () => {
    const v = decideSponsorship({ ...base, canSelfPay: false })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toMatch(/Fund the account/)
  })

  it('decides before consulting any budget, because none of them apply', () => {
    // Every budget wide open and every counter at zero. A sponsored verdict here
    // would be well-formed, plausible, and produce AA21 on send.
    const v = decideSponsorship({
      ...base,
      agentBudgetUsd: 1000,
      laneBudgetUsd: 1000,
      grantUsd: 1000,
      grantSpentUsd: 0,
    })
    expect(v.decision).toBe('self_pay')
  })
})

describe('with a paymaster, nothing changes', () => {
  it('still sponsors inside the budgets', () => {
    expect(decideSponsorship({ ...base, paymasterAvailable: true }).decision).toBe('sponsor')
  })

  it('still keeps the keeper off self-pay when the reserve is what ran out', () => {
    const v = decideSponsorship({
      lane: 'keeper',
      agentSpentUsd: 0,
      laneSpentUsd: 99,
      laneBudgetUsd: 2,
      canSelfPay: false,
      paymasterAvailable: true,
    })
    expect(v.decision).toBe('refuse')
  })
})

describe('the mode is wired, not merely defined', () => {
  it('reaches the keeper self-pay decision from the send path', () => {
    const src = readFileSync('lib/onchain/account.ts', 'utf8')
    expect(src).toContain('canSelfPay: PAYMASTER_DISABLED || lane === ')
  })

  it('does not demand a promise about a paymaster that does not exist', () => {
    // paymaster-unmetered asks the operator to confirm a spending policy on
    // sponsored gas. With no paymaster there is no sponsored gas, so requiring
    // the acknowledgement would block a deployment over a risk it cannot have.
    const src = readFileSync('lib/onchain/real-money.ts', 'utf8')
    expect(src).toContain('onchainEnv.paymasterMeteredAck || PAYMASTER_DISABLED')
  })

  it('reads the switch as an exact "true", never as mere presence', () => {
    // PAYMASTER_DISABLED=false must not disable the paymaster. Presence checks
    // are how an env var meant to be off ends up on.
    const src = readFileSync('lib/gas-budget.ts', 'utf8')
    expect(src).toMatch(/PAYMASTER_DISABLED = process\.env\.PAYMASTER_DISABLED === 'true'/)
  })
})
