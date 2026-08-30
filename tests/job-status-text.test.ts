import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { describeJobStatus, verdictOf, verdictLine } from '@/lib/job-status-text'

// The reported defect, verbatim: get_job described job #20 (on-chain
// Completed, grading FAILED) as "done and paid — see get_work_proof for the
// signed proof", while my_work correctly showed it as FAILED. These pin the
// two sentences that were wrong, at the level of what they claim, not how
// they are phrased.
describe('describeJobStatus', () => {
  it('never claims payment for a settled job that failed grading (job #20)', () => {
    const { hint, proofExpected } = describeJobStatus('Completed', false)
    expect(hint).not.toMatch(/paid/i)
    expect(hint).toMatch(/did NOT pass|not pass/i)
    expect(proofExpected).toBe(false)
  })

  it('never points at a work proof that cannot exist', () => {
    // A proof is only issued on a graded pass, so every other terminal
    // shape must leave proofExpected false — otherwise the operator is
    // sent to a tool that has nothing to return.
    for (const verdict of [false, null] as const) {
      expect(describeJobStatus('Completed', verdict).proofExpected).toBe(false)
      expect(describeJobStatus('Completed', verdict).hint).not.toMatch(/get_work_proof/)
    }
    expect(describeJobStatus('Completed', true).proofExpected).toBe(true)
  })

  it('reports a verdict that is already in while the chain still says Submitted (job #31)', () => {
    const failed = describeJobStatus('Submitted', false)
    expect(failed.hint).toMatch(/NOT PASSED/)
    // The old text claimed grading had not happened yet. It had.
    expect(failed.hint).not.toMatch(/awaiting independent grading/)
    expect(describeJobStatus('Submitted', true).hint).toMatch(/PASSED/)
  })

  it('keeps saying "awaiting grading" only when there really is no verdict', () => {
    expect(describeJobStatus('Submitted', null).hint).toMatch(/awaiting independent grading/)
  })

  it('does not invent a payer for a terminal job with no verdict on record', () => {
    const hint = describeJobStatus('Completed', null).hint
    expect(hint).toMatch(/settled/)
    expect(hint).not.toMatch(/paid/i)
  })

  it('passes the control cases through unchanged', () => {
    // The jobs the report confirmed were correct: passed + paid, and the
    // pre-terminal statuses, which no verdict should alter.
    expect(describeJobStatus('Completed', true).hint).toMatch(/done and paid/)
    expect(describeJobStatus('Open', null).hint).toMatch(/claimable now/)
    expect(describeJobStatus('Open', false).hint).toMatch(/claimable now/)
    expect(describeJobStatus('Accepted', null).hint).toMatch(/accepted/)
    expect(describeJobStatus('Refunded', null).hint).toMatch(/refunded/)
    expect(describeJobStatus('Cancelled', null).hint).toMatch(/cancelled/)
    expect(describeJobStatus('Disputed', null).hint).toMatch(/dispute/)
  })

  it('falls back rather than throwing on a status it does not know', () => {
    expect(describeJobStatus('SomethingNew', true)).toEqual({ hint: '—', proofExpected: false })
  })
})

describe('verdictOf', () => {
  it('reads the spec test result the way my_work does', () => {
    expect(verdictOf({ passed: true })).toBe(true)
    expect(verdictOf({ passed: false })).toBe(false)
  })

  it('treats a missing or unresolved result as no verdict, not as a failure', () => {
    // An ungraded job is not a failed job — conflating them would make
    // get_job accuse workers whose grading has simply not run.
    expect(verdictOf(null)).toBe(null)
    expect(verdictOf(undefined)).toBe(null)
    expect(verdictOf({})).toBe(null)
    expect(verdictOf({ passed: null })).toBe(null)
  })
})

describe('verdictLine', () => {
  it('states a verdict plainly and stays silent when there is none', () => {
    expect(verdictLine(true)).toBe('grading verdict: PASSED')
    expect(verdictLine(false)).toBe('grading verdict: NOT PASSED')
    expect(verdictLine(null)).toBe(null)
  })
})

describe('the tools that report a job actually use it', () => {
  // A pure module nothing calls is not a fix. These pin the CALL, not the
  // import — an import survives deleting the call, which is how a previous
  // regression pin in this repo passed while the behaviour was gone.
  const jobsHandler = () => readFileSync('lib/mcp/handlers/jobs.ts', 'utf8')

  it('get_job describes the status from the grading verdict, not a static map', () => {
    const body = jobsHandler()
    expect(body).toMatch(/describeJobStatus\(job\.status, verdict\)/)
    expect(body).toMatch(/verdictOf\(spec\?\.testResult\)/)
    // The map that caused the bug is gone, not merely shadowed.
    expect(body).not.toContain('const statusHint')
  })

  it('get_job quotes the reservation deadline instead of implying a permanent hold', () => {
    expect(jobsHandler()).toMatch(/reservationStateFor\(spec\.specHash\)/)
  })

  it('my_work marks a job posted by another account', () => {
    expect(jobsHandler()).toMatch(/outside job/)
  })

  it('a refused claim says when the reservation lapses', () => {
    const body = readFileSync('lib/labor-dispatch.ts', 'utf8')
    expect(body).toMatch(/await claimRefusalReason\(spec\.specHash\)/)
    expect(body).not.toContain('it is not open to anyone else.')
  })
})
