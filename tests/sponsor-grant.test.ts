import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { USER_GRANT_SHARE, decideSponsorship } from '@/lib/gas-budget'

/**
 * A finite grant needs a budget that can see a total.
 *
 * Every other budget in gas-budget.ts is measured over GAS_WINDOW_MS, which
 * assumes the pool refills. A prepaid paymaster balance does not. The failure
 * that shape produces is the one this codebase keeps meeting: on the day the
 * money runs out, `laneSpentUsd` reads the same as it did on the first day, the
 * verdict is `sponsor`, and nothing is wrong with any individual number. The
 * ceiling is real and the window simply cannot see it.
 *
 * Measured on Base mainnet at block 49316999 — base fee 0.005 gwei, ETH/USD
 * 1916.07 off the Chainlink feed — one 500k-gas UserOp costs about $0.0058. So a
 * $10 grant is roughly 1,700 operations, and the per-day caps of $5 + $2 are
 * about 1,200 of them. The daily fuse is not wrong; it is denominated for a
 * wallet somebody refills.
 */

const base = {
  lane: 'user' as const,
  agentSpentUsd: 0,
  laneSpentUsd: 0,
  canSelfPay: true,
  grantUsd: 10,
}

describe('the lifetime ceiling', () => {
  it('sponsors while the grant has room, with every daily budget untouched', () => {
    expect(decideSponsorship({ ...base, grantSpentUsd: 3 }).decision).toBe('sponsor')
  })

  it('degrades the user lane to self-pay at its share, not at the whole grant', () => {
    // $7.50 of $10. The remaining quarter is not the user lane's to spend.
    const at = decideSponsorship({ ...base, grantSpentUsd: 10 * USER_GRANT_SHARE })
    expect(at.decision).toBe('self_pay')
    expect(decideSponsorship({ ...base, grantSpentUsd: 10 * USER_GRANT_SHARE - 0.01 }).decision).toBe('sponsor')
  })

  it('refuses a user call that cannot pay its own way', () => {
    const v = decideSponsorship({ ...base, grantSpentUsd: 9, canSelfPay: false })
    expect(v.decision).toBe('refuse')
  })

  it('leaves the last quarter reachable only by the keeper', () => {
    // The point of the split. An attacker who burns the user lane's share must
    // not thereby stop the sweeps that free OTHER people's escrow — draining
    // gas is the operator's loss, freezing everyone's escrow is everyone's.
    const spent = 8 // past the user's 7.50, inside the grant's 10
    expect(decideSponsorship({ ...base, grantSpentUsd: spent }).decision).toBe('self_pay')
    expect(decideSponsorship({ ...base, lane: 'keeper', grantSpentUsd: spent }).decision).toBe('sponsor')
  })

  it('refuses keeper work once the grant itself is gone, and says it will not reset', () => {
    const v = decideSponsorship({ ...base, lane: 'keeper', grantSpentUsd: 10 })
    expect(v.decision).toBe('refuse')
    // The distinction a keeper alarm has to make: this is not tomorrow's problem.
    expect(v.reason).toMatch(/not a daily limit/)
  })

  it('is checked before the daily windows, because a window cannot see a total', () => {
    // Nothing spent today at all. Every per-day budget reads "within budget",
    // and sponsoring here is what empties the grant.
    const v = decideSponsorship({ ...base, agentSpentUsd: 0, laneSpentUsd: 0, grantSpentUsd: 9.99 })
    expect(v.decision).toBe('self_pay')
  })
})

describe('when there is no grant to speak of', () => {
  it('changes nothing for an operator who funds the paymaster', () => {
    // null = no lifetime ceiling. This is the default and the pre-existing
    // behaviour; the ceiling must be something you opt into, not a new way for
    // a working deployment to start refusing.
    expect(decideSponsorship({ ...base, grantUsd: null, grantSpentUsd: 999 }).decision).toBe('sponsor')
  })

  it('does not apply a ceiling when the total could not be read', () => {
    // gasSpentTotal returns null on an unreadable ledger and the caller passes
    // undefined. Fails toward sponsoring, like gasSpentInWindow — the daily caps
    // and the ZeroDev policy are still underneath.
    expect(decideSponsorship({ ...base, grantSpentUsd: undefined }).decision).toBe('sponsor')
  })
})

describe('the ceiling is wired, not merely written', () => {
  /**
   * The lesson from `realMoneyBlockers`, which was correct, tested, documented
   * and had zero callers. A pure function that decides nothing decides nothing.
   */
  const src = readFileSync('lib/onchain/account.ts', 'utf8')

  it('is read at both sponsorship decisions', () => {
    expect(src.match(/gasSpentTotal\(\)/g)?.length).toBe(2)
    expect(src.match(/grantSpentUsd: grantSpent \?\? undefined/g)?.length).toBe(2)
  })

  it('never substitutes zero for an unreadable total', () => {
    // `grantSpent ?? 0` would read as "the grant is untouched" and sponsor to
    // the end of it. The whole difference between the two is one character.
    expect(src).not.toMatch(/grantSpent \?\? 0/)
  })

  it('honours an explicit zero grant instead of treating it as unset', () => {
    const budget = readFileSync('lib/gas-budget.ts', 'utf8')
    // The FAUCET_MAX_PER_DAY shape: `Number(x) || 15` made a deliberate off
    // switch mean fifteen. An operator who sets the grant to 0 means zero.
    expect(budget).toMatch(/if \(raw === undefined \|\| raw\.trim\(\) === ''\) return null/)
    expect(budget).not.toMatch(/Number\(raw\) \|\| /)
  })
})
