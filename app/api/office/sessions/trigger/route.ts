import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'

// A trigger ticks every matching session inline (plan, dispatch) — give it
// the same room the worker's finish report has.
export const maxDuration = 120

/**
 * POST /api/office/sessions/trigger — the HTTP lane for event-driven office
 * sessions (docs/office-sessions.md). A CI job, a cron on the owner's
 * machine, a Slack workflow or anything else that can POST wakes the
 * sessions on this account that listed the name.
 *
 *   curl -X POST $ORIGIN/api/office/sessions/trigger \
 *     -H 'x-runtime-secret: <the worker token>' \
 *     -H 'content-type: application/json' \
 *     -d '{"agent_id":"<local agent id>","trigger":"nightly-report"}'
 *
 * Authenticated exactly like the worker's poll: a local agent's own secret,
 * and the account is the one that agent belongs to. The name is prefixed
 * `http:` on the way in (lib/session-triggers.ts), so a caller can never
 * forge a GitHub-sourced name. Nothing here moves money: a wake only starts
 * a session's next wave from its own budget under its own policy.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const agentId = body?.agent_id as string | undefined
  if (!agentId) return Response.json({ error: 'Missing agent_id' }, { status: 400 })
  const [ag] = await db.select({ id: agent.id, userId: agent.userId, runtimeType: agent.runtimeType }).from(agent).where(eq(agent.id, agentId))
  if (!ag || ag.runtimeType !== 'local') return Response.json({ error: 'Not a local-worker agent' }, { status: 404 })
  const auth = await resolveCallbackAuth(agentId)
  if (!auth.required || !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { httpTrigger } = await import('@/lib/session-triggers')
  const trigger = typeof body?.trigger === 'string' ? httpTrigger(body.trigger) : null
  if (!trigger) return Response.json({ error: 'trigger must be a short name: letters, digits, . _ - / (no wildcard)' }, { status: 400 })
  const { fireSessionTriggers } = await import('@/lib/office-session-server')
  const woke = await fireSessionTriggers([trigger], ag.userId)
  return Response.json({ ok: true, trigger, woke })
}
