import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Self-dealing is defended at the CREDIT end, not the claim end.
 *
 * An office is same-owner by construction — the roles are hired onto your
 * account and your own prime pays them — so a claim-side ban made all six
 * office templates unable to complete a single job. What is actually worth
 * preventing is the free JOB_COMPLETED event at the end: money loops A1→A2
 * inside one owner's control and A2 banks reputation for it. Withhold the
 * event and the loop is pure fee expense.
 *
 * Read from source: exercising these paths means real chain calls and a
 * database, and the property worth pinning is that neither half of the pair
 * quietly goes away. Same approach as tests/mcp-dispatch.
 */
const dispatch = readFileSync('lib/labor-dispatch.ts', 'utf8')
const labor = readFileSync('app/actions/labor.ts', 'utf8')

describe('the claim-side exception stays narrow', () => {
  it('still refuses a same-owner claim by default', () => {
    expect(dispatch).toContain("you can't grade and pay yourself")
  })

  it('lets through only a job assigned to THIS worker', () => {
    // Not "any reservation" and not "any same-owner agent" — the assignment
    // must name the claiming worker.
    expect(dispatch).toMatch(/assignedAgentFor\(specHash\)\)\s*===\s*worker\.id/)
  })

  it('reads the assignment, not the TTL-gated claim priority', () => {
    // reservedAgentFor expires after 30 minutes so an abandoned job falls back
    // to the market, and it is the RIGHT call in claimJobSpec and the accept
    // paths — which is why this is scoped to assertNotSelfDeal rather than the
    // file. Whether a job is its office's own work does not expire, and using
    // the expiring view there locked the desk out of its own escrow.
    const body = dispatch.slice(
      dispatch.indexOf('export async function assertNotSelfDeal'),
      dispatch.indexOf('export async function dispatchAcceptedJob'),
    )
    expect(body).toContain('assignedAgentFor')
    expect(body).not.toMatch(/await reservedAgentFor\(/)
  })

  it('keeps the self-CLAIM check absolute — the contract reverts on it', () => {
    // assertNotSelfClaim runs before any exception can apply.
    const body = dispatch.slice(dispatch.indexOf('export async function assertNotSelfDeal'))
    const claimAt = body.indexOf('assertNotSelfClaim(worker, requesterAddress)')
    const exceptionAt = body.indexOf('reservedAgentFor')
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(exceptionAt).toBeGreaterThan(claimAt)
  })

  it('passes the spec hash from both accept paths, or the exception can never fire', () => {
    const calls = [...dispatch.matchAll(/assertNotSelfDeal\(worker, [^)]*\)/g)].map((m) => m[0])
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const call of calls) expect(call, call).toContain('specHash')
  })
})

describe('the credit end closes what the claim end opened', () => {
  it('withholds the credit event when requester and worker share an owner', () => {
    expect(labor).toMatch(/requesterRow\.userId === workerAgent\.userId/)
  })

  it('checks ownership BEFORE writing the JOB_COMPLETED event', () => {
    const guardAt = labor.indexOf('requesterRow.userId === workerAgent.userId')
    const insertAt = labor.indexOf("eventType: 'JOB_COMPLETED'", guardAt)
    expect(guardAt).toBeGreaterThan(0)
    expect(insertAt).toBeGreaterThan(guardAt)
  })

  it('reads the requester owner it compares against', () => {
    // Without userId on that select the comparison is undefined === string,
    // which is silently false — i.e. the defence quietly off.
    const sel = labor.slice(labor.indexOf('const [requesterRow]'), labor.indexOf('Same owner on both sides'))
    expect(sel).toContain('userId: agent.userId')
  })
})
