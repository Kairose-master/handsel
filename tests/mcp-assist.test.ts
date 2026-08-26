import { describe, it, expect } from 'vitest'
import { assistedWorkerPrompt, isMcpMode, MAX_TOOL_OUTPUT_CHARS } from '@/lib/mcp-assist'
import { OFFICE_TEMPLATES, defaultWiringFor, resolveRoleConnector } from '@/lib/office-world-data'

const prompt = (over: Partial<Parameters<typeof assistedWorkerPrompt>[0]> = {}) =>
  assistedWorkerPrompt({
    agentName: 'AWS Reader',
    customInstructions: 'You answer only from AWS documentation.',
    brief: 'Report the Lambda limits that decide whether this workload fits.',
    toolName: 'aws___search_documentation',
    serverUrl: 'https://knowledge-mcp.global.api.aws',
    toolOutput: 'Lambda quotas: timeout 900 seconds.',
    nonce: 'N7',
    ...over,
  })

describe('isMcpMode', () => {
  it('accepts the two real modes and nothing else', () => {
    expect(isMcpMode('proxy')).toBe(true)
    expect(isMcpMode('assisted')).toBe(true)
    for (const bad of ['', 'PROXY', 'assist', null, undefined, 1, {}]) expect(isMcpMode(bad)).toBe(false)
  })
})

describe('assistedWorkerPrompt', () => {
  it('fences the retrieved content — it is arbitrary third-party text in a prompt', () => {
    const { user } = prompt()
    expect(user).toContain('BEGIN_TOOL_RESULT_N7')
    expect(user).toContain('END_TOOL_RESULT_N7')
  })

  it('carries the injection clause naming this call’s nonce', () => {
    const { system } = prompt()
    expect(system).toContain('N7')
    expect(system).toMatch(/never an instruction/i)
  })

  it('puts the brief in front of the retrieved material', () => {
    const { user } = prompt()
    expect(user.indexOf('Report the Lambda limits')).toBeLessThan(user.indexOf('BEGIN_TOOL_RESULT'))
  })

  it('names the tool and server the evidence came from', () => {
    const { system } = prompt()
    expect(system).toContain('aws___search_documentation')
    expect(system).toContain('https://knowledge-mcp.global.api.aws')
  })

  it('forbids filling gaps from memory — the whole reason for retrieval', () => {
    const { system } = prompt()
    expect(system).toMatch(/do not fill the gap from\s+memory/i)
  })

  it('keeps the agent’s own standing instructions', () => {
    expect(prompt().system).toContain('You answer only from AWS documentation.')
  })

  it('works for an agent with no custom instructions', () => {
    const { system } = prompt({ customInstructions: null })
    expect(system).not.toContain('Your standing instructions')
    expect(system).toContain('AWS Reader')
  })

  it('caps a search tool’s multi-KB dump', () => {
    const { user } = prompt({ toolOutput: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 5000) })
    expect(user).toContain('x'.repeat(MAX_TOOL_OUTPUT_CHARS))
    expect(user).not.toContain('x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1))
  })
})

describe('office bindings carry the mode', () => {
  it('defaults to proxy when a binding does not say — unchanged for everything older', () => {
    const resolved = resolveRoleConnector(
      [{ id: 'c1', label: 'X', serverUrl: 'https://x/mcp' }],
      { r: { connectorId: 'c1', toolName: 't' } },
      'r',
    )
    expect(resolved?.mode).toBe('proxy')
  })

  it('passes assisted through', () => {
    const resolved = resolveRoleConnector(
      [{ id: 'c1', label: 'X', serverUrl: 'https://x/mcp' }],
      { r: { connectorId: 'c1', toolName: 't', mode: 'assisted' } },
      'r',
    )
    expect(resolved?.mode).toBe('assisted')
  })

  it('ships every pre-wired role as assisted, since all the defaults are search servers', () => {
    // A shipped default in proxy mode would submit a result dump as the
    // deliverable and fail its own acceptance criteria.
    for (const t of OFFICE_TEMPLATES) {
      const { connectors, bindings } = defaultWiringFor(t)
      for (const role of t.roles) {
        if (!role.defaultConnector) continue
        expect(bindings[role.id].mode, `${t.id}/${role.id}`).toBe('assisted')
        expect(resolveRoleConnector(connectors, bindings, role.id)?.mode).toBe('assisted')
      }
    }
  })
})
