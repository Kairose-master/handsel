import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Shared code must not call a server action that authenticates from the
 * session.
 *
 * The two surfaces authenticate differently. A server action resolves its
 * caller from the session COOKIE; an MCP request carries an OAuth token and
 * has no cookie. So an action reached from the MCP path throws
 * "Unauthorized" for every caller — and nothing static catches it. tsc
 * resolves the import, lint passes, the unit tests pass, the production build
 * passes.
 *
 * It shipped twice in one afternoon. `wire_office_agent` called
 * `setMcpWorker` and failed loudly on its first real invocation.
 * `hireOfficeTemplateFor` called the same action inside a try/catch, so
 * `hire_office` failed SILENTLY: it created six agents, wired none of them,
 * and returned success — every reader a plain platform agent answering from
 * memory, which is precisely what that desk exists to prevent. The second one
 * was only caught because the roster was read afterwards.
 *
 * The fix in both cases is the split lib/mcp-worker-wiring.ts and
 * lib/office-hire.ts now use: the core takes a userId, the action supplies it
 * from the session, the MCP handler supplies it from the verified token.
 */
const SCANNED = ['lib', 'lib/mcp/handlers', 'lib/db', 'lib/onchain']

/**
 * Call sites that reach into app/actions and are safe today, each because the
 * action it calls does NOT read the session.
 *
 * This is an allowlist, not an exemption: the test still fails on a NEW
 * violation. Anything added here needs the same check done by hand — open the
 * action and confirm it never calls getSession(). The clean end state is that
 * this list is empty and `creditWorkerForJob` lives in a lib, with the action
 * as its wrapper.
 */
const KNOWN_SAFE: Record<string, string> = {
  'lib/labor-settle.ts': 'creditWorkerForJob — bookkeeping, no getSession()',
  'lib/delegation.ts': 'creditWorkerForJob — bookkeeping, no getSession()',
  'lib/credit-reconcile.ts': 'creditWorkerForJob — bookkeeping, no getSession()',
}

function offenders(): string[] {
  const found: string[] = []
  for (const dir of SCANNED) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const rel = `${dir}/${file}`
      const source = readFileSync(rel, 'utf8')
      // Static and dynamic both — both failures shipped as dynamic imports.
      if (!/['"]@\/app\/actions\/[^'"]+['"]/.test(source)) continue
      if (KNOWN_SAFE[rel]) continue
      found.push(rel)
    }
  }
  return found
}

describe('shared code never calls a session-authenticated server action', () => {
  it('has directories to scan', () => {
    expect(SCANNED.length).toBeGreaterThan(0)
  })

  it('finds no call site outside the reviewed allowlist', () => {
    expect(offenders()).toEqual([])
  })

  it('keeps the allowlist honest — every entry still has the import it excuses', () => {
    // An entry left behind after its import was removed would silently excuse
    // a future violation in the same file.
    for (const rel of Object.keys(KNOWN_SAFE)) {
      const source = readFileSync(rel, 'utf8')
      expect(/['"]@\/app\/actions\/[^'"]+['"]/.test(source), `${rel} no longer needs its allowlist entry`).toBe(true)
    }
  })

  it('scans the MCP handlers, where the rule is absolute', () => {
    for (const file of readdirSync('lib/mcp/handlers').filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(`lib/mcp/handlers/${file}`, 'utf8')
      expect([...source.matchAll(/['"]@\/app\/actions\/[^'"]+['"]/g)].map((m) => m[0]), file).toEqual([])
    }
  })
})
