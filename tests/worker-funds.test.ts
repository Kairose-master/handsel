import { describe, expect, it } from 'vitest'
import { bondFor, isBondHeld, walletUnderstates, workerFunds } from '@/lib/worker-funds'

/**
 * The arithmetic of the mainnet job that read as a loss.
 *
 * Worker started with 0.5 USDC, accepted a 0.1 bounty, delivered, was graded
 * pass — and its wallet read 0.465. Working appeared to have cost it 0.035. The
 * wallet was right and the conclusion was wrong: 0.035 was a bond the contract
 * was holding, and 0.135 (bounty plus that bond) was sitting in `withdrawable`.
 *
 * Every number below is from Base mainnet job #1 rather than invented.
 */

const SCHEDULE = { flat: 0.03, bps: 500 }

describe('the bond, which looks like a fee', () => {
  it('matches the deployed schedule at the bounty that caused the confusion', () => {
    // 0.03 + 5% of 0.1. The market's fee at the same bounty is also 0.035,
    // because FLAT_FEE/FEE_BPS were deployed with identical values — which is
    // exactly why the bond was mistaken for having been taken as the fee.
    expect(bondFor(0.1, SCHEDULE)).toBe(0.035)
  })

  it('scales, so the two stop being confusable only by accident', () => {
    expect(bondFor(1, SCHEDULE)).toBe(0.08)
    expect(bondFor(5, SCHEDULE)).toBe(0.28)
  })

  it('is zero for a bounty that is not a bounty', () => {
    expect(bondFor(0, SCHEDULE)).toBe(0)
    expect(bondFor(Number.NaN, SCHEDULE)).toBe(0)
  })
})

describe('where the bond is still held', () => {
  it('counts the states where the contract has it', () => {
    for (const s of ['Accepted', 'Submitted', 'Disputed']) expect(isBondHeld(s)).toBe(true)
  })

  it('stops counting it once settlement credited it back', () => {
    // Completed means the bond is already in `withdrawable`. Counting it in both
    // places would overstate the total — the opposite error, equally wrong.
    for (const s of ['Completed', 'Refused', 'Expired', 'Cancelled', 'Open']) {
      expect(isBondHeld(s)).toBe(false)
    }
  })
})

describe('the three places, on the real job', () => {
  it('reproduces the moment the wallet looked like a loss', () => {
    // Mid-job: bond posted, nothing settled yet.
    const f = workerFunds({
      wallet: 0.465,
      claimable: 0,
      openJobs: [{ jobId: 1, bounty: 0.1, status: 'Submitted' }],
      schedule: SCHEDULE,
    })
    expect(f.bonded).toBe(0.035)
    expect(f.total).toBe(0.5)
    // Nothing has been earned yet, and nothing has been lost either. The wallet
    // alone says otherwise.
    expect(walletUnderstates(f)).toBe(true)
  })

  it('reproduces the state after grading, before withdraw', () => {
    // This is what Base mainnet actually held: wallet 0.465, withdrawable 0.135.
    const f = workerFunds({
      wallet: 0.465,
      claimable: 0.135,
      openJobs: [{ jobId: 1, bounty: 0.1, status: 'Completed' }],
      schedule: SCHEDULE,
    })
    expect(f.bonded).toBe(0)
    expect(f.claimable).toBe(0.135)
    expect(f.total).toBe(0.6)
    expect(walletUnderstates(f)).toBe(true)
  })

  it('says nothing is hidden once the money has been collected', () => {
    const f = workerFunds({ wallet: 0.6, claimable: 0, openJobs: [], schedule: SCHEDULE })
    expect(f.total).toBe(0.6)
    expect(walletUnderstates(f)).toBe(false)
  })

  it('never double-counts a completed job’s bond', () => {
    // The failure mode of a careless fix: add the bond to the display AND leave
    // it inside claimable, so a worker owed 0.135 is told it has 0.170.
    const f = workerFunds({
      wallet: 0.465,
      claimable: 0.135,
      openJobs: [{ jobId: 1, bounty: 0.1, status: 'Completed' }],
      schedule: SCHEDULE,
    })
    expect(f.total).toBe(0.6)
    expect(f.total).not.toBe(0.635)
  })

  it('traces the bond to the jobs holding it', () => {
    // A total nobody can check is a total nobody believes — which is the whole
    // problem being fixed.
    const f = workerFunds({
      wallet: 1,
      claimable: 0,
      openJobs: [
        { jobId: 7, bounty: 0.1, status: 'Accepted' },
        { jobId: 8, bounty: 1, status: 'Submitted' },
        { jobId: 9, bounty: 5, status: 'Completed' },
      ],
      schedule: SCHEDULE,
    })
    expect(f.commitments.map((c) => c.jobId)).toEqual([7, 8])
    expect(f.bonded).toBe(0.115)
  })
})
