/**
 * An office pipeline step can be reserved for the owner's own machine — and
 * only when that machine exists.
 *
 * The danger this is built around: a step planned onto a `local` worker that
 * is not running is never claimed. It sits Open with its escrow locked,
 * which is exactly docs/failure-modes.md §30 ("a desk of ten agents that
 * could not take a single job") and the F1 frozen-escrow shape. So the
 * planner is only TOLD about the lane when the account has a local runtime,
 * and the parser drops it regardless unless the caller established the fact.
 * Two independent gates, because the first one is a prompt and a prompt is a
 * request, not a guarantee.
 */
import { describe, expect, it } from 'vitest'

import { parsePlannerOutput } from '@/lib/delegation'

const plan = (lane: string | null) =>
  JSON.stringify([
    {
      title: 'Fix the parser',
      description: 'The tokenizer drops escaped quotes.',
      acceptanceCriteria: 'Escaped quotes survive a round trip and the suite passes.',
      bountyUsd: 3,
      ...(lane ? { lane } : {}),
    },
    {
      title: 'Write the note',
      description: 'Summarise the change for the changelog.',
      acceptanceCriteria: 'One paragraph naming the bug and the fix, accurate to the diff.',
      bountyUsd: 3,
    },
  ])

describe('the local lane is refused unless a local worker exists', () => {
  it('drops lane:local when the caller has not established one', () => {
    const [first] = parsePlannerOutput(plan('local'), 6)
    expect(first.lane).toBeUndefined()
  })

  it('keeps lane:local when the caller says a local worker exists', () => {
    const [first] = parsePlannerOutput(plan('local'), 6, { allowLocalLane: true })
    expect(first.lane).toBe('local')
  })

  it('never invents a lane for a step that did not ask for one', () => {
    const [, second] = parsePlannerOutput(plan('local'), 6, { allowLocalLane: true })
    expect(second.lane).toBeUndefined()
  })
})

describe('the handsel lane needs no gate', () => {
  it('is kept either way — a platform runtime always exists', () => {
    expect(parsePlannerOutput(plan('handsel'), 6)[0].lane).toBe('handsel')
    expect(parsePlannerOutput(plan('handsel'), 6, { allowLocalLane: true })[0].lane).toBe('handsel')
  })
})

describe('anything else is not a lane', () => {
  it('drops values outside the two real ones', () => {
    for (const bogus of ['LOCAL', 'cloud', 'anywhere', '']) {
      expect(parsePlannerOutput(plan(bogus), 6, { allowLocalLane: true })[0].lane).toBeUndefined()
    }
  })
})
