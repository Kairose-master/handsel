import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DELEGATION_CONFIRM_LEASE_MS, DELEGATION_TICK_LEASE_MS } from '@/lib/delegation'

const src = readFileSync('lib/delegation.ts', 'utf8')
const entry = src.slice(
  src.indexOf('export const DELEGATION_CONFIRM_LEASE_MS'),
  src.indexOf('const VERIFIER_SYSTEM'),
)

// Found while chasing the §32 duplicate-escrow bug (a different delegation,
// this session): the "Research" step of a Research Desk had TWO completed,
// paid jobs on-chain for the identical spec. Unlike §32 that was not
// tickDelegation's held-back wave — this subtask has no dependsOn, so it
// posts immediately from confirmDelegationJobs (née postDelegationJobs),
// called from three independent places (the MCP tool, the server action, the
// API route), each doing its own "read status, check it's 'planned', post,
// write 'posted'" with nothing between the read and the write. Two confirms
// close together — a double click, a client retry after a slow response —
// could both read 'planned' before either wrote 'posted', and both would
// escrow every root subtask. Same shape as §32, same invariant from
// lib/ops-lease.ts: idempotence per call does not compose into idempotence
// under concurrency. postDelegationJobs itself already tolerates a
// SEQUENTIAL retry (its onchainJobId !== undefined guard) — that guard does
// nothing for two calls that both start from a fresh, pre-write read.
describe('one confirm posts a plan at a time', () => {
  it('takes a lease before posting', () => {
    expect(entry).toContain('acquireOpsLease')
    expect(entry.indexOf('acquireOpsLease')).toBeLessThan(entry.indexOf('postDelegationJobs('))
  })

  it('keys the lease per delegation, not globally', () => {
    expect(entry).toMatch(/delegation-confirm:\$\{dlgId\}/)
  })

  it('uses a different lease name than the tick advance', () => {
    // Confirm and tick are different operations on the same row; sharing a
    // lease name would make one block the other for no reason.
    expect(entry).toContain('delegation-confirm:')
    expect(entry).not.toContain('delegation-tick:')
  })

  it('re-reads the row AFTER taking the lease, not before', () => {
    // The read used to decide "is this plan for the taking" must happen
    // inside the lock — a read taken before acquiring it can already be
    // stale by the time the lock is granted.
    const lockAt = entry.indexOf('acquireOpsLease(leaseName')
    const firstSelect = entry.indexOf('db.select()')
    const secondSelect = entry.indexOf('db.select()', firstSelect + 1)
    expect(firstSelect).toBeGreaterThan(-1)
    expect(secondSelect).toBeGreaterThan(-1)
    // Exactly one of the two reads happens after the lock is taken.
    expect(secondSelect).toBeGreaterThan(lockAt)
  })

  it('re-checks status against the fresh read, not the pre-lock one', () => {
    const lockAt = entry.indexOf('acquireOpsLease(leaseName')
    const afterLock = entry.slice(lockAt)
    expect(afterLock).toMatch(/fresh\.status\s*!==\s*'planned'/)
  })

  it('releases the lease in finally', () => {
    expect(entry).toContain('finally')
    const financeAt = entry.indexOf('} finally')
    expect(entry.indexOf('releaseOpsLease', financeAt)).toBeGreaterThan(financeAt)
  })

  it('treats losing the lease as a clean refusal, not a crash', () => {
    expect(entry).toMatch(/if \(!\(await acquireOpsLease\([^)]*\)\)\) \{/)
  })

  it('preserves partial-posting recovery on a genuine failure', () => {
    // A real on-chain failure mid-loop must still leave whatever DID post
    // recorded, so a legitimate retry does not re-escrow those subtasks.
    const catchBlock = entry.slice(entry.indexOf('} catch'), entry.indexOf('} finally'))
    expect(catchBlock).toMatch(/mutableSubtasks/)
  })

  it('holds long enough to post every root subtask in one plan', () => {
    // More on-chain calls than a single tick's wave, so at least as long.
    expect(DELEGATION_CONFIRM_LEASE_MS).toBeGreaterThanOrEqual(DELEGATION_TICK_LEASE_MS)
  })
})

describe('every caller goes through the guarded entry point', () => {
  const callers = ['lib/mcp/handlers/delegation.ts', 'app/actions/delegate.ts', 'app/api/delegations/route.ts']

  it('calls confirmDelegationJobs', () => {
    for (const f of callers) {
      expect(readFileSync(f, 'utf8'), `${f} should call the guarded entry point`).toContain('confirmDelegationJobs(')
    }
  })

  it('none of them still call postDelegationJobs directly', () => {
    // A guard added to the shared function is a guard every direct caller of
    // the unguarded one would still walk around.
    for (const f of callers) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/[^.]postDelegationJobs\(/)
    }
  })
})
