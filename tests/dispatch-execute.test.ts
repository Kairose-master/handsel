import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Dispatch execution survives the request that started it.
 *
 * The defect (2026-08-31, live): cloud/mcp dispatch ran in the CALLING
 * request's after(), sharing its duration budget. Four office dispatches
 * behind one cron tick all died with the function — every task 'running'
 * until the 30-minute reap, zero callbacks, escrow refunded at the deadline.
 *
 * The fix is a handoff: runAgentTask POSTs the task id to
 * /api/runtime/execute (authenticated with CRON_SECRET), and that route runs
 * ONE dispatch in an invocation of its own. These are wiring pins in the
 * style of real-money-wiring.test.ts — the rule is trivial, the defect was
 * always in who actually calls what.
 */

const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('runAgentTask hands cloud/mcp dispatch to its own invocation', () => {
  const src = code('lib/agent-tasks.ts')

  it('both branches try the handoff and keep the inline path as fallback', () => {
    // Two call sites (cloud, mcp) — each guarded so a refused handoff still
    // dispatches inline rather than dropping the task.
    const handoffs = src.split('await handoffDispatchExecution(').length - 1
    expect(handoffs).toBe(2)
    expect(src).toContain('dispatchToCloudApi(agent, taskId, effectiveTask, callbackUrl)')
    expect(src).toContain('dispatchToMcpWorker(agent, taskId, effectiveTask, callbackUrl)')
  })

  it('a handoff timeout counts as handed off — never a second, parallel execution', () => {
    expect(src).toContain("error.name === 'TimeoutError'")
    const timeoutBranch = src.slice(src.indexOf("error.name === 'TimeoutError'"))
    expect(timeoutBranch.indexOf('return true')).toBeLessThan(timeoutBranch.indexOf('return false'))
  })

  it('executeDispatch refuses anything that is not a running cloud/mcp task', () => {
    const body = src.slice(src.indexOf('export async function executeDispatch'))
    expect(body).toContain("taskRow.status !== 'running'")
    expect(body).toContain("runtimeType === 'cloud'")
    expect(body).toContain("runtimeType === 'mcp'")
  })
})

describe('POST /api/runtime/execute', () => {
  const src = code('app/api/runtime/execute/route.ts')

  it('is operator-authenticated and claims a full budget of its own', () => {
    expect(src).toContain('requireOperator(request)')
    expect(src).toContain('export const maxDuration = 300')
  })

  it('derives the callback URL from its own host, never from the body', () => {
    expect(src).toContain("x-forwarded-host")
    expect(src).not.toMatch(/body[^\n]*callback/i)
  })
})
