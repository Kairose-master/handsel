import { db } from '@/lib/db'
import { user, agent, delegation } from '@/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { after } from 'next/server'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'
import {
  planDelegation,
  confirmDelegationJobs,
  tickDelegation,
  subtaskViews,
  type DelegationSubtask,
} from '@/lib/delegation'

export const maxDuration = 120 // confirm posts up to MAX_SUBTASKS on-chain escrows

const MAX_BUDGET_USD = 500 // keep in sync with app/actions/delegate.ts

/**
 * POST /api/delegations — headless delegation for the desktop Miner (and
 * any scripted client), multiplexed on `op`. Same auth split as the rest
 * of the headless surface:
 *
 *  - op "status": agent_id + X-Runtime-Secret header. Read-only view of
 *    the agent OWNER's delegations; also drives the deferred verification
 *    tick, exactly like the /delegate page's polling does. A leaked worker
 *    secret can watch/accelerate settlement but never redirect funds.
 *  - op "plan" | "confirm" | "discard": email + password re-auth. plan
 *    burns planner-LLM tokens, confirm is the moment money escrows —
 *    both are owner actions, not worker actions.
 *
 * Bodies:
 *   { op: "status",  agent_id }
 *   { op: "plan",    email, password, prime_agent_id, goal, budget_usd, auto_verify? }
 *   { op: "confirm", email, password, id }
 *   { op: "discard", email, password, id }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const op = String(body?.op ?? '')

  try {
    if (op === 'status') return await opStatus(request, body)
    if (op === 'plan' || op === 'confirm' || op === 'discard') {
      // Password-taking op that spends: 'plan' burns planner-LLM tokens and
      // 'confirm' escrows real money, so guessing here pays an attacker
      // twice. Throttled on attempts, before the bcrypt compare.
      const { authThrottled, throttleIp } = await import('@/lib/auth-throttle')
      if (await authThrottled('withdraw', throttleIp(request))) {
        return Response.json(
          { error: 'Too many credential attempts from this address — wait a few minutes and try again.' },
          { status: 429 },
        )
      }
      const u = await authOwner(body)
      if (!u) return Response.json({ error: 'Invalid credentials' }, { status: 401 })
      if (op === 'plan') return await opPlan(u.id, body)
      if (op === 'confirm') return await opConfirm(u.id, body)
      return await opDiscard(u.id, body)
    }
    return Response.json({ error: 'Unknown op' }, { status: 400 })
  } catch (error) {
    console.error(`[api/delegations ${op}]`, error)
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

async function authOwner(body: unknown) {
  const b = body as { email?: unknown; password?: unknown }
  const email = String(b?.email ?? '').trim().toLowerCase()
  const password = String(b?.password ?? '')
  if (!email || !password) return null
  const [u] = await db.select({ id: user.id, password: user.password }).from(user).where(eq(user.email, email))
  if (!u?.password || !(await bcrypt.compare(password, u.password))) return null
  return u
}

async function opStatus(request: Request, body: { agent_id?: unknown }) {
  const agentId = String(body?.agent_id ?? '')
  if (!agentId) return Response.json({ error: 'Missing agent_id' }, { status: 400 })
  const [ag] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!ag) return Response.json({ error: 'Agent not found' }, { status: 404 })
  const auth = await resolveCallbackAuth(agentId)
  if (!auth.required || !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rows: (typeof delegation.$inferSelect)[]
  try {
    rows = await db
      .select()
      .from(delegation)
      .where(eq(delegation.userId, ag.userId))
      .orderBy(desc(delegation.createdAt))
      .limit(10)
  } catch {
    return Response.json({ delegations: [] }) // table missing until migration runs
  }

  const hasActive = rows.some((r) => r.status === 'posted')
  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = hasActive ? await readJobs().catch(() => []) : []

  // Same no-cron heartbeat as the /delegate page: heavy settlement/tick
  // work runs after the response; the client's next poll sees the result.
  if (hasActive) {
    const active = rows.filter((r) => r.status === 'posted')
    after(async () => {
      const { sweepStuckGradedJobs } = await import('@/lib/labor-settle')
      await sweepStuckGradedJobs().catch((e) => console.error('[api/delegations] sweep failed:', e))
      for (const row of active) {
        await tickDelegation(row, jobs).catch((e) => console.error('[api/delegations] tick failed:', e))
      }
    })
  }

  const delegations = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      task: row.task,
      budget_usd: Number(row.budgetUsd),
      status: row.status,
      final_output: row.finalOutput,
      error: row.error,
      created_at: row.createdAt.toISOString(),
      subtasks:
        row.status === 'planned'
          ? (row.subtasks as DelegationSubtask[]).map((st) => ({ ...st, jobStatus: null, workerLabel: null }))
          : await subtaskViews(row, jobs),
    })),
  )
  return Response.json({ delegations })
}

async function opPlan(
  userId: string,
  body: { prime_agent_id?: unknown; goal?: unknown; budget_usd?: unknown; auto_verify?: unknown },
) {
  const primeAgentId = String(body?.prime_agent_id ?? '')
  const goal = String(body?.goal ?? '').trim()
  const budgetUsd = Number(body?.budget_usd)
  const autoVerify = body?.auto_verify === undefined ? true : Boolean(body.auto_verify)

  const [prime] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, primeAgentId), eq(agent.userId, userId)))
  if (!prime) return Response.json({ error: 'Agent not found on this account' }, { status: 404 })
  if (!prime.smartAccountAddress) {
    return Response.json({ error: 'Provision the prime agent first — it escrows the bounties' }, { status: 400 })
  }
  if (goal.length < 20) return Response.json({ error: 'Describe the task in at least 20 characters' }, { status: 400 })
  if (!Number.isFinite(budgetUsd) || budgetUsd < 2) {
    return Response.json({ error: 'Budget must be at least $2' }, { status: 400 })
  }
  if (budgetUsd > MAX_BUDGET_USD) {
    return Response.json({ error: `Budget is capped at $${MAX_BUDGET_USD} per delegation` }, { status: 400 })
  }

  const subtasks = await planDelegation(userId, goal, budgetUsd)
  const id = `dlg-${nanoid(10)}`
  await db.insert(delegation).values({
    id,
    userId,
    primeAgentId,
    task: goal,
    budgetUsd: budgetUsd.toFixed(2),
    status: 'planned',
    subtasks,
    autoVerify,
  })
  return Response.json({ id, subtasks })
}

async function opConfirm(userId: string, body: { id?: unknown }) {
  const id = String(body?.id ?? '')
  // The actual post — including the re-check-under-lease that makes a double
  // click or a retried request post once, not twice — lives in
  // lib/delegation.ts's confirmDelegationJobs, shared with the server action
  // and the MCP tool of the same name.
  const result = await confirmDelegationJobs(id, userId)
  if (!result.ok) {
    const notFound = /not found/i.test(result.error)
    return Response.json({ error: result.error }, { status: notFound ? 404 : 400 })
  }
  return Response.json({ posted: result.subtasks.length })
}

async function opDiscard(userId: string, body: { id?: unknown }) {
  const id = String(body?.id ?? '')
  const [row] = await db.select().from(delegation).where(eq(delegation.id, id))
  if (!row || row.userId !== userId) return Response.json({ error: 'Delegation not found' }, { status: 404 })
  if (row.status !== 'planned') {
    return Response.json({ error: 'Only unconfirmed plans can be discarded' }, { status: 400 })
  }
  await db.delete(delegation).where(eq(delegation.id, id))
  return Response.json({ ok: true })
}
