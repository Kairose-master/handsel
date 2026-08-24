/**
 * Planner-output guardrail tests. These checks are what stand between a
 * misbehaving/jailbroken planner LLM and real escrowed money, so they get
 * pinned: count bounds, per-subtask validation, and the budget ceiling.
 */
import { describe, it, expect } from 'vitest'
import {
  parsePlannerOutput,
  parseReviewVerdict,
  reviewTierGate,
  finalReviewerFor,
  MAX_SUBTASKS,
  MAX_REVIEW_TIERS,
  type DelegationSubtask,
} from '@/lib/delegation'

const goodSubtask = (over: Record<string, unknown> = {}) => ({
  title: 'Write flatten(xs)',
  description: 'Write a self-contained Python function flatten(xs)…',
  acceptanceCriteria: 'A function named flatten that flattens one level.',
  bountyUsd: 5,
  ...over,
})

describe('parsePlannerOutput', () => {
  it('parses a valid plan and normalizes bounties to cents', () => {
    const out = parsePlannerOutput(JSON.stringify([goodSubtask({ bountyUsd: 4.999 })]), 15)
    expect(out).toHaveLength(1)
    expect(out[0].bountyUsd).toBe(5)
    expect(out[0].testCode).toBeNull()
  })

  it('strips markdown code fences before parsing', () => {
    const fenced = '```json\n' + JSON.stringify([goodSubtask()]) + '\n```'
    expect(parsePlannerOutput(fenced, 15)).toHaveLength(1)
  })

  it('keeps testCode when present and non-empty', () => {
    const out = parsePlannerOutput(JSON.stringify([goodSubtask({ testCode: 'assert flatten([[1]]) == [1]' })]), 15)
    expect(out[0].testCode).toContain('assert')
  })

  it('rejects unparseable output', () => {
    expect(() => parsePlannerOutput('sure! here is the plan:', 15)).toThrow(/unparseable/)
  })

  it('rejects an empty plan and an oversized plan', () => {
    expect(() => parsePlannerOutput('[]', 15)).toThrow()
    const tooMany = Array.from({ length: MAX_SUBTASKS + 1 }, () => goodSubtask({ bountyUsd: 1 }))
    expect(() => parsePlannerOutput(JSON.stringify(tooMany), 100)).toThrow()
  })

  it('rejects subtasks missing required fields', () => {
    expect(() => parsePlannerOutput(JSON.stringify([goodSubtask({ title: '' })]), 15)).toThrow(/missing/)
    expect(() => parsePlannerOutput(JSON.stringify([goodSubtask({ acceptanceCriteria: 'short' })]), 15)).toThrow(/missing/)
  })

  it('rejects invalid bounties', () => {
    expect(() => parsePlannerOutput(JSON.stringify([goodSubtask({ bountyUsd: 0 })]), 15)).toThrow(/invalid bounty/)
    expect(() => parsePlannerOutput(JSON.stringify([goodSubtask({ bountyUsd: 'free' })]), 15)).toThrow(/invalid bounty/)
  })

  it('rejects a plan whose bounties exceed the budget — the hard money guard', () => {
    const plan = [goodSubtask({ bountyUsd: 8 }), goodSubtask({ bountyUsd: 8 })]
    expect(() => parsePlannerOutput(JSON.stringify(plan), 15)).toThrow(/exceeded the budget/)
  })

  it('accepts a plan exactly at budget', () => {
    const plan = [goodSubtask({ bountyUsd: 7.5 }), goodSubtask({ bountyUsd: 7.5 })]
    expect(parsePlannerOutput(JSON.stringify(plan), 15)).toHaveLength(2)
  })

  // --- dependency graph (dependsOn) — the DAG handoff ---

  const A = goodSubtask({ title: 'Draft the copy', bountyUsd: 4 })
  const B = (over: Record<string, unknown> = {}) =>
    goodSubtask({ title: 'Polish the copy', bountyUsd: 4, ...over })

  it('parses a valid handoff and carries dependsOn through', () => {
    const out = parsePlannerOutput(JSON.stringify([A, B({ dependsOn: ['Draft the copy'] })]), 15)
    expect(out[1].dependsOn).toEqual(['Draft the copy'])
    expect(out[0].dependsOn).toBeUndefined()
  })

  it('dedupes repeated dependency titles', () => {
    const out = parsePlannerOutput(
      JSON.stringify([A, B({ dependsOn: ['Draft the copy', 'Draft the copy'] })]),
      15,
    )
    expect(out[1].dependsOn).toEqual(['Draft the copy'])
  })

  it('rejects a dependency on an unknown subtask', () => {
    expect(() =>
      parsePlannerOutput(JSON.stringify([A, B({ dependsOn: ['Nonexistent'] })]), 15),
    ).toThrow(/unknown subtask/)
  })

  it('rejects a self-dependency', () => {
    expect(() =>
      parsePlannerOutput(JSON.stringify([B({ dependsOn: ['Polish the copy'] })]), 15),
    ).toThrow(/depends on itself/)
  })

  it('rejects a circular dependency', () => {
    const a = goodSubtask({ title: 'A', bountyUsd: 4, dependsOn: ['B'] })
    const b = goodSubtask({ title: 'B', bountyUsd: 4, dependsOn: ['A'] })
    expect(() => parsePlannerOutput(JSON.stringify([a, b]), 15)).toThrow(/circular/)
  })

  // --- peer review (reviewOf) ---

  it('parses a peer review and auto-depends it on its target', () => {
    const out = parsePlannerOutput(
      JSON.stringify([A, B({ title: 'Review the copy', reviewOf: 'Draft the copy' })]),
      15,
    )
    const rev = out.find((s) => s.reviewOf)!
    expect(rev.reviewOf).toBe('Draft the copy')
    expect(rev.dependsOn).toContain('Draft the copy') // review implies dependency
  })

  it('rejects a review of an unknown or self subtask, and a review of a review', () => {
    expect(() =>
      parsePlannerOutput(JSON.stringify([A, B({ title: 'R', reviewOf: 'Nope' })]), 15),
    ).toThrow(/reviews unknown/)
    expect(() =>
      parsePlannerOutput(JSON.stringify([B({ title: 'R', reviewOf: 'R' })]), 15),
    ).toThrow(/reviews itself/)
    const r1 = goodSubtask({ title: 'R1', bountyUsd: 4, reviewOf: 'Draft the copy' })
    const r2 = goodSubtask({ title: 'R2', bountyUsd: 4, reviewOf: 'R1' })
    expect(() => parsePlannerOutput(JSON.stringify([A, r1, r2]), 15)).toThrow(/review another review/)
  })

  // --- approval chain (reviewTier) — 기안 → 1차 → 2차 → 최종 ---

  it('accepts a single reviewer with no explicit tier (unchanged default behavior)', () => {
    const out = parsePlannerOutput(
      JSON.stringify([A, B({ title: 'Review the copy', reviewOf: 'Draft the copy' })]),
      15,
    )
    expect(out.find((s) => s.reviewOf)!.reviewTier).toBeUndefined()
  })

  it('accepts a contiguous 1..N chain of reviewers for the same target', () => {
    const r1 = B({ title: 'R1', bountyUsd: 4, reviewOf: 'Draft the copy', reviewTier: 1 })
    const r2 = B({ title: 'R2', bountyUsd: 4, reviewOf: 'Draft the copy', reviewTier: 2 })
    const out = parsePlannerOutput(JSON.stringify([A, r1, r2]), 15)
    expect(out.find((s) => s.title === 'R1')!.reviewTier).toBe(1)
    expect(out.find((s) => s.title === 'R2')!.reviewTier).toBe(2)
  })

  it('rejects a gap in the chain (tiers 1 and 3, no 2)', () => {
    const r1 = B({ title: 'R1', bountyUsd: 4, reviewOf: 'Draft the copy', reviewTier: 1 })
    const r3 = B({ title: 'R3', bountyUsd: 4, reviewOf: 'Draft the copy', reviewTier: 3 })
    expect(() => parsePlannerOutput(JSON.stringify([A, r1, r3]), 15)).toThrow(/1\.\.2 approval chain/)
  })

  it('rejects a duplicate tier', () => {
    const r1 = B({ title: 'R1', bountyUsd: 4, reviewOf: 'Draft the copy', reviewTier: 1 })
    const r1b = B({ title: 'R1b', bountyUsd: 4, reviewOf: 'Draft the copy', reviewTier: 1 })
    expect(() => parsePlannerOutput(JSON.stringify([A, r1, r1b]), 15)).toThrow(/1\.\.2 approval chain/)
  })

  it('rejects a chain longer than MAX_REVIEW_TIERS', () => {
    const reviews = Array.from({ length: MAX_REVIEW_TIERS + 1 }, (_, i) =>
      B({ title: `R${i + 1}`, bountyUsd: 1, reviewOf: 'Draft the copy', reviewTier: i + 1 }),
    )
    expect(() => parsePlannerOutput(JSON.stringify([A, ...reviews]), 15)).toThrow(/at most \d+ approval tiers/)
  })
})

