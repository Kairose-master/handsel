import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { APPEAL_WINDOW_MS } from '@/lib/appeal'
import { POSTING_FEE_BPS, POSTING_FEE_FLAT_USD, SILENCE_FORFEIT_BPS } from '@/lib/repo-job-templates'

const page = readFileSync('app/participation/page.tsx', 'utf8')
const terms = readFileSync('docs/worker-terms.md', 'utf8')

describe('the prose page and the rules table state the same numbers', () => {
  it('fee and bond', () => {
    for (const src of [page, terms]) {
      expect(src).toMatch(/5%.*\$0\.03/)
    }
    expect(POSTING_FEE_BPS).toBe(500)
    expect(POSTING_FEE_FLAT_USD).toBe(0.03)
  })

  it('silence forfeit, review and dispute windows', () => {
    expect(SILENCE_FORFEIT_BPS).toBe(1000)
    for (const src of [page, terms]) {
      expect(src).toMatch(/10%/)
      expect(src).toMatch(/24[- ]hour|24h/)
      expect(src).toMatch(/14 days/)
    }
  })

  it('appeal window matches the code', () => {
    const hours = APPEAL_WINDOW_MS / 3_600_000
    expect(page).toContain(`${hours} hours`)
    expect(terms).toContain(`${hours} hours`)
  })
})

describe('the two sentences that were stale are gone', () => {
  it('no longer says an unmerged PR is refunded', () => {
    // V1 wording. On V2 the platform records and stops, and expireReview
    // returns 90% — a buyer who read "refunds the poster" was told a number
    // that is off by the worker's silence forfeit.
    expect(page).not.toMatch(/closing unmerged refunds/)
    expect(page).toMatch(/does NOT refund it in full/)
    expect(terms).toMatch(/PR closed unmerged.*90% \/ 10%/)
  })

  it('no longer says there is no appeal', () => {
    expect(page).not.toMatch(/There is no appeal beyond the dispute mechanism/)
    expect(page).toMatch(/may appeal a FAILING verdict/)
  })
})

describe('absences are disclosed, not dressed up', () => {
  it('names KYC, jurisdiction and counsel terms as absent', () => {
    // Each absence row opens its figure cell with a bold "no…" — "none",
    // "no list", "none collected". The row is the disclosure.
    for (const word of ['KYC', 'Jurisdiction', 'Governing law']) expect(terms).toMatch(new RegExp(`\\| ${word}[^|]*\\| \\*\\*no`, 'i'))
  })

  it('never restates an on-chain immutable as a promise', () => {
    // Every money row that depends on deploy config must say so.
    for (const row of ['Posting fee', 'Worker bond', 'Review window', 'Dispute window']) {
      const line = terms.split('\n').find((l) => l.startsWith(`| ${row}`))!
      expect(line, row).toMatch(/at deploy/)
    }
  })
})
