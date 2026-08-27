import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { V2_HANDLES_IT } from '@/lib/dispute-policy'

// The stuck sweep runs from ordinary traffic, so whatever it prints, it prints
// every five minutes until the job leaves Submitted. That makes its wording a
// correctness concern rather than a style one.
const src = readFileSync('lib/labor-settle.ts', 'utf8')
const sweep = src.slice(src.indexOf('const submittedHashes'), src.indexOf('export async function regradeSubmittedSpec'))

describe('what the stuck-settlement sweep says about a failed job', () => {
  it('checks whether it may act before claiming to be acting', () => {
    // It logged "re-driving stuck settlement" and then returned immediately,
    // because on V2 returnFailedJobToMarket stands down and the review
    // deadline settles the job. Nothing was stuck and nothing was re-driven.
    // Read live, that line sent someone hunting a settlement bug that did not
    // exist — for twenty-five minutes.
    const drive = sweep.indexOf('re-driving stuck settlement for job #${job.id} (passed=false)')
    const check = sweep.indexOf('offchainMayResolveDisputes')
    expect(check).toBeGreaterThan(-1)
    expect(drive).toBeGreaterThan(check)
  })

  it('names the deadline that will actually settle it', () => {
    // "Waiting" is only reassuring with a number attached; without one it is
    // indistinguishable from stuck, which is the whole defect.
    expect(sweep).toContain('review deadline')
    expect(sweep).toContain('job.deadline')
  })

  it('degrades to the fact when the deadline is unknown, rather than inventing one', () => {
    expect(sweep).toContain("job.deadline === null")
  })

  it('says it once, not once per tick', () => {
    // A per-tick line about a job waiting out a 24h window outlasts every real
    // message around it.
    expect(sweep).toMatch(/else if \(fresh\)/)
    expect(sweep).toMatch(/if \(!fresh\) console\.log/)
  })
})

describe('the standing-down vocabulary is shared', () => {
  it('dispute-policy still exports the phrase the ops steps use', () => {
    // The pattern already existed — "so a quiet pass is legible in the ops log
    // rather than looking like a sweep that found nothing" — and this sweep
    // was the one place that never adopted it.
    expect(V2_HANDLES_IT).toMatch(/v2/i)
  })
})
