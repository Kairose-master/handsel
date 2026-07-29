import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, missingEssentials, type CapabilityStatus } from '@/lib/capabilities'

/**
 * The inventory has to stay complete, or it is worse than not having one.
 *
 * A capability table that silently omits a feature answers "everything is on"
 * while a button is missing — which is the exact confusion it exists to end.
 * So the test that matters is not that the table parses; it is that every
 * `is…Configured` predicate in the codebase appears in it.
 */

describe('the table is well-formed', () => {
  it('has unique keys', () => {
    const keys = CAPABILITIES.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('names at least one env var for every capability', () => {
    // "It is off" without "here is what turns it on" leaves the reader exactly
    // where they started.
    for (const cap of CAPABILITIES) {
      expect(cap.requires.length, `${cap.key} lists nothing that would enable it`).toBeGreaterThan(0)
    }
  })

  it('never names a secret VALUE, only variable names', () => {
    // This table is served publicly by GET /api/capabilities.
    for (const cap of CAPABILITIES) {
      for (const req of cap.requires) {
        expect(req, `${cap.key} requires an entry that looks like a value`).not.toMatch(/^0x[0-9a-f]{16,}/i)
      }
    }
  })

  it('distinguishes a hidden feature from one that throws when clicked', () => {
    // The distinction the first version of this table did not have, and the
    // reason it reported "nothing is blocking" while the Generate button 500'd.
    const throwers = CAPABILITIES.filter((c) => c.mode === 'throws').map((c) => c.key)
    expect(throwers).toContain('secretsAtRest')
    // A `throws` entry MUST carry a note: its whole problem is that the failure
    // arrives with the reason stripped out, so the explanation has to live here.
    for (const cap of CAPABILITIES.filter((c) => c.mode === 'throws')) {
      expect(cap.note, `${cap.key} throws and explains nothing`).toBeTruthy()
    }
  })

  it('marks the two the market cannot run without', () => {
    const essential = CAPABILITIES.filter((c) => !c.optional).map((c) => c.key)
    expect(essential).toContain('agentAccounts')
    expect(essential).toContain('laborMarket')
    // The credit vault is NOT essential — treating it as such is what hid the
    // Provision button on a deployment that was otherwise complete.
    expect(essential).not.toContain('onchain')
  })
})

describe('every gate in the codebase is in the table', () => {
  /** `is…Configured` / `is…Enabled` predicates exported anywhere in lib/. */
  function exportedGates(): string[] {
    const found = new Set<string>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(p)
        } else if (entry.name.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8')
          for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(is[A-Za-z0-9]+(?:Configured|Enabled))\s*\(/g)) {
            found.add(m[1])
          }
        }
      }
    }
    walk('lib')
    return [...found]
  }

  const wired = readFileSync('lib/capabilities.ts', 'utf8')

  it('finds the gates at all — the scan is the test here', () => {
    expect(exportedGates().length).toBeGreaterThanOrEqual(8)
    expect(exportedGates()).toContain('isGithubLoginEnabled')
  })

  it('wires each one into capabilityStatus', () => {
    // The failure this prevents: a new optional feature ships, nobody adds it
    // here, and the inventory reports a full house while a button is missing.
    const missing = exportedGates().filter((g) => !wired.includes(g))
    expect(missing, `predicates not wired into lib/capabilities.ts: ${missing.join(', ')}`).toEqual([])
  })
})

describe('missingEssentials', () => {
  const row = (key: string, on: boolean, optional: boolean) =>
    ({ key, label: key, requires: ['X'], optional, on }) as unknown as CapabilityStatus

  it('reports only the non-optional ones that are off', () => {
    const out = missingEssentials([
      row('laborMarket', false, false),
      row('email', false, true),
      row('agentAccounts', true, false),
    ])
    expect(out.map((c) => c.key)).toEqual(['laborMarket'])
  })

  it('is empty when the essentials are on, however much else is off', () => {
    // An optional feature being off is the normal state of this app, not a
    // problem to report — saying otherwise trains the reader to ignore it.
    const out = missingEssentials([
      row('laborMarket', true, false),
      row('agentAccounts', true, false),
      row('governance', false, true),
      row('erc8004', false, true),
    ])
    expect(out).toEqual([])
  })
})
