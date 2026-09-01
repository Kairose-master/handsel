import { describe, it, expect } from 'vitest'
import {
  FEE_RATE_MAX,
  FEE_RATE_MIN,
  MIN_ADVANCE_USD,
  MIN_RUNWAY_MS,
  feeRate,
  quoteAdvance,
  type AdvanceCollateral,
} from '@/lib/advance'
import { LTV_MAX, LTV_MIN, orchestrationRecord, type OrchestrationRecord } from '@/lib/orchestration-risk'

const NOW = 1_780_000_000_000

const collateral = (over: Partial<AdvanceCollateral> = {}): AdvanceCollateral => ({
  jobId: 41,
  contract: '0xmarket',
  bountyUsd: 100,
  status: 'Accepted',
  deliveryDeadlineMs: NOW + 4 * 60 * 60 * 1000,
  existingPayee: null,
  ...over,
})

const COLD: OrchestrationRecord = orchestrationRecord([])

/** A prime with enough finished delegations to be trusted at face value. */
const proven = (budgetUsd = 1000): OrchestrationRecord =>
  orchestrationRecord(
    Array.from({ length: 8 }, () => ({
      eventType: 'DELEGATION_COMPLETED',
      delivered: 3,
      total: 3,
      budgetUsd,
      createdAt: new Date(NOW),
    })),
  )

const ok = (q: ReturnType<typeof quoteAdvance>) => {
  if (!q.ok) throw new Error(`expected a quote, got refusal: ${q.reason}`)
  return q
}

describe('only an accepted job is collateral', () => {
  it('refuses every status but Accepted', () => {
    for (const status of ['Open', 'Submitted', 'Disputed', 'Completed', 'Refunded', 'Cancelled'] as const) {
      const q = quoteAdvance({ collateral: collateral({ status }), record: COLD, now: NOW })
      expect(q.ok, status).toBe(false)
      expect(q.ok === false && q.reason).toBe('not-accepted')
    }
    expect(quoteAdvance({ collateral: collateral(), record: COLD, now: NOW }).ok).toBe(true)
  })

  it('refuses a job whose delivery deadline has passed', () => {
    // The contract calls this dead, not late: submitWork reverts TooLate and
    // the only remaining transition pays the requester 100%. A lien here is
    // a claim on escrow no release path can reach.
    const q = quoteAdvance({
      collateral: collateral({ deliveryDeadlineMs: NOW - 1 }),
      record: COLD,
      now: NOW,
    })
    expect(q.ok === false && q.reason).toBe('expired')
  })

  it('refuses a lien with too little runway to be worth anything', () => {
    // assignPayee would SUCCEED here — the contract only checks the deadline
    // itself. Quoting against four remaining minutes is technically valid and
    // substantively a lie, so the refusal is ours, not the chain's.
    const q = quoteAdvance({
      collateral: collateral({ deliveryDeadlineMs: NOW + MIN_RUNWAY_MS - 1 }),
      record: COLD,
      now: NOW,
    })
    expect(q.ok === false && q.reason).toBe('too-little-runway')
    expect(quoteAdvance({ collateral: collateral({ deliveryDeadlineMs: NOW + MIN_RUNWAY_MS }), record: COLD, now: NOW }).ok).toBe(true)
  })

  it('refuses a job that already has a lender, and reads the zero address as none', () => {
    expect(
      quoteAdvance({ collateral: collateral({ existingPayee: '0x1111111111111111111111111111111111111111' }), record: COLD, now: NOW }),
    ).toMatchObject({ ok: false, reason: 'already-pledged' })
    // The chain reports "unassigned" as the zero address, not as null. Reading
    // that as a real payee would refuse every eligible job on the market.
    expect(quoteAdvance({ collateral: collateral({ existingPayee: `0x${'0'.repeat(40)}` }), record: COLD, now: NOW }).ok).toBe(true)
  })

  it('refuses a job with no bounty in escrow', () => {
    expect(quoteAdvance({ collateral: collateral({ bountyUsd: 0 }), record: COLD, now: NOW })).toMatchObject({
      ok: false,
      reason: 'no-collateral',
    })
  })
})

