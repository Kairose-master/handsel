import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('self-dealt jobs are settled by design — never "reconciled"', () => {
  // The sweep keyed "recorded" on the JOB_COMPLETED event, but a same-owner
  // job deliberately never gets one (withholding it IS the self-dealing
  // deterrent). Every office pipeline job therefore looked like lost history
  // forever: a false 'has been reconciled' feed line every cycle, and the
  // per-pass budget burned on jobs that can never be credited. The sweep
  // now resolves ownership and skips those before crediting.
  it('checks same-ownership before calling creditWorkerForJob', () => {
    const src = readFileSync('lib/credit-reconcile.ts', 'utf8')
    const ownershipAt = src.indexOf('agentByAddress(job.worker)')
    expect(ownershipAt).toBeGreaterThan(-1)
    expect(ownershipAt).toBeLessThan(src.indexOf('creditWorkerForJob(job.worker'))
    const block = src.slice(ownershipAt, ownershipAt + 400)
    expect(block).toContain('requester.userId === workerLookup.agent.userId')
    expect(block).toContain('continue')
  })
})
