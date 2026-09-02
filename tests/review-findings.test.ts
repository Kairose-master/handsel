import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  MAX_REVISION_ROUNDS,
  blockingOf,
  decideParked,
  decideReview,
  extractFindings,
  extractQuote,
  reviewFormatInstructions,
  summariseFindings,
} from '@/lib/review-findings'

const DELIVERABLE = `# Migration cost analysis

AWS published a 40% reduction in egress cost for customers on the new tier.
Our own p95 latency held at 180ms through the cutover.
The rollback plan is documented in runbooks/cutover.md.
`

describe('a blocking finding has to point at the work', () => {
  it('blocks on a quote that is really in the deliverable', () => {
    // The real round-2 catch: the reviewer quoted a claim that IS in the text
    // and said the attribution was wrong. That is a finding worth escrow, and
    // the rule has to keep it.
    const f = extractFindings(
      'BLOCKING: "AWS published a 40% reduction in egress cost" — that figure is not in the cited post; it is from a different vendor blog.',
      DELIVERABLE,
    )
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('blocking')
    expect(f[0].voided).toBeNull()
  })

  it('demotes a demand for changes that quotes nothing', () => {
    // "Could be more rigorous" is the whole pathology. It is always available,
    // always defensible, and now it does not hold a stranger's money.
    const f = extractFindings('BLOCKING: the analysis could be more rigorous and the tone is uneven.', DELIVERABLE)
    expect(f[0].kind).toBe('advisory')
    expect(f[0].voided).toBe('no-quote')
  })

  it('demotes an objection to text that is not there', () => {
    // Usually this is last round's objection, repeated after the worker fixed
    // it. Repeating is not discouraged — it is mechanically impossible, since
    // the sentence being complained about no longer exists to quote.
    const f = extractFindings('BLOCKING: "a 65% reduction in egress" — unsourced.', DELIVERABLE)
    expect(f[0].kind).toBe('advisory')
    expect(f[0].voided).toBe('quote-not-found')
  })

  it('ignores whitespace and case, because retyping a sentence is not a defect', () => {
    const f = extractFindings('BLOCKING: "aws published a 40%   REDUCTION\n in egress cost" — wrong source.', DELIVERABLE)
    expect(f[0].kind).toBe('blocking')
  })

  it('does not ignore the numbers, because a different number is a different claim', () => {
    const f = extractFindings('BLOCKING: "AWS published a 45% reduction in egress cost" — wrong source.', DELIVERABLE)
    expect(f[0].voided).toBe('quote-not-found')
  })

  it('reads the shape through whatever markdown a model wraps it in', () => {
    const review = [
      '- **BLOCKING:** "Our own p95 latency held at 180ms" — no measurement window given.',
      '1. BLOCKING - "The rollback plan is documented" — the file does not exist.',
      '> BLOCKING — "runbooks/cutover.md" — dead link.',
    ].join('\n')
    expect(blockingOf(extractFindings(review, DELIVERABLE))).toHaveLength(3)
  })

  it('takes backticks and curly quotes as quoting', () => {
    expect(extractQuote('BLOCKING: `p95 latency held at 180ms` — no window')).toBe('p95 latency held at 180ms')
    expect(extractQuote('BLOCKING: “p95 latency held at 180ms” — no window')).toBe('p95 latency held at 180ms')
  })

  it('keeps prose that never claimed to be blocking out of the count entirely', () => {
    const f = extractFindings('REVISE. The structure is fine but I would like more depth on cost.', DELIVERABLE)
    expect(f).toHaveLength(0)
    expect(blockingOf(f)).toHaveLength(0)
  })
})

