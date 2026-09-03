import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'

// A finish report ticks the session inline (verification, policy, maybe a
// reviewer call), so give it the same room the runtime callback has.
export const maxDuration = 300

/**
 * POST /api/worker/session-run — a local worker finishing an office-session
 * run (lib/office-session-server.ts `finishSessionRun`).
 *
 * Same authentication as /api/worker/poll: the agent's own secret, and the
 * run must belong to that agent. Progress and heartbeats do NOT come here;
 * they ride the poll (`session_runs`). This endpoint is the one report that
 * carries the deliverable, the diff and the test result, and it answers
 * with the session id so the worker's log can name it.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const agentId = body?.agent_id as string | undefined
  if (!agentId) return Response.json({ error: 'Missing agent_id' }, { status: 400 })
  const [ag] = await db.select({ id: agent.id, runtimeType: agent.runtimeType }).from(agent).where(eq(agent.id, agentId))
  if (!ag || ag.runtimeType !== 'local') return Response.json({ error: 'Not a local-worker agent' }, { status: 404 })
  const auth = await resolveCallbackAuth(agentId)
  if (!auth.required || !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { finishSessionRun } = await import('@/lib/office-session-server')
  const result = await finishSessionRun(agentId, {
    runId: body?.run_id,
    ok: body?.ok,
    exitCode: body?.exit_code,
    deliverable: body?.deliverable,
    diff: body?.diff,
    changedFiles: body?.changed_files,
    deletedFiles: body?.deleted_files,
    tests: body?.tests,
    costUsd: body?.cost_usd,
    tokensUsed: body?.tokens_used,
    harnessSessionId: body?.harness_session_id,
    error: body?.error,
    failureCode: body?.failure_code,
    checkpoint: body?.checkpoint,
  })
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json({ status: 'ok', session_id: result.sessionId })
}
