import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Perform an open AUDIO job end-to-end, server-side — the same path the
 * desktop miner uses (accept → generate TTS → POST the runtime callback with
 * the audio as an inline artifact), but driven here so an audio job can be
 * completed without a running desktop. Server-to-server base64 has no typing
 * limit, which is why this works where MCP submit_work can't.
 *
 * The callback then transcription-grades it (Whisper) and settles the escrow.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>. A secret in the query string is
 * refused — see lib/admin-route.ts. Params: ?job_id=N&agent=<name>.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: Request): Promise<Response> {
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response
  const url = new URL(request.url)

  const jobId = Number(url.searchParams.get('job_id'))
  const agentName = url.searchParams.get('agent') ?? ''
  if (!Number.isInteger(jobId)) return Response.json({ error: 'job_id required' }, { status: 400 })
  if (!agentName) return Response.json({ error: 'agent (worker name) required' }, { status: 400 })

  const [worker] = await db.select().from(agent).where(eq(agent.name, agentName))
  if (!worker) return Response.json({ error: `no agent named "${agentName}"` }, { status: 404 })

  try {
    // 1) Accept the job (checks capability, self-deal, min score, claims it).
    const { acceptJobForExternalWorker } = await import('@/lib/labor-dispatch')
    const { taskId, prompt, bounty } = await acceptJobForExternalWorker(worker, jobId)

    // 2) Extract the exact line to speak (the audio lane's marker), then TTS it.
    const raw = prompt.split('Acceptance criteria')[0] ?? prompt
    const script = (raw.split('Script to read:')[1] ?? raw).trim().replace(/^["“”']|["“”']$/g, '').trim()
    const { generateAudio } = await import('@/lib/demo-run')
    const audio = await generateAudio(script || prompt)
    const size = Math.floor((audio.base64.length * 3) / 4)

    // 3) Submit through the real runtime callback — same as the desktop miner.
    const { resolveCallbackAuth } = await import('@/lib/webhook')
    const cbAuth = await resolveCallbackAuth(worker.id)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cbAuth.required) headers['X-Runtime-Secret'] = cbAuth.secret
    const res = await fetch(`${url.origin}/api/runtime/callback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task_id: taskId,
        agent_id: worker.id,
        success: true,
        output: `Spoken audio of the requested line, produced with text-to-speech. Script: "${script}"`,
        artifacts: [{ name: 'narration.mp3', mime: audio.mime, data_base64: audio.base64, size }],
        quality_score: null,
        execution_time: 3,
        token_cost: 0,
        events: [],
      }),
    })
    const grading = await res.json().catch(() => null)
    return Response.json({ status: 'ok', jobId, worker: worker.name, bounty, script, callback: grading })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
