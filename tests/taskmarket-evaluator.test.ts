import { describe, expect, it } from 'vitest'
import {
  SCORE_SCALE_BPS,
  VERDICT_APPROVE,
  VERDICT_PARTIAL,
  VERDICT_REJECT,
  awardsProblem,
  toBps,
  toEvaluateArgs,
  type EvaluatorAward,
  type HandselGrade,
} from '@/lib/taskmarket-evaluator'

/**
 * These tests are the claim "Handsel can be an evaluator for someone else's
 * market", made checkable. The stub they replace
 * (`daydreamsai/skills-market#58`) returned a hardcoded pass, so the first and
 * last tests here exist to make that specific failure impossible to reintroduce:
 * REJECT must be reachable, and an ungraded deliverable must produce no verdict
 * at all rather than a convenient one.
 */

const WORKER = '0x1111111111111111111111111111111111111111' as const
const WORKER_2 = '0x2222222222222222222222222222222222222222' as const
const HASH = `0x${'a'.repeat(64)}` as const
const ZERO_HASH = `0x${'0'.repeat(64)}`
const REWARD = '5000000' // 5 USDC, 6 decimals

const award = (over: Partial<EvaluatorAward> = {}): EvaluatorAward => ({
  worker: WORKER,
  amount: REWARD,
  rank: 0,
  ...over,
})

const passed = (over: Partial<HandselGrade> = {}): HandselGrade => ({
  passed: true,
  reason: 'meets every criterion',
  proof: { id: 'p1', contentHash: HASH, attester: '0x81C76907812A098427E177B1Ef9779157a3D3B68' },
  ...over,
})

describe('the verdict that makes the stake mean something', () => {
  it('a failed deliverable reaches REJECT — the check can fail', () => {
    const d = toEvaluateArgs({
      grade: { passed: false, reason: 'the diff does not compile' },
      rewardBaseUnits: REWARD,
      awards: [award()],
    })
    expect(d.submit).toBe(true)
    if (!d.submit) return
    expect(d.args.verdictType).toBe(VERDICT_REJECT)
    expect(d.args.awards).toEqual([]) // a rejection pays nobody
    expect(d.reason).toContain('does not compile')
  })

  it('a REJECT carries no evidence hash, because nothing passed to anchor', () => {
    const d = toEvaluateArgs({
      grade: { passed: false, reason: 'fails' },
      rewardBaseUnits: REWARD,
      awards: [award()],
    })
    if (!d.submit) throw new Error('expected a submission')
    expect(d.args.evidenceHash).toBe(ZERO_HASH)
  })

  it('a passing deliverable reaches APPROVE and anchors the proof hash verbatim', () => {
    const d = toEvaluateArgs({ grade: passed(), rewardBaseUnits: REWARD, awards: [award()] })
    if (!d.submit) throw new Error('expected a submission')
    expect(d.args.verdictType).toBe(VERDICT_APPROVE)
    // The whole point of the integration: their bytes32 is our contentHash,
    // unmodified, so a reader can fetch /api/proof/<id> and recover the signer.
    expect(d.args.evidenceHash).toBe(HASH)
  })
})

describe('a timing state never collapses into a validity state', () => {
  it('passed: null submits nothing and lets the protocol charge us the stake', () => {
    const d = toEvaluateArgs({
      grade: { passed: null, reason: 'no LLM key on the account' },
      rewardBaseUnits: REWARD,
      awards: [award()],
    })
    expect(d.submit).toBe(false)
    if (d.submit) return
    expect(d.fallback).toBe('evaluatorTimeout')
    expect(d.reason).toContain('no LLM key')
    // Naming the consequence in the payload, so an operator reading a skipped
    // task sees who pays for the silence.
    expect(d.reason).toMatch(/stake is forfeit/i)
  })

  it('an ungraded deliverable is never quietly approved', () => {
    const d = toEvaluateArgs({
      grade: { passed: null, reason: 'provider error' },
      rewardBaseUnits: REWARD,
      awards: [award()],
    })
    expect(JSON.stringify(d)).not.toContain('"verdictType"')
  })
})

describe('no evidence, no verdict', () => {
  it('a pass with no work proof produces no submission', () => {
    const d = toEvaluateArgs({
      grade: passed({ proof: undefined }),
      rewardBaseUnits: REWARD,
      awards: [award()],
    })
    expect(d.submit).toBe(false)
    if (d.submit) return
    expect(d.fallback).toBe('evaluatorTimeout')
    expect(d.reason).toMatch(/no signed work proof/i)
  })

  it('a malformed contentHash is treated as no proof, not coerced', () => {
    const d = toEvaluateArgs({
      grade: passed({ proof: { id: 'p', contentHash: '0xdeadbeef', attester: '0x0' } }),
      rewardBaseUnits: REWARD,
      awards: [award()],
    })
    expect(d.submit).toBe(false)
  })
})

