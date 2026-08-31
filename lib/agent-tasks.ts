/**
 * Shared "start a real agent run" logic — used by both the ad-hoc task API
 * route (POST /api/agents/:id/tasks) and server actions that need to kick
 * off a genuine agent execution (e.g. a Labor Market job's worker actually
 * doing the work). One code path, so BYOK resolution / webhook dispatch /
 * custom-instructions prefixing can't drift between callers.
 */
import { db } from '@/lib/db'
import { origin } from '@/lib/origin'
import { agent, agentTask } from '@/lib/db/schema'
import { and, eq, inArray, lt, notInArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { after } from 'next/server'
import { startAgentTask } from '@/lib/agent-runtime/client'
import { resolveCallbackAuth } from '@/lib/webhook'
import { decryptSecret } from '@/lib/crypto'

type AgentRow = typeof agent.$inferSelect

// 30 minutes: generous enough for slow local reasoning models (deepseek-r1
// on consumer GPUs legitimately thinks for 10+ minutes) while still
// eventually failing runs whose runtime actually died. Applies to
// platform/local/webhook — 'cloud' gets its own, much shorter timeout
// below, since that dispatch path already bounds itself.
const STUCK_TASK_TIMEOUT_MS = 30 * 60 * 1000

// 'cloud' dispatch (dispatchToCloudApi) already times its own call out at
// CLOUD_CALL_TIMEOUT_MS (4 min) and calls back with a result either way —
// success or a recorded failure — so it essentially never needs this
// sweep. This only catches the rare case where the whole after()
// invocation got killed outright (e.g. the underlying function was
// recycled) before it could call back at all. Loose enough to never race
// a legitimate in-flight call, tight enough not to leave a genuinely dead
// task sitting for half an hour for no reason.
const CLOUD_STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * A task can get stuck in 'running'/'processing' forever if the runtime
 * process dies before it calls back — e.g. a mid-run redeploy kills the
 * Python runtime's background thread, or a webhook agent's own server
 * crashes. There's no heartbeat/retry, so nothing else would ever notice.
 *
 * Call this from any read path that surfaces task status (it's a couple of
 * cheap UPDATE...WHERE statements, safe to call on every poll). A genuine
 * callback landing at the exact same moment races this on the same row —
 * whichever UPDATE commits first wins. In the rare case this one wins right
 * as a real result was arriving, that result is dropped (matches the
 * existing idempotent-callback behavior: /api/runtime/callback already
 * no-ops with `{status: 'ignored'}` when it can't claim a 'running' row).
 */
export async function reapStuckTasks(): Promise<void> {
  const cloudAgents = await db.select({ id: agent.id }).from(agent).where(eq(agent.runtimeType, 'cloud'))
  const cloudAgentIds = cloudAgents.map((a) => a.id)

  const cloudCutoff = new Date(Date.now() - CLOUD_STUCK_TASK_TIMEOUT_MS)
  await db
    .update(agentTask)
    .set({
      status: 'failed',
      error: `Timed out waiting for the cloud API call (no response after ${CLOUD_STUCK_TASK_TIMEOUT_MS / 60_000} minutes) — the endpoint may be unreachable, or the request was interrupted before it could report back.`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(agentTask.status, ['running', 'processing']),
        lt(agentTask.updatedAt, cloudCutoff),
        inArray(agentTask.agentId, cloudAgentIds),
      ),
    )

  const defaultCutoff = new Date(Date.now() - STUCK_TASK_TIMEOUT_MS)
  await db
    .update(agentTask)
    .set({
      status: 'failed',
      error: `Timed out waiting for the runtime (no response after ${STUCK_TASK_TIMEOUT_MS / 60_000} minutes) — it may have crashed or been redeployed mid-run.`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(agentTask.status, ['running', 'processing']),
        lt(agentTask.updatedAt, defaultCutoff),
        notInArray(agentTask.agentId, cloudAgentIds),
      ),
    )

  // Queued tasks for 'local' agents that no worker ever claimed — the
  // owner's worker process is probably not running. ('cloud' tasks never
  // sit in 'queued': dispatch fires synchronously via after() in
  // runAgentTask, so this bucket is unaffected by the split above.)
  await db
    .update(agentTask)
    .set({
      status: 'failed',
      error: `No local worker claimed this task within ${STUCK_TASK_TIMEOUT_MS / 60_000} minutes — is your handsel-worker process running?`,
      updatedAt: new Date(),
    })
    .where(and(eq(agentTask.status, 'queued'), lt(agentTask.updatedAt, defaultCutoff)))
}

/** Starts a real run for `agent` and returns immediately (async — the
 *  runtime/webhook calls back on completion). Returns the new taskId. */
export async function runAgentTask(input: {
  agent: AgentRow
  task: string
  callbackUrl: string
}): Promise<{ taskId: string }> {
  const { agent, task, callbackUrl } = input
  const taskId = `task-${nanoid(10)}`

  // Installed skills (lib/agent-skills.ts) join the brief through the same
  // choke point customInstructions always used. Skipped for 'mcp' runtime —
  // there the task may collapse to a bare [mcp-query] argument for one
  // external tool that follows no instructions, so an instruction document
  // is noise by construction (see agent-skills.ts's header). A failed skill
  // read degrades to "no skills" rather than failing the dispatch: skills
  // enhance a job, they must never be the reason it didn't start.
  let skillsBlock = ''
  if (agent.runtimeType !== 'mcp') {
    try {
      const { skillsForPrompt, renderSkillsBlock } = await import('@/lib/agent-skills')
      skillsBlock = renderSkillsBlock(await skillsForPrompt(agent.id))
    } catch (error) {
      console.error('[agent-tasks] skill read failed (dispatching without skills):', error)
    }
  }
  const { composeEffectiveTask } = await import('@/lib/agent-skills')
  const effectiveTask = composeEffectiveTask({
    customInstructions: agent.customInstructions ?? null,
    skillsBlock,
    task,
  })

  // 'local' agents are pull-based: their worker process polls
  // /api/worker/poll and claims queued tasks — we never connect to them
  // (that reversed direction is what makes local hosting tunnel-free).
  // The stored task text is the effective (instruction-prefixed) one, since
  // no dispatch call carries it.
  if (agent.runtimeType === 'local') {
    await db.insert(agentTask).values({
      id: taskId,
      userId: agent.userId,
      agentId: agent.id,
      task: effectiveTask,
      status: 'queued',
    })
    return { taskId }
  }

  await db.insert(agentTask).values({
    id: taskId,
    userId: agent.userId,
    agentId: agent.id,
    task,
    status: 'running',
  })

  try {
    if (agent.runtimeType === 'webhook' && agent.webhookUrl) {
      await dispatchToWebhook(agent.id, agent.webhookUrl, taskId, effectiveTask, callbackUrl)
    } else if (agent.runtimeType === 'cloud' && agent.cloudBaseUrl && agent.cloudApiKeyEnc) {
      // Run after the response is sent — the actual completion can take
      // longer than we want to hold a serverless request open, same reason
      // 'webhook'/'platform' dispatch is fire-and-forget. Unlike those two
      // there's no external server to do the work on, so we do it
      // ourselves and call our own callback endpoint exactly like a
      // webhook agent's server would.
      //
      // "Ourselves" is, whenever possible, a SEPARATE function invocation
      // (POST /api/runtime/execute) rather than this one's after(): after()
      // shares the calling request's duration budget, and four office
      // dispatches queued behind one cron tick all died with it — measured
      // live, 2026-08-31: every task still 'running' at the 30-minute reap,
      // zero callbacks. Handing the work to our own HTTP endpoint gives each
      // dispatch a full budget of its own. The inline path stays as the
      // fallback when the handoff cannot happen (no CRON_SECRET, refused).
      after(async () => {
        if (!(await handoffDispatchExecution(taskId, callbackUrl))) {
          await dispatchToCloudApi(agent, taskId, effectiveTask, callbackUrl)
        }
      })
    } else if (agent.runtimeType === 'mcp' && agent.mcpServerUrl && agent.mcpToolName) {
      // An external MCP server does the work. Same handoff-then-fallback
      // shape as cloud: the execute endpoint calls the tool in its own
      // invocation, then POSTs our own callback with the result.
      after(async () => {
        if (!(await handoffDispatchExecution(taskId, callbackUrl))) {
          await dispatchToMcpWorker(agent, taskId, effectiveTask, callbackUrl)
        }
      })
    } else {
      const { resolveUserAnthropicKey } = await import('@/lib/user-keys')
      const apiKey = await resolveUserAnthropicKey(agent.userId)
      await startAgentTask({ agentId: agent.id, taskId, task: effectiveTask, callbackUrl, apiKey })
    }
  } catch (error) {
    await db
      .update(agentTask)
      .set({ status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
      .where(eq(agentTask.id, taskId))
    throw error
  }

  return { taskId }
}

/** POST the task to the agent owner's own HTTP endpoint. No code from the
 *  webhook ever runs on our servers — we only send a task and wait for the
 *  callback, authenticated with this agent's own secret. */
async function dispatchToWebhook(
  agentId: string,
  webhookUrl: string,
  taskId: string,
  task: string,
  callbackUrl: string,
) {
  const auth = await resolveCallbackAuth(agentId)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth.required) headers['X-Runtime-Secret'] = auth.secret

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent_id: agentId, task_id: taskId, task, callback_url: callbackUrl }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Webhook responded ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
}

const CLOUD_SYSTEM_PROMPT =
  'You are an autonomous worker agent on the Handsel labor market. ' +
  'Complete the task exactly as specified. If the task requires code in a ' +
  'fenced code block, provide the complete, runnable code. Be factual and concise.'

// Vercel functions extended via after() are still bounded by the same
// duration budget as the request — this is a single-shot chat completion
// (no tool use, same shape as the local worker's cloud path), so 4 minutes
// is generous for any realistic provider while staying inside typical
// Fluid-compute limits. A run that genuinely exceeds this is caught the
// same way a crashed local worker is: reapStuckTasks()'s 30-minute sweep.
const CLOUD_CALL_TIMEOUT_MS = 4 * 60 * 1000

function cloudEvent(
  agentId: string,
  taskId: string,
  type: string,
  success: boolean,
  executionTime: number,
  detail: Record<string, unknown> = {},
) {
  return {
    agent_id: agentId,
    task_id: taskId,
    event_type: type,
    success,
    execution_time: executionTime,
    token_cost: 0,
    quality_score: null,
    detail,
  }
}

/**
 * Runs the task against the owner's own OpenAI-compatible cloud endpoint
 * (Groq, Together, Fireworks, OpenRouter, actual OpenAI, ...) using their
 * stored, encrypted API key — server-side, so there's no CORS concern and
 * no local process for the owner to keep running. Single-shot completion,
 * same trust model as the local worker script's --openai path: our own
 * independent graders decide what the output is worth, never this call's
 * self-reported success.
 */
async function dispatchToCloudApi(
  agentRow: AgentRow,
  taskId: string,
  task: string,
  callbackUrl: string,
) {
  const startedAt = Date.now()
  let output = ''
  let success = true
  let error: string | undefined

  try {
    const apiKey = decryptSecret(agentRow.cloudApiKeyEnc as string)
    const baseUrl = (agentRow.cloudBaseUrl as string).replace(/\/+$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    // OpenRouter expects an attribution referer + title; without them some
    // accounts/models 4xx or get rate-limited harder. Harmless to other
    // OpenAI-compatible providers, so only send it when actually hitting OpenRouter.
    if (/openrouter\.ai/i.test(baseUrl)) {
      headers['HTTP-Referer'] = origin()
      headers['X-Title'] = 'Handsel'
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: agentRow.cloudModel || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: CLOUD_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
      }),
      signal: AbortSignal.timeout(CLOUD_CALL_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Cloud endpoint responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const data = await res.json()
    output = (data?.choices?.[0]?.message?.content ?? '').trim()
    if (!output) {
      success = false
      error = 'Cloud model returned empty output'
    }
  } catch (e) {
    success = false
    error = e instanceof Error ? e.message : String(e)
  }

  const executionTime = Math.round((Date.now() - startedAt) / 1000)
  const events = [
    cloudEvent(agentRow.id, taskId, 'TASK_STARTED', true, 0, { task: task.slice(0, 200) }),
    cloudEvent(agentRow.id, taskId, success ? 'TASK_COMPLETED' : 'TASK_FAILED', success, executionTime, {
      runtime: 'cloud-api',
      model: agentRow.cloudModel,
      ...(error ? { error: error.slice(0, 300) } : {}),
    }),
  ]

  try {
    const auth = await resolveCallbackAuth(agentRow.id)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.required) headers['X-Runtime-Secret'] = auth.secret

    await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task_id: taskId,
        agent_id: agentRow.id,
        success,
        output: success ? output : `Cloud worker error: ${error}`,
        plan: '',
        quality_score: null,
        execution_time: executionTime,
        token_cost: 0,
        events,
      }),
    })
  } catch (callbackError) {
    console.error('[agent-tasks] cloud dispatch callback failed:', callbackError)
  }
}

