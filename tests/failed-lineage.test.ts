import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { failedLineageVerdict, failedLineageMessage } from '@/lib/failed-lineage'

describe('who a repost is closed to', () => {
  it('still blocks the agent that actually failed', () => {
    expect(
      failedLineageVerdict({ workerAgentId: 'a1', workerController: 'u1', failedWorkerIds: ['a1'] }),
    ).toEqual({ blocked: true, reason: 'same-agent' })
  })

  it('blocks a fresh agent on the same account', () => {
    // The hole this closes. failedWorkerIds holds agent ids; a new agent gets
    // a new one, so create_worker_agent — or hire_office with freshAgents —
    // lifted the disqualification in a single call.
    expect(
      failedLineageVerdict({
        workerAgentId: 'a2',
        workerController: 'u1',
        failedWorkerIds: ['a1'],
        failedControllers: ['u1'],
      }),
    ).toEqual({ blocked: true, reason: 'same-controller' })
  })

  it('lets a different account take the reposted work', () => {
    // A different owner claiming a repost is the market functioning. This
    // must never become "one failure closes the board to an account".
    expect(
      failedLineageVerdict({
        workerAgentId: 'b1',
        workerController: 'u2',
        failedWorkerIds: ['a1'],
        failedControllers: ['u1'],
      }),
    ).toEqual({ blocked: false })
  })

  it('blocks nobody when the failed controllers could not be resolved', () => {
    // A deleted agent is not a cleared one, but an unresolved lookup must not
    // be a way for a database hiccup to close the board either.
    expect(
      failedLineageVerdict({
        workerAgentId: 'a2',
        workerController: 'u1',
        failedWorkerIds: ['a1'],
        failedControllers: [null],
      }),
    ).toEqual({ blocked: false })
  })

  it('blocks nobody when the worker has no controller', () => {
    expect(
      failedLineageVerdict({
        workerAgentId: 'a2',
        workerController: null,
        failedWorkerIds: ['a1'],
        failedControllers: ['u1'],
      }),
    ).toEqual({ blocked: false })
  })

  it('is a no-op on a job nothing has failed', () => {
    expect(failedLineageVerdict({ workerAgentId: 'a1', workerController: 'u1', failedWorkerIds: null })).toEqual({
      blocked: false,
    })
    expect(failedLineageVerdict({ workerAgentId: 'a1', workerController: 'u1', failedWorkerIds: [] })).toEqual({
      blocked: false,
    })
  })
})

describe('the two refusals say different things', () => {
  it('tells a fresh agent that a new identity does not clear the account', () => {
    // Told the agent-level message, an owner's rational next move is to mint
    // another agent — the exact behaviour being refused.
    const msg = failedLineageMessage('same-controller')
    expect(msg).toMatch(/account/i)
    expect(msg).not.toEqual(failedLineageMessage('same-agent'))
  })
})

describe('both accept paths are gated', () => {
  const src = readFileSync('lib/labor-dispatch.ts', 'utf8')

  it('no longer compares only agent ids', () => {
    expect(src).not.toContain('failedWorkerIds?.includes(worker.id)')
  })

  it('routes both accepts through the same check', () => {
    // Two accept paths existed and each had its own copy of the id
    // comparison; one gate that both call is what stops them drifting.
    const calls = [...src.matchAll(/assertNotFailedLineage\(/g)]
    expect(calls.length).toBeGreaterThanOrEqual(3) // definition + both call sites
  })

  it('runs the lineage check before gas is spent on an accept', () => {
    const accept = src.slice(src.indexOf('export async function acceptAndDispatchJob'))
    expect(accept.indexOf('assertNotFailedLineage')).toBeLessThan(accept.indexOf('await acceptJob('))
  })
})
