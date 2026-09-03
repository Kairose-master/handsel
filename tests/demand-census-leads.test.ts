import { describe, it, expect } from 'vitest'
import { ESTABLISHED_STARS, LEADS_HEADER, YOUNG_REPO_DAYS, leadsCsv, qualifyLead, qualifyLeads, repoOf, type IssueItem } from '@/lib/demand-census'

const NOW = Date.parse('2026-09-02T00:00:00Z')
const item = (over: Partial<IssueItem> = {}): IssueItem => ({
  html_url: 'https://github.com/acme/widget/issues/12',
  repository_url: 'https://api.github.com/repos/acme/widget',
  title: 'Fix flaky retry in the uploader',
  body: 'x'.repeat(200),
  created_at: '2026-08-30T00:00:00Z',
  comments: 0,
  labels: [{ name: 'bounty' }],
  ...over,
})

describe('a label is not money, and the score says so', () => {
  it('rewards a stated amount and penalises its absence', () => {
    const withAmt = qualifyLead(item({ body: 'Bounty: $150 on merge. ' + 'x'.repeat(200) }), NOW)
    const without = qualifyLead(item(), NOW)
    expect(withAmt.amount).toBe('$150')
    expect(withAmt.score).toBeGreaterThan(without.score)
    expect(without.amount).toBeNull()
    expect(without.reasons.join(' ')).toMatch(/not money/)
  })

  it('rewards a named payment rail most of all', () => {
    // The census README learned this by hand: a digest of eight "bounty
    // opportunities" contained zero that actually paid. A rail in the text
    // is the difference between a label and a way to get paid.
    const rail = qualifyLead(item({ body: 'Paid via Algora on merge. ' + 'x'.repeat(200) }), NOW)
    expect(rail.paymentChannel).toBe('algora')
    expect(rail.reasons.join(' ')).toMatch(/payment rail/)
  })

  it('never reports an absent amount as zero', () => {
    expect(qualifyLead(item(), NOW).amount).toBeNull()
    // Second column is `amount`. Empty, not "0" — a zero here would read as
    // "a bounty of nothing", which is a different (and false) claim.
    const row = leadsCsv([qualifyLead(item(), NOW)]).split('\n')[1]
    expect(row.split(',')[1]).toBe('')
  })
})

describe('what makes a lead worth looking at first', () => {
  it('prefers fresh, unclaimed, well-specified issues', () => {
    const good = qualifyLead(item({ created_at: '2026-09-01T00:00:00Z', comments: 0, body: 'x'.repeat(700) }), NOW)
    const stale = qualifyLead(item({ created_at: '2026-04-01T00:00:00Z', comments: 12, body: 'short' }), NOW)
    expect(good.score).toBeGreaterThan(stale.score)
    expect(stale.reasons.join(' ')).toMatch(/stale/)
    expect(stale.reasons.join(' ')).toMatch(/contested/)
    expect(stale.reasons.join(' ')).toMatch(/underspecified/)
  })

  it('drops things that are not tasks', () => {
    const epic = qualifyLead(item({ labels: [{ name: 'bounty' }, { name: 'epic' }] }), NOW)
    expect(epic.reasons.join(' ')).toMatch(/not a task/)
    expect(epic.score).toBeLessThan(qualifyLead(item(), NOW).score)
  })

  it('writes every reason out so a person can disagree', () => {
    const l = qualifyLead(item(), NOW)
    expect(l.reasons.length).toBeGreaterThan(0)
    for (const r of l.reasons) expect(r).toMatch(/^[+-]\d+ /)
  })
})

describe('the ranked list', () => {
  it('keeps one lead per repository — the fifth is the same relationship five times', () => {
    const leads = qualifyLeads(
      [1, 2, 3].map((n) => item({ html_url: `https://github.com/acme/widget/issues/${n}` })).concat(
        item({ html_url: 'https://github.com/other/thing/issues/1', repository_url: 'https://api.github.com/repos/other/thing' }),
      ),
      NOW,
    )
    expect(leads).toHaveLength(2)
    expect(new Set(leads.map((l) => l.repo)).size).toBe(2)
  })

  it('sorts by score, then freshness', () => {
    const leads = qualifyLeads(
      [
        item({ html_url: 'https://github.com/a/a/issues/1', repository_url: 'https://api.github.com/repos/a/a', body: 'short' }),
        item({ html_url: 'https://github.com/b/b/issues/1', repository_url: 'https://api.github.com/repos/b/b', body: '$200 via algora. ' + 'x'.repeat(700) }),
      ],
      NOW,
    )
    expect(leads[0].repo).toBe('b/b')
  })

  it('bounds the list', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ html_url: `https://github.com/r${i}/x/issues/1`, repository_url: `https://api.github.com/repos/r${i}/x` }),
    )
    expect(qualifyLeads(many, NOW, 25)).toHaveLength(25)
  })

  it('produces a CSV a spreadsheet can open, with quoted titles', () => {
    const csv = leadsCsv(qualifyLeads([item({ title: 'Fix "quoted", comma title' })], NOW))
    expect(csv.split('\n')[0]).toBe(LEADS_HEADER)
    expect(csv).toContain('"Fix ""quoted"", comma title"')
  })
})

describe('the repository behind the lead — what the first list could not see', () => {
  // 2026-09-03: the top of the first ranked list was a "bounty-plaza" repo,
  // a fibonacci coding test, and forks of kafka-go / go-github / cli under
  // week-old accounts. Every one scored well on the issue alone.
  it('a fork is somebody else\'s backlog', () => {
    const fork = qualifyLead(item(), NOW, { fork: true, stars: 0, createdAt: '2026-08-25T00:00:00Z' })
    const own = qualifyLead(item(), NOW, { fork: false, stars: 400, createdAt: '2021-01-01T00:00:00Z' })
    expect(fork.score).toBeLessThan(own.score)
    expect(fork.reasons.join(' ')).toMatch(/a fork/)
    expect(fork.reasons.join(' ')).toMatch(new RegExp(`repository is \\d+d old`))
    expect(own.reasons.join(' ')).toMatch(/400 stars/)
  })
  it('a lookup that failed is reported, never scored as a fresh starless repo', () => {
    const unread = qualifyLead(item(), NOW, { unreadable: true })
    expect(unread.score).toBe(qualifyLead(item(), NOW).score)
    expect(unread.reasons.join(' ')).toMatch(/unreadable/)
  })
  it('bot feeds are not maintainers', () => {
    for (const title of ['[radar] SN open bounty 2026-09-02T14:22', 'Generate qualifying GMV for 6 USDC prize — week 20260831']) {
      expect(qualifyLead(item({ title }), NOW).reasons.join(' '), title).toMatch(/bot feed/)
    }
    expect(qualifyLead(item({ title: 'Fix flaky retry in the uploader' }), NOW).reasons.join(' ')).not.toMatch(/bot feed/)
  })
  it('qualifyLeads keys the metadata by owner/name', () => {
    const meta = new Map([[repoOf(item()), { fork: true }]])
    expect(qualifyLeads([item()], NOW, 25, meta)[0].reasons.join(' ')).toMatch(/a fork/)
    expect(YOUNG_REPO_DAYS).toBe(30)
    expect(ESTABLISHED_STARS).toBe(100)
  })
})