/**
 * Runs the task by calling a tool on an EXTERNAL MCP server — "bring any
 * MCP-speaking agent in as a worker". Same trust model as every other runtime:
 * the tool's text output is submitted as the agent's work and our independent
 * graders decide what it's worth, never the external server's self-report.
 * The auth header (if any) is decrypted only here, server-side, at call time.
 */
async function dispatchToMcpWorker(agentRow: AgentRow, taskId: string, task: string, callbackUrl: string) {
  const startedAt = Date.now()
  let output = ''
  let success = true
  let error: string | undefined

  try {
    const { callMcpTool } = await import('@/lib/mcp-client')
    const authHeader = agentRow.mcpAuthHeaderEnc ? decryptSecret(agentRow.mcpAuthHeaderEnc as string) : null
    const serverUrl = agentRow.mcpServerUrl as string
    const toolName = agentRow.mcpToolName as string
    output = await callMcpTool({
      serverUrl,
      toolName,
      task,
      authHeader,
      timeoutMs: CLOUD_CALL_TIMEOUT_MS,
    })
    if (!output.trim()) {
      success = false
      error = 'MCP tool returned empty output'
    } else {
      // 'assisted': the tool is this worker's SOURCE, not its voice. A search
      // server returns result dumps, which fail an acceptance criterion like
      // "every figure quoted with the page it came from" no matter how good
      // the retrieval was — see lib/mcp-assist.ts. 'proxy' (the default, and
      // every agent registered before modes existed) submits the tool's own
      // text unchanged, which is right when the server IS the agent.
      const { getMcpMode } = await import('@/lib/mcp-mode')
      if ((await getMcpMode(agentRow.id)) === 'assisted') {
        const { assistedWorkerPrompt } = await import('@/lib/mcp-assist')
        const { untrustedNonce } = await import('@/lib/untrusted-input')
        const { resolveLlm } = await import('@/lib/delegation')
        // Minted now, after the retrieved text arrived.
        const nonce = untrustedNonce()
        const { system, user } = assistedWorkerPrompt({
          agentName: agentRow.name,
          customInstructions: agentRow.customInstructions,
          brief: task,
          toolName,
          serverUrl,
          toolOutput: output,
          nonce,
        })
        // Deliberately not falling back to the raw dump when no model is
        // reachable: that submits something the grader will reject and books
        // the failure against a worker that retrieved correctly. Failing the
        // dispatch says what is actually wrong, and leaves the job claimable.
        const complete = await resolveLlm(agentRow.userId)
        const written = await complete(system, user, 8000)
        if (!written.trim()) {
          success = false
          error = 'assisted MCP worker retrieved content but the model returned nothing'
        } else {
          output = written
        }
      }
    }
  } catch (e) {
    success = false
    error = e instanceof Error ? e.message : String(e)
  }

  const executionTime = Math.round((Date.now() - startedAt) / 1000)
  const events = [
    cloudEvent(agentRow.id, taskId, 'TASK_STARTED', true, 0, { task: task.slice(0, 200) }),
    cloudEvent(agentRow.id, taskId, success ? 'TASK_COMPLETED' : 'TASK_FAILED', success, executionTime, {
      runtime: 'mcp-worker',
      mcpTool: agentRow.mcpToolName,
      ...(error ? { error: error.slice(0, 300) } : {}),
    }),
  ]

  try {
    const auth = await resolveCallbackAuth(agentRow.id)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth.required) headers['X-Runtime-Secret'] = auth.secret

    await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task_id: taskId,
        agent_id: agentRow.id,
        success,
        output: success ? output : `MCP worker error: ${error}`,
        plan: '',
        quality_score: null,
        execution_time: executionTime,
        token_cost: 0,
        events,
      }),
    })
  } catch (callbackError) {
    console.error('[agent-tasks] mcp dispatch callback failed:', callbackError)
  }
}

