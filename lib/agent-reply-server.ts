/**
 * Calling the recipient's runtime, and turning what it says into a reply.
 *
 * lib/agent-reply.ts holds every rule; this holds the two things that need
 * the outside world — asking an agent, and the sweep that does it for every
 * unread question on the platform.
 *
 * Dispatch is deliberately its OWN path rather than `runAgentTask`. Three
 * reasons, in order of how much each would have cost to get wrong:
 *
 *   1. `runAgentTask` writes an `agent_tasks` row that the callback then
 *      turns into `agent_events` and a settlement attempt. Events are
 *      scoring input. Answering a question is not graded, not paid, and
 *      must move a credit score in neither direction.
 *   2. It is fire-and-forget by design (webhook/cloud/mcp all return before
 *      the work is done). A reply wants the answer in hand so it can be
 *      sent as a message; a callback round-trip would need a second table
 *      just to remember why the task existed.
 *   3. The job path carries skills, custom instructions and a brief format
 *      built for deliverables. A two-line answer to "have you scraped this
 *      already?" wants none of it.
 *
 * What it does share is the runtime configuration itself — the same
 * cloudBaseUrl/cloudModel/cloudApiKeyEnc and mcpServerUrl/mcpToolName rows
 * the job dispatcher reads, so an agent that can work can answer, with
 * nothing new to configure.
 */
import { db, pool } from '@/lib/db'
import { agent, agentMessage } from '@/lib/db/schema'
import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { decryptSecret } from '@/lib/crypto'
import { sendAgentMessage } from '@/lib/agent-messages'
import {
  autoDepthOf,
  autoReplyPayload,
  buildReplyPrompt,
  decideAutoReply,
  parseReplyOutput,
  refusalReason,
  type ReplyContextMessage,
} from '@/lib/agent-reply'

/** An answer is a couple of sentences. A runtime that has not produced one
 *  in two minutes is not about to. */
const ANSWER_TIMEOUT_MS = 120_000

/** Questions handled per sweep. The sweep runs on the ops cycle, so this is
 *  a per-tick ceiling, not a total — it keeps one busy account from
 *  monopolising a cron run. */
const MAX_QUESTIONS_PER_TICK = 12

/** How much of the pair's history the answering model sees. Enough to make
 *  a follow-up coherent, bounded so a long thread cannot grow the prompt
 *  without limit. */
const THREAD_CONTEXT = 4
const THREAD_BODY_LIMIT = 400

type AgentRow = typeof agent.$inferSelect

/* ── The opt-in flag ─────────────────────────────────────────────────── */

/**
 * Auto-reply is stored in its own self-migrating table rather than as an
 * `agent` column, and that is a deployment decision rather than a modelling
 * one.
 *
 * Drizzle's `select()` names every column of a table explicitly, so adding
 * one to `agent` makes EVERY read of that table fail — most of the site —
 * from the moment the new code deploys until somebody remembers to POST
 * /api/admin/migrate. Deploys here are automatic on push; migrations are a
 * manual admin call. A window where the whole product is down waiting for a
 * human is not a reasonable price for one boolean, especially on the
 * real-money deployment.
 *
 * A side table has no such window: the CREATE runs on first use, and an
 * account with no row simply has the feature off, which is the default
 * anyway.
 */
let autoReplyTableReady: Promise<void> | null = null
function ensureAutoReplyTable(): Promise<void> {
  autoReplyTableReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS agent_auto_reply (
         agent_id text PRIMARY KEY,
         enabled boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((error) => {
      autoReplyTableReady = null
      throw error
    })
  return autoReplyTableReady
}

/** Which of these agents answer by themselves. Absent row = off. */
export async function autoReplyFlags(agentIds: readonly string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set()
  await ensureAutoReplyTable()
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_auto_reply WHERE enabled = true AND agent_id = ANY($1)`,
    [[...agentIds]],
  )
  return new Set(rows.map((r) => r.agent_id))
}

/** Every agent on the platform with auto-reply on — the sweep's seed. */
export async function autoReplyAgentIds(): Promise<string[]> {
  await ensureAutoReplyTable()
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_auto_reply WHERE enabled = true`,
  )
  return rows.map((r) => r.agent_id)
}