describe('the disposition ignores the verdict word', () => {
  it('releases a REVISE that produced no verifiable finding', () => {
    // The core change. A reviewer that cannot point at what is wrong has not
    // earned a hold on somebody else's escrow.
    expect(decideReview({ samePerson: false, blockingCount: 0, round: 0 })).toBe('release')
  })

  it('sends real findings back while rounds remain', () => {
    expect(decideReview({ samePerson: false, blockingCount: 1, round: 0 })).toBe('revise')
    expect(decideReview({ samePerson: false, blockingCount: 3, round: 1 })).toBe('revise')
  })

  it('FAILS rather than parking, once rounds are spent and a finding still stands', () => {
    // The old outcome here was 'hand-to-owner', which set neither output nor
    // failed on the subtask — so workTerminal stayed false and the whole
    // delegation never finalized. An escrow parked forever pending a human is
    // the absence of a decision, not a conservative one.
    expect(decideReview({ samePerson: false, blockingCount: 1, round: MAX_REVISION_ROUNDS })).toBe('fail')
    expect(decideReview({ samePerson: false, blockingCount: 1, round: 99 })).toBe('fail')
  })

  it('still discards a self-review', () => {
    expect(decideReview({ samePerson: true, blockingCount: 5, round: 9 })).toBe('release')
  })

  it('always names an end state — there is no fourth outcome', () => {
    const seen = new Set<string>()
    for (const samePerson of [true, false]) {
      for (const blockingCount of [0, 1, 7]) {
        for (const round of [0, 1, 2, 5]) seen.add(decideReview({ samePerson, blockingCount, round }))
      }
    }
    expect([...seen].sort()).toEqual(['fail', 'release', 'revise'])
  })
})

describe('the observed pathology, replayed', () => {
  // Two live delegations, 8 verdicts, 0 APPROVE — three of them consecutive
  // REVISEs on a final round that had been told a REVISE would end the
  // pipeline unresolved. Explicit approval criteria did not move it. This is
  // that transcript's shape, run through the new rule.
  const round1 = 'REVISE. Not every number is sourced and the argument needs tightening.'
  const round2 = 'REVISE\nBLOCKING: "AWS published a 40% reduction in egress cost" — attributed to the wrong post.'
  const round3 = 'REVISE. Sourcing is better but I would still like deeper treatment of the tradeoffs.'

  it('round 1 releases — a demand with nothing to point at is not a hold', () => {
    expect(decideReview({ samePerson: false, blockingCount: blockingOf(extractFindings(round1, DELIVERABLE)).length, round: 0 })).toBe('release')
  })

  it('round 2 still blocks, because that finding was real', () => {
    // The rule must not buy termination by suppressing good review. This is
    // the exact catch the reviewer got right and the worker accepted.
    expect(decideReview({ samePerson: false, blockingCount: blockingOf(extractFindings(round2, DELIVERABLE)).length, round: 1 })).toBe('revise')
  })

  it('round 3 releases once the quoted sentence has been fixed', () => {
    const fixed = DELIVERABLE.replace('AWS published a 40% reduction in egress cost', 'Cloudflare reported a 40% egress reduction (2026 transit report)')
    // Even repeating round 2's exact objection cannot block now — the text it
    // quoted is gone.
    expect(blockingOf(extractFindings(round2, fixed))).toHaveLength(0)
    expect(decideReview({ samePerson: false, blockingCount: blockingOf(extractFindings(round3, fixed)).length, round: 2 })).toBe('release')
  })
})

describe('what the requester still gets to see', () => {
  it('records advisory findings instead of discarding them', () => {
    // Not blocking is not the same as not said. The requester reads these and
    // is free to disagree with the disposition.
    const f = extractFindings('BLOCKING: the tone is uneven.\nBLOCKING: "a 65% reduction" — unsourced.', DELIVERABLE)
    const summary = summariseFindings(f)
    expect(summary).toContain('advisory (no quoted span)')
    expect(summary).toContain('advisory (quote not in the deliverable)')
  })

  it('tells the reviewer the rule up front rather than keeping it as a trap', () => {
    const help = reviewFormatInstructions()
    expect(help).toContain('BLOCKING:')
    expect(help).toMatch(/checked against the deliverable/i)
    expect(help).toMatch(/does not hold/i)
  })
})

