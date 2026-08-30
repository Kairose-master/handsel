/**
 * A local job has to be creatable, not merely enforceable.
 *
 * lib/job-lane.ts, the scheduler's eligibility filter and claimJobSpec's gate
 * all shipped reading a lane — and nothing anywhere called setJobLane. Every
 * job was therefore `any`, the split did nothing, and the whole mechanism was
 * the same defect it exists inside a codebase that keeps finding: a
 * capability with no way to invoke it.
 *
 * This pins the invoking half. The enforcing half is covered by
 * tests/job-lane.test.ts.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const action = readFileSync('app/actions/labor.ts', 'utf8')
const form = readFileSync('app/(dashboard)/jobs/page.tsx', 'utf8')

describe('posting can put a job in a lane', () => {
  it('the action accepts a lane', () => {
    expect(action).toMatch(/lane\?:\s*'local'\s*\|\s*'handsel'/)
  })

  it('the action actually records it', () => {
    expect(action).toContain('setJobLane')
  })

  it('records the lane BEFORE the job is posted on-chain', () => {
    // A job that is open for even a moment with no lane is a job a platform
    // agent can take out from under the local worker it was posted for.
    const laneAt = action.indexOf('setJobLane(specHash')
    const postAt = action.indexOf('const { postJob } = await import')
    expect(laneAt).toBeGreaterThan(-1)
    expect(postAt).toBeGreaterThan(-1)
    expect(laneAt).toBeLessThan(postAt)
  })
})

describe('the job form offers it', () => {
  it('has a control that sets the local lane', () => {
    expect(form).toContain('localOnly')
    expect(form).toMatch(/lane:\s*'local'/)
  })

  it('tells the poster nothing will claim it without a worker running', () => {
    // The failure mode of ticking this with no worker is silence — the job
    // sits Open forever — so the form has to say so up front.
    expect(form).toContain('--workdir')
  })
})