export async function setAutoReplyFlag(agentId: string, enabled: boolean): Promise<void> {
  await ensureAutoReplyTable()
  await pool.query(
    `INSERT INTO agent_auto_reply (agent_id, enabled, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (agent_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [agentId, enabled],
  )
}

/**
 * Ask one agent one thing and return its text. Throws on a runtime failure
 * so the caller can log it and move on — a runtime that is down is not a
 * reason to lose the message, which stays unread and is retried next tick.
 */
export async function askAgent(agentRow: AgentRow, system: string, user: string): Promise<string> {
  if (agentRow.runtimeType === 'cloud' && agentRow.cloudBaseUrl && agentRow.cloudApiKeyEnc) {
    const apiKey = decryptSecret(agentRow.cloudApiKeyEnc)
    const baseUrl = agentRow.cloudBaseUrl.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: agentRow.cloudModel || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`cloud endpoint responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    return String(data?.choices?.[0]?.message?.content ?? '')
  }

  if (agentRow.runtimeType === 'mcp' && agentRow.mcpServerUrl && agentRow.mcpToolName) {
    const { callMcpTool } = await import('@/lib/mcp-client')
    // An external tool takes one argument and follows no system prompt, so
    // the rules have to travel inside the text it actually receives.
    return callMcpTool({
      serverUrl: agentRow.mcpServerUrl,
      toolName: agentRow.mcpToolName,
      task: `${system}\n\n---\n\n${user}`,
      authHeader: agentRow.mcpAuthHeaderEnc ? decryptSecret(agentRow.mcpAuthHeaderEnc) : null,
      timeoutMs: ANSWER_TIMEOUT_MS,
    })
  }

  // 'platform': the owner's own key, through the same resolver the planner
  // and the mail desk use, so BYOK applies here too.
  const { resolveLlm } = await import('@/lib/delegation')
  const complete = await resolveLlm(agentRow.userId)
  return complete(system, user, 700)
}

/** The pair's recent history, oldest first — what makes a follow-up read as
 *  a conversation rather than as an isolated ping. */
async function threadContext(selfId: string, otherId: string, nameOf: Map<string, string>): Promise<ReplyContextMessage[]> {
  const rows = await db
    .select({
      fromAgentId: agentMessage.fromAgentId,
      body: agentMessage.body,
      createdAt: agentMessage.createdAt,
    })
    .from(agentMessage)
    .where(
      or(
        and(eq(agentMessage.fromAgentId, selfId), eq(agentMessage.toAgentId, otherId)),
        and(eq(agentMessage.fromAgentId, otherId), eq(agentMessage.toAgentId, selfId)),
      ),
    )
    .orderBy(desc(agentMessage.createdAt))
    .limit(THREAD_CONTEXT + 1)

  return rows
    .slice(1) // the newest row is the message being answered
    .reverse()
    .map((m) => ({
      fromName: nameOf.get(m.fromAgentId) ?? 'another agent',
      body: m.body.length > THREAD_BODY_LIMIT ? `${m.body.slice(0, THREAD_BODY_LIMIT)}…` : m.body,
      at: m.createdAt.toISOString(),
    }))
}

export type ReplyOutcome =
  | { status: 'sent'; messageId: string }
  | { status: 'skipped'; why: string }
  | { status: 'failed'; error: string }

/**
 * Answer one specific message, if the rules allow it. Exported so a single
 * message can be driven from a test, a tool, or the sweep below — the rules
 * are applied here exactly once, whoever is calling.
 */
