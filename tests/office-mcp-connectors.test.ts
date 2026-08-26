/**
 * resolveRoleConnector — which MCP source each office role gets wired to.
 *
 * The refusals are the point. An office can now hold several connectors at
 * once (web search for one role, a private vault for another), and the one
 * outcome that must never happen is a role being silently pointed at a
 * DIFFERENT role's server: it would then deliver confident work off the wrong
 * source, which is worse than not being wired at all.
 */
import { describe, it, expect } from 'vitest'
import { resolveRoleConnector, type McpConnector } from '@/lib/office-world-data'

const EXA: McpConnector = { id: 'c1', label: 'Exa web search', serverUrl: 'https://mcp.exa.ai/mcp' }
const VAULT: McpConnector = { id: 'c2', label: 'Vault', serverUrl: 'https://v.example/mcp', authHeader: 'Bearer t' }
const ALL = [EXA, VAULT]

describe('resolveRoleConnector', () => {
  it('wires a role to the connector it names, not to the first one', () => {
    expect(resolveRoleConnector(ALL, { editor: { connectorId: 'c2', toolName: 'obsidian_search' } }, 'editor')).toEqual({
      serverUrl: 'https://v.example/mcp',
      toolName: 'obsidian_search',
      authHeader: 'Bearer t',
    })
  })

  it('lets different roles use different connectors in the same office', () => {
    const bindings = {
      researcher: { connectorId: 'c1', toolName: 'web_search_exa' },
      editor: { connectorId: 'c2', toolName: 'obsidian_search' },
    }
    expect(resolveRoleConnector(ALL, bindings, 'researcher')?.serverUrl).toBe('https://mcp.exa.ai/mcp')
    expect(resolveRoleConnector(ALL, bindings, 'editor')?.serverUrl).toBe('https://v.example/mcp')
  })

  it('leaves an unbound role alone', () => {
    expect(resolveRoleConnector(ALL, { editor: { connectorId: 'c1', toolName: 'x' } }, 'researcher')).toBeNull()
    expect(resolveRoleConnector(ALL, undefined, 'researcher')).toBeNull()
  })

  it('refuses a binding whose connector is gone rather than falling back', () => {
    expect(resolveRoleConnector(ALL, { r: { connectorId: 'deleted', toolName: 'web_search_exa' } }, 'r')).toBeNull()
  })

  it('refuses a binding with no tool name — a server alone cannot be called', () => {
    expect(resolveRoleConnector(ALL, { r: { connectorId: 'c1', toolName: '   ' } }, 'r')).toBeNull()
  })

  it('refuses a connector whose URL was never filled in', () => {
    const blank: McpConnector = { id: 'c3', label: 'Half-added', serverUrl: '  ' }
    expect(resolveRoleConnector([blank], { r: { connectorId: 'c3', toolName: 'go' } }, 'r')).toBeNull()
  })

  it('trims, and drops an empty auth header instead of sending one', () => {
    const c: McpConnector = { id: 'c4', label: 'X', serverUrl: ' https://x/mcp ', authHeader: '   ' }
    expect(resolveRoleConnector([c], { r: { connectorId: 'c4', toolName: ' go ' } }, 'r')).toEqual({
      serverUrl: 'https://x/mcp',
      toolName: 'go',
      authHeader: undefined,
    })
  })
})
