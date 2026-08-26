import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * An MCP handler must never call a server action.
 *
 * The two surfaces authenticate differently and cannot be mixed. A server
 * action resolves its caller from the SESSION COOKIE; an MCP request carries
 * an OAuth token and has no cookie. So an action called from a handler throws
 * "Unauthorized" for every caller, always — and nothing static catches it.
 * tsc is happy (the import resolves), lint is happy, the unit tests are happy,
 * the production build is happy.
 *
 * This is not hypothetical. `wire_office_agent` shipped calling
 * `setMcpWorker` from app/actions/webhook, passed all of the above, and
 * failed on its first real invocation against the deployed connector. The fix
 * is the split lib/mcp-worker-wiring.ts and lib/office-hire.ts both use: the
 * core takes a userId, the action supplies it from the session, the handler
 * supplies it from the verified token.
 */
const DIR = 'lib/mcp/handlers'

describe('MCP handlers never reach into app/actions', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'))

  it('has handlers to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s imports no server action', (file) => {
    const source = readFileSync(`${DIR}/${file}`, 'utf8')
    // Static and dynamic both — the failure shipped as a dynamic import.
    const offenders = [...source.matchAll(/['"]@\/app\/actions\/[^'"]+['"]/g)].map((m) => m[0])
    expect(offenders, `${file} must call the lib directly, not a server action`).toEqual([])
  })
})
