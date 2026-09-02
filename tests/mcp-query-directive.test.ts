import { describe, it, expect } from 'vitest'
import { extractMcpQuery, pickToolArgumentKey, scopeForQuery } from '@/lib/mcp-client'
import { OFFICE_TEMPLATES, defaultWiringFor, resolveRoleConnector } from '@/lib/office-world-data'

describe('extractMcpQuery', () => {
  it('returns null for a brief that names no query — the full brief still goes', () => {
    expect(extractMcpQuery('Do the work.\n\nAcceptance criteria: it is done.')).toBeNull()
  })

  it('pulls the query off its marker line', () => {
    const brief = 'Report on AWS limits.\n\n[mcp-query] Lambda quotas timeout memory concurrency\n\nMore text.'
    expect(extractMcpQuery(brief)).toBe('Lambda quotas timeout memory concurrency')
  })

  it('finds the marker wherever it sits — the DSL is prepended and the shared source appended', () => {
    const brief = '## plan\n…\n\nThe brief.\n\n[mcp-query] short query\n\n## Shared source\nlots of text'
    expect(extractMcpQuery(brief)).toBe('short query')
  })

  it('is case-insensitive on the marker but keeps the query verbatim', () => {
    expect(extractMcpQuery('[MCP-Query] Workers CPU Time Limit')).toBe('Workers CPU Time Limit')
  })

  it('ignores a marker that is not at the start of its line', () => {
    // Otherwise a worker output or shared source quoting the marker mid-sentence
    // could redirect the query.
    expect(extractMcpQuery('the reviewer wrote [mcp-query] nonsense inline')).toBeNull()
  })

  it('treats a marker with nothing after it as absent, not as an empty query', () => {
    expect(extractMcpQuery('Brief.\n[mcp-query]   \nmore')).toBeNull()
  })

  it('takes the first marker when a brief somehow carries two', () => {
    expect(extractMcpQuery('[mcp-query] first\n[mcp-query] second')).toBe('first')
  })

  it('caps a paragraph that was pasted after the marker', () => {
    const long = 'x'.repeat(2000)
    expect(extractMcpQuery(`[mcp-query] ${long}`)!.length).toBe(400)
  })

  it('tolerates an empty task', () => {
    expect(extractMcpQuery('')).toBeNull()
  })
})

