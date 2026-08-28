import { describe, it, expect } from 'vitest'
import {
  portfolioFilePath,
  portfolioCommitMessage,
  renderPortfolioMarkdown,
  PORTFOLIO_DELIVERABLE_LIMIT,
} from '@/lib/agent-repo'

describe('portfolioFilePath', () => {
  it('is deterministic and slugs the title for humans', () => {
    expect(portfolioFilePath(42, 'Write the Q3 report!')).toBe('deliverables/job-42-write-the-q3-report.md')
    expect(portfolioFilePath(42, 'Write the Q3 report!')).toBe(portfolioFilePath(42, 'Write the Q3 report!'))
  })

  it('survives titles that slug to nothing, and caps slug length', () => {
    expect(portfolioFilePath(7, '!!!')).toBe('deliverables/job-7-job.md')
    const long = portfolioFilePath(7, 'x'.repeat(300))
    expect(long.length).toBeLessThan(90)
  })

  it('two jobs with the same title still get distinct paths — the id disambiguates', () => {
    expect(portfolioFilePath(1, 'Same title')).not.toBe(portfolioFilePath(2, 'Same title'))
  })
})

describe('portfolioCommitMessage', () => {
  it('names the job and settlement, and bounds the title', () => {
    const m = portfolioCommitMessage(9, 'T'.repeat(200))
    expect(m).toContain('job #9 settled:')
    expect(m.length).toBeLessThan(100)
  })
})

describe('renderPortfolioMarkdown', () => {
  const base = {
    jobId: 42,
    title: 'Write the report',
    specHash: '0xabc',
    bountyUsd: 12.5,
    txHash: '0xdeadbeef',
    agentName: 'Ada',
    proofUrl: 'https://example.com/proof/p1',
    deliverableText: 'The full report body.',
    settledAt: new Date('2026-08-28T00:00:00Z'),
  }

  it('leads with provenance — every settlement fact present, then the deliverable', () => {
    const md = renderPortfolioMarkdown(base)
    expect(md).toContain('# Write the report')
    expect(md).toContain('#42')
    expect(md).toContain('Ada')
    expect(md).toContain('$12.50 USDC')
    expect(md).toContain('0xdeadbeef')
    expect(md).toContain('0xabc')
    expect(md).toContain('https://example.com/proof/p1')
    expect(md.indexOf('0xdeadbeef')).toBeLessThan(md.indexOf('The full report body.'))
  })

  it('omits absent spec hash / proof rows rather than printing empty cells', () => {
    const md = renderPortfolioMarkdown({ ...base, specHash: null, proofUrl: null })
    expect(md).not.toContain('Spec hash')
    expect(md).not.toContain('Work proof')
  })

  it('a non-text deliverable states what it is instead of pretending emptiness is content', () => {
    const md = renderPortfolioMarkdown({ ...base, deliverableText: null })
    expect(md).toContain('not text')
  })

  it('discloses a truncated deliverable in platform-authored text — silent cuts are the defect', () => {
    const md = renderPortfolioMarkdown({ ...base, deliverableText: 'x'.repeat(PORTFOLIO_DELIVERABLE_LIMIT + 500) })
    expect(md).toContain('PLATFORM NOTICE')
    expect(md).toContain('500')
  })

  it('does not truncate a deliverable exactly at the limit', () => {
    const md = renderPortfolioMarkdown({ ...base, deliverableText: 'x'.repeat(PORTFOLIO_DELIVERABLE_LIMIT) })
    expect(md).not.toContain('PLATFORM NOTICE')
  })
})
