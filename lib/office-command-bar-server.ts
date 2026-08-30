/**
 * Reads the command bar's numbers. Every field is a live query; anything
 * without an honest source is absent from CommandBarView entirely rather
 * than computed from a partial view (see lib/office-command-bar.ts).
 */
import { db, pool } from '@/lib/db'
import { agent, agentTask, jobSpec } from '@/lib/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { CommandBarView } from '@/lib/office-command-bar'
import { officeSlotsByAgentId } from '@/lib/office'

export async function readCommandBar(userId: string, slot: number): Promise<CommandBarView> {
  const roster = await db
    .select({ id: agent.id, addr: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.userId, userId))
  const bySlot = await officeSlotsByAgentId(roster.map((a) => a.id))
  const mine = roster.filter((a) => (bySlot.get(a.id) ?? 1) === slot)
  const ids = mine.map((a) => a.id)

  const agents = { total: mine.length, provisioned: mine.filter((a) => a.addr).length }

  // Running tasks: what a runtime is executing right now for THIS office.
  const running =
    ids.length === 0
      ? 0
      : (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(agentTask)
            .where(and(inArray(agentTask.agentId, ids), inArray(agentTask.status, ['queued', 'running', 'processing'])))
        )[0]?.n ?? 0

  // Waiting approval: this office's own posted work that has been delivered
  // and not yet settled. Counted from job_specs the office's agents worked,
  // which is the set an owner is actually being asked to look at.
  const waiting =
    ids.length === 0
      ? 0
      : (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(jobSpec)
            .where(and(inArray(jobSpec.workerAgentId, ids), sql`${jobSpec.agentTaskId} is not null`))
        )[0]?.n ?? 0

  // Human decisions: escalations raised TO the owner (lib/office-escalation).
  // Its table is self-migrating and may not exist yet on a fresh deployment,
  // so a missing relation reads as zero rather than failing the whole bar.
  let humanDecisions = 0
  try {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM mail_escalation WHERE created_at > now() - interval '7 days'`,
    )
    humanDecisions = Number(rows[0]?.n ?? 0)
  } catch {
    humanDecisions = 0
  }

  // Gas actually spent in the last 24h. Null when the table has nothing —
  // "no sponsored spend" is not "$0.00/h" (see burnPerHour).
  let gasUsd24h: number | null = null
  try {
    const { rows } = await pool.query<{ total: string | null }>(
      `SELECT sum(usd)::text AS total FROM gas_spend WHERE created_at > now() - interval '24 hours'`,
    )
    const total = rows[0]?.total
    gasUsd24h = total === null || total === undefined ? null : Number(total)
  } catch {
    gasUsd24h = null
  }

  // Treasury is the office's own helper; a failure there must not take the
  // rest of the bar with it.
  let treasuryUsd: number | null = null
  try {
    const { buildOfficeTreasury } = await import('@/lib/office-treasury')
    const t = await buildOfficeTreasury(userId, slot)
    treasuryUsd = typeof t?.office?.usdcTotal === 'number' ? t.office.usdcTotal : null
  } catch {
    treasuryUsd = null
  }

  return { treasuryUsd, agents, runningTasks: running, waitingApproval: waiting, humanDecisions, gasUsd24h }
}
