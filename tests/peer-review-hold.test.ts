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

  it("releases once the TARGET carries the reviewer's APPROVE", () => {
    // The verdict lives on the TARGET — tickDelegation's resolution loop
    // writes target.reviewVerdict and nothing ever writes the reviewer's own
    // field. The first version of this predicate read the reviewer's, which
    // stays undefined forever, so the hold could never lift (live, job #25,
    // 2026-09-01: grading passed, review conversation finished, settlement
    // re-driving eternally). These fixtures put the verdict where the code
    // that produces it actually puts it.
    expect(heldForPeerReview([target({ reviewVerdict: 'approve' }), reviewer()], 25).hold).toBe(false)
    // A verdict on the reviewer row alone means nothing.
    expect(heldForPeerReview([target(), reviewer({ reviewVerdict: 'approve' })], 25).hold).toBe(true)
  })

  it("still holds on terminal REVISE — the escrow is the owner's to judge", () => {
    // Rounds spent without approval = hand-to-owner (docs/collaboration.md).
    // Auto-releasing on the grade here would overrule the reviewer the
    // pipeline paid; the hold stays, with a reason that says whose call it is.
    const v = heldForPeerReview([target({ reviewVerdict: 'revise' }), reviewer()], 25)
    expect(v.hold).toBe(true)
    expect(v.hold && v.reason).toContain('owner')
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

  it("holds a tier chain until the chain writes the target's verdict", () => {
    // Tier resolution also lands on the target: the chain's deciding verdict
    // is what tickDelegation records there. Reviewer-row verdicts alone —
    // whatever tier — keep the hold.
    const t1 = reviewer({ title: 'Review tier 1', reviewVerdict: 'approve' })
    const t2 = reviewer({ title: 'Review tier 2' }) // not posted yet
    expect(heldForPeerReview([target(), t1, t2], 25).hold).toBe(true)
    expect(heldForPeerReview([target({ reviewVerdict: 'approve' }), t1, t2], 25).hold).toBe(false)
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
