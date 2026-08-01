import { describe, expect, it } from 'vitest'
import {
  assessCredit,
  creditLimitForScore,
  type AgentEventInput,
} from '@/lib/credit-engine/scoring'
import { DEFAULT_TERMS } from '@/lib/reputation-lending'

/**
 * One job used to be worth a five-figure credit line.
 *
 * Measured on the shipped defaults before `NO_EVIDENCE_FACTOR` existed: a
 * single completed, independently-graded job scored **673 (BB) with a $5,250
 * limit** — over the 600 lending gate on its first day. Ten jobs was AA, fifty
 * was AAA. The cause was not the weights; it was the prior. `dampen` shrank
 * every factor toward 50, and 50 maps to 645, so an agent the engine knew
 * nothing about started above the gate and evidence only nudged it.
 *
 * That contradicts the one thing this product claims — a credit score *earned
 * from real behaviour*. These tests pin the property rather than the numbers:
 * a thin history must not reach the gate, and the curve must be a curve rather
 * than the cliff a hardcoded `score: 300` branch was papering over.
 */

const NOW = new Date('2026-08-01T00:00:00Z')
const HOUR = 3_600_000

const ev = (o: Partial<AgentEventInput> = {}): AgentEventInput => ({
  eventType: 'VERIFIED_TASK_COMPLETED',
  success: true,
  executionTime: 30,
  tokenCost: 100,
  qualityScore: 0.9,
  createdAt: NOW,
  counterparty: null,
  grader: 'code',
  counterpartyScore: null,
  exposureUsd: 10,
  counterpartyOtherPartners: null,
  ...o,
})

/** The most flattering history a worker of this size can have: every job
 *  passed, every counterparty independent and well-scored, every grade from a
 *  grader the pair cannot author. If the gate holds against THIS, it holds. */
function spotlessHistory(jobs: number): AgentEventInput[] {
  const out: AgentEventInput[] = []
  for (let i = 0; i < jobs; i++) {
    const createdAt = new Date(NOW.getTime() - (i + 1) * HOUR)
    out.push(ev({ createdAt }))
    out.push(
      ev({
        eventType: 'JOB_COMPLETED',
        counterparty: `client-${i}`,
        counterpartyScore: 700,
        counterpartyOtherPartners: 5,
        createdAt,
      }),
    )
  }
  return out
}

const scoreAt = (jobs: number) => assessCredit(spotlessHistory(jobs), undefined, NOW).score

describe('a thin history cannot buy credit', () => {
  it('one flawless job does not reach the lending gate', () => {
    const one = assessCredit(spotlessHistory(1), undefined, NOW)
    expect(one.score).toBeLessThan(DEFAULT_TERMS.minScore)
    // And the score-derived ceiling is zero, before the collateral cap in
    // credit-engine/index.ts even gets a turn. Two independent gates, and the
    // first one should already be shut.
    expect(creditLimitForScore(one.score)).toBe(0)
  })

  it('so does a second and a third', () => {
    expect(scoreAt(2)).toBeLessThan(DEFAULT_TERMS.minScore)
    expect(scoreAt(3)).toBeLessThan(DEFAULT_TERMS.minScore)
  })

  it('the gate is reachable — this is a slope, not a wall', () => {
    // Guards the opposite failure: a prior so punishing that no amount of
    // honest work ever clears the gate would make the lending path dead code.
    expect(scoreAt(20)).toBeGreaterThan(DEFAULT_TERMS.minScore)
  })
})

describe('the curve is continuous at the cold start', () => {
  it('no-evidence sits at the documented floor', () => {
    const none = assessCredit([], undefined, NOW)
    expect(none.score).toBe(300)
    expect(none.rating).toBe('D')
    expect(none.creditLimit).toBe(0)
  })

  it('the first job is a step, not a leap', () => {
    // The old behaviour jumped 300 → 673 on one event. The exact size of the
    // step is a tuning decision; that it is not a third of the whole range is
    // the property.
    const step = scoreAt(1) - 300
    expect(step).toBeGreaterThan(0)
    expect(step).toBeLessThan(150)
  })

  it('score rises monotonically with evidence', () => {
    const counts = [0, 1, 2, 3, 5, 8, 10, 20, 50]
    const scores = counts.map(scoreAt)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1])
    }
  })
})

describe('what the change must NOT do', () => {
  it('an established agent is not re-scored into the floor', () => {
    // The anchor change costs a long history very little — it is a statement
    // about ignorance, and a 50-job agent is not unknown. If a future tweak
    // craters proven agents, that is a different bug and this catches it.
    expect(scoreAt(50)).toBeGreaterThan(850)
  })

  it('never having borrowed is still not the same as defaulting', () => {
    // paymentHistory is a RAW input held at 50 for an agent with no repayment
    // events, deliberately, and dampening the factors must not reach through
    // and turn "no loans" into "bad loans".
    const history = spotlessHistory(10)
    const defaulted = assessCredit(
      [
        ...history,
        ev({
          eventType: 'REPAYMENT_DEFAULTED',
          success: false,
          qualityScore: null,
          createdAt: NOW,
        }),
      ],
      undefined,
      NOW,
    )
    expect(defaulted.score).toBeLessThan(scoreAt(10))
  })

  it('padding a record with failures cannot raise the score', () => {
    // The defect this file found while being written. Dampening trades
    // certainty for sample size, and the sample size used to be every terminal
    // task — so failures BOUGHT confidence, which scaled the surviving factors
    // back up. Five successes plus five failures scored 649 against 640 for the
    // five successes alone: a strictly worse agent, a strictly better number.
    const base = spotlessHistory(5)
    for (const padding of [1, 3, 5, 20]) {
      const padded = [
        ...base,
        ...Array.from({ length: padding }, (_, i) =>
          ev({
            eventType: 'VERIFIED_TASK_FAILED',
            success: false,
            qualityScore: null,
            createdAt: new Date(NOW.getTime() - (i + 20) * HOUR),
          }),
        ),
      ]
      expect(assessCredit(padded, undefined, NOW).score).toBeLessThan(scoreAt(5))
    }
  })

  it('failure still outweighs the same volume of success', () => {
    const good = spotlessHistory(5)
    const mixed = [
      ...good,
      ...Array.from({ length: 5 }, (_, i) =>
        ev({
          eventType: 'VERIFIED_TASK_FAILED',
          success: false,
          qualityScore: null,
          createdAt: new Date(NOW.getTime() - (i + 20) * HOUR),
        }),
      ),
    ]
    expect(assessCredit(mixed, undefined, NOW).score).toBeLessThan(scoreAt(5))
  })
})
