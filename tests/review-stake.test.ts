import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  REVIEW_STAKE,
  STAKE_BURN_ADDRESS,
  reviewStakeUsd,
  decideStakeOutcome,
  stakeMoveAllowed,
  hasHeldReviewStake,
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

describe('hasHeldReviewStake — the sweep key', () => {
  it('is true only while a stake is undecided', () => {
    expect(hasHeldReviewStake([{}, { reviewStake: { reviewerAgentId: 'r', amountUsd: 0.57, status: 'held' } }])).toBe(true)
    expect(hasHeldReviewStake([{ reviewStake: { reviewerAgentId: 'r', amountUsd: 0.57, status: 'forfeited' } }])).toBe(false)
    expect(hasHeldReviewStake([{ reviewStake: { reviewerAgentId: 'r', amountUsd: 0.57, status: 'returned' } }])).toBe(false)
    expect(hasHeldReviewStake([])).toBe(false)
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

  it('the terminal branch records the stake; a same-author discard never stakes', () => {
    // The trigger moved. This anchored on `hand-to-owner`, and that outcome
    // no longer exists — the evidence rule in lib/review-findings.ts made the
    // terminal a `fail`, so the stake rides that instead. The property is
    // unchanged and so is everything this asserts: recorded once, at the
    // terminal, and never against a verdict that was discarded for
    // same-authorship, because a verdict nobody acted on cannot be
    // accountable.
    //
    // Worth stating what the two mechanisms now split between them. The
    // evidence rule removes the CHEAP refusal: a reviewer with nothing to
    // quote releases rather than reaching this branch at all. The stake
    // covers what a quote cannot check — a quote verifies the locator, not
    // the defect, so a bogus complaint pinned to a real sentence still needs
    // a price.
    const branch = src.slice(src.indexOf('// Rounds spent with a verified blocking finding'))
    expect(branch.length).toBeGreaterThan(100)
    expect(branch).toContain('reviewStakeUsd(reviewer.bountyUsd)')
    expect(branch.indexOf('!samePerson')).toBeGreaterThan(-1)
    expect(branch.indexOf('!samePerson')).toBeLessThan(branch.indexOf('reviewStakeUsd'))
  })

  it('the stake rides a terminal the pipeline can actually leave', () => {
    // The old trigger set neither `failed` nor `output`, so the delegation
    // never finalized and the stake's own resolver waited on an owner action
    // that might never come. Staking on a state nothing exits is a price
    // nobody ever pays.
    const branch = src.slice(src.indexOf('// Rounds spent with a verified blocking finding'), src.indexOf('// Drain the parked backlog'))
    expect(branch).toContain('target.failed = true')
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
    const block = src.slice(at, at + 3600)
    expect(block).toContain('await db')
    expect(block).toContain('.update(delegation)')
    expect(block.indexOf('.update(delegation)')).toBeLessThan(block.indexOf('// This delegation') === -1 ? block.length : block.indexOf('// This delegation'))
  })

  it('resolution runs on FINISHED delegations too — the terminal that records a stake also finalizes the row', () => {
    // The first stake ever recorded (job #53) sat 'held' on a completed
    // delegation while the owner released the job. The tick that would have
    // burned it only ever saw 'posted' rows. Both surfaces that read the
    // chain now sweep finished rows with a held stake through the resolver.
    expect(src).toContain('export async function resolveReviewStakes(')
    const ops = readFileSync('lib/ops-cycle.ts', 'utf8')
    expect(ops).toContain('resolveReviewStakes')
    expect(ops).toContain('hasHeldReviewStake')
    expect(ops).toMatch(/status\} = 'completed' AND/)
    const handler = readFileSync('lib/mcp/handlers/delegation.ts', 'utf8')
    expect(handler).toContain('resolveReviewStakes(row, jobs)')
    expect(handler).toContain("r.status === 'completed' && hasHeldReviewStake(")
  })

  it('an owner release is a judgment of the WORK — the paid piece stops being failed and re-enters the output', () => {
    const at = src.indexOf('export async function resolveReviewStakes(')
    const fn = src.slice(at, src.indexOf('async function tickDelegationLocked('))
    expect(fn).toContain('st.failed = false')
    expect(fn).toContain('st.output = st.submittedOutput')
    expect(fn).toContain("row.status === 'completed'")
    expect(fn).toContain('finalOutput: assembleFinalOutput(row.task, subtasks)')
    // …and only on the forfeit side: a returned stake vindicated the refusal.
    expect(fn.indexOf('st.failed = false')).toBeGreaterThan(fn.indexOf("stake.status = 'returned'"))
  })

  it('the final-round brief discloses the stake — an unknown stake disciplines nobody', () => {
    expect(src).toContain('half your review bounty is burned')
    expect(src).toContain('An APPROVE that closes the review stakes nothing')
  })
})
