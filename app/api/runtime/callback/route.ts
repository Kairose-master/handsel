import { db } from '@/lib/db'
import { agentEvent, agentTask } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'
import {
  completeSettlement,
  deferSettlement,
  enqueueSettlement,
} from '@/lib/callback/settlement-queue'

// Verified-task settlement runs two UserOps; allow time for bundler inclusion.
// Still generous, because settlement is still attempted inline — but it is no
// longer load-bearing: a request killed at the budget leaves a `pending` row
// in settlement_queue rather than nothing at all.
export const maxDuration = 300

/**
 * POST /api/runtime/callback
 * Called by the Python runtime OR a user's own BYO-agent webhook when a task
 * finishes. Persists the behavioral events and recalculates the agent's
 * credit, then records the result on the task row for the dashboard to poll.
 *
 * Auth is resolved PER-TASK'S OWNING AGENT (not one global secret): a
 * platform-runtime task requires RUNTIME_SHARED_SECRET; a webhook-runtime
 * task requires that agent's own secret — so one agent's webhook can never
 * forge a callback for another agent's task.
 *
 * Processing is claimed atomically (running → processing) so a retried
 * callback can't double-insert events.
 */
/**
 * Ceiling on a stored deliverable. Generous for what this market actually
 * trades — a text answer, or a unified diff of a few thousand lines — and
 * far below the point where one worker's submissions become the database's
 * problem. Binary deliverables do not come through here at all; they go to
 * blob storage as artifacts, which have their own limits.
 */