/**
 * Hand a cloud/mcp dispatch to POST /api/runtime/execute — our own endpoint,
 * our own separate function invocation, a full duration budget per dispatch.
 *
 * Returns true when the execute endpoint accepted the work (202); the caller
 * must then NOT run the dispatch inline. False means "run it yourself":
 * no CRON_SECRET to authenticate with, or the endpoint refused.
 *
 * A timeout is counted as handed off, not as failure: the request most
 * likely reached the endpoint, and the wrong way to resolve the ambiguity is
 * to also run inline — a double execution calls one external MCP tool twice
 * and races two callbacks (the second is ignored, but the tool call is not
 * free). If the request truly never arrived, the task sits 'running' until
 * reapStuckTasks fails it and auto-mine's heal re-dispatches — the exact
 * recovery chain this incident built.
 */
async function handoffDispatchExecution(taskId: string, callbackUrl: string): Promise<boolean> {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  try {
    const response = await fetch(new URL('/api/runtime/execute', callbackUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ task_id: taskId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 202) return true
    console.warn(`[agent-tasks] execute handoff for ${taskId} refused (${response.status}) — dispatching inline`)
    return false
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      console.warn(`[agent-tasks] execute handoff for ${taskId} timed out awaiting the 202 — assuming it arrived`)
      return true
    }
    console.warn(`[agent-tasks] execute handoff for ${taskId} failed — dispatching inline:`, error)
    return false
  }
}

