import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { governingDeadline, hasLapsed, dueDeadlines, type DeadlineJob } from '@/lib/deadlines'

/**
 * `status` alone does not say what may be done to a job.
 *
 * The contract's enum changes only when somebody CALLS an exit. So a job whose
 * open window lapsed an hour ago still reads `Open`, and `Open` actually means
 * "open, OR lapsed and not yet settled". The two are identical in `status` and
 * differ in whether `acceptJob` reverts.
 *
 * Job #1 on Base Sepolia sat in exactly that state for 46 minutes: openDeadline
 * 06:18:04Z, still `Open` at 07:03:47Z because nothing had called `expireOpen`.
 * The board offered Accept the whole time, and pressing it produced
 * "An error occurred in the Server Components render" — the third digest of the
 * day from the same cause: a precondition the UI could have known and did not.
 *
 * It could not have known, in fact: `readJobsV2` decoded all four deadlines and
 * the V1-shaped mapping in labor.ts kept none of them. Same lossy hop that had
 * just dropped `specHash`.
 */

const base: DeadlineJob = {
  id: 1,
  status: 'Open',
  openDeadline: 1785392284,
  deliveryDeadline: 0,
  reviewDeadline: 0,
  disputeDeadline: 0,
}

describe('the deadline that governs the current state', () => {
  it('picks the one matching the status', () => {
    expect(governingDeadline(base)).toBe(1785392284)
    expect(
      governingDeadline({ ...base, status: 'Accepted', deliveryDeadline: 999 }),
    ).toBe(999)
    expect(governingDeadline({ ...base, status: 'Submitted', reviewDeadline: 42 })).toBe(42)
    expect(governingDeadline({ ...base, status: 'Disputed', disputeDeadline: 7 })).toBe(7)
  })

  it('is null in the states that hold no money', () => {
    for (const status of ['Completed', 'Cancelled', 'Refunded', 'Expired'] as const) {
      expect(governingDeadline({ ...base, status })).toBeNull()
    }
  })

  it('treats a zero deadline as unknown, never as overdue since 1970', () => {
    // The states are read off-chain. A decode that went wrong must not be able
    // to make a live job look settleable — the same guard dueDeadlines uses.
    expect(governingDeadline({ ...base, openDeadline: 0 })).toBeNull()
    expect(hasLapsed({ ...base, openDeadline: 0 }, 2_000_000_000)).toBe(false)
  })
})

describe('lapsed matches the real job that produced the digest', () => {
  const NOW = 1785395027 // 07:03:47Z, when I read the chain

  it('is lapsed at the moment Accept was pressed', () => {
    expect(hasLapsed(base, NOW)).toBe(true)
    expect(NOW - governingDeadline(base)!).toBe(2743)
  })

  it('was not lapsed while the window was open', () => {
    expect(hasLapsed(base, 1785392283)).toBe(false)
  })

  it('flips exactly ON the deadline, not one second later', () => {
    // `>=`, because that is what every guard in the contract uses. A UI that
    // waits one more second is a UI that disagrees with the thing it calls.
    expect(hasLapsed(base, 1785392284)).toBe(true)
  })

  it('agrees with the sweep about what is due', () => {
    // Two readers of one table; if they disagree, the UI hides a button the
    // sweep will not act on, or offers one it will.
    const due = dueDeadlines([base], NOW)
    expect(due).toHaveLength(1)
    expect(due[0].fn).toBe('expireOpen')
    expect(hasLapsed(base, NOW)).toBe(true)

    const notYet = dueDeadlines([base], 1785392283)
    expect(notYet).toHaveLength(0)
    expect(hasLapsed(base, 1785392283)).toBe(false)
  })
})

describe('the UI is wired to it', () => {
  const page = readFileSync('app/(dashboard)/jobs/page.tsx', 'utf8')
  const labor = readFileSync('lib/onchain/labor.ts', 'utf8')

  it('does not offer Accept on a lapsed job', () => {
    expect(page).toMatch(/job\.status === 'Open' && workerFor\(job\) && !job\.lapsed/)
  })

  it('says why instead of just hiding the button', () => {
    // A vanished button is the same puzzle the digest was.
    expect(page).toContain("t('jobs.lapsed.note')")
    const dict = readFileSync('lib/i18n-dict.ts', 'utf8')
    expect(dict.split("'jobs.lapsed.note':").length - 1).toBe(3)
  })

  it('carries the deadlines through the mapping that used to drop them', () => {
    expect(labor).toMatch(/deadline: governingDeadline\(j\)/)
    expect(labor).toMatch(/lapsed: hasLapsed\(j, nowSec\)/)
    // V1 has no deadlines; null/false are the honest answers, not placeholders.
    expect(labor).toMatch(/deadline: null/)
  })
})
