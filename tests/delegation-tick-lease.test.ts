import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DELEGATION_TICK_LEASE_MS } from '@/lib/delegation'
import { TRAFFIC_TICK_INTERVAL_MS } from '@/lib/ops-cycle'

const src = readFileSync('lib/delegation.ts', 'utf8')
// From the constant, so the doc comment above the function is inside the
// slice — the reasoning is half of what these assertions are checking.
const entry = src.slice(src.indexOf('export const DELEGATION_TICK_LEASE_MS'), src.indexOf('async function tickDelegationLocked'))

describe('one delegation advances at a time', () => {
  // Observed in production: two ticks overlapped, both read a held-back
  // subtask as onchainJobId === undefined, and both posted it. The same step
  // was escrowed twice and the second escrow stranded on a job nobody would
  // ever work.
  it('takes a lease before doing anything', () => {
    expect(entry).toContain('acquireOpsLease')
    expect(entry.indexOf('acquireOpsLease')).toBeLessThan(entry.indexOf('tickDelegationLocked'))
  })

  it('keys the lease per delegation, not globally', () => {
    // A global lease would serialise unrelated delegations and turn a
    // correctness fix into a throughput bug.
    expect(entry).toMatch(/delegation-tick:\$\{row\.id\}/)
  })

  it('releases it in finally, so a legitimate next tick is not blocked', () => {
    // Taken as a mutex, not as an interval. Holding it for the whole TTL after
    // the work is done blocks the very next advance.
    expect(entry).toContain('finally')
    expect(entry).toContain('releaseOpsLease')
  })

  it('treats losing the lease as a no-op, not an error', () => {
    // Another tick is already doing this work; that is success, not failure.
    expect(entry).toMatch(/if \(!\(await acquireOpsLease\([^)]*\)\)\) return/)
  })

  it('guards the operation rather than one of its callers', () => {
    // Five entry points call this — the ops cycle, the MCP handler's after(),
    // the /delegate action, the delegations API. A guard on one is a guard
    // the others walk around.
    const callers = ['lib/ops-cycle.ts', 'lib/mcp/handlers/delegation.ts', 'app/actions/delegate.ts', 'app/api/delegations/route.ts']
    for (const f of callers) {
      expect(readFileSync(f, 'utf8'), `${f} should call the guarded entry point`).toContain('tickDelegation(')
    }
    // And none of them may reach the unguarded body.
    for (const f of callers) {
      expect(readFileSync(f, 'utf8'), f).not.toContain('tickDelegationLocked')
    }
  })

  it('holds long enough for the on-chain posts a wave makes', () => {
    expect(DELEGATION_TICK_LEASE_MS).toBeGreaterThanOrEqual(60_000)
    // But not so long that a crashed tick strands the delegation past the
    // next traffic tick that would have retried it.
    expect(DELEGATION_TICK_LEASE_MS).toBeLessThanOrEqual(TRAFFIC_TICK_INTERVAL_MS)
  })
})

describe('the reasoning is written down where the next person will look', () => {
  it('names the failure it prevents', () => {
    const flat = entry.replace(/\s*\n\s*\*?\s*/g, ' ')
    expect(flat).toMatch(/escrowed twice/i)
  })

  it('cites the invariant it is an instance of', () => {
    // lib/ops-lease.ts's own header: idempotence per call does not compose
    // into idempotence under concurrency.
    const flat = entry.replace(/\s*\n\s*\*?\s*/g, ' ')
    expect(flat).toMatch(/does not compose into idempotence under concurrency/i)
  })
})
