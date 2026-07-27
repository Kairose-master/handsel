import { describe, it, expect } from 'vitest'
import { OPS_STEPS, TRAFFIC_TICK_INTERVAL_MS } from '@/lib/ops-cycle'
import { DRAIN_BATCH } from '@/lib/callback/settlement-drain'
import { RECONCILE_MAX_LOOKUPS } from '@/lib/bounty-reconcile'

// The cron and ordinary traffic run the SAME step list; these pin the
// properties that keep the two entry points honest.

describe('OPS_STEPS', () => {
  it('has unique step names — the report is keyed by them', () => {
    const names = OPS_STEPS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('marks the visitor-facing sweeps fast, and the expensive ones not', () => {
    const fast = OPS_STEPS.filter((s) => s.fast).map((s) => s.name)
    // Money that should have moved and escrow that should have been freed are
    // what a visitor can actually feel. `boardRestock` used to be asserted
    // here; it was removed with the translation dogfood it existed to post,
    // and an empty board is now a true statement rather than a gap to fill.
    expect(fast).toContain('sweep')
    expect(fast).toContain('abandonedClaims')
    expect(fast).toContain('bountyReconcile')
    // LLM-backed and fan-out work stays on the cron's guaranteed budget.
    expect(fast).not.toContain('autoVotes')
    expect(fast).not.toContain('delegations')
    expect(fast).not.toContain('faucet')
  })

  it('keeps the fast subset small enough to finish inside a request budget', () => {
    // A count is a proxy for time, and a weak one — but it still catches the
    // drift it was written for, which is "everything looks urgent, so mark it
    // all fast". Raised from 8 to 10 when settlementQueue and bountyReconcile
    // landed; both are money-owed sweeps that a visitor genuinely feels, and
    // both are batch-capped rather than open-ended (see below).
    expect(OPS_STEPS.filter((s) => s.fast).length).toBeLessThanOrEqual(10)
  })

  it('bounds the expensive fast steps by a cap they control', () => {
    // This is what the count was really proxying for. A fast step rides on
    // after() with whatever budget the request has left, so its work has to be
    // bounded by something it chooses — not by however many rows happen to
    // exist. Unbounded work early in the list starves every step after it,
    // because the cycle is sequential and a killed lambda takes the rest with
    // it.
    const fast = OPS_STEPS.filter((s) => s.fast).map((s) => s.name)
    expect(fast).toContain('settlementQueue') // DRAIN_BATCH = 2
    expect(fast).toContain('bountyReconcile') // RECONCILE_MAX_LOOKUPS = 5
    expect(DRAIN_BATCH).toBeLessThanOrEqual(5)
    expect(RECONCILE_MAX_LOOKUPS).toBeLessThanOrEqual(10)
  })

  it('ticks traffic no more than once every five minutes', () => {
    expect(TRAFFIC_TICK_INTERVAL_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })
})
