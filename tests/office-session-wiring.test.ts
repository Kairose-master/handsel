/**
 * Source-level pins for the office-session runtime's wiring — the things a
 * unit test on the pure modules cannot see and a refactor would silently
 * lose: the ops step, the poll's session-run channel, the finish route's
 * auth, the worker's mirror, and the one release site.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OPS_STEPS } from '@/lib/ops-cycle'

const read = (p: string) => readFileSync(p, 'utf8')

describe('office-session wiring', () => {
  it('is an ops step, cron-only, placed before the fleet sweep', () => {
    const names = OPS_STEPS.map((s) => s.name)
    const step = OPS_STEPS.find((s) => s.name === 'officeSessions')
    expect(step).toBeTruthy()
    expect(step!.fast).toBeFalsy()
    expect(names.indexOf('officeSessions')).toBeLessThan(names.indexOf('fleetTick'))
    expect(names.indexOf('officeSessions')).toBeGreaterThan(names.indexOf('delegations'))
  })

  it('the poll hands out session runs, folds their reports, and carries the cancel list', () => {
    const src = read('app/api/worker/poll/route.ts')
    expect(src).toContain('recordSessionRunReport(agentId, report)')
    expect(src).toContain('claimSessionRunFor(agentId)')
    expect(src).toContain('session_cancel')
    // The report is folded under the AUTHENTICATED agent id, never the body's.
    expect(src).not.toMatch(/recordSessionRunReport\(body/)
  })

  it('the finish route authenticates like the poll and never trusts the body for the agent', () => {
    const src = read('app/api/worker/session-run/route.ts')
    expect(src).toContain("callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))")
    expect(src).toContain("ag.runtimeType !== 'local'")
    expect(src).toContain('finishSessionRun(agentId,')
  })

  it('the server releases escrow only through the existing release site', () => {
    const src = read('lib/office-session-server.ts')
    expect(src).toContain('autoApprovePassedJob(')
    expect(src).not.toContain('approveJob(')
    expect(src).not.toContain('transferUsdc(')
    // and posts escrow jobs with autoApprove OFF, flipped only by settle_escrow
    expect(src).toMatch(/autoApprove: false/)
  })

  it('the worker never asks Claude Code for bypassPermissions on a session run', () => {
    const src = read('public/handsel-worker.mjs')
    const start = src.indexOf('function claudeSessionArgv(')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).not.toContain('bypassPermissions')
    expect(body).toContain("'acceptEdits' : 'plan'")
    expect(src).toContain("platformPost('/api/worker/session-run'")
    expect(src).toContain('session_runs: drainSessionRuns()')
    expect(src).toContain('cancelSessionRuns(polled.session_cancel)')
    // a busy worker still polls to report — a silent run is a dead run to the platform
    expect(src).toContain('capacity: 0,')
    expect(read('app/api/worker/poll/route.ts')).toContain('body?.capacity === 0')
    // a grant cannot widen the worker's own --workdir
    expect(src).toContain("is outside this worker's --workdir")
  })

  it('pause reaches the harness process: the poll carries the list, the worker stops and continues the child', () => {
    const poll = read('app/api/worker/poll/route.ts')
    expect(poll).toContain('pausedRunsFor(agentId)')
    expect(poll.match(/session_pause: sessionPause/g)?.length).toBeGreaterThanOrEqual(3)
    const worker = read('public/handsel-worker.mjs')
    expect(worker).toContain('function pauseSessionRuns(')
    expect(worker).toContain("'SIGSTOP' : 'SIGCONT'")
    expect(worker.match(/pauseSessionRuns\((polled|heard)\.session_pause\)/g)?.length).toBe(2)
    const server = read('lib/office-session-server.ts')
    expect(server).toContain('ADD COLUMN IF NOT EXISTS paused')
    expect(server).toContain('setDispatchesPaused(sessionId, true)')
    expect(server).toContain('setDispatchesPaused(sessionId, false)')
  })

  it('event-driven sessions wake from the GitHub webhook and from the HTTP lane', () => {
    const webhook = read('app/api/github/webhook/route.ts')
    // fired before the handlers, off the response path, after the signature check
    expect(webhook.indexOf('void wakeOfficeSessions(event, payload)')).toBeGreaterThan(webhook.indexOf('verifyGithubSignature(raw'))
    expect(webhook.indexOf('void wakeOfficeSessions(event, payload)')).toBeLessThan(webhook.indexOf("if (event === 'pull_request') return await handlePullRequest"))
    expect(webhook).toContain('githubTriggersFor(event, payload)')
    expect(webhook).toContain('fireSessionTriggers(fired)')
    const http = read('app/api/office/sessions/trigger/route.ts')
    expect(http).toContain("callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))")
    expect(http).toContain("ag.runtimeType !== 'local'")
    expect(http).toContain('httpTrigger(body.trigger)')
    // scoped to the authenticated agent's own account, never a body-supplied user
    expect(http).toContain('fireSessionTriggers([trigger], ag.userId)')
    expect(http).not.toMatch(/body\??\.user_id/)
  })

  it('the grant a run gets is layered, never widened, and the session pays for its own proof', () => {
    const server = read('lib/office-session-server.ts')
    expect(server).toContain('narrowGrant(base, grantRow ? s.workspace : null, taskGrantLayer(task))')
    expect(server).toContain('workerHistoryFrom(past.rows')
    expect(server).toContain("case 'issue_proof':")
    expect(server).toContain('issueWorkProof({')
    expect(server).toContain('jobRef: `oses:${state.session.id}:${taskId}`')
  })

  it('a remote worker is invoked through the market\'s own dispatch, and its callback ticks the session', () => {
    const server = read('lib/office-session-server.ts')
    expect(server).toContain("if (workerRow && workerRow.runtimeType !== 'local') return dispatchRemoteRun(state, c, workerRow)")
    expect(server).toContain("runAgentTask({ agent: worker, task: brief, callbackUrl: absoluteUrl('/api/runtime/callback') })")
    expect(server).toContain('ADD COLUMN IF NOT EXISTS agent_task_id')
    // the poll only ever hands out 'queued' rows — a remote row is never given to a polling worker
    expect(server).toMatch(/WHERE agent_id = \$1 AND status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED/)
    expect(server).toContain('const collected = await collectRemoteRuns(state)')
    expect(server).toContain("status IN ('queued', 'claimed', 'remote') GROUP BY agent_id")
    const cb = read('app/api/runtime/callback/route.ts')
    expect(cb).toContain('void wakeSessionRun(taskId)')
    expect(cb).toContain('tickSessionForAgentTask(taskId)')
    // and a coding task with a workspace still cannot land on one
    expect(read('lib/office-session-loop.ts')).toContain("task.kind === 'coding' && state.session.workspace && c.runtimeType !== 'local'")
  })

  it('the MCP control room mirrors the page: start, status, decide, control', () => {
    const src = read('lib/mcp/handlers/office-sessions.ts')
    for (const t of ['start_office_session', 'office_session_status', 'decide_session_approval', 'control_office_session']) expect(src).toContain(`case '${t}':`)
    // every write goes through the owner-scoped server functions
    expect(src).toContain('decideApproval(auth.userId')
    expect(src).toContain('pauseOfficeSession(auth.userId')
    expect(src).toContain('fireSessionTriggers([trigger], auth.userId)')
    expect(src).not.toContain('autoApprovePassedJob')
    expect(read('app/api/mcp/route.ts')).toContain('handleOfficeSessions')
  })

  it('the loop timing knobs are bounded', async () => {
    const { loopTimingFromEnv } = await import('@/lib/office-session-server')
    expect(loopTimingFromEnv({ OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS: '1' } as unknown as NodeJS.ProcessEnv).heartbeatTimeoutMs).toBe(30_000)
    expect(loopTimingFromEnv({ OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS: '99999999999' } as unknown as NodeJS.ProcessEnv).heartbeatTimeoutMs).toBe(3_600_000)
    expect(loopTimingFromEnv({ OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS: 'nope' } as unknown as NodeJS.ProcessEnv)).toEqual({})
    expect(loopTimingFromEnv({} as unknown as NodeJS.ProcessEnv)).toEqual({})
  })
})
