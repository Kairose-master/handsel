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

  it('the loop timing knobs are bounded', async () => {
    const { loopTimingFromEnv } = await import('@/lib/office-session-server')
    expect(loopTimingFromEnv({ OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS: '1' } as unknown as NodeJS.ProcessEnv).heartbeatTimeoutMs).toBe(30_000)
    expect(loopTimingFromEnv({ OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS: '99999999999' } as unknown as NodeJS.ProcessEnv).heartbeatTimeoutMs).toBe(3_600_000)
    expect(loopTimingFromEnv({ OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS: 'nope' } as unknown as NodeJS.ProcessEnv)).toEqual({})
    expect(loopTimingFromEnv({} as unknown as NodeJS.ProcessEnv)).toEqual({})
  })
})