describe('template default wiring', () => {
  it('is empty for a template that declares no defaults', () => {
    const t = OFFICE_TEMPLATES.find((x) => x.roles.every((r) => !r.defaultConnector))!
    expect(defaultWiringFor(t)).toEqual({ connectors: [], bindings: {} })
  })

  it('binds every role that declares a default, and only those', () => {
    for (const t of OFFICE_TEMPLATES) {
      const { bindings } = defaultWiringFor(t)
      const declared = t.roles.filter((r) => r.defaultConnector).map((r) => r.id).sort()
      expect(Object.keys(bindings).sort(), t.id).toEqual(declared)
    }
  })

  it('shares one connector row between roles pointing at the same server', () => {
    const wiring = defaultWiringFor({
      ...OFFICE_TEMPLATES[0],
      roles: [
        { ...OFFICE_TEMPLATES[0].roles[0], id: 'a', defaultConnector: { label: 'X', serverUrl: 'https://x/mcp', toolName: 't1' } },
        { ...OFFICE_TEMPLATES[0].roles[0], id: 'b', defaultConnector: { label: 'X', serverUrl: 'https://x/mcp', toolName: 't2' } },
      ],
    })
    expect(wiring.connectors).toHaveLength(1)
    expect(wiring.bindings.a.connectorId).toBe(wiring.bindings.b.connectorId)
    // Same server, different tool on it — the binding, not the connector, carries the tool.
    expect(wiring.bindings.a.toolName).toBe('t1')
    expect(wiring.bindings.b.toolName).toBe('t2')
  })

  it('produces wiring the resolver actually accepts', () => {
    // defaultWiringFor and resolveRoleConnector are the two halves of the same
    // path — defaults that the resolver then refuses would wire nothing.
    for (const t of OFFICE_TEMPLATES) {
      const { connectors, bindings } = defaultWiringFor(t)
      for (const role of t.roles) {
        if (!role.defaultConnector) continue
        const resolved = resolveRoleConnector(connectors, bindings, role.id)
        expect(resolved, `${t.id}/${role.id}`).not.toBeNull()
        expect(resolved!.serverUrl).toBe(role.defaultConnector.serverUrl)
        expect(resolved!.toolName).toBe(role.defaultConnector.toolName)
      }
    }
  })

  it('only ever points a default at https', () => {
    for (const t of OFFICE_TEMPLATES) {
      for (const r of t.roles) {
        if (r.defaultConnector) expect(r.defaultConnector.serverUrl, `${t.id}/${r.id}`).toMatch(/^https:\/\//)
      }
    }
  })
})

describe('the Cloud Options Desk', () => {
  const t = OFFICE_TEMPLATES.find((x) => x.id === 'cloud-options-desk')!

  it('ships every reading role pre-wired, so hiring it needs no MCP setup', () => {
    for (const id of ['aws', 'azure', 'cloudflare', 'independent']) {
      expect(t.roles.find((r) => r.id === id)?.defaultConnector, id).toBeDefined()
    }
  })

  it('points each READER at a different vendor — one server would defeat the desk', () => {
    // The uniqueness rule is about the four reading roles: each must quote
    // its OWN vendor (aws/azure/cloudflare) or none (independent). The
    // synthesis and review roles legitimately share a general search tool —
    // their job is writing and checking, not vendor retrieval — and they
    // gained default connectors precisely so they stop hiring as un-runnable
    // 'platform' agents (docs/failure-modes.md section 61).
    const hosts = ['aws', 'azure', 'cloudflare', 'independent']
      .map((id) => t.roles.find((r) => r.id === id)?.defaultConnector)
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => new URL(c.serverUrl).host)
    expect(hosts).toHaveLength(4)
    expect(new Set(hosts).size).toBe(hosts.length)
  })

  it('the writing roles are wired too — an unwired role hires as an un-runnable platform agent', () => {
    for (const id of ['architect', 'red-team']) {
      expect(t.roles.find((r) => r.id === id)?.defaultConnector, id).toBeDefined()
    }
  })

  it('gives every tool-backed step its own short query, not its brief', () => {
    for (const id of ['aws', 'azure', 'cloudflare', 'independent']) {
      const step = t.pipeline.find((s) => s.roleId === id)!
      expect(step.mcpQuery, id).toBeTruthy()
      // Short enough to actually be a query: the measured failure was a
      // ~1000-char brief burying the subject.
      expect(step.mcpQuery!.length, id).toBeLessThan(200)
      expect(step.mcpQuery!.length, id).toBeGreaterThan(20)
      // And it survives the round trip into the brief.
      expect(extractMcpQuery(`${step.brief}\n\n[mcp-query] ${step.mcpQuery}`)).toBe(step.mcpQuery)
      // And it follows the JOB: a fixed phrase sent every AWS reader to the
      // Lambda quotas page whatever the desk was asked (rounds 3–6, 2026-09-02).
      expect(step.mcpQuery, id).toContain('{scope}')
    }
  })

  it('scopeForQuery cuts a paragraph-sized scope to a query, on a word, and leaves a short one alone', () => {
    expect(scopeForQuery('short scope')).toBe('short scope')
    const long = 'A tenant-scoped event audit log: ingest bursts up to 5,000 events/sec (each under 2KB) with exactly-once deduplication on a client-supplied event id, keep 30 days queryable by tenant and time range, export each day to object storage nightly, and guarantee that one tenant cannot slow another. Which of AWS, Azure and Cloudflare fits?'
    const q = scopeForQuery(long)
    expect(q.length).toBeLessThanOrEqual(220)
    expect(q.length).toBeGreaterThan(110)
    expect(q.endsWith(' ')).toBe(false)
    expect(long.startsWith(q)).toBe(true)
    // Substituted into every template query, the marker line stays a query.
    for (const id of ['aws', 'azure', 'cloudflare', 'independent']) {
      const step = t.pipeline.find((s) => s.roleId === id)!
      const line = step.mcpQuery!.replaceAll('{scope}', q)
      expect(line.length, id).toBeLessThanOrEqual(400)
      expect(extractMcpQuery(`brief\n\n[mcp-query] ${line}`)).toBe(line)
    }
  })

  it('has the architect wait on all four reads and the red team gate the result', () => {
    expect(t.pipeline.find((s) => s.roleId === 'architect')!.dependsOnRoleIds.sort()).toEqual([
      'aws', 'azure', 'cloudflare', 'independent',
    ])
    expect(t.pipeline.find((s) => s.roleId === 'red-team')!.reviewOfRoleId).toBe('architect')
  })

  it('picks the argument key each real tool schema actually wants', () => {
    // The shapes probed live on 2026-08-26 (docs/office-connectors.md).
    expect(pickToolArgumentKey({ properties: { search_phrase: { type: 'string' } }, required: ['search_phrase'] })).toBe('search_phrase')
    expect(pickToolArgumentKey({ properties: { query: { type: 'string' } }, required: ['query'] })).toBe('query')
  })
})
