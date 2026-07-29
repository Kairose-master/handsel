import { describe, expect, it } from 'vitest'
import { ESCROW_HOLDING, summariseJobs, TERMINAL } from '@/lib/market-health'
import { V2_JOB_STATUS } from '@/lib/deadlines'

/**
 * The public numbers.
 *
 * `Disputed` was in the wrong place on BOTH lines, in opposite directions —
 * the same misconception counted twice. Missing from escrow, where a disputed
 * bounty is sitting in the contract exactly like an accepted one. Present in
 * terminal, where it is the least terminal state there is, being the one that
 * is waiting on a decision.
 *
 * And `Expired` was in neither, so on a V2 market every deadline settlement —
 * the outcome the dispute design makes the DEFAULT — would have vanished from
 * the published settlement rate entirely.
 */

const j = (status: string, bounty = 10) => ({ status, bounty })

describe('escrowed money', () => {
  it('counts a disputed bounty — it has not paid anyone', () => {
    expect(summariseJobs([j('Disputed', 25)]).escrowedUsd).toBe(25)
  })

  it('counts every state that still holds money and no others', () => {
    const held = summariseJobs(ESCROW_HOLDING.map((s) => j(s, 10))).escrowedUsd
    expect(held).toBe(ESCROW_HOLDING.length * 10)
    expect(summariseJobs(TERMINAL.map((s) => j(s, 10))).escrowedUsd).toBe(0)
  })

  it('does not silently drop a state the contract can produce', () => {
    // Every status in the V2 enum must be classified as one or the other.
    // An unclassified state is money that exists and appears nowhere — which
    // is exactly what Expired was.
    const classified = new Set<string>([...ESCROW_HOLDING, ...TERMINAL])
    expect(V2_JOB_STATUS.filter((s) => !classified.has(s))).toEqual([])
  })
})

describe('settlement rate', () => {
  it('does not count a disputed job as settled', () => {
    // It used to sit in the denominator, so an unresolved dispute depressed the
    // rate as though it had already failed to settle.
    const withDispute = summariseJobs([j('Completed'), j('Disputed')])
    expect(withDispute.settlementRate).toBe(100)
  })

  it('counts an expired job in the denominator', () => {
    // On V2 this is the DEFAULT outcome. Leaving it out would have published a
    // rate computed from the minority of jobs someone happened to act on.
    expect(summariseJobs([j('Completed'), j('Expired')]).settlementRate).toBe(50)
  })

  it('never counts an expired job as a completion', () => {
    // "Settled by a deadline, no verdict exists." Calling that a completion
    // flatters the number, and the contract says the credit engine must not
    // read it as a verdict either way.
    expect(summariseJobs([j('Expired'), j('Expired')]).settlementRate).toBe(0)
  })

  it('is null rather than zero when nothing has terminated', () => {
    // No fake data: 0% and "no data yet" are different claims about a market.
    expect(summariseJobs([j('Open'), j('Accepted')]).settlementRate).toBeNull()
    expect(summariseJobs([]).settlementRate).toBeNull()
  })
})

describe('the counts themselves', () => {
  it('reports every status it saw, classified or not', () => {
    const out = summariseJobs([j('Open'), j('Open'), j('Disputed')])
    expect(out.byStatus).toEqual({ Open: 2, Disputed: 1 })
    expect(out.total).toBe(3)
  })
})
