/**
 * The label-to-bounty bot's pure decisions. The bot moves escrow off a
 * webhook, so what counts as a bounty label — and what gets rejected loudly
 * instead of silently — is pinned here.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_LABEL_BOUNTY_USD,
  bountyLabelOn,
  bountyPostedComment,
  briefFromIssue,
  notLinkedComment,
  parseBountyLabel,
  validateLabelBounty,
} from '@/lib/bounty-label'

describe('parseBountyLabel', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseBountyLabel('bounty:$15')).toBe(15)
    expect(parseBountyLabel('bounty: $15')).toBe(15)
    expect(parseBountyLabel('bounty:15')).toBe(15)
    expect(parseBountyLabel('Bounty:$15.50')).toBe(15.5)
    expect(parseBountyLabel('  bounty:$7  ')).toBe(7)
  })

  it('rejects everything else — an ordinary label must never move money', () => {
    expect(parseBountyLabel('bug')).toBeNull()
    expect(parseBountyLabel('bounty')).toBeNull()
    expect(parseBountyLabel('bounty:$0')).toBeNull()
    expect(parseBountyLabel('bounty:$-5')).toBeNull()
    expect(parseBountyLabel('bounty:$15USD')).toBeNull()
    expect(parseBountyLabel('big bounty:$15')).toBeNull()
    expect(parseBountyLabel('bounty:$1e9')).toBeNull()
  })
})

describe('validateLabelBounty', () => {
  it('caps typos before they escrow a fortune', () => {
    expect(validateLabelBounty(15)).toEqual({ ok: true })
    expect(validateLabelBounty(MAX_LABEL_BOUNTY_USD)).toEqual({ ok: true })
    expect(validateLabelBounty(MAX_LABEL_BOUNTY_USD + 1).ok).toBe(false)
    expect(validateLabelBounty(0.5).ok).toBe(false)
  })
})

describe('briefFromIssue', () => {
  it('carries the issue body and the backlink', () => {
    const brief = briefFromIssue({ title: 'Fix pagination', body: 'Off by one on page 2.', url: 'https://github.com/a/b/issues/3' })
    expect(brief).toContain('Off by one on page 2.')
    expect(brief).toContain('https://github.com/a/b/issues/3')
  })
  it('truncates a monster body and says so', () => {
    const brief = briefFromIssue({ title: 't', body: 'x'.repeat(9000), url: 'u' })
    expect(brief.length).toBeLessThan(4300)
    expect(brief).toContain('truncated')
  })
  it('handles an empty body honestly', () => {
    expect(briefFromIssue({ title: 't', body: null, url: 'u' })).toContain('no description')
  })
})

describe('bountyLabelOn', () => {
  it('finds a bounty among ordinary labels, or none', () => {
    expect(bountyLabelOn([{ name: 'bug' }, { name: 'bounty:$20' }])).toBe(20)
    expect(bountyLabelOn([{ name: 'bug' }])).toBeNull()
    expect(bountyLabelOn([])).toBeNull()
    expect(bountyLabelOn(undefined)).toBeNull()
  })
})

describe('bot comments', () => {
  it('the posted comment states the two rules that matter: merge pays, close refunds', () => {
    const c = bountyPostedComment({ bountyUsd: 15, jobId: 42, origin: 'https://x.dev', realMoney: true })
    expect(c).toContain('$15')
    expect(c).toContain('job #42')
    expect(c).toContain('merging the PR releases the escrow'.slice(0, 10))
    expect(c.toLowerCase()).toContain('refund')
  })

  /**
   * §23: a repo had two markets' Apps installed, the testnet one answered
   * first, and its comment was word-for-word what a real bounty looks like.
   * Whether the money is real is the one fact this comment must never leave
   * ambiguous — it is all most people will ever read about that job.
   */
  it('says whether the money is real, in the headline sentence itself', () => {
    const real = bountyPostedComment({ bountyUsd: 1, jobId: 7, origin: 'https://x.dev', realMoney: true })
    const test = bountyPostedComment({ bountyUsd: 1, jobId: 7, origin: 'https://x.dev', realMoney: false })
    expect(real).toMatch(/real USDC/)
    expect(test).toMatch(/testnet tokens \(no real value\)/)
    // Not merely different somewhere — different in the first line, so it
    // cannot be missed by someone who reads nothing else.
    expect(real.split('\n')[0]).not.toBe(test.split('\n')[0])
  })

  it('a sandbox comment names the mix-up it is most likely to be', () => {
    const test = bountyPostedComment({ bountyUsd: 1, jobId: null, origin: 'https://x.dev', realMoney: false })
    expect(test).toMatch(/different market's App answered/)
    // The real one must NOT carry that hedge — a genuine bounty hinting that
    // another market may have answered would undercut what it is asserting.
    const real = bountyPostedComment({ bountyUsd: 1, jobId: null, origin: 'https://x.dev', realMoney: true })
    expect(real).not.toMatch(/different market/)
  })
  it('the not-linked comment is onboarding, not an error dump', () => {
    const c = notLinkedComment('https://x.dev')
    expect(c).toContain('/api/github/oauth/start')
    expect(c).toContain('re-add the label')
  })
})
