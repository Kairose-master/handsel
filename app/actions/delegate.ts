'use server'

/**
 * Delegation actions — the owner-facing wrapper over lib/delegation.ts.
 * plan (nothing escrowed) → confirm (jobs posted, budget escrowed) →
 * status reads (which double as the completion/verification tick, same
 * no-cron pattern as the Worker Console's cloud auto-mine sweep).
 */
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent, delegation } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import {
  planDelegation,
  confirmDelegationJobs,
  tickDelegation,
  subtaskViews,
  delegationCost,
  MAX_SUBTASKS,
  type DelegationSubtask,
} from '@/lib/delegation'

const MAX_BUDGET_USD = 500 // per delegation — matches the scale testnet jobs actually run at

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

async function requireOwnedDelegation(id: string, userId: string) {
  const [row] = await db.select().from(delegation).where(eq(delegation.id, id))
  if (!row || row.userId !== userId) throw new Error('Delegation not found')
  return row
}

/** Step 1: decompose. Stores the plan as 'planned' — the owner sees the
 *  exact subtasks and bounties before a single cent is escrowed. */
export async function createDelegationPlan(input: {
  primeAgentId: string
  task: string
  budgetUsd: number
  autoVerify: boolean
}) {
  const userId = await requireUser()
  const [prime] = await db.select().from(agent).where(eq(agent.id, input.primeAgentId))
  if (!prime || prime.userId !== userId) throw new Error('Agent not found')
  if (!prime.smartAccountAddress) throw new Error('Provision the prime agent first — it escrows the bounties')

  const task = input.task.trim()
  if (task.length < 20) throw new Error('Describe the task in at least 20 characters')
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 2) throw new Error('Budget must be at least $2')
  if (input.budgetUsd > MAX_BUDGET_USD) throw new Error(`Budget is capped at $${MAX_BUDGET_USD} per delegation`)

  try {
    const subtasks = await planDelegation(userId, task, input.budgetUsd)
    const id = `dlg-${nanoid(10)}`
    await db.insert(delegation).values({
      id,
      userId,
      primeAgentId: input.primeAgentId,
      task,
      budgetUsd: input.budgetUsd.toFixed(2),
      status: 'planned',
      subtasks,
      autoVerify: input.autoVerify,
    })
    revalidatePath('/delegate')
    return { id, subtasks }
  } catch (error) {
    // Returned (not thrown) so the REAL message survives production —
    // Next.js masks thrown server-action errors ("The specific message is
    // omitted..."), which is exactly what the first live user hit.
    console.error('[createDelegationPlan]', error)
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Step 2: the owner confirmed the reviewed plan — post the jobs for real.
 *  This is the moment money moves (escrow per subtask, prime's wallet).
 *
 *  requireOwnedDelegation still gates entry (throws on missing/not-yours, this
 *  action's existing contract); the actual post — including the re-check and
 *  lease that make a double click or a retried request post once, not twice —
 *  lives in lib/delegation.ts's confirmDelegationJobs, shared with the MCP
 *  tool of the same name so the race isn't fixed in one caller and not the
 *  other. */
export async function confirmDelegation(id: string) {
  const userId = await requireUser()
  await requireOwnedDelegation(id, userId)
  const result = await confirmDelegationJobs(id, userId)
  if (!result.ok) return { error: result.error }
  revalidatePath('/delegate')
  return { posted: result.subtasks.length }
}

/** Discard a plan that was never confirmed (nothing was escrowed). */
export async function discardDelegation(id: string) {
  const userId = await requireUser()
  const row = await requireOwnedDelegation(id, userId)
  if (row.status !== 'planned') throw new Error('Only unconfirmed plans can be discarded')
  await db.delete(delegation).where(eq(delegation.id, id))
  revalidatePath('/delegate')
  return { ok: true }
}

/** The status read the /delegate page polls — doubles as the tick that
 *  verifies submissions and finalizes completed delegations. */
export async function getMyDelegations() {
  const userId = await requireUser()

  let rows: (typeof delegation.$inferSelect)[]
  try {
    rows = await db
      .select()
      .from(delegation)
      .where(eq(delegation.userId, userId))
      .orderBy(desc(delegation.createdAt))
      .limit(20)
  } catch (error) {
    // Table missing until the operator runs /api/admin/migrate — show an
    // empty list (the form still works up to plan-time) instead of taking
    // the whole page down with it.
    console.error('[delegate] delegations read failed (migration pending?):', error)
    return []
  }

  // One on-chain read shared by the status views below — this action polls
  // every ~8s while the page is open, so per-row reads would multiply RPC
  // load for nothing.
  const hasActive = rows.some((r) => r.status === 'posted')
  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = hasActive ? await readJobs().catch(() => []) : []

  // The heavy work — re-driving stuck settlements (on-chain txs, tens of
  // seconds) and per-delegation verification ticks (LLM calls) — runs
  // AFTER the response is sent. Running it inline once froze this page on
  // a loading spinner for a full settlement's duration; the next 8s poll
  // picks up whatever the deferred work finished. Still no cron: the
  // owner's own polling remains the heartbeat.
  if (hasActive) {
    const active = rows.filter((r) => r.status === 'posted')
    after(async () => {
      const { sweepStuckGradedJobs } = await import('@/lib/labor-settle')
      await sweepStuckGradedJobs().catch((e) => console.error('[delegate] sweep failed:', e))
      for (const row of active) {
        await tickDelegation(row, jobs).catch((e) => console.error('[delegate] tick failed:', e))
      }
    })
  }

  const agents = await db.select().from(agent).where(eq(agent.userId, userId))
  const agentName = new Map(agents.map((a) => [a.id, a.name]))

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      primeAgentId: row.primeAgentId,
      primeAgentName: agentName.get(row.primeAgentId) ?? 'Unknown agent',
      task: row.task,
      budgetUsd: Number(row.budgetUsd),
      status: row.status,
      autoVerify: row.autoVerify,
      finalOutput: row.finalOutput,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      // Transparent money breakdown — escrow/released/refunded/locked, plus
      // gas (sponsored, $0) and fee ($0) stated so nothing is unexplained.
      cost: delegationCost(row, jobs),
      // Who escrows each subtask. Named only where it ISN'T the prime — a
      // delegation with one payer (still the common case) would otherwise
      // repeat the same name down every line. Unresolvable ids are labelled
      // rather than dropped: a plan naming a wallet outside this account is
      // something the owner must see before confirming, and postDelegationJobs
      // refuses it at that point.
      subtasks: (row.status === 'planned'
        ? (row.subtasks as DelegationSubtask[]).map((st) => ({
            ...st,
            jobStatus: null as string | null,
            workerLabel: null as string | null,
          }))
        : await subtaskViews(row, jobs)
      ).map((st) => ({
        ...st,
        payerLabel:
          st.payerAgentId && st.payerAgentId !== row.primeAgentId
            ? (agentName.get(st.payerAgentId) ?? 'an agent outside this account')
            : null,
      })),
    })),
  )
}

/** Prime-agent candidates for the delegate form (provisioned = can escrow). */
export async function getDelegationAgents() {
  const userId = await requireUser()
  const agents = await db.select().from(agent).where(eq(agent.userId, userId))
  return agents.map((a) => ({ id: a.id, name: a.name, provisioned: Boolean(a.smartAccountAddress) }))
}

export async function delegationLimits() {
  return { maxSubtasks: MAX_SUBTASKS, maxBudgetUsd: MAX_BUDGET_USD }
}
