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

describe('dispatching outside a request scope', () => {
  it('falls back to running now when after() refuses, and never throws at the caller', async () => {
    const { deferDispatch } = await import('@/lib/agent-tasks')
    // The real failure: Next's after() throws outside a request scope, that
    // throw reached runAgentTask's catch, and the task was marked failed
    // before the worker was ever called (failure-modes §72).
    let ran = 0
    const refuse = () => {
      throw new Error('`after` was called outside a request scope.')
    }
    expect(() =>
      deferDispatch(async () => {
        ran += 1
      }, refuse),
    ).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(ran).toBe(1)
    // inside a request scope it is scheduled, not run inline
    const scheduled: Array<() => Promise<void>> = []
    deferDispatch(async () => {
      ran += 1
    }, (f) => scheduled.push(f))
    expect(scheduled).toHaveLength(1)
    expect(ran).toBe(1)
    // a failing dispatch is logged, not an unhandled rejection
    expect(() =>
      deferDispatch(async () => {
        throw new Error('boom')
      }, refuse),
    ).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('both deferred dispatch sites go through it', () => {
    const src = read('lib/agent-tasks.ts')
    expect(src.match(/deferDispatch\(async \(\) => \{/g)).toHaveLength(2)
    // no bare after() left on a dispatch path
    expect(src).not.toMatch(/\n {6}after\(async/)
  })
})

describe('the control room speaks the owner\'s language', () => {
  it('every status and kind has a label in en and ko — a missing one renders its own key', async () => {
    const { DICTIONARIES } = await import('@/lib/i18n-dict')
    const { SESSION_STATUSES, SESSION_KINDS } = await import('@/lib/office-session')
    for (const loc of ['en', 'ko'] as const) {
      for (const s of SESSION_STATUSES) expect(DICTIONARIES[loc][`sess.status.${s}`], `${loc}/${s}`).toBeTruthy()
      for (const k of SESSION_KINDS) expect(DICTIONARIES[loc][`sess.kindOf.${k}`], `${loc}/${k}`).toBeTruthy()
    }
  })

  it('the pages and the strip render those labels through t(), not the raw enum', () => {
    const page = read('app/(dashboard)/office/sessions/page.tsx')
    const detail = read('app/(dashboard)/office/sessions/[id]/page.tsx')
    const strip = read('components/office-control-strip.tsx')
    for (const [name, src] of [['page', page], ['detail', detail], ['strip', strip]] as const) {
      expect(src, name).toContain('sess.status.${')
      expect(src, name).toContain('useI18n')
      // the old raw rendering is gone
      expect(src, name).not.toContain("{s.status.replace(/_/g, ' ')}")
    }
    // and the ko dictionary actually differs from en (a copy would be a silent no-op)
    expect(page).toContain("t('sess.title')")
    expect(detail).toContain("tr('sess.timeline')")
  })
})

describe('an office session talking outside itself', () => {
  it('consult and notify are commands the server performs, and the notify pass covers every early return', () => {
    const loop = read('lib/office-session-loop.ts')
    // the wrapper, not the body: a tick that completes a session returns
    // before the dispatch stage's tail ever runs
    expect(loop).toContain('return { ...result, commands: [...result.commands, ...notifyCommands(result, obs)] }')
    expect(loop).toContain('function runTick(')
    expect(loop).toContain("bindingsFor(obs.tools, s(), 'consult')")
    const server = read('lib/office-session-server.ts')
    expect(server).toContain("case 'consult_tool':")
    expect(server).toContain("case 'notify_tool':")
    expect(server).toContain('CREATE TABLE IF NOT EXISTS office_session_tool')
  })

  it('the outbound call carries only what notifyText builds, and the answer is discarded', () => {
    const server = read('lib/office-session-server.ts')
    const start = server.indexOf('async function notifyTool(')
    expect(start).toBeGreaterThan(0)
    const body = server.slice(start, server.indexOf('\n}\n', start))
    expect(body).toContain('notifyText({')
    // nothing from the work itself reaches the wire
    for (const leak of ['deliverable', 'diff', 'outcome', 'brief']) expect(body, leak).not.toContain(leak)
    // and the tool's reply only becomes a TOOL_NOTIFIED ok/error, never state
    expect(body).toContain("'TOOL_NOTIFIED'")
    expect(body).not.toContain('result.output')
  })

  it('the consulted answer reaches the worker fenced, through the brief\'s memory slot', () => {
    const server = read('lib/office-session-server.ts')
    expect(server).toContain('consultedContext(state, task.id, nonce)')
    expect(server).toContain('renderConsult({ label: consult.label, host: consult.host }')
    // one consult per task, recorded even when it failed
    expect(server).toMatch(/officeEvent\(s\.id, 'TOOL_CONSULTED'/)
    expect(server).toContain('ok: false')
  })

  it('the auth header is encrypted at rest and decrypted only for the call', () => {
    const server = read('lib/office-session-server.ts')
    expect(server).toContain('encryptSecret(input.authHeader)')
    expect(server).toContain('decryptSecret(enc)')
    expect(server).toContain('auth_header_enc text')
    // never selected into the binding list the page and MCP read
    const listStart = server.indexOf('export async function sessionToolBindings(')
    const listBody = server.slice(listStart, server.indexOf('\n}\n', listStart))
    expect(listBody).not.toContain('auth_header_enc')
  })

  it('is reachable from MCP and from the page', () => {
    expect(read('lib/mcp/handlers/office-sessions.ts')).toContain("case 'session_tools':")
    const page = read('app/(dashboard)/office/sessions/page.tsx')
    expect(page).toContain('attachOfficeTool(')
    expect(page).toContain('detachOfficeTool(')
    expect(page).toContain("t('sess.toolNever')")
  })
})

describe('the operator surfaces', () => {
  it('the metrics are computed from the log and shown above everything but the inbox', () => {
    const page = read('app/(dashboard)/office/sessions/page.tsx')
    // needs-you first, then what it saved you — in that order
    expect(page.indexOf('<Inbox view={view}')).toBeLessThan(page.indexOf('<Metrics view={view}'))
    expect(page.indexOf('<Metrics view={view}')).toBeLessThan(page.indexOf('<Sessions view={view}'))
    expect(page).toContain('metricLines(view.metrics)')
    expect(page).toContain("t('sess.metricsNote')")
    const action = read('app/actions/office-session.ts')
    expect(action).toContain('officeMetrics(await os.sessionStatesFor(user.id, slot)')
  })

  it('a posture is a policy write, so the engine never learns presets exist', () => {
    const action = read('app/actions/office-session.ts')
    const start = action.indexOf('export async function setOfficePolicyPreset(')
    expect(start).toBeGreaterThan(0)
    const body = action.slice(start, action.indexOf('\n}\n', start))
    expect(body).toContain('os.setOfficePolicy(user.id, slot, { ...PRESET_POLICIES[preset], id: \'office\' })')
    expect(read('lib/approval-policy.ts')).not.toContain('preset ===')
    // and the JSON editor is still there, behind the postures
    const page = read('app/(dashboard)/office/sessions/page.tsx')
    expect(page).toContain('<Posture view={view}')
    expect(page).toContain("t('sess.editJson')")
  })

  it('every posture and metric label exists in en and ko', async () => {
    const { DICTIONARIES } = await import('@/lib/i18n-dict')
    const { POLICY_PRESETS } = await import('@/lib/approval-policy')
    const { metricLines, EMPTY_METRICS } = await import('@/lib/office-metrics')
    for (const loc of ['en', 'ko'] as const) {
      for (const p of POLICY_PRESETS) {
        const key = `sess.posture${p.charAt(0).toUpperCase()}${p.slice(1)}`
        expect(DICTIONARIES[loc][key], `${loc}/${key}`).toBeTruthy()
      }
      for (const l of metricLines(EMPTY_METRICS)) expect(DICTIONARIES[loc][`sess.m.${l.key}`], `${loc}/${l.key}`).toBeTruthy()
    }
  })
})

describe('Repo Care, the first vertical', () => {
  it('is a configuration of the runtime, not a second runtime', () => {
    const server = read('lib/office-session-server.ts')
    const start = server.indexOf('export async function startRepoCareSession(')
    expect(start).toBeGreaterThan(0)
    const body = server.slice(start, server.indexOf('\n}\n', start))
    // an ordinary scheduled session, with the settings on the side
    expect(body).toContain("kind: 'scheduled'")
    expect(body).toContain('createOfficeSession({')
    expect(body).toContain('setRepoCare(session.id, input.userId, care)')
    // it refuses without a workspace: Repo Care works in the owner's checkout
    expect(body).toContain('no workspace grant on this account')
    // and the plan comes from the backlog, not the goal
    expect(server).toContain('const care = await getRepoCare(s.id)')
    expect(server).toContain('triageRepoCare(care, s.wave)')
  })

  it('a PR is opened only after the task settled, through the App\'s validating helper', () => {
    const loop = read('lib/office-session-loop.ts')
    // emitted next to the settle, never on submit
    const settleBlock = loop.slice(loop.indexOf("emit('TASK_SETTLED'"), loop.indexOf("emit('TASK_SETTLED'") + 600)
    expect(settleBlock).toContain("commands.push({ kind: 'open_pr', taskId: t.id })")
    const server = read('lib/office-session-server.ts')
    expect(server).toContain("case 'open_pr':")
    const start = server.indexOf('async function openTaskPr(')
    const body = server.slice(start, server.indexOf('\n}\n', start))
    expect(body).toContain('openPrFromDiff({')
    // idempotent: a PR artifact already there means no second PR
    expect(body).toContain("a.name.startsWith('pr-')")
    // a failure to land is as visible as a landing
    expect(body).toContain("'SESSION_ESCALATED'")
  })

  it('the skip list is recorded, not swallowed', () => {
    const server = read('lib/office-session-server.ts')
    expect(server).toContain('async function recordTriage(')
    expect(server).toContain('left-for-a-person-w')
    // the morning report is assembled per read, so it cannot go stale
    expect(server).toContain('export async function repoCareReport(')
    expect(server).toContain('morningReport({')
    // the report links each task's own signed proof, not just its PR
    expect(server).toContain("a.taskId === t.id && a.kind === 'proof'")
    expect(server).toContain('proofUrl: proof?.ref ?? null')
    expect(read('app/(dashboard)/office/sessions/[id]/page.tsx')).toContain('officeSessionReport(id)')
  })

  it('is reachable from MCP with the same guard rails', () => {
    const handler = read('lib/mcp/handlers/office-sessions.ts')
    expect(handler).toContain("case 'start_repo_care':")
    expect(handler).toContain('worker_agent_id is required')
    expect(handler).toContain('startRepoCareSession({')
    // the tool never takes a policy or a grant: those stay where they are governed
    const start = handler.indexOf("case 'start_repo_care':")
    const body = handler.slice(start, handler.indexOf('case \'session_tools\':', start))
    expect(body).not.toContain('policy')
    expect(body).not.toContain('grant')
  })

  it('CI is read back onto the task that opened the PR, not just recorded as a market job', () => {
    const server = read('lib/office-session-server.ts')
    expect(server).toContain('export async function findRepoCareTaskForPr(')
    expect(server).toContain('office_session_repo_care')
    // the reverse index matches on the SAME artifact name openTaskPr writes
    expect(server).toContain("`pr-${prNumber}.md`")
    expect(server).toContain('export async function recordPrCiVerdict(')
    expect(server).toContain("type: 'PR_CI_REPORTED'")
    // never touches settlement — this fills in the report on an already-terminal task
    const start = server.indexOf('export async function recordPrCiVerdict(')
    const body = server.slice(start, server.indexOf('\n}\n', start))
    expect(body).not.toContain('TASK_SETTLED')
    expect(body).not.toContain('autoApprovePassedJob')
    // the report reads the SAME field the event writes, not a re-derivation
    expect(server).toContain('ciPassed: t.outcome?.ciPassed ?? null')
  })

  it('the webhook checks Repo Care only when the PR is not a market job, and only for a real conclusion', () => {
    const route = read('app/api/github/webhook/route.ts')
    expect(route).toContain('async function maybeRecordRepoCareCi(')
    // reached from inside the `if (!spec)` branch, before the market's own `continue`
    const specBranch = route.slice(route.indexOf('if (!spec) {'), route.indexOf('gradedAHandselJob = true'))
    expect(specBranch).toContain('maybeRecordRepoCareCi(')
    const start = route.indexOf('async function maybeRecordRepoCareCi(')
    const body = route.slice(start, route.indexOf('\n}\n', start))
    expect(body).toContain("conclusion === 'success'")
    expect(body).toContain("conclusion === 'failure'")
    // neutral/skipped/action_required never write a verdict
    expect(body).toContain('if (passed === null) return')
    expect(body).toContain('findRepoCareTaskForPr(repoFullName, prNumber)')
    expect(body).toContain('recordPrCiVerdict({')
  })

  it('the morning report gives a CI-failed landed PR its own heading, ahead of Landed', () => {
    const repoCare = read('lib/repo-care.ts')
    const start = repoCare.indexOf('export function morningReport(')
    const body = repoCare.slice(start, repoCare.indexOf('\nexport ', start + 10))
    const ciFailedIdx = body.indexOf("block('CI failed on a landed PR'")
    const landedIdx = body.indexOf("block('Landed'")
    expect(ciFailedIdx).toBeGreaterThan(-1)
    expect(landedIdx).toBeGreaterThan(-1)
    expect(ciFailedIdx).toBeLessThan(landedIdx)
  })
})
