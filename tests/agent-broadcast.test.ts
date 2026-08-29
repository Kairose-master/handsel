/**
 * The broadcast's pure half (lib/agent-broadcast.ts). Two rules carry the
 * whole primitive — never to yourself, never past the cap — and the third
 * property that matters is determinism: the same question broadcast twice
 * must reach the same room, not a fresh random dozen of it.
 */
import { describe, expect, it } from 'vitest'
import {
  BROADCAST_SCOPES,
  MAX_BROADCAST_RECIPIENTS,
  planBroadcast,
  summarizeBroadcast,
  type BroadcastCandidate,
} from '@/lib/agent-broadcast'

const c = (agentId: string, name = agentId, userId = 'u1'): BroadcastCandidate => ({ agentId, name, userId })

describe('planBroadcast', () => {
  it('never sends to the sender', () => {
    const plan = planBroadcast('me', [c('me'), c('you')])
    expect(plan.recipients.map((r) => r.agentId)).toEqual(['you'])
  })

  it('drops duplicate candidates rather than messaging twice', () => {
    const plan = planBroadcast('me', [c('you'), c('you'), c('them')])
    expect(plan.recipients).toHaveLength(2)
  })

  it('caps recipients and reports the overflow instead of hiding it', () => {
    const many = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 5 }, (_, i) => c(`a${i}`, `Agent ${String(i).padStart(2, '0')}`))
    const plan = planBroadcast('me', many)
    expect(plan.recipients).toHaveLength(MAX_BROADCAST_RECIPIENTS)
    expect(plan.overflow).toBe(5)
  })

  it('is deterministic — the same room, not a fresh sample', () => {
    const many = Array.from({ length: 30 }, (_, i) => c(`a${i}`, `Agent ${String(i).padStart(2, '0')}`))
    expect(planBroadcast('me', many)).toEqual(planBroadcast('me', [...many].reverse()))
  })

  it('breaks a name tie on id so two identically named agents keep a stable order', () => {
    const plan = planBroadcast('me', [c('b', 'Same'), c('a', 'Same')])
    expect(plan.recipients.map((r) => r.agentId)).toEqual(['a', 'b'])
  })

  it('handles an empty room', () => {
    expect(planBroadcast('me', [])).toEqual({ recipients: [], overflow: 0 })
    expect(planBroadcast('me', [c('me')])).toEqual({ recipients: [], overflow: 0 })
  })

  it('honours a caller-supplied cap', () => {
    const plan = planBroadcast('me', [c('a'), c('b'), c('c')], 1)
    expect(plan.recipients).toHaveLength(1)
    expect(plan.overflow).toBe(2)
  })
})

describe('summarizeBroadcast', () => {
  const base = { scope: 'office' as const, delivered: 0, failed: 0, overflow: 0, deliveries: [] }

  it('says what to do when the room was empty, per scope', () => {
    expect(summarizeBroadcast(base)).toContain('Nobody else is in this office')
    expect(summarizeBroadcast({ ...base, scope: 'connected' })).toContain('office codes')
  })

  it('reports refusals and overflow alongside the delivery count', () => {
    const line = summarizeBroadcast({ ...base, delivered: 3, failed: 1, overflow: 4 })
    expect(line).toContain('Delivered to 3 agents')
    expect(line).toContain('1 refused or rate-limited')
    expect(line).toContain('4 more in range')
  })

  it('gets the singular right', () => {
    expect(summarizeBroadcast({ ...base, delivered: 1 })).toContain('Delivered to 1 agent.')
  })
})

describe('scopes', () => {
  it('offers no market-wide scope — that would be a spam primitive', () => {
    expect([...BROADCAST_SCOPES]).toEqual(['office', 'connected'])
  })
})
