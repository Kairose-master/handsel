/**
 * Decision-table engine + the real trust gates. decideAutoRelease is the
 * authority the settlement path consults, so its behavior is pinned here.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluate,
  decideAutoRelease,
  decideBuildDraw,
  reputationCapUsd,
  AUTO_RELEASE_TABLE,
  BUILD_DRAW_TABLE,
  CREDIT_CEILING_TABLE,
  decisionTableToMarkdown,
} from '@/lib/decision-table'

describe('decision-table engine', () => {
  it('matches comparisons, ranges, any, and literals (FIRST hit)', () => {
    expect(evaluate(CREDIT_CEILING_TABLE, { creditScore: 500 })?.ceiling).toBe('$50')
    expect(evaluate(CREDIT_CEILING_TABLE, { creditScore: 700 })?.ceiling).toBe('$50')
    expect(evaluate(CREDIT_CEILING_TABLE, { creditScore: 900 })?.ceiling).toBe('$5 + (score−600)×$0.20')
    expect(evaluate(CREDIT_CEILING_TABLE, { creditScore: 1200 })?.ceiling).toBe('$100')
  })

  it('renders GitHub-flavored markdown', () => {
    const md = decisionTableToMarkdown(AUTO_RELEASE_TABLE)
    expect(md).toContain('| Grader verdict |')
    expect(md).toContain('auto_release')
  })
})

describe('reputationCapUsd — matches the reputation-lending formula', () => {
  it('is the base cap below the minimum score', () => {
    expect(reputationCapUsd(0)).toBe(50)
    expect(reputationCapUsd(599)).toBe(50)
  })
  it('stays at base while reputation is under it, then rises, then caps at max', () => {
    expect(reputationCapUsd(825)).toBe(50) // 5 + 225*0.2 = 50 → max(50,50)
    expect(reputationCapUsd(1000)).toBe(85) // 5 + 400*0.2 = 85
    expect(reputationCapUsd(1075)).toBe(100) // 5 + 475*0.2 = 100
    expect(reputationCapUsd(5000)).toBe(100) // bounded by maxLimit
  })
})

describe('decideAutoRelease — the authoritative gate', () => {
  const base = { verdict: 'pass', autoApprove: true, bountyUsd: 10, capUsd: 50 } as const

  it('releases a passing job within the ceiling', () => {
    expect(decideAutoRelease(base).action).toBe('auto_release')
  })
  it('holds a passing job that exceeds the ceiling', () => {
    expect(decideAutoRelease({ ...base, bountyUsd: 80 }).action).toBe('manual_review')
  })
  it('holds when the requester opted out of auto-approve', () => {
    expect(decideAutoRelease({ ...base, autoApprove: false }).action).toBe('manual_review')
  })
  it('reposts a failed job while reposts remain, then escalates', () => {
    expect(decideAutoRelease({ ...base, verdict: 'fail' }).action).toBe('refund_repost')
    expect(decideAutoRelease({ ...base, verdict: 'fail', repostsExhausted: true }).action).toBe('manual_review')
  })
  it('waits while grading is pending', () => {
    expect(decideAutoRelease({ ...base, verdict: 'pending' }).action).toBe('wait')
  })
  it('a high-reputation worker clears a bounty the base cap would hold', () => {
    const cap = reputationCapUsd(1000) // $85
    expect(decideAutoRelease({ verdict: 'pass', autoApprove: true, bountyUsd: 80, capUsd: cap }).action).toBe('auto_release')
  })
})

describe('decideBuildDraw — the build-envelope draw gate (docs/build-service.md)', () => {
  it('renders as a table too, same engine as every other gate', () => {
    expect(decisionTableToMarkdown(BUILD_DRAW_TABLE)).toContain('closed')
  })
  it('allows a draw within budget on an open envelope', () => {
    expect(decideBuildDraw({ closed: false, amountBaseUnits: '50', remainingBaseUnits: '100' }).decision).toBe('allow')
  })
  it('rejects any draw on a closed envelope, even a technically-affordable one', () => {
    const out = decideBuildDraw({ closed: true, amountBaseUnits: '1', remainingBaseUnits: '1000' })
    expect(out.decision).toBe('reject')
    expect(out.reason).toMatch(/closed/)
  })
  it('rejects a draw that would exceed the remaining budget', () => {
    const out = decideBuildDraw({ closed: false, amountBaseUnits: '101', remainingBaseUnits: '100' })
    expect(out.decision).toBe('reject')
    expect(out.reason).toMatch(/exceed/)
  })
  it('rejects zero and non-numeric draw amounts', () => {
    expect(decideBuildDraw({ closed: false, amountBaseUnits: '0', remainingBaseUnits: '100' }).decision).toBe('reject')
    expect(decideBuildDraw({ closed: false, amountBaseUnits: 'nope', remainingBaseUnits: '100' }).decision).toBe('reject')
  })
})
