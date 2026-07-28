import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dueDeadlines,
  MAX_EXITS_PER_PASS,
  V2_JOB_STATUS,
  type DeadlineJob,
  type V2JobStatus,
} from '@/lib/deadlines'

/**
 * The table that decides which permissionless exit to call, and when.
 *
 * Getting a row of it wrong is not a missed sweep — it is calling `reclaimJob`
 * on a job that is owed to a worker. Every case here is an off-by-one against a
 * timestamp, which is why the decision was made a pure function taking the clock
 * as an argument rather than reading it.
 */

const T = 1_800_000_000

const job = (o: Partial<DeadlineJob> & { status: V2JobStatus }): DeadlineJob => ({
  id: 1,
  openDeadline: 0,
  deliveryDeadline: 0,
  reviewDeadline: 0,
  disputeDeadline: 0,
  ...o,
})

describe('the status list matches the contract', () => {
  it('has exactly the enum in LaborMarketV2.sol, in order', () => {
    // The guard the V1 decoder needed and did not have. Its list had seven
    // entries and a `?? 'Open'` fall-through, so index 7 — `Expired`, the state
    // EVERY timeout settles to — decoded as an open job on the board.
    //
    // Parsed from the Solidity source rather than the ABI because an ABI erases
    // enums to uint8: `status` is just a number there, and a number cannot tell
    // you a state was appended. Appending to the contract without appending here
    // now fails the build.
    const src = readFileSync('contracts/src/LaborMarketV2.sol', 'utf8')
    const body = /enum Status \{([\s\S]*?)\}/.exec(src)?.[1]
    expect(body, 'could not find `enum Status` in the contract').toBeTruthy()

    const members = body!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').replace(/\/\/\/.*$/, '').trim())
      .filter((line) => /^[A-Z][A-Za-z]*,?$/.test(line))
      .map((line) => line.replace(/,$/, ''))

    expect(members).toEqual([...V2_JOB_STATUS])
  })
})

describe('each money-holding state has exactly one exit', () => {
  const cases: Array<[V2JobStatus, keyof DeadlineJob, string]> = [
    ['Open', 'openDeadline', 'expireOpen'],
    ['Accepted', 'deliveryDeadline', 'reclaimJob'],
    ['Submitted', 'reviewDeadline', 'expireReview'],
    ['Disputed', 'disputeDeadline', 'expireDispute'],
  ]

  it.each(cases)('%s past its %s calls %s', (status, deadline, fn) => {
    const due = dueDeadlines([job({ status, [deadline]: T })], T)
    expect(due).toEqual([{ jobId: 1, fn, dueAt: T }])
  })

  it.each(cases)('%s is driven by its OWN deadline and no other', (status, deadline) => {
    // Every other deadline set and long past; the governing one unset. If the
    // table keyed on the wrong field this would settle a job that is not due.
    const others = (['openDeadline', 'deliveryDeadline', 'reviewDeadline', 'disputeDeadline'] as const).filter(
      (d) => d !== deadline,
    )
    const j = job({ status })
    for (const o of others) j[o] = T - 999_999
    expect(dueDeadlines([j], T)).toEqual([])
  })
})

describe('the boundary is the contract"s boundary', () => {
  it('does not fire one second early', () => {
    expect(dueDeadlines([job({ status: 'Submitted', reviewDeadline: T })], T - 1)).toEqual([])
  })

  it('fires exactly AT the deadline, because the contract guards with >=', () => {
    // A sweep that waited for `now > deadline` would disagree by one second
    // with the function it is calling — the call already succeeds on-chain.
    expect(dueDeadlines([job({ status: 'Submitted', reviewDeadline: T })], T)).toHaveLength(1)
  })

  it('never treats an unset deadline as 1970', () => {
    // Defensive against a bad decode rather than against the contract: within
    // the right status the deadline is always written. But these states are read
    // off-chain, and a decode that went wrong must not be able to produce a
    // settlement call.
    expect(dueDeadlines([job({ status: 'Accepted', deliveryDeadline: 0 })], T)).toEqual([])
    expect(dueDeadlines([job({ status: 'Open', openDeadline: -1 })], T)).toEqual([])
  })
})

describe('terminal states are left alone', () => {
  it.each(['Completed', 'Cancelled', 'Refunded', 'Expired'] as const)('%s produces no call', (status) => {
    const j = job({ status })
    for (const d of ['openDeadline', 'deliveryDeadline', 'reviewDeadline', 'disputeDeadline'] as const) {
      j[d] = T - 999_999
    }
    expect(dueDeadlines([j], T)).toEqual([])
  })

  it('covers every status in the enum — no state is unaccounted for', () => {
    // Either a status is money-holding and gets exactly one exit, or it is
    // terminal and gets none. A new state that is neither would slip through
    // both suites above without this.
    const handled = V2_JOB_STATUS.map((status) => {
      const j = job({ status })
      for (const d of ['openDeadline', 'deliveryDeadline', 'reviewDeadline', 'disputeDeadline'] as const) {
        j[d] = T - 1
      }
      return dueDeadlines([j], T).length
    })
    expect(handled).toEqual([1, 1, 1, 0, 0, 1, 0, 0])
  })
})

describe('ordering', () => {
  it('is oldest first, so a capped pass cannot starve the longest wait', () => {
    const jobs: DeadlineJob[] = [
      job({ id: 3, status: 'Submitted', reviewDeadline: T - 10 }),
      job({ id: 1, status: 'Open', openDeadline: T - 5000 }),
      job({ id: 2, status: 'Disputed', disputeDeadline: T - 900 }),
    ]
    expect(dueDeadlines(jobs, T).map((d) => d.jobId)).toEqual([1, 2, 3])
  })

  it('breaks ties by job id, so a pass is deterministic', () => {
    const jobs: DeadlineJob[] = [
      job({ id: 9, status: 'Open', openDeadline: T }),
      job({ id: 4, status: 'Open', openDeadline: T }),
    ]
    expect(dueDeadlines(jobs, T).map((d) => d.jobId)).toEqual([4, 9])
  })

  it('leaves the caller to apply the cap, and the cap is small', () => {
    // Each exit is a sponsored UserOp costing the operator real gas, and these
    // ride the ops cycle on visitor traffic. A sweep bounded by "how many jobs
    // exist" has its cost set by whoever posts the jobs.
    expect(MAX_EXITS_PER_PASS).toBeLessThanOrEqual(3)
    const many = Array.from({ length: 50 }, (_, i) => job({ id: i + 1, status: 'Open', openDeadline: T - i }))
    expect(dueDeadlines(many, T)).toHaveLength(50)
  })
})