const MAX_OUTPUT_BYTES = 256 * 1024

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const taskId = body?.task_id as string | undefined
  if (!taskId) return Response.json({ error: 'Missing task_id' }, { status: 400 })

  // The output is worker-controlled and was stored with no size limit at
  // all, three times over (verified task, labor settlement, task row). A
  // worker could claim, submit megabytes, and repeat — cheap for them,
  // permanent for the database, and paid for by every later reader of the
  // table.
  //
  // Rejected rather than truncated, deliberately: a silently shortened
  // unified diff is a patch that no longer applies, so the worker would be
  // failed by CI for something the platform did to their work. Better to
  // refuse it and say why while they can still act on it.
  const rawOutput = String(body?.output ?? '')
  const outputBytes = Buffer.byteLength(rawOutput, 'utf8')
  if (outputBytes > MAX_OUTPUT_BYTES) {
    return Response.json(
      {
        error: `Submission is ${Math.round(outputBytes / 1024)}KB; the limit is ${MAX_OUTPUT_BYTES / 1024}KB. ` +
          `Submit a unified diff rather than whole files, or attach large deliverables as artifacts.`,
      },
      { status: 413 },
    )
  }

  const [taskRow] = await db.select().from(agentTask).where(eq(agentTask.id, taskId))
  if (!taskRow) return Response.json({ status: 'ignored' }) // unknown task — idempotent no-op

  const auth = await resolveCallbackAuth(taskRow.agentId)
  if (auth.required && !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // A lifecycle-events-only post. The grading retry loop
  // (lib/grading-retry.ts) sends several submissions for ONE task, and
  // TASK_COMPLETED is a credit event — emitting one per attempt would count a
  // single task three times. So the worker posts attempts with no events and
  // sends them once, here, when the sequence is actually over. No output is
  // read and nothing settles: this path exists so the events can arrive after
  // the task has left `running` and can no longer be claimed below.
  if (body?.events_only === true) {
    const only = Array.isArray(body?.events) ? body.events : []
    if (only.length > 0) {
      await db.insert(agentEvent).values(
        only.map((event: Record<string, unknown>) => ({
          id: nanoid(),
          agentId: taskRow.agentId,
          taskId,
          eventType: String(event.event_type),
          success: Boolean(event.success),
          executionTime: Number(event.execution_time) || 0,
          tokenCost: Number(event.token_cost) || 0,
          qualityScore:
            event.quality_score === null || event.quality_score === undefined
              ? null
              : Number(event.quality_score).toFixed(3),
          detail: (event.detail as Record<string, unknown>) ?? {},
        })),
      )
    }
    return Response.json({ status: 'ok', recorded: only.length })
  }

  // Atomically claim the task so concurrent/retried callbacks process once.
  const claimed = await db
    .update(agentTask)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(and(eq(agentTask.id, taskId), eq(agentTask.status, 'running')))
    .returning()

  if (claimed.length === 0) {
    // Already processed — acknowledge idempotently.
    return Response.json({ status: 'ignored' })
  }

  const agentId = claimed[0].agentId
  const events = Array.isArray(body?.events) ? body.events : []

  try {
    // Binary deliverables (images/files) ride alongside the text output.
    // Validated hard before anything is stored; a bad artifact set fails
    // the submission with an actionable error instead of dropping files.
    const { validateArtifacts } = await import('@/lib/artifacts')
    const artifacts = validateArtifacts(body?.artifacts)
    if (artifacts.length > 0) {
      const { artifact } = await import('@/lib/db/schema')
      await db.insert(artifact).values(
        artifacts.map((a) => ({
          id: `art-${nanoid(16)}`,
          taskId,
          agentId,
          name: a.name,
          mime: a.mime,
          dataBase64: a.dataBase64,
          url: a.url,
          size: a.size,
        })),
      )
    }

    if (events.length > 0) {
      await db.insert(agentEvent).values(
        events.map((event: any) => ({
          id: nanoid(),
          agentId,
          taskId,
          eventType: String(event.event_type),
          success: Boolean(event.success),
          executionTime: Number(event.execution_time) || 0,
          tokenCost: Number(event.token_cost) || 0,
          qualityScore:
            event.quality_score === null || event.quality_score === undefined
              ? null
              : Number(event.quality_score).toFixed(3),
          detail: event.detail ?? {},
        })),
      )
    }

    // The worker's part is over and its proof is stored. Everything after
    // this line is the PLATFORM's obligation — grade, move the escrow,
    // recompute credit — and it is recorded as such before it is attempted.
    await db
      .update(agentTask)
      .set({
        status: 'completed',
        output: rawOutput,
        result: {
          success: Boolean(body?.success),
          plan: body?.plan ?? '',
          qualityScore: Number(body?.quality_score) || 0,
          evaluation: body?.evaluation ?? null,
          executionTime: Number(body?.execution_time) || 0,
          tokenCost: Number(body?.token_cost) || 0,
        },
        updatedAt: new Date(),
      })
      .where(eq(agentTask.id, taskId))
    await enqueueSettlement(taskId, agentId)
  } catch (error) {
    // Only the persistence above can reach here, and a task whose deliverable
    // could not be stored genuinely did fail.
    await db
      .update(agentTask)
      .set({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(agentTask.id, taskId))
    console.error('[runtime/callback] Failed to store task result', taskId, error)
    return Response.json({ error: 'Failed to process callback' }, { status: 500 })
  }

  // Attempt it inline anyway, because a worker that learns within the second
  // whether it was paid is worth keeping — the queue is a floor under this,
  // not a replacement for it. If the lambda dies here instead of returning,
  // the row stays `pending` and the ops cycle finishes the job.
  try {
    const { settleTask } = await import('@/lib/callback/settle')
    const { grading } = await settleTask(taskId, agentId, rawOutput)
    if (grading?.settled === 'retry') {
      // Not settled and not finished: the grade failed, the escrow has not
      // moved, and the job is still this worker's while attempts remain
      // (lib/grading-retry.ts). The task goes back to `running` so the next
      // submission can claim it above — without this the atomic claim, which
      // exists to stop a RETRIED CALLBACK double-processing one submission,
      // would also refuse a genuinely new one and the retry loop would hang
      // on its second attempt.
      await db.update(agentTask).set({ status: 'running', updatedAt: new Date() }).where(eq(agentTask.id, taskId))
      return Response.json({ status: 'ok', grading })
    }
    await completeSettlement(taskId)
    return Response.json({ status: 'ok', grading })
  } catch (error) {
    await deferSettlement(taskId, error)
    console.error('[runtime/callback] settlement deferred for task', taskId, error)
    // 200, not 500: the submission was accepted and stored. Failing the
    // worker's request for our own settlement outage would tell it to retry
    // work it has already delivered.
    return Response.json({ status: 'ok', grading: null, settlement: 'queued' })
  }
}