describe('awards may never exceed the escrow', () => {
  it('an overrun refuses rather than broadcasting a call that must revert', () => {
    const d = toEvaluateArgs({
      grade: passed(),
      rewardBaseUnits: REWARD,
      awards: [award({ amount: '5000001' })],
    })
    expect(d.submit).toBe(false)
    if (d.submit) return
    expect(d.reason).toContain('exceed task reward')
  })

  it('splitting the escrow across winners is PARTIAL, not APPROVE', () => {
    const d = toEvaluateArgs({
      grade: passed(),
      rewardBaseUnits: REWARD,
      awards: [award({ amount: '3000000', rank: 0 }), award({ worker: WORKER_2, amount: '1000000', rank: 1 })],
    })
    if (!d.submit) throw new Error('expected a submission')
    expect(d.args.verdictType).toBe(VERDICT_PARTIAL)
  })

  it('paying out the full escrow across winners is still APPROVE', () => {
    const d = toEvaluateArgs({
      grade: passed(),
      rewardBaseUnits: REWARD,
      awards: [award({ amount: '3000000', rank: 0 }), award({ worker: WORKER_2, amount: '2000000', rank: 1 })],
    })
    if (!d.submit) throw new Error('expected a submission')
    expect(d.args.verdictType).toBe(VERDICT_APPROVE)
  })

  it('names each way an award list is unusable', () => {
    expect(awardsProblem([], REWARD)).toMatch(/no winner/)
    expect(awardsProblem([award({ worker: '0xnope' as `0x${string}` })], REWARD)).toMatch(/not an address/)
    expect(awardsProblem([award({ amount: '1.5' })], REWARD)).toMatch(/not a base-unit integer/)
    expect(awardsProblem([award({ rank: -1 })], REWARD)).toMatch(/uint16 range/)
    expect(awardsProblem([award({ amount: '0' })], REWARD)).toMatch(/total zero/)
    expect(awardsProblem([award({ amount: '1' }), award({ amount: '1' })], REWARD)).toMatch(/duplicate/)
    expect(awardsProblem([award()], '5000000')).toBeNull()
  })
})

describe('score and confidence stay inside uint16 with a published scale', () => {
  it('maps 0..1 onto basis points and clamps both ends', () => {
    expect(toBps(0)).toBe(0)
    expect(toBps(1)).toBe(SCORE_SCALE_BPS)
    expect(toBps(0.5)).toBe(5000)
    expect(toBps(2)).toBe(SCORE_SCALE_BPS)
    expect(toBps(-1)).toBe(0)
  })

  it('never emits NaN — an unreadable score is 0, not an arbitrary number', () => {
    expect(toBps(NaN)).toBe(0)
    expect(toBps(undefined)).toBe(0)
    // Infinity is garbage, not a perfect score. Clamping it to the maximum
    // would invent a 100% grade out of a parse failure — the same shape of
    // error as approving an ungraded deliverable, one field down.
    expect(toBps(Infinity)).toBe(0)
    expect(toBps(-Infinity)).toBe(0)
  })

  it('every emitted score and confidence fits uint16', () => {
    const d = toEvaluateArgs({
      grade: passed(),
      rewardBaseUnits: REWARD,
      awards: [award()],
      score: 99,
      confidence: 99,
    })
    if (!d.submit) throw new Error('expected a submission')
    expect(d.args.score).toBeLessThanOrEqual(65535)
    expect(d.args.confidence).toBeLessThanOrEqual(65535)
    expect(Number.isInteger(d.args.score)).toBe(true)
  })

  it('a missing confidence is 0 and says nothing about how sure we were', () => {
    const d = toEvaluateArgs({ grade: passed(), rewardBaseUnits: REWARD, awards: [award()] })
    if (!d.submit) throw new Error('expected a submission')
    expect(d.args.confidence).toBe(0)
  })
})

describe('the enum ordering is theirs, not ours', () => {
  it('matches ITMPCore.VerdictType { APPROVE, REJECT, PARTIAL }', () => {
    // Pinned because getting this wrong silently pays a failing worker.
    expect([VERDICT_APPROVE, VERDICT_REJECT, VERDICT_PARTIAL]).toEqual([0, 1, 2])
  })
})