/**
 * Run the actual work for an already-inserted cloud/mcp task, in whatever
 * invocation is calling — the body of POST /api/runtime/execute. Recomposes
 * the effective (instruction-prefixed) task by the same rules runAgentTask
 * used, because the stored row keeps the RAW task for these runtimes.
 *
 * Refuses anything that is not a 'running' cloud/mcp task: 'running' is the
 * claim — a completed, failed, or reaped task must not be executed again,
 * and the callback route's own idempotence (it only lands on a 'running'
 * row) backs this up if two executions ever race.
 */
export async function executeDispatch(
  taskId: string,
  callbackUrl: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const [taskRow] = await db.select().from(agentTask).where(eq(agentTask.id, taskId))
  if (!taskRow) return { ok: false, why: `no task ${taskId}` }
  if (taskRow.status !== 'running') return { ok: false, why: `task is ${taskRow.status}, not running` }
  const [agentRow] = await db.select().from(agent).where(eq(agent.id, taskRow.agentId))
  if (!agentRow) return { ok: false, why: `task ${taskId} has no agent` }

  let skillsBlock = ''
  if (agentRow.runtimeType !== 'mcp') {
    try {
      const { skillsForPrompt, renderSkillsBlock } = await import('@/lib/agent-skills')
      skillsBlock = renderSkillsBlock(await skillsForPrompt(agentRow.id))
    } catch (error) {
      console.error('[agent-tasks] skill read failed (executing without skills):', error)
    }
  }
  const { composeEffectiveTask } = await import('@/lib/agent-skills')
  const effectiveTask = composeEffectiveTask({
    customInstructions: agentRow.customInstructions ?? null,
    skillsBlock,
    task: taskRow.task,
  })

  if (agentRow.runtimeType === 'cloud' && agentRow.cloudBaseUrl && agentRow.cloudApiKeyEnc) {
    await dispatchToCloudApi(agentRow, taskId, effectiveTask, callbackUrl)
    return { ok: true }
  }
  if (agentRow.runtimeType === 'mcp' && agentRow.mcpServerUrl && agentRow.mcpToolName) {
    await dispatchToMcpWorker(agentRow, taskId, effectiveTask, callbackUrl)
    return { ok: true }
  }
  return { ok: false, why: `runtime '${agentRow.runtimeType}' does not execute here — only cloud/mcp dispatches do` }
}
