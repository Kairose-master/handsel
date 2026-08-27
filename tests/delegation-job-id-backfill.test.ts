import { describe, it, expect } from 'vitest'
import { backfillJobIds, type DelegationSubtask } from '@/lib/delegation'

const st = (over: Partial<DelegationSubtask>): DelegationSubtask => ({
  title: 't',
  description: 'd',
  acceptanceCriteria: 'c',
  bountyUsd: 1,
  ...over,
})

describe('backfillJobIds', () => {
  it('recovers an id lost between postJob and the read that follows it', () => {
    const subtasks = [st({ specHash: '0xaa' })]
    expect(backfillJobIds(subtasks, [{ id: 13, specHash: '0xaa' }])).toBe(1)
    expect(subtasks[0].onchainJobId).toBe(13)
  })

  it('never touches a subtask that already has its id', () => {
    // The chain is the authority for a hash it has already answered for; a
    // second match must not renumber a job mid-flight.
    const subtasks = [st({ specHash: '0xaa', onchainJobId: 7 })]
    expect(backfillJobIds(subtasks, [{ id: 99, specHash: '0xaa' }])).toBe(0)
    expect(subtasks[0].onchainJobId).toBe(7)
  })

  it('leaves a subtask that was never posted alone', () => {
    // No specHash means it is held back waiting on a dependency, not lost.
    const subtasks = [st({})]
    expect(backfillJobIds(subtasks, [{ id: 1, specHash: '0xaa' }])).toBe(0)
    expect(subtasks[0].onchainJobId).toBeUndefined()
  })

  it('reports zero when the chain has no job for that hash yet', () => {
    const subtasks = [st({ specHash: '0xbb' })]
    expect(backfillJobIds(subtasks, [{ id: 1, specHash: '0xaa' }])).toBe(0)
    expect(subtasks[0].onchainJobId).toBeUndefined()
  })

  it('repairs several at once and counts them', () => {
    const subtasks = [st({ specHash: '0xaa' }), st({ specHash: '0xbb' }), st({ specHash: '0xcc' })]
    const repaired = backfillJobIds(subtasks, [
      { id: 13, specHash: '0xaa' },
      { id: 15, specHash: '0xcc' },
    ])
    expect(repaired).toBe(2)
    expect(subtasks.map((s) => s.onchainJobId)).toEqual([13, undefined, 15])
  })

  it('matches on the exact hash, never a prefix', () => {
    // specHash is content-addressed; a loose match would attach a subtask to
    // somebody else's escrow.
    const subtasks = [st({ specHash: '0xaa' })]
    expect(backfillJobIds(subtasks, [{ id: 1, specHash: '0xaabb' }])).toBe(0)
    expect(subtasks[0].onchainJobId).toBeUndefined()
  })

  it('is a no-op on an empty chain read, so a failed RPC cannot clear ids', () => {
    const subtasks = [st({ specHash: '0xaa', onchainJobId: 4 }), st({ specHash: '0xbb' })]
    expect(backfillJobIds(subtasks, [])).toBe(0)
    expect(subtasks[0].onchainJobId).toBe(4)
  })
})
