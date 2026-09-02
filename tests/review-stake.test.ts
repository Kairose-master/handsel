import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  REVIEW_STAKE,
  STAKE_BURN_ADDRESS,
  reviewStakeUsd,
  decideStakeOutcome,
  stakeMoveAllowed,
} from '@/lib/review-stake'

/**
 * Verdict stake — reviewer pay accountable to its verdict. Background:
 * eight verdicts, zero APPROVEs across the first three finished review
 * conversations; brief-level fixes (approval standard, final-round
 * disclosure) moved nothing. The stake prices stonewalling with a
 * NON-RECURSIVE trigger: the owner's own on-chain judgment of the refused
 * deliverable.
 */

describe('reviewStakeUsd — half the review bounty, floored, min a cent', () => {
  it('takes half and floors to the cent', () => {
    expect(reviewStakeUsd(1.14)).toBe(0.57)
    expect(reviewStakeUsd(1.71)).toBe(0.85)
  })
  it('never goes below the minimum', () => {
    expect(reviewStakeUsd(0.01)).toBe(REVIEW_STAKE.MIN_USD)
  })
})

describe('decideStakeOutcome — the chain decides, mechanically', () => {
  it('owner release = reviewer overruled = forfeit', () => {
    expect(decideStakeOutcome('Completed')).toBe('forfeit')
  })
  it('refund or dispute = the refusal agreed with the outcome = return', () => {
    expect(decideStakeOutcome('Refunded')).toBe('return')
    expect(decideStakeOutcome('Disputed')).toBe('return')
  })
  it('an undecided job keeps holding', () => {
    expect(decideStakeOutcome('Submitted')).toBe('hold')
    expect(decideStakeOutcome('Accepted')).toBe('hold')
  })
})

describe('the burn is real money-gated, and goes to nobody', () => {
  it('testnet moves freely; real money needs the explicit flag', () => {
    expect(stakeMoveAllowed(false, undefined)).toBe(true)
    expect(stakeMoveAllowed(true, undefined)).toBe(false)
    expect(stakeMoveAllowed(true, 'true')).toBe(true)
  })
  it('the burn address is the canonical dead address — paying the owner would make overruling profitable', () => {
    expect(STAKE_BURN_ADDRESS).toBe('0x000000000000000000000000000000000000dEaD')
  })
})

describe('the wiring — recorded at stonewall, resolved by the chain, disclosed to the reviewer', () => {
  const src = readFileSync('lib/delegation.ts', 'utf8')

  it('hand-to-owner records the stake; a same-author discard never stakes', () => {
    const branch = src.slice(src.indexOf('// Rounds spent.'))
    expect(branch).toContain('reviewStakeUsd(reviewer.bountyUsd)')
    expect(branch.indexOf('!samePerson')).toBeGreaterThan(-1)
    expect(branch.indexOf('!samePerson')).toBeLessThan(branch.indexOf('reviewStakeUsd'))
  })

  it('resolution reads the on-chain status and burns via transferUsdc to the dead address', () => {
    const at = src.indexOf('decideStakeOutcome(targetJob.status)')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 2000)
    expect(block).toContain('STAKE_BURN_ADDRESS')
    expect(block).toContain('transferUsdc(stake.reviewerAgentId')
    expect(block).toContain('REVIEW_STAKE_ALLOW_REAL_MONEY')
  })

  it('a stake resolution persists immediately — a money fact must not ride the end-of-tick save', () => {
    const at = src.indexOf('decideStakeOutcome(targetJob.status)')
    const block = src.slice(at, at + 2600)
    expect(block).toContain('await db.update(delegation).set({ subtasks })')
  })

  it('the final-round brief discloses the stake — an unknown stake disciplines nobody', () => {
    expect(src).toContain('half your review bounty is burned')
    expect(src).toContain('An APPROVE that closes the review stakes nothing')
  })
})
