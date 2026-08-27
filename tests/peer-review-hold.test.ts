import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { heldForPeerReview, type ReviewableSubtask } from '@/lib/peer-review-hold'

/** Strip comments before asserting on source, so a doc comment that MENTIONS a
 *  symbol can never stand in for the code that uses it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const target = (over: Partial<ReviewableSubtask> = {}): ReviewableSubtask => ({
  title: 'Platform recommendation',
  onchainJobId: 25,
  ...over,
})
const reviewer = (over: Partial<ReviewableSubtask> = {}): ReviewableSubtask => ({
  title: 'Red team',
  reviewOf: 'Platform recommendation',
  ...over,
})

describe('heldForPeerReview', () => {
  it('holds a reviewed subtask whose reviewer has no verdict yet', () => {
    const v = heldForPeerReview([target(), reviewer()], 25)
    expect(v.hold).toBe(true)
    expect(v.hold && v.reason).toContain('Red team')
  })

  it('holds even when the reviewer has not been posted on-chain yet', () => {
    // This is the live case: the reviewer is held back by the wave scheduler
    // until its target delivers, so at the moment of settlement it has no job
    // id at all. A gate that only looked at posted reviewers would be open
    // exactly when it mattered.
    const notPosted = reviewer()
    expect(notPosted.onchainJobId).toBeUndefined()
    expect(heldForPeerReview([target(), notPosted], 25).hold).toBe(true)
  })

  it('releases once the reviewer has returned APPROVE', () => {
    expect(heldForPeerReview([target(), reviewer({ reviewVerdict: 'approve' })], 25).hold).toBe(false)
  })

  it('releases on REVISE too — that verdict has its own route', () => {
    // A revise sends the work back to its worker. Holding here as well would
    // freeze the escrow behind a gate that has already given its answer.
    expect(heldForPeerReview([target(), reviewer({ reviewVerdict: 'revise' })], 25).hold).toBe(false)
  })

  it('does not hold a job that belongs to no delegation', () => {
    expect(heldForPeerReview([target(), reviewer()], 999).hold).toBe(false)
  })

  it('does not hold an unreviewed sibling in the same delegation', () => {
    const sibling: ReviewableSubtask = { title: 'AWS read', onchainJobId: 20 }
    expect(heldForPeerReview([target(), reviewer(), sibling], 20).hold).toBe(false)
  })

  it('does not hold the reviewer job itself', () => {
    expect(heldForPeerReview([target(), reviewer({ onchainJobId: 28 })], 28).hold).toBe(false)
  })

  it('holds every tier until the last one has a verdict', () => {
    const t1 = reviewer({ title: 'Review tier 1', reviewVerdict: 'approve' })
    const t2 = reviewer({ title: 'Review tier 2' }) // not posted yet
    expect(heldForPeerReview([target(), t1, t2], 25).hold).toBe(true)
    const t2done = reviewer({ title: 'Review tier 2', reviewVerdict: 'approve' })
    expect(heldForPeerReview([target(), t1, t2done], 25).hold).toBe(false)
  })

  it('names the count when more than one reviewer is outstanding', () => {
    const v = heldForPeerReview(
      [target(), reviewer({ title: 'Red team' }), reviewer({ title: 'Second opinion' })],
      25,
    )
    expect(v.hold && v.reason).toContain('2 peer reviewers')
  })

  it('holds — does not release — a subtask it cannot match reviewers to', () => {
    // Pessimistic by design: a wrongly-held job is released by the next tick,
    // a wrongly-released one has already moved real money.
    const untitled: ReviewableSubtask = { onchainJobId: 25 }
    expect(heldForPeerReview([untitled, reviewer()], 25).hold).toBe(true)
  })

  it('ignores a whitespace-only reviewOf rather than matching a blank title', () => {
    const blank: ReviewableSubtask = { title: '   ', onchainJobId: 25 }
    const ghost: ReviewableSubtask = { title: 'ghost', reviewOf: '   ' }
    expect(heldForPeerReview([blank, ghost], 25).hold).toBe(true) // blank title → held, not matched
  })
})

describe('the settlement path actually asks', () => {
  const src = codeOnly(readFileSync('lib/labor-settle.ts', 'utf8'))

  it('checks the hold before it approves', () => {
    const check = src.indexOf('heldForPeerReviewOnChain(')
    const approve = src.indexOf('approveJob(spec.requesterAgentId')
    expect(check).toBeGreaterThan(-1)
    expect(approve).toBeGreaterThan(-1)
    expect(check).toBeLessThan(approve)
  })

  it('does not exempt the merge authorization from the review gate', () => {
    // A merge outranks a GRADER verdict, not a promise the requester wrote
    // into their own plan and is paying a reviewer to keep.
    const i = src.indexOf('heldForPeerReviewOnChain(')
    const window = src.slice(Math.max(0, i - 400), i)
    expect(window).not.toMatch(/authorization\s*[!=]==?\s*'merge'/)
  })

  it('holds when the delegation read fails', () => {
    expect(src).toMatch(/catch[\s\S]{0,200}return\s*\{\s*hold:\s*true/)
  })
})
