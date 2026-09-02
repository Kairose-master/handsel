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
    // Three: the cloud and mcp branches of runAgentTask, and the retry
    // follow-up (§68), which hands the next attempt to its own invocation
    // exactly like the first one.
    const handoffs = src.split('await handoffDispatchExecution(').length - 1
    expect(handoffs).toBe(3)
    expect(src).toContain('dispatchToCloudApi(agent, taskId, effectiveTask, callbackUrl)')
    expect(src).toContain('dispatchToMcpWorker(agent, taskId, effectiveTask, callbackUrl)')
  })

  it('a handoff timeout counts as handed off — never a second, parallel execution', () => {
    expect(src).toContain("error.name === 'TimeoutError'")
    const timeoutBranch = src.slice(src.indexOf("error.name === 'TimeoutError'"))
    expect(timeoutBranch.indexOf('return true')).toBeLessThan(timeoutBranch.indexOf('return false'))
  })

  it('the handoff targets the PUBLIC origin, never the callback URL host', () => {
    // A cron-invoked request can carry a deployment-protected host; every
    // URL built from it answers 401 at the edge. Measured live: the first
    // three handoffs all refused this way.
    const body = src.slice(src.indexOf('async function handoffDispatchExecution'))
    expect(body).toContain("absoluteUrl('/api/runtime/execute')")
    expect(body).not.toContain("new URL('/api/runtime/execute', callbackUrl)")
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

describe('the cron hands the ops cycle a PUBLIC origin', () => {
  it('runOpsCycle gets origin(), not the request host', () => {
    // Same edge-401 defect from the other side: the cron request's own host
    // can be deployment-protected, and the ops origin becomes every runtime
    // callback's target — which is how cron-context dispatches died with no
    // callback while visitor-traffic dispatches completed.
    const src = code('app/api/cron/settle/route.ts')
    expect(src).toContain('runOpsCycle(origin())')
    expect(src).not.toMatch(/runOpsCycle\(`\$\{proto\}/)
  })
})

describe('a platform-run dispatch acts on a retry verdict — the local worker was not the only worker', () => {
  // 2026-09-02, job #55: the AWS reader (mcp-wired) failed grading, the
  // callback answered 'retry' with the grader's reasons, and the dispatcher
  // had already thrown the reply away. The task sat 'running' until the
  // 30-minute reap; every "attempt" cost a reap cycle. docs/failure-modes.md §68.
  const src = code('lib/agent-tasks.ts')

  it('both dispatchers post through one helper and read the reply', () => {
    expect(src.split('await postDispatchCallback(').length - 1).toBe(2)
    expect(src).toContain('return await res.json()')
  })

  it('both dispatchers follow up on the reply, with their own inline rerun as the fallback', () => {
    expect(src).toContain('await followUpOnRetry(agentRow, taskId, task, callbackUrl, reply, (next) => dispatchToCloudApi(agentRow, taskId, next, callbackUrl))')
    expect(src).toContain('await followUpOnRetry(agentRow, taskId, task, callbackUrl, reply, (next) => dispatchToMcpWorker(agentRow, taskId, next, callbackUrl))')
  })

  it('the feedback is persisted on the RAW task row before the handoff, so the fresh invocation carries it', () => {
    const body = src.slice(src.indexOf('async function followUpOnRetry'))
    expect(body).toContain('retryVerdictOf(reply)')
    const persist = body.indexOf('.set({ task: retryBrief(row.task, verdict.reason)')
    const handoff = body.indexOf('await handoffDispatchExecution(taskId, callbackUrl)')
    expect(persist).toBeGreaterThan(-1)
    expect(persist).toBeLessThan(handoff)
  })
})
