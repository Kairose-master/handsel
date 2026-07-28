import { describe, expect, it } from 'vitest'
import {
  authorOfRule,
  decideRefund,
  decisionTableToMarkdown,
  REFUND_GATE_TABLE,
  type RefundGround,
} from '@/lib/decision-table'

/**
 * The gate that decides whether a dispute returns escrow.
 *
 * It exists because the alternative is a live theft path. `lib/text-grading.ts`
 * interpolates the requester's `acceptanceCriteria` raw into the grader's prompt
 * and the system prompt says those criteria ARE the contract — so a requester
 * can author a rule nothing can satisfy, collect the finished deliverable
 * off-chain the moment it is submitted, and have the verdict hand the money
 * back too. The work is done, the worker is unpaid, and every step looks
 * legitimate in the logs.
 *
 * So: **a verdict may never move money toward the party who authored the rule
 * that produced it.** Everything else here is a consequence of that line.
 */

const ground = (o: Parameters<typeof decideRefund>[0]): RefundGround => decideRefund(o).ground
const decision = (o: Parameters<typeof decideRefund>[0]) => decideRefund(o).decision

describe('the four grounds', () => {
  it('refunds when nothing was delivered at all', () => {
    // A fact about bytes. Nobody's opinion is involved and nobody can fake the
    // absence of their own submission.
    expect(decideRefund({ hasDeliverable: false })).toMatchObject({
      decision: 'refund',
      ground: 'NO_DELIVERABLE',
    })
  })

  it('refunds when the delivered bytes are not the committed bytes', () => {
    expect(ground({ hasDeliverable: true, hashMismatch: 'yes' })).toBe('SUBSTITUTED')
  })

  it('refunds when the artifact kind contradicts the sealed brief', () => {
    expect(ground({ hasDeliverable: true, kindMismatch: 'yes' })).toBe('WRONG_KIND')
  })

  it('refunds on a failing PLATFORM-authored grader', () => {
    expect(ground({ hasDeliverable: true, verdict: 'fail', ruleAuthor: 'platform' })).toBe(
      'PLATFORM_TESTS_FAIL',
    )
  })
})

describe('THE INVARIANT — a verdict cannot pay the author of its own rule', () => {
  it('never refunds on a requester-authored rule, whatever it says', () => {
    // The whole free-work fix, in one assertion. Enumerated rather than
    // spot-checked: every verdict a requester-authored rule can produce, with
    // every combination of the evidence that is genuinely unknown.
    for (const verdict of ['fail', 'pass', 'pending'] as const) {
      for (const hashMismatch of ['no', 'unknown'] as const) {
        for (const kindMismatch of ['no', 'unknown'] as const) {
          expect(
            decision({ hasDeliverable: true, verdict, ruleAuthor: 'requester', hashMismatch, kindMismatch }),
            `requester-authored ${verdict} must not refund`,
          ).toBe('no_refund')
        }
      }
    }
  })

  it('treats a missing author as requester, not as platform', () => {
    // Fail closed. An unlabelled verdict is one nobody has vouched for, and the
    // safe reading of "I do not know who wrote this rule" is "not the platform".
    expect(decision({ hasDeliverable: true, verdict: 'fail' })).toBe('no_refund')
  })

  it('still refunds a requester-authored dispute on grounds they did NOT author', () => {
    // The invariant restricts the VERDICT, not the requester. Someone who was
    // genuinely sent nothing is still made whole.
    expect(ground({ hasDeliverable: false, verdict: 'fail', ruleAuthor: 'requester' })).toBe(
      'NO_DELIVERABLE',
    )
    expect(ground({ hasDeliverable: true, hashMismatch: 'yes', verdict: 'pass', ruleAuthor: 'requester' })).toBe(
      'SUBSTITUTED',
    )
  })
})

