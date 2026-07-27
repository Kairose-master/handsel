import { db } from '@/lib/db'
import { agent, agentTask } from '@/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'
import { autoMineTick } from '@/lib/auto-mine'

// Auto-mine may perform an on-chain accept inside a poll (Sepolia blocks
// are ~12s); give the function room to finish rather than orphaning an
// accepted job mid-dispatch.
export const maxDuration = 60

/**
 * POST /api/worker/poll — the pull half of "sell your locally-hosted AI's
 * labor" with zero networking setup.
 *
 * A 'local' agent's worker process (public/handsel-worker.mjs) polls this
 * endpoint from the owner's machine. Because the connection is always
 * OUTBOUND from their side, there is no webhook URL, no tunnel, no port
 * forwarding — the same trick CI runners use. We hand out at most one queued
 * task per poll, claimed atomically (queued → running) so two workers (or a
 * retry) can never both run the same task. Results come back through the
 * existing /api/runtime/callback, authenticated with the same per-agent
 * secret this endpoint requires.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const agentId = body?.agent_id as string | undefined
  if (!agentId) return Response.json({ error: 'Missing agent_id' }, { status: 400 })

  const [ag] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!ag || ag.runtimeType !== 'local') {
    return Response.json({ error: 'Not a local-worker agent' }, { status: 404 })
  }

  const auth = await resolveCallbackAuth(agentId)
  if (!auth.required || !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    // A local agent without a secret is misconfigured — fail closed.
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await db.update(agent).set({ lastPollAt: new Date() }).where(eq(agent.id, agentId))

  // Oldest queued task first; atomic claim so a concurrent poll gets nothing.
  let [candidate] = await db
    .select()
    .from(agentTask)
    .where(and(eq(agentTask.agentId, agentId), eq(agentTask.status, 'queued')))
    .orderBy(asc(agentTask.createdAt))
    .limit(1)

  // Idle + auto-mine on → claim the next qualifying open job right now,
  // inside this poll: the worker's heartbeat is the mining loop.
  if (!candidate && ag.autoMine) {
    const url = new URL(request.url)
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
    const claimed = await autoMineTick(ag, `${proto}://${host}/api/runtime/callback`).catch((e) => {
      console.error('[worker/poll] auto-mine tick failed:', e)
      return false
    })
    if (claimed) {
      ;[candidate] = await db
        .select()
        .from(agentTask)
        .where(and(eq(agentTask.agentId, agentId), eq(agentTask.status, 'queued')))
        .orderBy(asc(agentTask.createdAt))
        .limit(1)
    }
  }

  if (!candidate) return Response.json({ task: null })

  const claimed = await db
    .update(agentTask)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(agentTask.id, candidate.id), eq(agentTask.status, 'queued')))
    .returning()

  if (claimed.length === 0) return Response.json({ task: null }) // raced — next poll

  // Tell the worker what kind of deliverable this task expects — an image
  // job needs the callback to attach artifacts, not just text.
  let deliverableKind = 'text'
  try {
    const { jobSpec } = await import('@/lib/db/schema')
    const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.agentTaskId, candidate.id))
    if (spec?.deliverableKind) deliverableKind = spec.deliverableKind
  } catch { /* pre-migration DB — text is always right */ }

  return Response.json({
    task: {
      task_id: candidate.id,
      agent_id: agentId,
      task: candidate.task,
      deliverable_kind: deliverableKind,
    },
  })
}
