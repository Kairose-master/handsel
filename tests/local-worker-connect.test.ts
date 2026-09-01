import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Two MCP entry points, one act: seating a local coding harness in an agent.
 *
 * connect_local_worker names the agent directly; wire_office_agent with
 * server_url "local" reaches the same act through the rewiring verb (and
 * through OLDER clients whose tool list predates connect_local_worker —
 * live constraint the day this shipped: the connected assistant's snapshot
 * could not see the new tool, and the wiring tool it could see became the
 * road in). Both must go through lib/local-worker-connect.ts, or the two
 * answers drift — the register route's reconnect semantics live there once.
 */

const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('local worker connect — one implementation, two tools', () => {
  it('connect_local_worker delegates to the shared lib', () => {
    const src = code('lib/mcp/handlers/worker.ts')
    const body = src.slice(src.indexOf("case 'connect_local_worker'"), src.indexOf("case 'set_auto_mine'"))
    expect(body).toContain("await import('@/lib/local-worker-connect')")
    expect(body).toContain('connectLocalWorker(auth.userId')
  })

  it('wire_office_agent accepts server_url "local" and delegates to the same lib', () => {
    const src = code('lib/mcp/handlers/office.ts')
    const body = src.slice(src.indexOf("case 'wire_office_agent'"))
    expect(body).toContain("serverUrl.toLowerCase() === 'local'")
    expect(body).toContain("await import('@/lib/local-worker-connect')")
    // The local branch must be checked BEFORE the https:// refusal, or the
    // word "local" can never reach it. Ordered on the RAW file: the comment
    // stripper truncates lines at the first "//", and both the refusal
    // string and the /^https:\/\//i regex on its line contain one.
    const raw = readFileSync('lib/mcp/handlers/office.ts', 'utf8')
    const wireAt = raw.indexOf("case 'wire_office_agent'")
    expect(raw.indexOf("=== 'local'", wireAt)).toBeLessThan(raw.indexOf('must start with https', wireAt))
  })

  it('the shared lib rotates the secret and mints the {a,s,u} token the worker parses', () => {
    const src = code('lib/local-worker-connect.ts')
    expect(src).toContain("runtimeType: 'local'")
    expect(src).toContain('encryptWebhookSecret(secret)')
    expect(src).toContain("JSON.stringify({ a: target.id, s: secret, u: origin() })")
    expect(src).toContain("toString('base64url')")
    // handsel-worker requires all three keys — pin the wire format here too.
    const worker = readFileSync('public/handsel-worker.mjs', 'utf8')
    expect(worker).toContain('!cfg.a || !cfg.s || !cfg.u')
  })
})
