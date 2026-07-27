import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  RECONCILE_GRACE_MS,
  decideBountyCancel,
  explainBountyReason,
  type BountyFact,
  type BountyReason,
} from '@/lib/bounty-reconcile'

/**
 * The decision, alone. Cancelling spends a requester's escrow, so the property
 * that matters is not "does it catch the abandoned ones" — it is "does it ever
 * cancel one it should not."
 */

const OLD = RECONCILE_GRACE_MS + 1
const live: BountyFact = { issueState: 'open', hasBountyLabel: true, jobStatus: 'Open', ageMs: OLD }

describe('it cancels a bounty nobody wants any more', () => {
  it('when the issue was closed', () => {
    expect(decideBountyCancel({ ...live, issueState: 'closed' })).toEqual({
      cancel: true,
      reason: 'issue-closed',
    })
  })

  it('when the label was removed', () => {
    expect(decideBountyCancel({ ...live, hasBountyLabel: false })).toEqual({
      cancel: true,
      reason: 'label-removed',
    })
  })

  it('when both — closed wins, and the reason must say which', () => {
    // Not cosmetic: the issue comment quotes the reason back, and "the label
    // was removed" on an issue somebody closed reads as a bug.
    expect(decideBountyCancel({ ...live, issueState: 'closed', hasBountyLabel: false }).reason).toBe('issue-closed')
  })
})

describe('it refuses to act on missing evidence', () => {
  // failure-modes invariant 5, and §12: an empty result from a failed read is
  // not an empty world. Every one of these would be a refund of a live bounty.
  it('does not cancel when the chain could not be read', () => {
    expect(decideBountyCancel({ ...live, jobStatus: null, issueState: 'closed' })).toEqual({
      cancel: false,
      reason: 'chain-unreadable',
    })
  })

  it('does not cancel when GitHub could not be read', () => {
    // A 404 means the App lost access or the repo went private. Treating it as
    // "closed" would refund every bounty in a repo the moment a token expired.
    expect(decideBountyCancel({ ...live, issueState: null, hasBountyLabel: null }).cancel).toBe(false)
  })

  it('does not cancel on a half-read issue — state without labels', () => {
    expect(decideBountyCancel({ ...live, hasBountyLabel: null, issueState: 'open' }).cancel).toBe(false)
  })

  it('leaves a live, labelled issue alone', () => {
    expect(decideBountyCancel(live)).toEqual({ cancel: false, reason: 'still-wanted' })
  })
})

describe('a claimed job outlives its label', () => {
  it.each(['Accepted', 'Submitted', 'Disputed'])('does not cancel a %s job', (jobStatus) => {
    // A worker has committed real work. The requester closing the issue must
    // not be able to destroy it — this is the rule the webhook already
    // enforces, restated here because the sweep runs without a webhook.
    expect(decideBountyCancel({ ...live, jobStatus, issueState: 'closed' })).toEqual({
      cancel: false,
      reason: 'not-open',
    })
  })

  it('does not resurrect a settled job either', () => {
    for (const jobStatus of ['Completed', 'Refunded', 'Cancelled']) {
      expect(decideBountyCancel({ ...live, jobStatus, issueState: 'closed' }).cancel).toBe(false)
    }
  })
})

describe('the grace window', () => {
  it('leaves a freshly posted bounty alone', () => {
    // The posting webhook holds a two-minute lock across a ~30s on-chain round
    // trip. Reading GitHub inside that window can see the issue before the
    // label event settles.
    expect(decideBountyCancel({ ...live, issueState: 'closed', ageMs: 0 })).toEqual({
      cancel: false,
      reason: 'too-new',
    })
  })

  it('is long enough to outlast the posting round trip and a re-label', () => {
    expect(RECONCILE_GRACE_MS).toBeGreaterThan(5 * 60_000)
  })

  it('acts once the window has passed', () => {
    expect(decideBountyCancel({ ...live, issueState: 'closed', ageMs: RECONCILE_GRACE_MS }).cancel).toBe(true)
  })

  it('checks age before touching GitHub, so a young bounty costs no API call', () => {
    // The sweep short-circuits on any reason other than issue-unreadable, so
    // `too-new` must be decidable with both GitHub fields still null.
    const verdict = decideBountyCancel({ issueState: null, hasBountyLabel: null, jobStatus: 'Open', ageMs: 0 })
    expect(verdict.reason).toBe('too-new')
  })
})

describe('every outcome is named', () => {
  const REASONS: BountyReason[] = [
    'chain-unreadable',
    'not-open',
    'too-new',
    'issue-unreadable',
    'issue-closed',
    'label-removed',
    'still-wanted',
  ]

  it('reaches every reason from some real input', () => {
    // A sweep reporting "0 cancelled" without saying what it saw is
    // indistinguishable from one that is broken (§18). An unreachable reason
    // means the enumeration lies about the decision.
    const reached = new Set(
      [
        { ...live, jobStatus: null },
        { ...live, jobStatus: 'Accepted' },
        { ...live, ageMs: 0 },
        { ...live, issueState: null, hasBountyLabel: null },
        { ...live, issueState: 'closed' as const },
        { ...live, hasBountyLabel: false },
        live,
      ].map((f) => decideBountyCancel(f).reason),
    )
    expect([...reached].sort()).toEqual([...REASONS].sort())
  })

  it('explains each one in words a person can act on', () => {
    for (const reason of REASONS) {
      expect(explainBountyReason(reason).length).toBeGreaterThan(10)
    }
  })

  it('has no reason the switch forgot', () => {
    // explainBountyReason has no default branch; a new reason without a case
    // fails tsc. This pins the reverse — a case for a reason nobody emits.
    const source = readFileSync('lib/bounty-reconcile.ts', 'utf8')
    const cases = [...source.matchAll(/^ {4}case '([a-z-]+)':$/gm)].map((m) => m[1])
    expect(cases.sort()).toEqual([...REASONS].sort())
  })
})

describe('it is wired into the ops cycle', () => {
  it('runs as a step, or none of the above ever executes', () => {
    // The whole point is that this runs without a webhook. A module nothing
    // calls is the bug it was written to fix, wearing a different file name.
    expect(readFileSync('lib/ops-cycle.ts', 'utf8')).toContain('reconcileBounties')
  })
})
