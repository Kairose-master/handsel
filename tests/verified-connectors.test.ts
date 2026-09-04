/**
 * The verified-connector catalog is a CLAIM — "these servers were probed
 * end-to-end and work as workers" — so these tests pin it to the two places
 * that claim already lives, instead of letting a third copy drift:
 *
 * 1. `docs/office-connectors.md`'s "Verified working" table is the probe
 *    record. Every catalog entry must appear there verbatim (URL, tool,
 *    argument key). A connector added to the catalog without a recorded
 *    probe is exactly the unverified wiring that document exists to prevent.
 * 2. Office templates' `defaultConnector`s ship the same servers pre-wired.
 *    Every one of them must resolve to a catalog entry, so the hire dialog
 *    and the one-click cards can never disagree about what is trusted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VERIFIED_CONNECTORS,
  verifiedConnectorById,
  verifiedConnectorFor,
  verifiedConnectorToolId,
} from '@/lib/verified-connectors'
import { OFFICE_TEMPLATES } from '@/lib/office-world-data'
import { toolIdentityOf } from '@/lib/tool-identity'

const DOC = readFileSync(join(process.cwd(), 'docs', 'office-connectors.md'), 'utf8')

describe('VERIFIED_CONNECTORS', () => {
  it('has unique ids and well-formed entries', () => {
    const ids = VERIFIED_CONNECTORS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of VERIFIED_CONNECTORS) {
      expect(c.serverUrl).toMatch(/^https:\/\//)
      expect(c.toolName.trim()).toBe(c.toolName)
      expect(c.toolName.length).toBeGreaterThan(0)
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.blurb.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(c.verifiedOn))).toBe(false)
    }
  })

  it('every entry is recorded in docs/office-connectors.md (URL, tool, arg key)', () => {
    for (const c of VERIFIED_CONNECTORS) {
      expect(DOC, `${c.id}: serverUrl not in the probe record`).toContain(c.serverUrl)
      expect(DOC, `${c.id}: toolName not in the probe record`).toContain(c.toolName)
      expect(DOC, `${c.id}: argKey not in the probe record`).toContain(c.argKey)
    }
  })

  it('every current entry is a search-shaped server, so every one is assisted', () => {
    // office-connectors.md: a search server in 'proxy' submits a result dump
    // as the deliverable — found live on the first roster read. If an
    // agent-shaped server is ever added here as 'proxy', delete this test
    // deliberately rather than weakening it.
    for (const c of VERIFIED_CONNECTORS) {
      expect(c.mode, `${c.id} must be assisted`).toBe('assisted')
    }
  })

  it("covers every office template's defaultConnector — pre-wired and one-click cannot drift apart", () => {
    for (const template of OFFICE_TEMPLATES) {
      for (const role of template.roles) {
        const dc = role.defaultConnector
        if (!dc) continue
        const hit = verifiedConnectorFor(dc.serverUrl, dc.toolName)
        expect(hit, `${template.id}/${role.id} default connector is not in the verified catalog`).not.toBeNull()
      }
    }
  })
})

describe('verifiedConnectorById / verifiedConnectorFor', () => {
  it('finds by id, null for unknown', () => {
    expect(verifiedConnectorById('exa')?.toolName).toBe('web_search_exa')
    expect(verifiedConnectorById('nope')).toBeNull()
  })

  it('matches typed wiring ignoring whitespace and a trailing slash', () => {
    expect(verifiedConnectorFor(' https://mcp.exa.ai/mcp/ ', ' web_search_exa ')?.id).toBe('exa')
    expect(verifiedConnectorFor('https://mcp.exa.ai/mcp', 'some_other_tool')).toBeNull()
    expect(verifiedConnectorFor('https://elsewhere.example/mcp', 'web_search_exa')).toBeNull()
  })
})

describe('verifiedConnectorToolId — the /directory bridge to real ToolRecords', () => {
  it('computes the exact id a real graded job on this server/tool would carry', () => {
    for (const c of VERIFIED_CONNECTORS) {
      const id = verifiedConnectorToolId(c)
      const fromRealAgent = toolIdentityOf({ runtimeType: 'mcp', mcpServerUrl: c.serverUrl, mcpToolName: c.toolName })
      expect(id, `${c.id} produced no id`).not.toBeNull()
      expect(id).toBe(fromRealAgent?.id)
      expect(id).toBe(`mcp:${c.serverUrl}#${c.toolName}`)
    }
  })

  it('is stable across two calls (pure)', () => {
    const c = VERIFIED_CONNECTORS[0]
    expect(verifiedConnectorToolId(c)).toBe(verifiedConnectorToolId(c))
  })
})
