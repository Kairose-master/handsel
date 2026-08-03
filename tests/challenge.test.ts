import { describe, expect, it } from 'vitest'
import {
  challengeHeadline,
  describeChallenge,
  isChallengeTitle,
  pickChallengeJob,
  type ChallengeJobInput,
} from '@/lib/challenge'

/**
 * The page these back advertises real money. Every state below is one the
 * chain has actually been in or can reach in a day, and the reason they are
 * unit-tested rather than eyeballed is job #2: the first $100 escrow lapsed
 * and was refunded. A page that could only render "locked" would have gone on
 * claiming a prize that had already come back.
 */

const DAY = 86_400
const NOW = 1_785_000_000
const WINDOW = 30

const job = (over: Partial<ChallengeJobInput> = {}): ChallengeJobInput => ({
  id: 3,
  status: 'Accepted',
  bounty: 100,
  deadline: NOW + 18 * DAY,
  worker: '0xw',
  ...over,
})

describe('recognising the challenge escrow', () => {
  it('matches on the published title prefix, case and padding insensitive', () => {
    expect(isChallengeTitle('OPEN CHALLENGE — $100 escrow, deliberately locked')).toBe(true)
    expect(isChallengeTitle('  open challenge — take it')).toBe(true)
    expect(isChallengeTitle('Fetch the document content')).toBe(false)
    expect(isChallengeTitle(null)).toBe(false)
    expect(isChallengeTitle(undefined)).toBe(false)
  })

  it('picks the highest id, so a replacement escrow supersedes a lapsed one', () => {
    // Exactly the live history: #2 refunded, #3 accepted.
    const jobs = [job({ id: 2, status: 'Refunded' }), job({ id: 3 }), job({ id: 5, status: 'Open' })]
    const titles = new Map([
      [2, 'OPEN CHALLENGE — $100 escrow'],
      [3, 'OPEN CHALLENGE — $100 escrow'],
      [5, 'Query agent wallet balance'],
    ])
    expect(pickChallengeJob(jobs, (j) => titles.get(j.id))?.id).toBe(3)
  })

  it('returns null when nothing on the board is a challenge', () => {
    expect(pickChallengeJob([job()], () => 'Reverse the words of a string')).toBeNull()
    expect(pickChallengeJob([], () => 'OPEN CHALLENGE')).toBeNull()
  })
})

describe('classifying the escrow', () => {
  it('Accepted with time left is live, and counts both directions', () => {
    const s = describeChallenge(job(), NOW, WINDOW)
    expect(s.kind).toBe('live')
    if (s.kind !== 'live') return
    expect(s.prizeUsd).toBe(100)
    expect(s.daysElapsed).toBe(12) // 30-day window, 18 left
    expect(s.daysLeft).toBe(18)
    expect(s.endsAt).toBe(NOW + 18 * DAY)
  })

  it('Accepted past its deadline is LAPSED, not live', () => {
    // The distinction the page exists to make. An accepted job whose delivery
    // window closed is reclaimable by a sweep, so the prize is no longer
    // reliably locked — and `status` alone still reads "Accepted", which is
    // exactly how a stale page keeps advertising money that is on its way out.
    const s = describeChallenge(job({ deadline: NOW - DAY }), NOW, WINDOW)
    expect(s.kind).toBe('lapsed')
    if (s.kind !== 'lapsed') return
    expect(s.daysElapsed).toBe(31)
  })

  it('the boundary second is lapsed, not live', () => {
    expect(describeChallenge(job({ deadline: NOW }), NOW, WINDOW).kind).toBe('lapsed')
    expect(describeChallenge(job({ deadline: NOW + 1 }), NOW, WINDOW).kind).toBe('live')
  })

  it('Refunded is settled and not taken — job #2, exactly', () => {
    const s = describeChallenge(job({ id: 2, status: 'Refunded' }), NOW, WINDOW)
    expect(s).toEqual({ kind: 'settled', jobId: 2, prizeUsd: 100, status: 'Refunded', taken: false })
  })

  it('Completed means the money left, and says so', () => {
    // A self-to-self challenge escrow should never complete. If it does, that
    // is the headline, not a footnote.
    const s = describeChallenge(job({ status: 'Completed' }), NOW, WINDOW)
    expect(s.kind).toBe('settled')
    if (s.kind !== 'settled') return
    expect(s.taken).toBe(true)
  })

  it('an accepted job with no deadline is not a live challenge', () => {
    // V1 jobs carry no deadlines at all. Rendering one as "live, day N" would
    // invent a clock the chain never had.
    expect(describeChallenge(job({ deadline: null }), NOW, WINDOW).kind).toBe('settled')
  })

  it('no job at all is its own state', () => {
    expect(describeChallenge(null, NOW, WINDOW)).toEqual({ kind: 'none' })
  })

  it('never reports negative days elapsed', () => {
    // A deadline further out than the window (someone re-posted with a longer
    // one) must not render "Day -4".
    const s = describeChallenge(job({ deadline: NOW + 40 * DAY }), NOW, WINDOW)
    expect(s.kind).toBe('live')
    if (s.kind !== 'live') return
    expect(s.daysElapsed).toBe(0)
  })
})

describe('the headline', () => {
  it('is the one the doc specifies while the money is locked', () => {
    expect(challengeHeadline(describeChallenge(job(), NOW, WINDOW))).toBe('$100. Day 12. Still here.')
  })

  it('does not say "still here" when it is not', () => {
    for (const state of [
      describeChallenge(job({ deadline: NOW - DAY }), NOW, WINDOW),
      describeChallenge(job({ status: 'Refunded' }), NOW, WINDOW),
      describeChallenge(null, NOW, WINDOW),
    ]) {
      expect(challengeHeadline(state)).not.toContain('Still here')
    }
  })

  it('names the job and its status when no prize is locked', () => {
    expect(challengeHeadline(describeChallenge(job({ id: 2, status: 'Refunded' }), NOW, WINDOW))).toBe(
      'No prize locked right now (job #2 is Refunded).',
    )
  })
})