export async function answerMessage(messageId: string): Promise<ReplyOutcome> {
  const [incoming] = await db.select().from(agentMessage).where(eq(agentMessage.id, messageId))
  if (!incoming) return { status: 'skipped', why: 'message not found' }

  const [recipient] = await db.select().from(agent).where(eq(agent.id, incoming.toAgentId))
  if (!recipient) return { status: 'skipped', why: 'recipient agent not found' }
  const [sender] = await db
    .select({ id: agent.id, name: agent.name })
    .from(agent)
    .where(eq(agent.id, incoming.fromAgentId))

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent = await db
    .select({ toAgentId: agentMessage.toAgentId, payload: agentMessage.payload })
    .from(agentMessage)
    .where(and(eq(agentMessage.fromAgentId, recipient.id), gt(agentMessage.createdAt, dayAgo)))
  const autoSent = recent.filter((r) => {
    const p = r.payload as Record<string, unknown> | null
    return p?.autoReply === true
  })

  const enabled = (await autoReplyFlags([recipient.id])).has(recipient.id)
  const decision = decideAutoReply({
    enabled,
    messageType: incoming.type,
    incomingDepth: autoDepthOf(incoming.payload),
    repliesToday: autoSent.length,
    repliesToThisSenderToday: autoSent.filter((r) => r.toAgentId === incoming.fromAgentId).length,
    runtimeType: recipient.runtimeType,
  })
  if (!decision.reply) return { status: 'skipped', why: refusalReason(decision.why) }

  const nameOf = new Map<string, string>([
    [recipient.id, recipient.name],
    ...(sender ? ([[sender.id, sender.name]] as [string, string][]) : []),
  ])
  const { counterInstructionsForAgent } = await import('@/lib/office-counter-server')
  const { system, user } = buildReplyPrompt({
    selfName: recipient.name,
    selfDescription: recipient.description,
    senderName: sender?.name ?? 'another agent',
    messageType: incoming.type,
    incomingBody: incoming.body,
    thread: await threadContext(recipient.id, incoming.fromAgentId, nameOf),
    standingInstructions: await counterInstructionsForAgent(recipient.id),
  })

  let raw: string
  try {
    raw = await askAgent(recipient, system, user)
  } catch (error) {
    // Left unread on purpose: the runtime was down, not the message wrong.
    // The next tick tries again.
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }

  const parsed = parseReplyOutput(raw)
  if ('refused' in parsed) {
    // An empty answer still consumed a call, and re-asking every tick would
    // consume one forever — so the question is marked read and dropped.
    await markRead(incoming.id)
    return { status: 'skipped', why: 'the runtime returned an empty answer' }
  }

  try {
    const { id } = await sendAgentMessage({
      fromAgentId: recipient.id,
      toAgentId: incoming.fromAgentId,
      type: 'info',
      body: parsed.body,
      payload: autoReplyPayload(autoDepthOf(incoming.payload), incoming.id),
    })
    await markRead(incoming.id)
    return { status: 'sent', messageId: id }
  } catch (error) {
    // A block, a suspension or the hourly limit. The answer is not owed
    // twice, so the question is marked read either way.
    await markRead(incoming.id)
    return { status: 'skipped', why: error instanceof Error ? error.message : String(error) }
  }
}

async function markRead(messageId: string): Promise<void> {
  await db.update(agentMessage).set({ readAt: new Date() }).where(eq(agentMessage.id, messageId))
}

/**
 * The sweep: every unread question addressed to an agent that opted in.
 *
 * Runs from the ops cycle, which is what makes the lane autonomous rather
 * than a button — the whole point is that an agent answers at three in the
 * morning with nobody watching. Bounded per tick, and one runtime's failure
 * never stops the rest.
 */
export async function tickAgentReplies(): Promise<string | Record<string, unknown>> {
  const enabled = await autoReplyAgentIds()
  if (enabled.length === 0) return 'no agent has auto-reply on'
  const ids = new Set(enabled)

  // Only questions, only unread, oldest first — the same order check_inbox
  // uses, so a human and the sweep work a backlog the same way.
  const pending = await db
    .select({ id: agentMessage.id, toAgentId: agentMessage.toAgentId, type: agentMessage.type })
    .from(agentMessage)
    .where(isNull(agentMessage.readAt))
    .orderBy(asc(agentMessage.createdAt))
    .limit(200)

  const mine = pending.filter((m) => ids.has(m.toAgentId)).slice(0, MAX_QUESTIONS_PER_TICK)
  if (mine.length === 0) return 'no unread questions for an auto-reply agent'

  let sent = 0
  let skipped = 0
  let failed = 0
  for (const m of mine) {
    try {
      const outcome = await answerMessage(m.id)
      if (outcome.status === 'sent') sent += 1
      else if (outcome.status === 'failed') {
        failed += 1
        console.warn(`[agent-reply] ${m.id}: ${outcome.error}`)
      } else skipped += 1
    } catch (error) {
      failed += 1
      console.error('[agent-reply] unexpected failure answering', m.id, error)
    }
  }
  return { considered: mine.length, sent, skipped, failed }
}
