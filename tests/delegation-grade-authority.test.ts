import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * One escrow, one grade. The delegation tick re-grades a Submitted subtask
 * on the heartbeat so a deliverable whose submission-time grade returned no
 * verdict still settles. It must never re-grade one whose verdict was a
 * recorded FAIL: on V2 that job is deliberately left Submitted for the
 * review deadline to refund, and a second, more lenient prompt releasing it
 * is the money following whichever grader said yes (job #55, 2026-09-02 —
 * docs/failure-modes.md §69).
 */
describe('the delegation verifier is a fallback for an absent verdict, not an appeal court', () => {
  const src = readFileSync('lib/delegation.ts', 'utf8')
  const block = src.slice(src.indexOf("job.status === 'Submitted' && row.autoVerify"))

  it('loads the platform grade alongside the spec fields the tick reads', () => {
    const select = src.slice(src.indexOf('const specs = wantedHashes.length'), src.indexOf('const specByHash = new Map'))
    expect(select).toContain('testResult: jobSpec.testResult')
  })

  it('skips a recorded FAIL before any verifier runs, and says so', () => {
    const guard = block.indexOf('recorded === false')
    const verify = block.indexOf('verifySubmission(complete, st, output)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(verify)
    expect(block.slice(guard, verify)).toContain('platform grade is a recorded FAIL')
    expect(block.slice(guard, verify)).toContain('continue')
  })

  it('a null verdict (grader unavailable at submission) still falls through to the verifier', () => {
    // Only `false` is a verdict. `null`/undefined is the case this block was
    // written for and must keep working.
    expect(block).toContain('if (recorded === false)')
    expect(block).not.toContain('if (recorded !== true)')
  })
})
