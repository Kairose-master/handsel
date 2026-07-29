import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decideSponsorship,
  keeperStarved,
  KEEPER_LANE_BUDGET_USD,
  type SponsorInput,
} from '@/lib/gas-budget'

/**
 * The fuse, and the reserve behind it.
 *
 * Two properties matter more than the numbers:
 *
 * 1. **Exhaustion degrades to self-pay, it does not refuse.** A budget that
 *    refuses converts a gas attack into a denial of service — the attacker
 *    spends the operator's money and takes the market offline as a bonus.
 * 2. **Keeper traffic draws on a reserve user traffic cannot touch.** A single
 *    pool means draining it also disables expireReview / expireDispute /
 *    reclaimJob / expireOpen, which free OTHER people's escrow. That would turn
 *    a gas attack into a way to freeze the market's money — strictly worse than
 *    the gas, and the exact failure class v2 exists to close.
 */

const base: SponsorInput = {
  lane: 'user',
  agentSpentUsd: 0,
  laneSpentUsd: 0,
  canSelfPay: true,
  agentBudgetUsd: 1,
  laneBudgetUsd: 10,
}
const decide = (o: Partial<SponsorInput> = {}) => decideSponsorship({ ...base, ...o })

describe('within budget', () => {
  it('sponsors', () => {
    expect(decide().decision).toBe('sponsor')
  })

  it('sponsors right up to the threshold', () => {
    expect(decide({ agentSpentUsd: 0.999 }).decision).toBe('sponsor')
  })
})

describe('exhaustion degrades — it does not stop the market', () => {
  it('falls through to self-pay at the agent ceiling', () => {
    expect(decide({ agentSpentUsd: 1 })).toMatchObject({ decision: 'self_pay' })
  })

  it('falls through to self-pay at the lane ceiling', () => {
    expect(decide({ laneSpentUsd: 10 })).toMatchObject({ decision: 'self_pay' })
  })

  it('names which ceiling was hit, because the two mean different things', () => {
    // One agent over its own cap is ordinary. The whole lane over its cap is an
    // incident. An operator reading a log needs to tell them apart.
    expect(decide({ agentSpentUsd: 1 }).reason).toContain('agent')
    expect(decide({ laneSpentUsd: 10 }).reason).toContain('lane')
    expect(decide({ agentSpentUsd: 1, laneSpentUsd: 10 }).reason).toContain('agent and lane')
  })

  it('refuses only when the caller genuinely cannot pay', () => {
    expect(decide({ agentSpentUsd: 1, canSelfPay: false })).toMatchObject({ decision: 'refuse' })
  })

  it('never refuses a caller that CAN pay, however far over budget', () => {
    // The property an attacker must not be able to break: no amount of spending
    // by anyone takes the market away from someone holding their own gas.
    expect(decide({ agentSpentUsd: 1e9, laneSpentUsd: 1e9 }).decision).toBe('self_pay')
  })
})

describe('the keeper reserve', () => {
  it('is not touched by user spending', () => {
    // The whole point. The user lane is drained to a billion dollars and the
    // sweeps that free other people's escrow still run.
    expect(decideSponsorship({ ...base, lane: 'keeper', laneSpentUsd: 0, agentSpentUsd: 1e9 })).toMatchObject({
      decision: 'sponsor',
    })
  })

  it('has its own ceiling', () => {
    expect(
      decideSponsorship({ ...base, lane: 'keeper', laneSpentUsd: 5, laneBudgetUsd: 5 }).decision,
    ).toBe('refuse')
  })

  it('refuses rather than self-pays, because there is nobody to bill', () => {
    // A keeper call is the operator freeing somebody else's escrow. There is no
    // caller to charge, so the honest options are do it or say it is not done.
    expect(
      decideSponsorship({ ...base, lane: 'keeper', laneSpentUsd: 5, laneBudgetUsd: 5, canSelfPay: true })
        .decision,
    ).toBe('refuse')
  })

  it('says plainly what an exhausted reserve means', () => {
    const out = decideSponsorship({ ...base, lane: 'keeper', laneSpentUsd: 5, laneBudgetUsd: 5 })
    expect(out.reason).toMatch(/settlement sweeps are not running/)
  })

  it('warns before it is empty, not after', () => {
    // The sweeps are capped per pass, so sustained keeper burn is not "busy" —
    // it means the ops cycle is running far more often than intended or
    // something is retrying without bound. Worth a look before it stops.
    expect(keeperStarved(KEEPER_LANE_BUDGET_USD * 0.79)).toBe(false)
    expect(keeperStarved(KEEPER_LANE_BUDGET_USD * 0.8)).toBe(true)
  })
})

describe('budgets that were never meant', () => {
  it('is per-AGENT, so a Sybil does not get a bigger allowance by spreading out', () => {
    // A per-user cap only bites once every agent is traced to one user, which
    // is exactly what a Sybil is arranging not to happen. Two fresh agents each
    // get one agent budget, and the LANE cap is what stops the sum.
    expect(decide({ agentSpentUsd: 0, laneSpentUsd: 9.99 }).decision).toBe('sponsor')
    expect(decide({ agentSpentUsd: 0, laneSpentUsd: 10 }).decision).toBe('self_pay')
  })
})

describe('the wiring, asserted at the source', () => {
  // The decision is pure and tested above; what a unit test cannot show is that
  // anything CALLS it. These are the same shape as the dispute-policy grep, and
  // for the same reason: a fuse nothing consults is decoration.
  const code = (p: string) =>
    readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('sendAgentCall consults the budget before sponsoring', () => {
    const src = code('lib/onchain/account.ts')
    expect(src).toContain('decideSponsorship')
    expect(src).toContain('recordGasSpend')
  })

  it('exhaustion routes to the self-pay path that already existed', () => {
    // Not a new code path — sendEoaCall predates this and is the unsponsored
    // mode the file already documented.
    const src = code('lib/onchain/account.ts')
    expect(src).toMatch(/self_pay[\s\S]{0,200}sendEoaCall/)
  })

  it('the permissionless exits are on the KEEPER lane', () => {
    // If these ever draw on the user lane, draining it disables the sweeps that
    // free other people's escrow — a gas attack becomes a way to freeze the
    // market's money.
    expect(code('lib/onchain/labor-v2.ts')).toMatch(/lane:\s*'keeper'/)
  })
})
