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

  // Which harness this worker is running, if any. Best-effort on purpose:
  // failing to record it must never cost the worker its poll, and the only
  // thing lost is one row in a public tool listing.
  if ('harness' in (body ?? {})) {
    const { recordHarness } = await import('@/lib/agent-harness-server')
    await recordHarness(agentId, body.harness).catch(() => {})
  }

  // What this machine can actually DO, probed by the worker rather than
  // promised at registration. A worker that declares 'video' without ffmpeg
  // gets matched to media jobs it will fail, and a failed job costs the
  // agent its own credit score — so the declaration is refreshed on every
  // poll, the same reasoning as the harness id above.
  if (Array.isArray(body?.capabilities)) {
    const { normalizeCapabilities } = await import('@/lib/artifacts')
    await db
      .update(agent)
      .set({ capabilities: normalizeCapabilities(body.capabilities), updatedAt: new Date() })
      .where(eq(agent.id, agentId))
      .catch(() => {})
  }

  // Run telemetry: what the harness is doing right now, drained by the
  // worker on this same round trip. Best-effort for the same reason the
  // harness id is — this endpoint's job is handing out paid work, and a
  // dropped log line must never cost a worker its task. `agentId` is the
  // AUTHENTICATED one, never the body's, so a worker cannot write telemetry
  // onto somebody else's run by naming their task id.
  if (Array.isArray(body?.runs) && body.runs.length > 0) {
    const { recordRunReport } = await import('@/lib/harness-run-server')
    for (const report of body.runs.slice(0, 8)) {
      await recordRunReport(agentId, report).catch(() => {})
    }
  }

  // Office-session runs ride the same poll (lib/office-session-server.ts).
  // Reports first — a run's progress must land even on a poll that hands
  // out nothing — then the cancel list, then a queued run if this worker has
  // one. A session run takes priority over a market task: it is work the
  // owner's own office scheduled on the owner's own machine.
  let sessionCancel: string[] = []
  try {
    const os = await import('@/lib/office-session-server')
    if (Array.isArray(body?.session_runs) && body.session_runs.length > 0) {
      for (const report of body.session_runs.slice(0, 8)) await os.recordSessionRunReport(agentId, report).catch(() => {})
    }
    sessionCancel = await os.cancelledRunsFor(agentId).catch(() => [])
    if (body?.session_capacity !== 0) {
      const handout = await os.claimSessionRunFor(agentId)
      if (handout) return Response.json({ task: null, session_run: handout, session_cancel: sessionCancel })
    }
  } catch (e) {
    console.error('[worker/poll] office-session step failed:', e)
  }

  // A report-only poll: the worker is at capacity and only wants its
  // reports folded and its cancel list. Hand out nothing.
  if (body?.capacity === 0) return Response.json({ task: null, session_cancel: sessionCancel })

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

  if (!candidate) return Response.json({ task: null, session_cancel: sessionCancel })

  const claimed = await db
    .update(agentTask)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(agentTask.id, candidate.id), eq(agentTask.status, 'queued')))
    .returning()

  if (claimed.length === 0) return Response.json({ task: null }) // raced — next poll

  // Tell the worker what kind of deliverable this task expects — an image
  // job needs the callback to attach artifacts, not just text.
  let deliverableKind = 'text'
  // A repo job's deliverable is a unified diff against a specific branch, and
  // the worker cannot know that from the brief alone once a coding harness is
  // doing the work — the harness reads the brief, edits files, and has no idea
  // anything is expected to come back as a patch. Naming the repo here is what
  // lets the worker clone it, run the harness inside the checkout, and take
  // the diff with git (lib/worker-deliverable.ts). Without it, harness mode
  // submits prose for the one job type it exists to do.
  let repo: { full_name: string; base_branch: string | null } | null = null
  // The requester's notes so far (lib/job-channel.ts), appended to the brief
  // HERE rather than stored in it: the stored prompt is what the spec hash
  // binds, and a note is context on top of that, never part of it.
  let taskText = candidate.task
  try {
    const { jobSpec } = await import('@/lib/db/schema')
    const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.agentTaskId, candidate.id))
    if (spec) {
      const { notesFor } = await import('@/lib/job-channel-server')
      const { withRequesterNotes } = await import('@/lib/job-channel')
      const { untrustedNonce } = await import('@/lib/untrusted-input')
      const notes = await notesFor(spec.specHash).catch(() => [])
      taskText = withRequesterNotes(candidate.task, notes, untrustedNonce())
    }
    if (spec?.deliverableKind) deliverableKind = spec.deliverableKind
    if (spec?.repoFullName) {
      const { validateRepoFullName } = await import('@/lib/repo-jobs')
      // Validated HERE as well as in the worker: this is a value the platform
      // is handing to a command line on somebody else's machine, and "the
      // other side checks it" is not a property this side gets to assume.
      if (validateRepoFullName(spec.repoFullName)) {
        // NOT `|| 'main'`. octocat/Hello-World defaults to master, and a
        // guessed branch fails the clone with "Remote branch main not
        // found". Null tells the worker to take the repository's own
        // default, which is always right and costs no lookup.
        repo = { full_name: spec.repoFullName, base_branch: spec.baseBranch || null }
      }
    }
  } catch { /* pre-migration DB — text is always right */ }

  // A media job's recipe, COMPILED HERE.
  //
  // The worker gets an argv array, not a spec to interpret. One
  // implementation of "what ffmpeg invocation does this job mean"
  // (lib/media-recipe.ts) instead of a platform copy and a worker copy that
  // drift until the same job grades differently depending on which side
  // built the command. The worker's whole contribution to a media job is a
  // machine with ffmpeg on it, and that is the point: it substitutes its own
  // input and output paths into the two placeholders and runs the binary
  // directly — never through a shell.
  let media: { args: string[]; must: unknown; source_url: string; input_token: string; output_token: string } | null = null
  try {
    const { extractMediaSpec, ffmpegArgs, MEDIA_INPUT_TOKEN, MEDIA_OUTPUT_TOKEN } = await import('@/lib/media-recipe')
    const spec = extractMediaSpec(candidate.task)
    if (spec) {
      media = {
        args: ffmpegArgs(spec, MEDIA_INPUT_TOKEN, MEDIA_OUTPUT_TOKEN),
        must: spec.must,
        source_url: spec.sourceUrl,
        input_token: MEDIA_INPUT_TOKEN,
        output_token: MEDIA_OUTPUT_TOKEN,
      }
    }
  } catch {
    // A malformed media block is the requester's problem and it surfaces at
    // grading, not by withholding the task: the worker still gets the brief
    // and can fail it with a message a person can act on.
  }

  return Response.json({
    task: {
      task_id: candidate.id,
      agent_id: agentId,
      task: taskText,
      deliverable_kind: deliverableKind,
      repo,
      media,
    },
    session_cancel: sessionCancel,
  })
}
