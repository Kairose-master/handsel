import { describe, it, expect } from 'vitest'
import {
  decideRevision,
  revisionBrief,
  reReviewBrief,
  MAX_REVISION_ROUNDS,
  parseReviewVerdict,
} from '@/lib/delegation'

describe('decideRevision', () => {
  it('releases on approval', () => {
    expect(decideRevision({ approve: true, samePerson: false, round: 0 })).toBe('release')
  })

  it('sends a first REVISE back to the worker instead of to a human', () => {
    expect(decideRevision({ approve: false, samePerson: false, round: 0 })).toBe('revise')
  })

  it('keeps looping while rounds remain', () => {
    expect(decideRevision({ approve: false, samePerson: false, round: MAX_REVISION_ROUNDS - 1 })).toBe('revise')
  })

  it('hands to the owner once the rounds are spent', () => {
    expect(decideRevision({ approve: false, samePerson: false, round: MAX_REVISION_ROUNDS })).toBe('hand-to-owner')
    expect(decideRevision({ approve: false, samePerson: false, round: MAX_REVISION_ROUNDS + 5 })).toBe('hand-to-owner')
  })

  it('discards a self-review rather than letting an agent send its own work back', () => {
    expect(decideRevision({ approve: false, samePerson: true, round: 0 })).toBe('release')
    expect(decideRevision({ approve: true, samePerson: true, round: 0 })).toBe('release')
  })

  it('terminates: repeated REVISEs reach a terminal decision within the bound', () => {
    let round = 0
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      const d = decideRevision({ approve: false, samePerson: false, round })
      seen.push(d)
      if (d !== 'revise') break
      round++
    }
    expect(seen.filter((d) => d === 'revise')).toHaveLength(MAX_REVISION_ROUNDS)
    expect(seen[seen.length - 1]).toBe('hand-to-owner')
  })

  it('honours an explicit round cap', () => {
    expect(decideRevision({ approve: false, samePerson: false, round: 0, maxRounds: 0 })).toBe('hand-to-owner')
  })
})

describe('revisionBrief', () => {
  const brief = () =>
    revisionBrief({
      title: 'Write the market note',
      acceptanceCriteria: 'Covers all three tickers.',
      priorOutput: 'AAPL is fine.',
      reviewerNote: 'Missing MSFT and NVDA.',
      round: 1,
      nonce: 'NONCE1',
    })

  it('fences the reviewer note — it is another agent writing into this prompt', () => {
    const out = brief()
    expect(out).toContain('BEGIN_REVIEWER_NOTE_NONCE1')
    expect(out).toContain('END_REVIEWER_NOTE_NONCE1')
  })

  it('fences the prior submission too', () => {
    expect(brief()).toContain('BEGIN_PRIOR_SUBMISSION_NONCE1')
  })

  it('restates the unchanged acceptance criteria as the contract', () => {
    const out = brief()
    expect(out).toContain('Covers all three tickers.')
    expect(out).toMatch(/unchanged/i)
  })

  it('asks for the full corrected deliverable, not a diff', () => {
    expect(brief()).toMatch(/not a diff/i)
  })

  it('says which round this is, so the worker knows the loop is bounded', () => {
    expect(brief()).toContain(`Revision 1 of ${MAX_REVISION_ROUNDS}`)
  })

  it('tells the worker the criteria win over the note', () => {
    expect(brief()).toMatch(/keep the\s+criteria/i)
  })

  it('caps a runaway prior submission', () => {
    const out = revisionBrief({
      title: 't',
      acceptanceCriteria: 'c',
      priorOutput: 'x'.repeat(50_000),
      reviewerNote: 'n',
      round: 1,
      nonce: 'N',
    })
    expect(out.length).toBeLessThan(20_000)
  })
})

describe('reReviewBrief', () => {
  const brief = () =>
    reReviewBrief({
      title: 'Write the market note',
      acceptanceCriteria: 'Covers all three tickers.',
      revisedOutput: 'AAPL, MSFT and NVDA are covered.',
      priorNote: 'Missing MSFT and NVDA.',
      round: 1,
      nonce: 'NONCE2',
    })

  it('fences the revised deliverable — the worker wrote it', () => {
    expect(brief()).toContain('BEGIN_REVISED_SUBMISSION_NONCE2')
  })

  it('shows the reviewer what it asked for, so it cannot move the goalposts', () => {
    const out = brief()
    expect(out).toContain('Missing MSFT and NVDA.')
    expect(out).toMatch(/Do not raise requirements/i)
  })

  it('asks for the same APPROVE/REVISE reply the first review used', () => {
    const out = brief()
    expect(out).toContain('APPROVE')
    expect(out).toContain('REVISE')
    // The reply it asks for is the one parseReviewVerdict actually reads.
    expect(parseReviewVerdict('APPROVE — all three now covered').approve).toBe(true)
    expect(parseReviewVerdict('REVISE — NVDA still missing').approve).toBe(false)
  })
})
