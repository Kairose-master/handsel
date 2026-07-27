import { describe, expect, it } from 'vitest'
import {
  accountCarryover,
  applyCarryover,
  CARRYOVER_SCORE_PENALTY,
  CARRYOVER_WEIGHT,
  explainCarryover,
  MAX_CARRYOVER,
  type InheritedFailure,
} from '@/lib/credit-engine/account-history'

const NOW = new Date('2026-07-27T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)

const fail = (agentId: string, days = 0): InheritedFailure => ({
  eventType: 'VERIFIED_TASK_FAILED',
  createdAt: daysAgo(days),
  agentId,
})
const success = (agentId: string): InheritedFailure => ({
  eventType: 'VERIFIED_TASK_COMPLETED',
  createdAt: NOW,
  agentId,
})

describe('only failures carry', () => {
  it('ignores a sibling’s successes entirely', () => {
    // Inheriting success would let an operator with a good record mint agents
    // that arrive pre-loaded with reputation — reputation nobody earned, which
    // is the thing this system exists not to sell.
    const c = accountCarryover([success('a'), success('a'), success('b')], NOW)
    expect(c.weight).toBe(0)
    expect(c.rawFailures).toBe(0)
  })

  it('carries a sibling’s failures at less than full weight', () => {
    const c = accountCarryover([fail('a')], NOW)
    expect(c.weight).toBeCloseTo(CARRYOVER_WEIGHT, 3)
    expect(c.weight).toBeLessThan(1)
  })

  it('counts several failures from several agents', () => {
    const c = accountCarryover([fail('a'), fail('a'), fail('b')], NOW)
    expect(c.rawFailures).toBe(3)
    expect(c.agents).toBe(2)
  })
})

describe('carryover fades, and is bounded', () => {
  it('decays with the slow negative half-life', () => {
    const fresh = accountCarryover([fail('a', 0)], NOW).weight
    const old = accountCarryover([fail('a', 365)], NOW).weight
    expect(old).toBeLessThan(fresh)
    expect(old).toBeCloseTo(fresh / 2, 2) // one negative half-life
  })

  it('caps, so one bad period does not make an account permanently unusable', () => {
    // An operator who cannot use the platform at all moves to a new ACCOUNT,
    // and account-level evasion is a harder problem than the one being solved.
    const many = Array.from({ length: 100 }, (_, i) => fail(`a${i}`))
    expect(accountCarryover(many, NOW).weight).toBe(MAX_CARRYOVER)
  })

  it('is zero for an operator with no other agents', () => {
    expect(accountCarryover([], NOW).weight).toBe(0)
  })
})

describe('the invariant: rotating must never pay', () => {
  // The attack is an agent with a bad record being abandoned for a fresh one.
  // Shedding has to cost more than staying, or the defence is decorative.
  it('makes a fresh agent score no better than the one it replaced', () => {
    const failures = [fail('old'), fail('old'), fail('old')]

    // Staying: the agent's own three failures cost it roughly 8 risk points
    // each, and risk is 10% of a 690-point span — about 5.5 score points per
    // failure.
    const OWN_FAILURE_SCORE_COST = 5.5
    const stayed = 500 - failures.length * OWN_FAILURE_SCORE_COST

    // Rotating: a cold-start agent, minus what it inherits.
    const rotated = applyCarryover(500, accountCarryover(failures, NOW))

    expect(rotated).toBeLessThanOrEqual(stayed)
  })

  it('prices a shed failure above a kept one', () => {
    // CARRYOVER_WEIGHT x CARRYOVER_SCORE_PENALTY must exceed the ~5.5 points a
    // failure costs an agent that keeps it. Otherwise rotation is still cheaper
    // and every other part of this file is theatre.
    expect(CARRYOVER_WEIGHT * CARRYOVER_SCORE_PENALTY).toBeGreaterThan(5.5)
  })

  it('does not punish an agent for its own failures twice', () => {
    // Sibling events only. If the agent's own history were included here it
    // would be counted once by the scoring path and again by this one, which
    // penalises staying put — exactly backwards.
    const c = accountCarryover([], NOW)
    expect(c.weight).toBe(0)
  })
})

describe('applyCarryover', () => {
  it('subtracts proportionally', () => {
    const c = accountCarryover([fail('a'), fail('b')], NOW)
    expect(applyCarryover(700, c)).toBe(Math.round(700 - c.weight * CARRYOVER_SCORE_PENALTY))
  })

  it('never drops below the score floor', () => {
    const many = Array.from({ length: 100 }, (_, i) => fail(`a${i}`))
    expect(applyCarryover(310, accountCarryover(many, NOW))).toBe(300)
  })

  it('leaves a clean account untouched', () => {
    expect(applyCarryover(742, accountCarryover([], NOW))).toBe(742)
  })
})

describe('explainCarryover', () => {
  it('says nothing when nothing was deducted', () => {
    expect(explainCarryover(accountCarryover([], NOW))).toBeNull()
  })

  it('explains a deduction, because an unexplained one looks like a bug', () => {
    const text = explainCarryover(accountCarryover([fail('a'), fail('b')], NOW))!
    expect(text).toContain('2 other agents')
    expect(text).toContain('successes stay with the agent that earned them')
  })

  it('uses singular wording for a single sibling', () => {
    expect(explainCarryover(accountCarryover([fail('a')], NOW))!).toContain('another agent')
  })
})
