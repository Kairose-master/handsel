import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BASE_BACKOFF_MS,
  LOCK_TIMEOUT_MS,
  MAX_BACKOFF_MS,
  MAX_SETTLEMENT_ATTEMPTS,
  backoffMs,
  describeSettlement,
  hasGivenUp,
  nextRunAfter,
} from '@/lib/callback/settlement-queue'

/**
 * The retry schedule, and the two invariants that make the queue safe.
 *
 * The DB half is not exercised here — it needs a real Postgres. What IS
 * testable is the arithmetic that decides when a settlement is retried and
 * when it stops being retried, which is the part that gets tuned later by
 * someone who no longer remembers why the numbers were chosen.
 */

describe('backoff', () => {
  it('does not wait before the first attempt', () => {
    expect(backoffMs(0)).toBe(0)
  })

  it('doubles', () => {
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS)
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 2)
    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 4)
  })

  it('caps, so the tail of the schedule stays inside a working session', () => {
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS)
  })

  it('never schedules a retry in the past', () => {
    const now = new Date('2026-07-27T00:00:00Z')
    for (let a = 0; a <= MAX_SETTLEMENT_ATTEMPTS; a++) {
      expect(nextRunAfter(a, now).getTime()).toBeGreaterThanOrEqual(now.getTime())
    }
  })
})

describe('giving up', () => {
  it('keeps going while attempts remain', () => {
    expect(hasGivenUp(MAX_SETTLEMENT_ATTEMPTS - 1)).toBe(false)
  })

  it('stops at the limit rather than retrying forever', () => {
    // A machine retrying a permanent failure forever is how a stuck payment
    // stays invisible. `abandoned` exists to be looked at.
    expect(hasGivenUp(MAX_SETTLEMENT_ATTEMPTS)).toBe(true)
    expect(hasGivenUp(MAX_SETTLEMENT_ATTEMPTS + 1)).toBe(true)
  })

  it('spans long enough to outlive a transient outage', () => {
    // A bundler backlog or a rate-limited grader lasts minutes, not seconds.
    // If the whole schedule fits inside one, the retries buy nothing.
    let total = 0
    for (let a = 1; a < MAX_SETTLEMENT_ATTEMPTS; a++) total += backoffMs(a)
    expect(total).toBeGreaterThan(30 * 60_000)
  })
})

describe('the lock outlives the work it protects', () => {
  it('holds longer than a settlement can legitimately run', () => {
    // maxDuration on the callback route is the longest one settlement may
    // take. A lock that expires sooner lets a second drain start the same
    // task while the first is still going — worse than no lock at all.
    const route = readFileSync('app/api/runtime/callback/route.ts', 'utf8')
    const declared = route.match(/maxDuration\s*=\s*(\d+)/)
    expect(declared).not.toBeNull()
    expect(LOCK_TIMEOUT_MS).toBeGreaterThan(Number(declared![1]) * 1000)
  })
})

describe('describeSettlement', () => {
  it('says how far along a retry is', () => {
    const line = describeSettlement({ taskId: 't1', attempts: 3, lastError: null, status: 'pending' })
    expect(line).toContain('t1')
    expect(line).toContain(`3/${MAX_SETTLEMENT_ATTEMPTS}`)
  })

  it('carries the reason, because an unexplained stuck payment reads as a bug', () => {
    const line = describeSettlement({
      taskId: 't2',
      attempts: 8,
      lastError: 'bundler rejected: AA25 invalid nonce',
      status: 'abandoned',
    })
    expect(line).toContain('abandoned')
    expect(line).toContain('AA25 invalid nonce')
  })

  it('truncates a long error rather than pasting a stack trace into a report', () => {
    const line = describeSettlement({
      taskId: 't3',
      attempts: 1,
      lastError: 'x'.repeat(5000),
      status: 'pending',
    })
    expect(line.length).toBeLessThan(300)
  })
})

describe('the callback no longer blames the worker for our outage', () => {
  const route = readFileSync('app/api/runtime/callback/route.ts', 'utf8')

  it('records the settlement intent before attempting it', () => {
    // Written first, on purpose: an intent recorded after the attempt does
    // not exist for the attempt that died.
    expect(route.indexOf('enqueueSettlement')).toBeLessThan(route.indexOf('settleTask'))
  })

  it('answers 200 when only the settlement failed', () => {
    // The deliverable is stored and the task is `completed` by then. Failing
    // the worker's request would tell it to redo work it already delivered.
    const deferred = route.slice(route.indexOf('await deferSettlement'))
    expect(deferred).toContain("settlement: 'queued'")
    expect(deferred).not.toContain('status: 500')
  })
})
