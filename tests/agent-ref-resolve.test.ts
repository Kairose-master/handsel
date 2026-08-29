/**
 * resolveAgentRef — the pure precedence behind the MCP messaging tools'
 * "which agent did the caller mean" (lib/agent-messages.ts). The rule under
 * test is the safety one: anything ambiguous is returned as candidates,
 * never guessed — a negotiation message to the wrong stranger is worse than
 * a follow-up question.
 */
import { describe, expect, it } from 'vitest'
import { resolveAgentRef } from '@/lib/agent-messages'

const agents = [
  { id: 'a1', name: 'Copywriter' },
  { id: 'a2', name: 'copy editor' },
  { id: 'a3', name: 'Red Team' },
  { id: 'a4', name: 'red team' },
]

describe('resolveAgentRef', () => {
  it('an id match wins outright', () => {
    expect(resolveAgentRef(agents, { id: 'a3', name: 'Copywriter' })).toEqual({ found: agents[2] })
  })

  it('an id that matches nothing is none — never a fallback to name', () => {
    expect(resolveAgentRef(agents, { id: 'nope', name: 'Copywriter' })).toEqual({ found: null, why: 'none' })
  })

  it('exact name match is case-insensitive', () => {
    expect(resolveAgentRef(agents, { name: 'COPYWRITER' })).toEqual({ found: agents[0] })
  })

  it('two exact matches are ambiguous, not first-wins', () => {
    const res = resolveAgentRef(agents, { name: 'red team' })
    expect(res.found).toBeNull()
    if (!res.found && res.why === 'ambiguous') expect(res.matches).toHaveLength(2)
    else throw new Error('expected ambiguous')
  })

  it('a unique substring match resolves as a convenience', () => {
    expect(resolveAgentRef(agents, { name: 'writer' })).toEqual({ found: agents[0] })
  })

  it('a shared substring is ambiguous', () => {
    const res = resolveAgentRef(agents, { name: 'copy' })
    expect(res.found).toBeNull()
    if (!res.found && res.why === 'ambiguous') expect(res.matches.map((m) => m.id)).toEqual(['a1', 'a2'])
    else throw new Error('expected ambiguous')
  })

  it('exact beats substring: an exact match is found even when the same string is also a substring of others', () => {
    const withExact = [...agents, { id: 'a5', name: 'Copy' }]
    expect(resolveAgentRef(withExact, { name: 'copy' })).toEqual({ found: { id: 'a5', name: 'Copy' } })
  })

  it('no name and no id is none', () => {
    expect(resolveAgentRef(agents, { name: '  ' })).toEqual({ found: null, why: 'none' })
    expect(resolveAgentRef(agents, {})).toEqual({ found: null, why: 'none' })
  })
})
