import { describe, it, expect } from 'vitest'
import { OPS_STEPS, TRAFFIC_TICK_INTERVAL_MS, FULL_CYCLE_LEASE_MS } from '@/lib/ops-cycle'
import { readFileSync } from 'node:fs'
import { DRAIN_BATCH } from '@/lib/callback/settlement-drain'
import { RECONCILE_MAX_LOOKUPS } from '@/lib/bounty-reconcile'
import { MAX_EXITS_PER_PASS } from '@/lib/deadlines'
import { MAX_RULINGS_PER_PASS } from '@/lib/dispute-gate'
import { MAX_WITHDRAWALS_PER_PASS } from '@/lib/withdraw-sweep'

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
    // landed, then 11 for `deadlines` and 12 for `disputeGate`. Every raise
    // has carried the same
    // justification, and it is CHECKED below rather than asserted here: the
    // step frees escrow a visitor can feel, and it is capped by a constant it
    // owns.
    expect(OPS_STEPS.filter((s) => s.fast).length).toBeLessThanOrEqual(12)
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
    expect(fast).toContain('deadlines') // MAX_EXITS_PER_PASS = 3
    expect(fast).toContain('disputeGate') // MAX_RULINGS_PER_PASS = 3
    expect(fast).toContain('withdrawals') // MAX_WITHDRAWALS_PER_PASS = 2
    expect(DRAIN_BATCH).toBeLessThanOrEqual(5)
    expect(RECONCILE_MAX_LOOKUPS).toBeLessThanOrEqual(10)
    // Each exit is a sponsored UserOp costing the operator real gas, so this
    // cap is tighter than the others by a category, not by a preference.
    expect(MAX_EXITS_PER_PASS).toBeLessThanOrEqual(3)
    expect(MAX_RULINGS_PER_PASS).toBeLessThanOrEqual(3)
    // Tighter still. A withdrawal is the least urgent call this system makes —
    // the money is safe where it is — so it must never crowd out the exits,
    // which free money that is NOT safe where it is.
    expect(MAX_WITHDRAWALS_PER_PASS).toBeLessThan(MAX_EXITS_PER_PASS)
  })

  it('ticks traffic no more than once every five minutes', () => {
    expect(TRAFFIC_TICK_INTERVAL_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })
})

describe('the scheduled full cycle', () => {
  // Traffic only ever runs the fast subset, so the steps that actually drive
  // an open plan forward — `fleetTick` (mining) and `delegations` (waves,
  // review, synthesis) — reach production ONLY through the cron. A cron slow
  // enough to be decorative leaves those two dark, which looks exactly like a
  // market where nobody claims anything. That failure is a schedule, not a
  // bug, so the schedule is pinned here.
  const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as Array<{
    path: string
    schedule: string
  }>

  it('schedules the settlement heartbeat at least every 15 minutes', () => {
    const settle = crons.find((c) => c.path === '/api/cron/settle')
    expect(settle).toBeDefined()
    const [minute, hour] = settle!.schedule.split(' ')
    // `*/N * * * *` is the only shape that runs intraday; anything with a
    // fixed hour is at best hourly and cannot carry the fleet.
    expect(hour).toBe('*')
    const everyN = /^\*\/(\d+)$/.exec(minute)
    expect(everyN, `expected */N minutes, got ${settle!.schedule}`).not.toBeNull()
    expect(Number(everyN![1])).toBeLessThanOrEqual(15)
  })

  it('holds a lease at least as long as the gap between fires', () => {
    // The lease is what makes a frequent cron safe: the next fire is a no-op
    // while this one still works. Shorter than the interval and it buys
    // nothing; the two numbers have to move together.
    const settle = crons.find((c) => c.path === '/api/cron/settle')!
    const everyMinutes = Number(/^\*\/(\d+)$/.exec(settle.schedule.split(' ')[0])![1])
    expect(FULL_CYCLE_LEASE_MS).toBeGreaterThanOrEqual(everyMinutes * 60_000)
  })
})
