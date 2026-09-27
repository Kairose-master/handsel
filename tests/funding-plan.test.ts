import { describe, expect, it } from 'vitest'
import { fundingPlanInWords, groupWaveByPayer, userOpsFor } from '@/lib/funding-plan'

/**
 * The batching rule behind postDelegationJobs: a wave grouped by payer is one
 * UserOp per payer. Pinned so a refactor that quietly goes back to one
 * UserOp per job fails a test instead of a bundler rate limit.
 */
describe('groupWaveByPayer', () => {
  it('keeps payer first-seen order and item order within a payer', () => {
    const items = [
      { id: 'a', payer: 'p1' },
      { id: 'b', payer: 'p2' },
      { id: 'c', payer: 'p1' },
    ]
    const g = groupWaveByPayer(items, (i) => i.payer)
    expect([...g.keys()]).toEqual(['p1', 'p2'])
    expect(g.get('p1')!.map((i) => i.id)).toEqual(['a', 'c'])
  })
  it('an empty wave is an empty map', () => {
    expect(groupWaveByPayer([], () => 'x').size).toBe(0)
  })
})

describe('userOpsFor', () => {
  it('a five-step single-payer desk is one UserOp instead of five', () => {
    expect(userOpsFor([5])).toEqual({ perJob: 5, batched: 1, saved: 4 })
  })
  it('two payers cost two, however the jobs split', () => {
    expect(userOpsFor([3, 2])).toEqual({ perJob: 5, batched: 2, saved: 3 })
  })
  it('one job saves nothing and says so', () => {
    expect(userOpsFor([1])).toEqual({ perJob: 1, batched: 1, saved: 0 })
    expect(fundingPlanInWords([1])).toBe('1 job posted in 1 transaction')
    expect(fundingPlanInWords([4, 1])).toContain('3 fewer')
  })
})