describe('the parser cannot be broken by ordinary reviewer prose', () => {
  it('keeps a quote that spans two sentences of the deliverable', () => {
    // A line parser read the newline as an unterminated quote and demoted the
    // finding. Silently turning a real objection into an advisory one is the
    // one direction this rule must never fail in.
    const twoLines = 'BLOCKING: "Our own p95 latency held at 180ms through the cutover.\nThe rollback plan is documented in runbooks/cutover.md." — neither is evidenced.'
    expect(blockingOf(extractFindings(twoLines, DELIVERABLE))).toHaveLength(1)
  })

  it('does not let one unterminated quote swallow the findings after it', () => {
    const review = [
      'BLOCKING: "this quote never closes and rambles on',
      'BLOCKING: "Our own p95 latency held at 180ms" — no measurement window.',
    ].join('\n')
    const f = extractFindings(review, DELIVERABLE)
    expect(f).toHaveLength(2)
    expect(blockingOf(f)).toHaveLength(1)
  })

  it('does not fire on the word blocking used in a sentence', () => {
    // "this is blocking the rollout" is prose, not a finding, and counting it
    // would hold escrow on a turn of phrase.
    const f = extractFindings('REVISE — the missing runbook is blocking the rollout in my view.', DELIVERABLE)
    expect(f).toHaveLength(0)
  })

  it('survives an empty review and an empty deliverable without blocking', () => {
    // A reviewer that returned nothing is a missing review, not a rejection.
    // Holding a worker's money because the REVIEWER failed would be the
    // pathology with the parties swapped.
    expect(extractFindings('', DELIVERABLE)).toEqual([])
    expect(decideReview({ samePerson: false, blockingCount: 0, round: 2 })).toBe('release')
    expect(blockingOf(extractFindings('BLOCKING: "anything" — x', ''))).toHaveLength(0)
  })
})

describe('the backlog the old rule left behind', () => {
  it('releases a parked target whose recorded note holds no verifiable finding', () => {
    // Old notes have no BLOCKING lines, so under this rule they never held the
    // money. Applying the same standard backwards is not leniency.
    expect(decideParked({ reviewNote: 'REVISE — needs more depth on the tradeoffs.', submittedOutput: DELIVERABLE }).disposition).toBe('release')
    expect(decideParked({ reviewNote: null, submittedOutput: DELIVERABLE }).disposition).toBe('release')
  })

  it('fails a parked target whose recorded note still quotes the work', () => {
    const r = decideParked({
      reviewNote: 'BLOCKING: "The rollback plan is documented in runbooks/cutover.md." — that file does not exist.',
      submittedOutput: DELIVERABLE,
    })
    expect(r.disposition).toBe('fail')
    expect(r.blocking).toHaveLength(1)
  })

  it('never leaves a parked target parked', () => {
    // The whole point. Every input reaches one of two end states.
    for (const note of ['', 'REVISE', 'BLOCKING: vague', 'BLOCKING: "Our own p95 latency held at 180ms" — no window']) {
      expect(['release', 'fail']).toContain(decideParked({ reviewNote: note, submittedOutput: DELIVERABLE }).disposition)
    }
  })
})

describe('the state the pipeline could not leave', () => {
  const src = readFileSync('lib/delegation.ts', 'utf8')

  /** The tick's own terminality test, copied from lib/delegation.ts. */
  const workTerminal = (st: { failed?: boolean; output?: string | null }) => Boolean(st.failed) || st.output != null

  it('shows why hand-to-owner hung the whole delegation', () => {
    // It set reviewVerdict and nothing else. Not failed, no output — so this
    // subtask never satisfied workTerminal, the integration gate never ran,
    // and the delegation never finalized. Not a slow path: no path.
    const parked = { reviewVerdict: 'revise' as const, failed: false, output: null }
    expect(workTerminal(parked)).toBe(false)
  })

  it('both new dispositions produce a state the pipeline can leave', () => {
    expect(workTerminal({ failed: true, output: null })).toBe(true) // fail
    expect(workTerminal({ failed: false, output: '(delivered)' })).toBe(true) // release
  })

  it('the tick still defines terminality the way this test assumes', () => {
    // If that definition changes, the two assertions above stop meaning
    // anything, and they are the whole claim of this change.
    expect(src).toContain('workSubtasks.every((st) => st.failed || st.output != null)')
  })

  it('the tick unparks the rows the old branch already stranded', () => {
    // Fixing the decision only helps reviews that have not happened yet. Two
    // targets were sitting in the old state when this was written, and their
    // escrows would have refunded by delivery-deadline timeout — the harshest
    // ending, reached by nobody deciding anything.
    expect(src).toContain('decideParked(')
    expect(src).toMatch(/unparking a hand-to-owner target/)
  })

  it('the terminal branch marks the subtask failed rather than parking it', () => {
    const terminal = src.slice(src.indexOf('// Rounds spent with a verified blocking finding'))
    expect(terminal.slice(0, 2000)).toContain('target.failed = true')
  })
})
