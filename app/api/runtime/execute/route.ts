import { after } from 'next/server'

// One dispatch per invocation, with the whole budget to itself — that is the
// point of this route (see lib/agent-tasks.ts handoffDispatchExecution).
export const maxDuration = 300

/**
 * POST /api/runtime/execute — run one already-created cloud/mcp task's
 * dispatch in an invocation of its own.
 *
 * Why this exists: cloud/mcp dispatch used to run in the CALLING request's
 * after(), which shares that request's duration budget. One dispatch riding
 * one user request fit fine; four office dispatches queued behind one cron
 * tick did not — measured live (2026-08-31), all four died with the
 * function, no callback, every task 'running' until the 30-minute reap.
 * Here each dispatch gets its own 300s.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` — the platform calling
 * itself, same credential as the cron. The body names only a task_id; the
 * task must already exist and be 'running', so the endpoint can start
 * nothing new, redirect nothing (the callback URL is derived from this
 * request's own host, never from the body), and at worst re-runs a dispatch
 * whose duplicate callback the callback route already ignores.
 */
export async function POST(request: Request) {
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => null)
  const taskId = typeof (body as { task_id?: unknown } | null)?.task_id === 'string' ? (body as { task_id: string }).task_id : null
  if (!taskId) return Response.json({ error: 'task_id (string) is required' }, { status: 400 })

  // Same own-origin derivation as the cron route: the callback must land on
  // THIS deployment, and must not be steerable by the caller.
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
  const callbackUrl = `${proto}://${host}/api/runtime/callback`

  // Validate BEFORE the 202 so a bad task id is the caller's error, then do
  // the actual work after the response — in this invocation's own budget.
  const { executeDispatch } = await import('@/lib/agent-tasks')
  const { db } = await import('@/lib/db')
  const { agentTask } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const [taskRow] = await db.select({ status: agentTask.status }).from(agentTask).where(eq(agentTask.id, taskId))
  if (!taskRow) return Response.json({ error: `no task ${taskId}` }, { status: 404 })
  if (taskRow.status !== 'running') {
    return Response.json({ error: `task is ${taskRow.status}, not running` }, { status: 409 })
  }

  after(async () => {
    const outcome = await executeDispatch(taskId, callbackUrl).catch((error) => ({
      ok: false as const,
      why: error instanceof Error ? error.message : String(error),
    }))
    if (!outcome.ok) console.error(`[runtime-execute] dispatch of ${taskId} did not run: ${outcome.why}`)
  })

  return Response.json({ status: 'executing', task_id: taskId }, { status: 202 })
}
