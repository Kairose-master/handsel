/**
 * Which of a paid commission's subtasks a customer's poll may start.
 *
 * `fleetTick` — the ops step that turns an accepted job into a running one
 * — is cron-only, and `/api/cron/settle`'s own header says it plainly: "the
 * two steps that move an open plan forward … are not in it. They run here
 * or nowhere." `commissionStatus` already ticks the delegation on every
 * poll, so waves and settlement advanced; dispatch did not. On a deployment
 * whose heartbeat is slow or absent, an outside customer therefore pays,
 * the pipeline escrows, a worker accepts — and the order sits at "Accepted"
 * with no error anywhere. Observed live on the rehearsal deployment.
 *
 * The selection rule is the part worth testing without a chain or a DB, so
 * it is pure. Everything it must refuse is a way of starting work twice, or
 * of starting work that isn't this customer's.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

import { MAX_DISPATCH_PER_POLL, undispatchedAcceptedJobs } from '@/lib/commission-dispatch'
import type { DelegationSubtask } from '@/lib/delegation'

const st = (over: Partial<DelegationSubtask>): DelegationSubtask => ({
  title: 't',
  description: 'd',
  acceptanceCriteria: 'a',
  bountyUsd: 1,
  ...over,
})

describe('undispatchedAcceptedJobs', () => {
  it('selects an accepted job that has a spec and a real worker', () => {
    const out = undispatchedAcceptedJobs(
      [st({ specHash: '0xspec', onchainJobId: 7 })],
      [{ id: 7, status: 'Accepted', worker: '0xabc0000000000000000000000000000000000001' }],
    )
    expect(out).toEqual([{ jobId: 7, specHash: '0xspec', worker: '0xabc0000000000000000000000000000000000001' }])
  })

  it('ignores a job that is not Accepted', () => {
    for (const status of ['Open', 'Submitted', 'Completed', 'Disputed']) {
      expect(
        undispatchedAcceptedJobs(
          [st({ specHash: '0xspec', onchainJobId: 7 })],
          [{ id: 7, status, worker: '0xabc0000000000000000000000000000000000001' }],
        ),
      ).toEqual([])
    }
  })

  it('ignores the zero address — an Open job reports it and it is not a worker', () => {
    expect(
      undispatchedAcceptedJobs(
        [st({ specHash: '0xspec', onchainJobId: 7 })],
        [{ id: 7, status: 'Accepted', worker: '0x0000000000000000000000000000000000000000' }],
      ),
    ).toEqual([])
  })

  it('ignores a subtask already marked failed', () => {
    expect(
      undispatchedAcceptedJobs(
        [st({ specHash: '0xspec', onchainJobId: 7, failed: true })],
        [{ id: 7, status: 'Accepted', worker: '0xabc0000000000000000000000000000000000001' }],
      ),
    ).toEqual([])
  })

  it('ignores subtasks with no job or no spec — nothing to dispatch against', () => {
    expect(undispatchedAcceptedJobs([st({ onchainJobId: 7 })], [{ id: 7, status: 'Accepted', worker: '0xabc1' }])).toEqual([])
    expect(undispatchedAcceptedJobs([st({ specHash: '0xspec' })], [{ id: 7, status: 'Accepted', worker: '0xabc1' }])).toEqual([])
  })

  it('never returns a job outside this delegation, however many are on-chain', () => {
    const out = undispatchedAcceptedJobs(
      [st({ specHash: '0xmine', onchainJobId: 2 })],
      [
        { id: 1, status: 'Accepted', worker: '0xabc0000000000000000000000000000000000001' },
        { id: 2, status: 'Accepted', worker: '0xabc0000000000000000000000000000000000002' },
        { id: 3, status: 'Accepted', worker: '0xabc0000000000000000000000000000000000003' },
      ],
    )
    expect(out.map((o) => o.jobId)).toEqual([2])
  })

  it('caps how much one poll can start', () => {
    expect(MAX_DISPATCH_PER_POLL).toBeGreaterThan(0)
    expect(MAX_DISPATCH_PER_POLL).toBeLessThanOrEqual(5)
  })
})

describe('the worker lookup compares addresses the way addresses are defined', () => {
  // An EVM address is case-insensitive: the chain hands back whatever casing
  // it uses (often EIP-55) and the column holds whatever provisioning wrote.
  // An exact match finds nothing, and this function's failure mode when it
  // finds nothing is silence — indistinguishable from "no work to do". The
  // first version of this file had exactly that bug. Invariant 18.
  const src = readFileSync('lib/commission-dispatch.ts', 'utf8')

  it('never matches smartAccountAddress case-sensitively', () => {
    expect(src).not.toMatch(/eq\(agent\.smartAccountAddress/)
  })

  it('lowercases both sides of the comparison', () => {
    expect(src).toContain('lower(')
    expect(src).toContain('.toLowerCase()')
  })
})