describe('parseReviewVerdict', () => {
  it('reads an explicit approval', () => {
    expect(parseReviewVerdict('APPROVE — reads well').approve).toBe(true)
    expect(parseReviewVerdict('LGTM').approve).toBe(true)
  })
  it('reads a revision request, and REVISE wins over a stray approve word', () => {
    expect(parseReviewVerdict('REVISE: tighten the second sentence').approve).toBe(false)
    expect(parseReviewVerdict('I would approve it, but please REVISE the ending').approve).toBe(false)
  })
  it('treats an unclear verdict as a revision — silence is not approval', () => {
    expect(parseReviewVerdict('hmm, interesting work').approve).toBe(false)
  })
})

describe('reviewTierGate — the approval chain never runs a later sign-off ahead of an earlier one', () => {
  const st = (over: Partial<DelegationSubtask> & { title: string }): DelegationSubtask => ({
    description: '',
    acceptanceCriteria: '',
    bountyUsd: 1,
    ...over,
  })

  it('tier 1 (or unset) is always ready — no prior tier to wait on', () => {
    expect(reviewTierGate([], st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1 }))).toEqual({ state: 'ready' })
    expect(reviewTierGate([], st({ title: 'R1', reviewOf: 'Draft' }))).toEqual({ state: 'ready' }) // unset == tier 1
  })

  it('tier 2 is blocked while tier 1 has not delivered a verdict yet', () => {
    const tier1 = st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1 }) // output still null
    const tier2 = st({ title: 'R2', reviewOf: 'Draft', reviewTier: 2 })
    expect(reviewTierGate([tier1, tier2], tier2)).toEqual({ state: 'blocked' })
  })

  it('tier 2 becomes ready the moment tier 1 delivers an APPROVE', () => {
    const tier1 = st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1, output: 'APPROVE — looks good' })
    const tier2 = st({ title: 'R2', reviewOf: 'Draft', reviewTier: 2 })
    expect(reviewTierGate([tier1, tier2], tier2)).toEqual({ state: 'ready' })
  })

  it('tier 2 is aborted — never posted — when tier 1 delivers a REVISE', () => {
    const tier1 = st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1, output: 'REVISE: fix the tone' })
    const tier2 = st({ title: 'R2', reviewOf: 'Draft', reviewTier: 2 })
    expect(reviewTierGate([tier1, tier2], tier2)).toEqual({ state: 'aborted', note: 'REVISE: fix the tone' })
  })

  it('an abort propagates forward: tier 3 aborts once tier 2 is marked failed from tier 1\'s revise', () => {
    const tier1 = st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1, output: 'REVISE: no' })
    const tier2 = st({ title: 'R2', reviewOf: 'Draft', reviewTier: 2, failed: true, failReason: 'approval chain aborted — REVISE: no' })
    const tier3 = st({ title: 'R3', reviewOf: 'Draft', reviewTier: 3 })
    expect(reviewTierGate([tier1, tier2, tier3], tier3)).toEqual({
      state: 'aborted',
      note: 'approval chain aborted — REVISE: no',
    })
  })
})

describe('finalReviewerFor — the reviewer whose verdict actually decides the target', () => {
  const st = (over: Partial<DelegationSubtask> & { title: string }): DelegationSubtask => ({
    description: '',
    acceptanceCriteria: '',
    bountyUsd: 1,
    ...over,
  })

  it('is the sole reviewer when there is only one — same as before chains existed', () => {
    const only = st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1 })
    expect(finalReviewerFor([only], 'Draft')).toBe(only)
  })

  it('is the highest tier when several are present, regardless of array order', () => {
    const tier2 = st({ title: 'R2', reviewOf: 'Draft', reviewTier: 2 })
    const tier1 = st({ title: 'R1', reviewOf: 'Draft', reviewTier: 1 })
    const tier3 = st({ title: 'R3', reviewOf: 'Draft', reviewTier: 3 })
    expect(finalReviewerFor([tier2, tier1, tier3], 'Draft')).toBe(tier3)
  })

  it('is undefined when the target has no reviewer at all', () => {
    expect(finalReviewerFor([st({ title: 'Unrelated', reviewOf: 'Something else' })], 'Draft')).toBeUndefined()
  })
})
