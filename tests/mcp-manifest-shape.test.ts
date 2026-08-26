import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOOLS } from '@/lib/mcp/tools-manifest'

/**
 * The manifest is a wire contract a connector reads to decide how to call us.
 * A schema that lists a `required` name it never declares, or an enum whose
 * default the description contradicts, is not a type error on either side —
 * it is a tool the model calls wrongly, once, with money involved.
 */
type Tool = {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, { type?: string; description?: string; enum?: string[]; items?: unknown }>
    required?: string[]
    additionalProperties?: boolean
  }
}
const tools = TOOLS as unknown as Tool[]

describe('every MCP tool', () => {
  it('has a unique snake_case name', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n, n).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('describes itself well enough for a model to choose it', () => {
    for (const t of tools) expect(t.description.trim().length, t.name).toBeGreaterThan(40)
  })

  it('declares an object schema that refuses unknown arguments', () => {
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.inputSchema.additionalProperties, t.name).toBe(false)
    }
  })

  it('only requires parameters it actually declares', () => {
    for (const t of tools) {
      for (const r of t.inputSchema.required ?? []) {
        expect(Object.keys(t.inputSchema.properties), `${t.name}.${r}`).toContain(r)
      }
    }
  })

  it('gives every parameter a type', () => {
    for (const t of tools) {
      for (const [k, p] of Object.entries(t.inputSchema.properties)) {
        expect(p.type, `${t.name}.${k}`).toBeTruthy()
        if (p.type === 'array') expect(p.items, `${t.name}.${k}`).toBeTruthy()
      }
    }
  })

  it('leaves no enum empty or duplicated', () => {
    for (const t of tools) {
      for (const [k, p] of Object.entries(t.inputSchema.properties)) {
        if (!p.enum) continue
        expect(p.enum.length, `${t.name}.${k}`).toBeGreaterThan(1)
        expect(new Set(p.enum).size, `${t.name}.${k}`).toBe(p.enum.length)
      }
    }
  })
})

describe('the office tools', () => {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const OFFICE = [
    'list_office_templates',
    'hire_office',
    'office_roster',
    'set_office_source',
    'wire_office_agent',
    'test_mcp_connector',
  ]

  it('are all advertised', () => {
    for (const n of OFFICE) expect(byName.get(n), n).toBeDefined()
  })

  it('says plainly that hire_office does not move money', () => {
    // The whole safety story of hiring a desk from a conversation: the model
    // must not believe this call escrows, or it will skip the approval step.
    const d = byName.get('hire_office')!.description
    expect(d).toMatch(/does NOT move money/i)
    expect(d).toContain('confirm_delegation')
  })

  it('needs only a template and a scope to hire — everything else has a default', () => {
    expect(byName.get('hire_office')!.inputSchema.required).toEqual(['template_id', 'scope'])
  })

  it('offers the same mode choice everywhere a tool gets wired', () => {
    for (const n of ['hire_office', 'wire_office_agent', 'connect_mcp_worker']) {
      const t = byName.get(n)!
      const modeEnum =
        n === 'hire_office'
          ? ((t.inputSchema.properties.connectors.items as { properties: Record<string, { enum?: string[] }> })
              .properties.mode.enum)
          : t.inputSchema.properties.mode.enum
      expect([...modeEnum!].sort(), n).toEqual(['assisted', 'proxy'])
    }
  })

  it('warns in every mode description that a search server needs assisted', () => {
    // The defect this mode exists for is silent: proxy on a search server
    // submits a result dump and the worker wears the failed grade.
    for (const n of ['hire_office', 'wire_office_agent', 'connect_mcp_worker']) {
      const t = byName.get(n)!
      const text = JSON.stringify(t.inputSchema)
      expect(text.toLowerCase(), n).toContain('search')
    }
  })

  it('lets the read-only tools be called with no arguments at all', () => {
    for (const n of ['list_office_templates', 'office_roster']) {
      expect(byName.get(n)!.inputSchema.required ?? [], n).toEqual([])
    }
  })
})

describe('the connector doc keeps up with the manifest', () => {
  // The doc is how a person decides whether to add the connector at all, and
  // its tool table is the only place the count is asserted in prose. A tool
  // added without a row is invisible; a heading that says 28 when there are
  // 34 is the kind of thing nobody notices for months.
  const doc = readFileSync('docs/mcp-connector.md', 'utf8')

  it('states the real tool count in its heading', () => {
    const stated = doc.match(/^## Tools \((\d+)\)$/m)
    expect(stated, 'the "## Tools (N)" heading').not.toBeNull()
    expect(Number(stated![1])).toBe(tools.length)
  })

  it('has a table row for every advertised tool', () => {
    const missing = tools.map((t) => t.name).filter((n) => !doc.includes(`\`${n}\``))
    expect(missing).toEqual([])
  })
})
