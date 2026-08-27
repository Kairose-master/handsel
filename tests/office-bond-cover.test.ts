import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MAX_AUTO_BOND_COVER_USD } from '@/lib/office-bond-cover'

// Bond cover moves the owner's money without the owner asking, so what it is
// gated on matters more than what it does. These pin the gate rather than the
// mechanics — the mechanics are one call to fundAgentUsdc, which is tested
// through planUsdcFunding.
/** Comments stripped: these assertions are about what the code CALLS, and a
 *  comment explaining "assignedAgentFor, not reservedAgentFor" would
 *  otherwise fail the very check it is explaining. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const src = readFileSync('lib/office-bond-cover.ts', 'utf8')
const body = codeOnly(src.slice(src.indexOf('export async function coverBondForAssignedJob')))

describe('what bond cover is gated on', () => {
  it('gates on assignment, not on the expiring reservation', () => {
    // reservedAgentFor's TTL governs claim PRIORITY. Gating cover on it would
    // switch an office's bond payments off thirty minutes after it posted its
    // own pipeline — a worse bug than the one cover fixes. Same distinction
    // the self-deal exception already had to make.
    expect(body).toContain('assignedAgentFor')
    expect(body).not.toContain('reservedAgentFor')
  })

  it('refuses any job not assigned to this exact worker', () => {
    // Anyone can post a job. Without this line a stranger could post work
    // priced to drain the funder into bonds, and a bond on abandoned work is
    // burned rather than returned.
    expect(body).toMatch(/assignedTo !== worker\.id/)
  })

  it('never takes a userId from an argument', () => {
    // The one rule every money path in this repo shares: the caller says
    // WHICH agent, never WHOSE. fundAgentUsdc re-checks both ends against the
    // id read off the worker row.
    expect(body).toContain('fundAgentUsdc(worker.userId')
    expect(body).not.toMatch(/input\.userId|args\.user_id/)
  })

  it('caps a single top-up', () => {
    // A bond is a percentage of a bounty, so a mis-priced office job implies
    // a mis-priced bond. The cap bounds that to something an owner shrugs at.
    expect(MAX_AUTO_BOND_COVER_USD).toBeGreaterThan(0)
    expect(MAX_AUTO_BOND_COVER_USD).toBeLessThanOrEqual(5)
    expect(body).toContain('MAX_AUTO_BOND_COVER_USD')
  })

  it('tops up to the bond and no further', () => {
    // Not a round number and not a buffer: the amount is what the chain is
    // about to charge, rounded up only to the cent so it cannot land short.
    expect(body).toMatch(/Math\.ceil\(verdict\.shortUsd \* 100\) \/ 100/)
  })

  it('reports a reason instead of throwing', () => {
    // A failed top-up must not become a new way for a claim to die; the
    // accept still runs and the chain still refuses what it should.
    expect(body).not.toMatch(/\bthrow new Error\b/)
  })
})

describe('where it is called from', () => {
  const dispatch = readFileSync('lib/labor-dispatch.ts', 'utf8')
  const accept = codeOnly(dispatch.slice(dispatch.indexOf('export async function acceptAndDispatchJob')))

  it('runs after the off-chain claim, so a worker that lost the race never pays', () => {
    const claimAt = accept.indexOf('claimJobSpec')
    const coverAt = accept.indexOf('coverBondForAssignedJob')
    expect(claimAt).toBeGreaterThan(-1)
    expect(coverAt).toBeGreaterThan(claimAt)
  })

  it('runs before the accept it exists to make possible', () => {
    expect(accept.indexOf('coverBondForAssignedJob')).toBeLessThan(accept.indexOf('await acceptJob('))
  })

  it('cannot fail the accept', () => {
    const window = accept.slice(accept.indexOf('coverBondForAssignedJob') - 400, accept.indexOf('await acceptJob('))
    expect(window).toContain('catch')
  })
})

describe('the miner lets assigned work through the bond gate', () => {
  const mine = codeOnly(readFileSync('lib/auto-mine.ts', 'utf8'))

  it('does not skip a job whose bond the office is going to cover', () => {
    // Without this the two halves cancel: the gate filters the job out before
    // the accept path that would have funded it ever runs, and the desk stays
    // exactly as stuck as it was.
    expect(mine).toContain('isMineByAssignment')
    const gate = mine.slice(mine.indexOf('canPostBond: (job)'), mine.indexOf('canPostBond: (job)') + 500)
    expect(gate).toContain('isMineByAssignment(job.id)')
  })

  it('resolves assignment without the reservation TTL', () => {
    expect(mine).toContain('assignmentsByHash')
  })
})
