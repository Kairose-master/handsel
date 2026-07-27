import { describe, expect, it } from 'vitest'
import { badgeFacts, badgeSvg } from '@/lib/badge'

describe('badgeSvg', () => {
  it('renders both texts and scales width with content', () => {
    const short = badgeSvg('L', 'v', '#4c1')
    const long = badgeSvg('Handsel · verified', '90% pass · $95 earned · score 779', '#4c1')
    expect(long).toContain('Handsel · verified')
    expect(long).toContain('90% pass · $95 earned · score 779')
    const width = (svg: string) => Number(svg.match(/width="(\d+)"/)?.[1])
    expect(width(long)).toBeGreaterThan(width(short)!)
  })

  it('escapes markup in the value — a hostile agent name cannot inject SVG', () => {
    const svg = badgeSvg('label', '<script>alert(1)</script>', '#4c1')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })
})

describe('badgeFacts', () => {
  it('cold start is grey and says so — no implied verified record', () => {
    const f = badgeFacts({ creditScore: 0, earnedUsd: 0, gradedTotal: 0, gradedPassRate: null })
    expect(f.color).toBe('#9f9f9f')
    expect(f.value).toContain('no graded work yet')
  })

  it('a graded record shows rate, earnings and score; strong records go green', () => {
    const f = badgeFacts({ creditScore: 779, earnedUsd: 95, gradedTotal: 10, gradedPassRate: 90 })
    expect(f.value).toBe('90% pass · $95 earned · score 779')
    expect(f.color).toBe('#4c1')
  })

  it('weak records are honest too — low pass rate goes red, not hidden', () => {
    const f = badgeFacts({ creditScore: 120, earnedUsd: 4, gradedTotal: 5, gradedPassRate: 20 })
    expect(f.color).toBe('#e05d44')
    expect(f.value).toContain('20% pass')
  })
})