describe('unknown evidence is not evidence', () => {
  it.each([
    ['an artifact that could not be fetched', { hasDeliverable: true, hashMismatch: 'unknown' as const }],
    ['a legacy spec hash that cannot be verified', { hasDeliverable: true, kindMismatch: 'unknown' as const }],
    ['a grader that never ran', { hasDeliverable: true, verdict: 'pending' as const, ruleAuthor: 'platform' as const }],
  ])('degrades toward no_refund: %s', (_label, input) => {
    // Every unknown must fall the same way. A gate that refunds when it cannot
    // tell is a gate an attacker reaches by breaking the thing that tells it —
    // taking an artifact host offline would become a way to claw money back.
    expect(decision(input)).toBe('no_refund')
  })

  it('never confuses "no mismatch" with "mismatch unknown"', () => {
    expect(decision({ hasDeliverable: true, hashMismatch: 'no', kindMismatch: 'no' })).toBe('no_refund')
  })
})

describe('the fall-through', () => {
  it('lands on a state that needs nobody', () => {
    // decideAutoRelease falls through to `manual_review` — a state that needs a
    // person, which is exactly what this whole change exists to remove. This
    // falls through to the review deadline, which needs no one.
    const out = decideRefund({ hasDeliverable: true })
    expect(out).toMatchObject({ decision: 'no_refund', ground: 'NONE' })
    expect(out.reason).toMatch(/deadline/)
  })

  it('is total — every input combination produces a decision', () => {
    // A null from evaluate() would fall back to no_refund silently. Better to
    // know the table actually covers its own input space.
    for (const hasDeliverable of [true, false]) {
      for (const hashMismatch of ['yes', 'no', 'unknown'] as const) {
        for (const kindMismatch of ['yes', 'no', 'unknown'] as const) {
          for (const verdict of ['pass', 'fail', 'pending'] as const) {
            for (const ruleAuthor of ['requester', 'platform'] as const) {
              const out = decideRefund({ hasDeliverable, hashMismatch, kindMismatch, verdict, ruleAuthor })
              expect(['refund', 'no_refund']).toContain(out.decision)
              expect(out.reason.length).toBeGreaterThan(0)
            }
          }
        }
      }
    }
  })
})

describe('the table is the rule, and it is publishable', () => {
  it('renders to markdown for the public ruling log', () => {
    const md = decisionTableToMarkdown(REFUND_GATE_TABLE)
    expect(md).toContain('Dispute refund gate')
    for (const g of ['NO_DELIVERABLE', 'SUBSTITUTED', 'WRONG_KIND', 'PLATFORM_TESTS_FAIL']) {
      expect(md).toContain(g)
    }
  })

  it('has no rule that reads a requester-authored verdict', () => {
    // The invariant is enforced in decideRefund and not in the table, because a
    // table row is something a person can add without noticing what it implies.
    // This asserts the table has no input that could carry one.
    expect(REFUND_GATE_TABLE.inputs.map((i) => i.key)).not.toContain('verdict')
    expect(REFUND_GATE_TABLE.inputs.map((i) => i.key)).toContain('platformVerdict')
  })
})

describe('authorOfRule', () => {
  it('answers platform only for an explicitly recorded binding', () => {
    expect(authorOfRule({ testSuiteSlug: 'two-sum' })).toBe('platform')
  })

  it('answers requester for everything else, including unlabelled', () => {
    expect(authorOfRule({ testSuiteSlug: null })).toBe('requester')
    expect(authorOfRule({})).toBe('requester')
    expect(authorOfRule({ testSuiteSlug: '' })).toBe('requester')
  })

  it('cannot be reached through a job TITLE', () => {
    // The forgeable path, closed. resolveTestSuiteSpec() maps a title prefix to
    // a platform grader, and a title is whatever the requester typed — so
    // titling a job `tests → two-sum:` would otherwise buy a platform-authored
    // verdict on unrelated work, which fails, which refunds them.
    const spec = { title: 'tests → two-sum: write the acceptance tests for twoSum()' } as {
      title: string
      testSuiteSlug?: string | null
    }
    expect(authorOfRule(spec)).toBe('requester')
    expect(decideRefund({ hasDeliverable: true, verdict: 'fail', ruleAuthor: authorOfRule(spec) }).decision).toBe(
      'no_refund',
    )
  })
})