describe('the pledge fits inside the bounty', () => {
  it('never assigns more than the escrow holds — the chain would revert BadPayeeAmount', () => {
    // The failure this pins: quoting the LTV limit and then adding a fee on
    // top. At 0.9 LTV of a $100 bounty that is $90 + fee = $91.80, which fits;
    // the trap is a record that earns the ceiling on a bounty where it does
    // not. Every combination has to land inside the escrow.
    for (const bountyUsd of [1, 2, 5, 10, 33.33, 100, 999.99]) {
      for (const record of [COLD, proven(bountyUsd * 10), proven(1)]) {
        const q = quoteAdvance({ collateral: collateral({ bountyUsd }), record, now: NOW })
        if (!q.ok) continue
        expect(q.pledgeUsd, `bounty ${bountyUsd}`).toBeLessThanOrEqual(bountyUsd)
        expect(q.advanceUsd + q.feeUsd).toBeCloseTo(q.pledgeUsd, 6)
        expect(q.residualUsd).toBeCloseTo(bountyUsd - q.pledgeUsd, 6)
      }
    }
  })

  it('leaves headroom by construction — the LTV ceiling and the fee floor must multiply under 1', () => {
    // The two constants live in different files and know nothing about each
    // other. `advanceLimit` can hand back LTV_MAX of the bounty, and the fee
    // is charged ON TOP of that, so `LTV_MAX * (1 + feeRate(LTV_MAX))` is the
    // worst pledge the system can construct. Cross 1.0 and every maximum
    // advance becomes a BadPayeeAmount revert in front of a borrower who was
    // already told yes. Today it is 0.918; this is the alarm on that number.
    expect(LTV_MAX * (1 + feeRate(LTV_MAX))).toBeLessThanOrEqual(1)
    const q = ok(quoteAdvance({ collateral: collateral({ bountyUsd: 100 }), record: proven(1000), now: NOW }))
    expect(q.advanceUsd).toBe(100 * LTV_MAX)
    expect(q.pledgeUsd).toBeLessThan(100)
  })

  it('rounds the fee against the borrower, never against the lender', () => {
    // A fee rounded down is a lender that earns a cent less than it priced,
    // every time, forever. Ceil is the only direction that is safe to repeat.
    const q = ok(quoteAdvance({ collateral: collateral({ bountyUsd: 77.77 }), record: COLD, now: NOW }))
    expect(q.feeUsd).toBeGreaterThanOrEqual(q.advanceUsd * q.feeRate)
  })
})

describe('the fee prices the risk the LTV could not remove', () => {
  it('costs a cold-start prime more per dollar than a proven one', () => {
    const cold = ok(quoteAdvance({ collateral: collateral(), record: COLD, now: NOW }))
    const warm = ok(quoteAdvance({ collateral: collateral(), record: proven(), now: NOW }))
    expect(cold.feeRate).toBeGreaterThan(warm.feeRate)
    expect(cold.ltv).toBeLessThan(warm.ltv)
  })

  it('stays inside the published band whatever the LTV', () => {
    for (const ltv of [-1, 0, LTV_MIN, 0.5, 0.7, LTV_MAX, 1, 99]) {
      expect(feeRate(ltv)).toBeGreaterThanOrEqual(FEE_RATE_MIN)
      expect(feeRate(ltv)).toBeLessThanOrEqual(FEE_RATE_MAX)
    }
  })
})

describe('a request is quoted down, not rejected', () => {
  it('gives the maximum when nothing is asked for', () => {
    const max = ok(quoteAdvance({ collateral: collateral(), record: COLD, now: NOW }))
    const asked = ok(quoteAdvance({ collateral: collateral(), record: COLD, requestedUsd: 10_000, now: NOW }))
    expect(asked.advanceUsd).toBe(max.advanceUsd)
  })

  it('honours a smaller request exactly', () => {
    const q = ok(quoteAdvance({ collateral: collateral(), record: COLD, requestedUsd: 12.5, now: NOW }))
    expect(q.advanceUsd).toBe(12.5)
  })

  it('refuses rather than quoting a dust advance', () => {
    expect(quoteAdvance({ collateral: collateral(), record: COLD, requestedUsd: 0.4, now: NOW })).toMatchObject({
      ok: false,
      reason: 'below-minimum',
    })
    expect(quoteAdvance({ collateral: collateral({ bountyUsd: 1.5 }), record: COLD, now: NOW })).toMatchObject({
      ok: false,
      reason: 'below-minimum',
    })
  })

  it('never returns a quote under the minimum it claims to enforce', () => {
    for (const bountyUsd of [1, 1.5, 2, 2.2, 3, 4.4]) {
      const q = quoteAdvance({ collateral: collateral({ bountyUsd }), record: COLD, now: NOW })
      if (q.ok) expect(q.advanceUsd, `bounty ${bountyUsd}`).toBeGreaterThanOrEqual(MIN_ADVANCE_USD)
    }
  })
})
