import { describe, it, expect } from 'vitest'
import {
  conversationsFor,
  conversationKindOf,
  CONVERSATION_WINDOW_MS,
  CONVERSATION_PREVIEW_LIMIT,
  type RawAgentMessage,
} from '@/lib/office-conversations'

const NOW = new Date('2026-08-28T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

const row = (over: Partial<RawAgentMessage>): RawAgentMessage => ({
  id: 'm1',
  fromAgentId: 'a1',
  toAgentId: 'a2',
  type: 'job_proposal',
  body: 'Build me a thing for $3',
  createdAt: ago(60_000),
  ...over,
})

const roster = new Set(['a1', 'a2', 'a3'])

describe('conversationKindOf', () => {
  it('maps every real message type, and only real ones', () => {
    expect(conversationKindOf('inquiry')).toBe('inquiry')
    expect(conversationKindOf('info')).toBe('info')
    expect(conversationKindOf('job_proposal')).toBe('proposal')
    expect(conversationKindOf('job_counter_proposal')).toBe('counter')
    expect(conversationKindOf('job_proposal_accept')).toBe('accept')
    expect(conversationKindOf('job_proposal_reject')).toBe('reject')
    expect(conversationKindOf('verified_task_proposal')).toBe('verified_proposal')
    expect(conversationKindOf('something_new')).toBeNull()
  })
})

describe('conversationsFor', () => {
  it('shapes a fresh in-roster message with its real body as preview', () => {
    const out = conversationsFor([row({})], roster, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'm1',
      fromAgentId: 'a1',
      toAgentId: 'a2',
      kind: 'proposal',
      preview: 'Build me a thing for $3',
    })
  })

  it('drops a message when either endpoint is outside the roster — no second endpoint, no ping', () => {
    expect(conversationsFor([row({ toAgentId: 'stranger' })], roster, NOW)).toEqual([])
    expect(conversationsFor([row({ fromAgentId: 'stranger' })], roster, NOW)).toEqual([])
  })

  it('drops messages older than the freshness window — the office reads as "now"', () => {
    expect(conversationsFor([row({ createdAt: ago(CONVERSATION_WINDOW_MS + 1_000) })], roster, NOW)).toEqual([])
    expect(conversationsFor([row({ createdAt: ago(CONVERSATION_WINDOW_MS - 1_000) })], roster, NOW)).toHaveLength(1)
  })

  it('drops self-messages and unknown types rather than drawing noise or a mislabeled icon', () => {
    expect(conversationsFor([row({ toAgentId: 'a1' })], roster, NOW)).toEqual([])
    expect(conversationsFor([row({ type: 'future_type' })], roster, NOW)).toEqual([])
  })

  it('truncates a long body with an ellipsis, disclosed in the preview itself', () => {
    const out = conversationsFor([row({ body: 'x'.repeat(CONVERSATION_PREVIEW_LIMIT + 40) })], roster, NOW)
    expect(out[0].preview.endsWith('…')).toBe(true)
    expect(out[0].preview.length).toBe(CONVERSATION_PREVIEW_LIMIT + 1)
  })

  it('orders newest first and caps the count so a chatty pair cannot flood the scene', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `m${i}`, createdAt: ago(i * 1_000) }))
    const out = conversationsFor(rows, roster, NOW, { limit: 5 })
    expect(out).toHaveLength(5)
    expect(out.map((c) => c.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('tolerates small clock skew but drops rows stamped far in the future', () => {
    expect(conversationsFor([row({ createdAt: new Date(NOW.getTime() + 30_000) })], roster, NOW)).toHaveLength(1)
    expect(conversationsFor([row({ createdAt: new Date(NOW.getTime() + 5 * 60_000) })], roster, NOW)).toEqual([])
  })
})
